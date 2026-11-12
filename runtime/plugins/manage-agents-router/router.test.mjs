import assert from "node:assert/strict"
import test from "node:test"
import { decidePermission, decideSessionTools, decideSubagentModel, decideToolExecution, modelOf, validateRouting } from "./router.js"

const routing = validateRouting({
  version: 2,
  archetypes: {
    flow: {
      callers: ["flow-build", "flow-plan"],
      pinned: ["flow-eye"],
      routes: {
        mistral: { "flow-explore": "mistral/small#high", "flow-review": "inherit", "flow-eye": "mistral/x" },
        "mistral/big": { "flow-explore": "mistral/medium" },
      },
    },
  },
})
const call = (overrides) => decideSubagentModel(routing, { callerAgent: "flow-build", callerModel: { providerID: "mistral", id: "large" }, targetAgent: "flow-explore", ...overrides })

test("routes by caller provider, exact model first", () => {
  assert.deepEqual(call({}), { model: "mistral/small#high" })
  assert.deepEqual(call({ callerModel: { providerID: "mistral", id: "big" } }), { model: "mistral/medium" })
  assert.deepEqual(call({ callerAgent: "flow-plan" }), { model: "mistral/small#high" })
})

test("leaves the call alone: explicit model, pinned, inherit, unknown caller or provider, same model", () => {
  assert.equal(call({ requestedModel: "a/b" }), null)
  assert.equal(call({ targetAgent: "flow-eye" }), null)
  assert.equal(call({ targetAgent: "flow-review" }), null)
  assert.equal(call({ callerAgent: "other" }), null)
  assert.equal(call({ callerModel: { providerID: "openai", id: "x" } }), null)
  assert.equal(call({ callerModel: "mistral/small#high" }), null)
  assert.equal(decideSubagentModel(null, { callerAgent: "flow-build" }), null)
})

test("validation rejects malformed routing", () => {
  assert.throws(() => validateRouting({ version: 1, archetypes: {} }), /unsupported version/)
  assert.throws(() => validateRouting({ version: 2, archetypes: { a: { callers: [], pinned: [], routes: { "bad key": {} } } } }), /invalid trigger/)
  assert.throws(() => validateRouting({ version: 2, archetypes: { a: { callers: ["x"], pinned: [], routes: { p: { y: "nope" } } } } }), /not "inherit"/)
  assert.deepEqual(modelOf({ providerID: "p", id: "m", variant: "high" }), { provider: "p", model: "m", full: "p/m#high" })
})

test("conditional IF/OR rules: multi-trigger OR, specificity (* < provider < exact), tools, permissions and delegations", () => {
  const rich = validateRouting({
    version: 2,
    archetypes: {
      slides: {
        callers: ["slides-agent", "slides-lead"],
        pinned: ["slides-eye"],
        routes: {},
        rules: [
          {
            triggers: ["*"],
            layer: 0,
            then: {
              models: { "slides-writer": "openai/gpt-5-mini" },
              tools: { bash: "ask", "slide_*": "allow" },
              delegations: { "*": "allow" },
            },
          },
          {
            triggers: ["anthropic", "openai/gpt-5.4"],
            layer: 1,
            then: {
              models: { "slides-writer": "google/gemini-4#high", "slides-eye": "ignored/pinned" },
              tools: { bash: "deny", "slide_*": "deny", slide_render: "allow" },
              permissions: { edit: "ask" },
              delegations: { "slides-heavy": "deny" },
            },
          },
          {
            triggers: ["anthropic/claude-opus-4-6"],
            layer: 1,
            then: {
              tools: { bash: "allow" },
              delegations: { "slides-heavy": "allow" },
            },
          },
        ],
      },
    },
  })

  // Fallback "*" trigger applies on mistral
  assert.deepEqual(
    decideSubagentModel(rich, { callerAgent: "slides-agent", callerModel: "mistral/large", targetAgent: "slides-writer" }),
    { model: "openai/gpt-5-mini" },
  )
  assert.deepEqual(
    decidePermission(rich, { agent: "slides-agent", model: "mistral/large", action: "bash" }),
    { effect: "ask", message: 'Conditional flow (slides-agent on mistral/large) sets "bash" to ask.' },
  )

  // Multi-trigger OR matches both any anthropic model and exact openai/gpt-5.4
  for (const callerModel of ["anthropic/claude-sonnet-4-5", "openai/gpt-5.4#high"]) {
    assert.deepEqual(
      decideSubagentModel(rich, { callerAgent: "slides-lead", callerModel, targetAgent: "slides-writer" }),
      { model: "google/gemini-4#high" },
    )
    assert.equal(
      decideSubagentModel(rich, { callerAgent: "slides-lead", callerModel, targetAgent: "slides-eye" }),
      null,
      "pinned subagent stays untouched",
    )
    assert.deepEqual(
      decideSessionTools(rich, {
        agent: "slides-agent",
        model: callerModel,
        toolNames: ["read", "bash", "slide_export", "slide_render", "subagent"],
      }),
      ["bash", "slide_export"],
    )
    assert.deepEqual(
      decideToolExecution(rich, { callerAgent: "slides-agent", callerModel, tool: "bash", input: {} }),
      {
        blocked: true,
        reason: `Tool "bash" is disabled by manage-agents conditional flow when slides-agent runs on ${callerModel.split("#")[0]}.`,
      },
    )
    assert.deepEqual(
      decideToolExecution(rich, { callerAgent: "slides-agent", callerModel, tool: "subagent", input: { agent: "slides-heavy" } }),
      {
        blocked: true,
        reason: `Delegation to "slides-heavy" is disabled by manage-agents conditional flow when slides-agent runs on ${callerModel.split("#")[0]}.`,
      },
    )
    assert.deepEqual(
      decideToolExecution(rich, { callerAgent: "slides-agent", callerModel, tool: "subagent", input: { agent: "slides-writer" } }),
      { blocked: false, model: "google/gemini-4#high" },
    )
    assert.deepEqual(
      decidePermission(rich, { agent: "slides-agent", model: callerModel, action: "edit" }),
      { effect: "ask", message: `Conditional flow (slides-agent on ${callerModel.split("#")[0]}) sets "edit" to ask.` },
    )
  }

  // Exact model trigger overrides provider trigger within the same layer
  assert.deepEqual(
    decideSessionTools(rich, { agent: "slides-agent", model: "anthropic/claude-opus-4-6", toolNames: ["bash", "slide_export", "slide_render"] }),
    ["slide_export"],
  )
  assert.equal(
    decideToolExecution(rich, { callerAgent: "slides-agent", callerModel: "anthropic/claude-opus-4-6", tool: "subagent", input: { agent: "slides-heavy" } }),
    null,
  )

  // permissions.shell = "deny" also strips/blocks bash tool calls as defense-in-depth
  const permDeny = validateRouting({
    version: 2,
    archetypes: {
      solo: {
        callers: ["solo-lead"],
        pinned: [],
        routes: {},
        rules: [{ triggers: ["*"], layer: 2, then: { permissions: { shell: "deny", edit: "deny" } } }],
      },
    },
  })
  assert.deepEqual(decideSessionTools(permDeny, { agent: "solo-lead", model: "openai/gpt-5", toolNames: ["read", "bash", "write"] }), ["bash", "write"])
  assert.equal(decideToolExecution(permDeny, { callerAgent: "solo-lead", callerModel: "openai/gpt-5", tool: "bash", input: {} })?.blocked, true)
})
