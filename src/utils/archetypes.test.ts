import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { tempDir, writePack } from "../../test/helpers.js"
import { callersLabel, describeArchetype, describePackFlows, exportFlowsToPackManifest, isConfigurablePack, isRoutableArchetype, setArchetypeConfig } from "./archetypes.js"
import { hasErrors, MANIFEST_FILE, validatePack } from "./packs.js"

const agent = (frontmatter: string) => `---\ndescription: agent\n${frontmatter}---\n\nBody.\n`

const FLOW_FILES = {
  "agents/flow-build.md": agent("mode: primary\n"),
  "agents/flow-plan.md": agent("mode: primary\n"),
  "agents/flow-review.md": agent("mode: subagent\n"),
  "agents/flow-explore.md": agent("mode: subagent\n"),
  "agents/flow-eye.md": agent("mode: subagent\nmodel: vision/model\n")
}

const FLOW_MANIFEST = {
  name: "flow",
  archetype: { callers: ["flow-build", "flow-plan"], reference: "flow-build" },
  routingDefaults: { mistral: { "flow-review": "mistral/large", "flow-explore": "inherit" } }
}

function flowCatalog(t: test.TestContext, manifest: Record<string, unknown> = FLOW_MANIFEST, files: Record<string, string> = FLOW_FILES) {
  const root = tempDir(t, "archetype-catalog-")
  writePack(path.join(root, "packs", "flow"), files, manifest)
  writePack(path.join(root, "packs", "plain"), { "agents/plain-one.md": agent("") }, { name: "plain" })
  return root
}

const manifestPath = (root: string) => path.join(root, "packs", "flow", MANIFEST_FILE)
const readManifest = (root: string) => JSON.parse(fs.readFileSync(manifestPath(root), "utf8"))

test("describeArchetype splits callers, routable subagents and pinned subagents and maps routing to roles", (t) => {
  const root = flowCatalog(t)

  const view = describeArchetype(root, "flow")!

  assert.equal(view.id, "flow")
  assert.deepEqual(view.reference, { role: "build", name: "flow-build", subagent: false })
  assert.deepEqual(view.callers.map(caller => caller.name), ["flow-build", "flow-plan"])
  assert.deepEqual(view.related.map(item => item.role), ["explore", "review"])
  assert.deepEqual(view.pinned, [{ role: "eye", name: "flow-eye", subagent: true, model: "vision/model" }])
  assert.deepEqual(view.configs, { mistral: { review: "mistral/large", explore: "inherit" } })
  assert.equal(callersLabel(view), "flow-build or flow-plan")
})

test("describeArchetype is null for packs without an archetype, unknown packs and a missing reference agent", (t) => {
  const root = flowCatalog(t)
  assert.equal(describeArchetype(root, "plain"), null)
  assert.equal(describeArchetype(root, "missing"), null)

  const { "agents/flow-build.md": _reference, ...withoutReference } = FLOW_FILES
  assert.equal(describeArchetype(flowCatalog(t, FLOW_MANIFEST, withoutReference), "flow"), null)
})

test("callersLabel names a single caller and joins three with commas", (t) => {
  const single = describeArchetype(flowCatalog(t, { ...FLOW_MANIFEST, archetype: { callers: ["flow-build"], reference: "flow-build" } }), "flow")!
  assert.equal(callersLabel(single), "flow-build")
  assert.deepEqual(single.callers.map(caller => caller.name), ["flow-build"])
  assert.ok(single.related.some(item => item.name === "flow-plan") === false, "a primary agent is never a routable subagent")

  const three = { ...single, callers: [single.reference, { role: "plan", name: "flow-plan", subagent: false }, { role: "ask", name: "flow-ask", subagent: false }] }
  assert.equal(callersLabel(three), "flow-build, flow-plan or flow-ask")
})

test("setArchetypeConfig adds and replaces a configuration, writing sorted agent IDs and keeping the manifest valid", (t) => {
  const root = flowCatalog(t)

  const file = setArchetypeConfig(root, "flow", "openai/gpt-x", { review: "openai/gpt-x#high", explore: "inherit" })
  assert.equal(file, manifestPath(root))
  assert.deepEqual(readManifest(root).routingDefaults, {
    mistral: { "flow-explore": "inherit", "flow-review": "mistral/large" },
    "openai/gpt-x": { "flow-explore": "inherit", "flow-review": "openai/gpt-x#high" }
  })
  assert.equal(readManifest(root).name, "flow")
  assert.match(fs.readFileSync(file, "utf8"), /\n$/)

  setArchetypeConfig(root, "flow", "mistral", { review: "mistral/small" })
  assert.deepEqual(readManifest(root).routingDefaults.mistral, { "flow-review": "mistral/small" })
  assert.deepEqual(describeArchetype(root, "flow")!.configs.mistral, { review: "mistral/small" })
})

test("setArchetypeConfig renames a configuration through previousTrigger and refuses to overwrite another one", (t) => {
  const root = flowCatalog(t)

  setArchetypeConfig(root, "flow", "mistral/large", { review: "mistral/large" }, { previousTrigger: "mistral" })
  assert.deepEqual(readManifest(root).routingDefaults, { "mistral/large": { "flow-review": "mistral/large" } })

  setArchetypeConfig(root, "flow", "openai", { explore: "inherit" })
  const before = fs.readFileSync(manifestPath(root), "utf8")
  assert.throws(() => setArchetypeConfig(root, "flow", "openai", { review: "openai/x" }, { previousTrigger: "mistral/large" }), /flow already has a configuration for 'openai'/)
  assert.equal(fs.readFileSync(manifestPath(root), "utf8"), before)

  setArchetypeConfig(root, "flow", "openai", { review: "openai/x" }, { previousTrigger: "openai" })
  assert.deepEqual(readManifest(root).routingDefaults.openai, { "flow-review": "openai/x" })
})

test("setArchetypeConfig deletes a configuration and drops routingDefaults when none is left", (t) => {
  const root = flowCatalog(t)

  assert.throws(() => setArchetypeConfig(root, "flow", "openai", null), /No configuration 'openai' in flow/)
  setArchetypeConfig(root, "flow", "mistral", null)

  assert.equal(Object.hasOwn(readManifest(root), "routingDefaults"), false)
  assert.deepEqual(describeArchetype(root, "flow")!.configs, {})
})

test("setArchetypeConfig rejects pinned and unknown subagents, invalid triggers and models, and non-archetype packs", (t) => {
  const root = flowCatalog(t)
  const before = fs.readFileSync(manifestPath(root), "utf8")

  assert.throws(() => setArchetypeConfig(root, "flow", "openai", { eye: "openai/x" }), /eye: not a routable subagent of flow \(it has a fixed model\)/)
  assert.throws(() => setArchetypeConfig(root, "flow", "openai", { plan: "openai/x" }), /plan: not a routable subagent of flow$/)
  assert.throws(() => setArchetypeConfig(root, "flow", "openai", { ghost: "openai/x" }), /ghost: not a routable subagent/)
  assert.throws(() => setArchetypeConfig(root, "flow", "openai", { review: "no-slash" }), /review: 'no-slash' is not "inherit" or provider\/model\[#variant\]/)
  assert.throws(() => setArchetypeConfig(root, "flow", "openai", { review: "openai/x#a#b" }), /is not "inherit"/)
  for (const trigger of ["", "has space", "openai#high", "a/b/c#x"]) {
    assert.throws(() => setArchetypeConfig(root, "flow", trigger, { review: "openai/x" }), /the trigger must be "provider" or "provider\/model"/, trigger)
  }
  assert.throws(() => setArchetypeConfig(root, "plain", "openai", {}), /'plain' is not an archetype pack of this catalog/)
  assert.throws(() => setArchetypeConfig(root, "missing", "openai", {}), /'missing' is not an archetype pack of this catalog/)
  assert.equal(fs.readFileSync(manifestPath(root), "utf8"), before)
})

test("setArchetypeConfig restores the manifest bytes when the pack no longer validates", (t) => {
  const root = flowCatalog(t, FLOW_MANIFEST, { ...FLOW_FILES, "stray.txt": "not allowed at the pack root\n" })
  const before = fs.readFileSync(manifestPath(root), "utf8")

  assert.throws(() => setArchetypeConfig(root, "flow", "openai", { review: "openai/x" }), (error: Error) => {
    assert.match(error.message, /^Configuration rejected:\n  - /)
    assert.match(error.message, /only opencode-pack\.json/)
    return true
  })

  assert.equal(fs.readFileSync(manifestPath(root), "utf8"), before)
})

test("setArchetypeConfig works when the workspace is the archetype pack itself", (t) => {
  const root = writePack(tempDir(t, "archetype-single-"), FLOW_FILES, FLOW_MANIFEST)

  setArchetypeConfig(root, "flow", "openai", { review: "openai/x" })

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, MANIFEST_FILE), "utf8")).routingDefaults.openai, { "flow-review": "openai/x" })
  assert.equal(isRoutableArchetype(root, "flow"), true)
})

test("isRoutableArchetype is true only for an archetype pack of the catalog", (t) => {
  const root = flowCatalog(t)
  writePack(path.join(root, "packs", "broken"), {}, null)
  fs.writeFileSync(path.join(root, "packs", "broken", MANIFEST_FILE), "{ not json")

  assert.equal(isRoutableArchetype(root, "flow"), true)
  assert.equal(isRoutableArchetype(root, "plain"), false)
  assert.equal(isRoutableArchetype(root, "broken"), false)
  assert.equal(isRoutableArchetype(root, "missing"), false)
  assert.equal(isRoutableArchetype(root, "../flow"), false)
  assert.equal(isRoutableArchetype(root, undefined), false)
  assert.equal(isRoutableArchetype(root, null), false)
})

test("describePackFlows works on packs without archetype and exportFlowsToPackManifest writes valid contract 1.1 flowDefaults", (t) => {
  const root = tempDir(t, "flows-slides-")
  const slidesDir = writePack(
    path.join(root, "packs", "slides"),
    {
      "agents/slides-agent.md": agent('mode: primary\npermissions:\n  - action: shell\n    resource: "*"\n    effect: deny\n'),
      "agents/slides-writer.md": agent("mode: subagent\n"),
      "tools/slides/slide_render.ts": "export default {}\n",
    },
    { name: "slides" },
  )

  assert.equal(isRoutableArchetype(root, "slides"), false)
  assert.equal(isConfigurablePack(root, "slides"), true)

  const view = describePackFlows(root, "slides", {
    routeLayers: [{ anthropic: { "slides-writer": "google/gemini-4#high" } }],
    userRules: [
      {
        triggers: ["mistral", "openai/gpt-5.4"],
        then: { models: { "slides-writer": "openai/gpt-5-mini" }, tools: { slide_render: "allow" }, delegations: { "slides-writer": "allow" } },
      },
    ],
  })!

  assert.equal(view.callerSource, "inferred")
  assert.deepEqual(view.callers.map(c => c.name), ["slides-agent"])
  assert.ok(view.staticDeniedTools.has("bash"))
  assert.equal(view.flows.length, 2)

  const exportedFile = exportFlowsToPackManifest(root, view)
  assert.equal(exportedFile, path.join(slidesDir, MANIFEST_FILE))
  const exported = JSON.parse(fs.readFileSync(exportedFile, "utf8"))
  assert.equal(exported.contract, "1.1")
  assert.deepEqual(exported.archetype, { callers: ["slides-agent"], reference: "slides-agent" })
  assert.deepEqual(exported.routingDefaults, { anthropic: { "slides-writer": "google/gemini-4#high" } })
  assert.equal(exported.flowDefaults.length, 1)
  assert.equal(hasErrors(validatePack(slidesDir)), false)
})

test("describePackFlows carries static permission denials through tool aliases", (t) => {
  const cases = [
    { name: "V1 edit", frontmatter: "permission:\n  edit: deny\n", denied: ["edit", "write"] },
    { name: "V2 edit", frontmatter: 'permissions:\n  - action: edit\n    resource: "*"\n    effect: deny\n', denied: ["edit", "write"] },
    { name: "V1 shell", frontmatter: "permission:\n  shell: deny\n", denied: ["shell", "bash"] },
    { name: "V1 bash", frontmatter: "permission:\n  bash: false\n", denied: ["bash", "shell"] },
    { name: "V2 shell", frontmatter: 'permissions:\n  - action: shell\n    resource: "*"\n    effect: deny\n', denied: ["shell", "bash"] },
    { name: "V2 wildcard", frontmatter: 'permissions:\n  - action: "*"\n    resource: "*"\n    effect: deny\n', denied: ["*"] },
  ]

  for (const { name, frontmatter, denied } of cases) {
    const root = tempDir(t, `static-denial-${name.replaceAll(" ", "-")}-`)
    writePack(path.join(root, "packs", "policy"), {
      "agents/caller.md": agent(`mode: primary\n${frontmatter}`),
    }, { name: "policy" })

    const view = describePackFlows(root, "policy")!
    for (const key of denied) assert.ok(view.staticDeniedTools.has(key), `${name} should deny ${key}`)
    if (denied.includes("write")) {
      assert.equal(view.availableTools.find(tool => tool.key === "write")?.staticallyDeniedByCaller, true, name)
    }
    if (denied.includes("bash") || denied.includes("shell")) {
      assert.equal(view.availableTools.find(tool => tool.key === "bash")?.staticallyDeniedByCaller, true, name)
    }
    if (denied.includes("*")) assert.ok(view.availableTools.every(tool => tool.staticallyDeniedByCaller), name)
  }
})

test("describePackFlows respects wildcard permission defaults and explicit tool exceptions", (t) => {
  const cases = [
    {
      name: "V2 later allow",
      frontmatter: 'permissions:\n  - action: edit\n    resource: "*"\n    effect: deny\n  - action: edit\n    resource: "*"\n    effect: allow\n',
      expected: { edit: false, write: false },
    },
    {
      name: "V1 permission wildcard allow",
      frontmatter: 'permission:\n  "*": deny\n  edit: allow\n',
      expected: { edit: false, write: false, read: true, bash: true, grep: true, glob: true },
    },
    {
      name: "V2 wildcard deny followed by allow",
      frontmatter: 'permissions:\n  - action: "*"\n    resource: "*"\n    effect: deny\n  - action: read\n    resource: "*"\n    effect: allow\n',
      expected: { read: false, write: true, edit: true, bash: true, grep: true },
    },
    {
      name: "V2 wildcard deny after allow",
      frontmatter: 'permissions:\n  - action: read\n    resource: "*"\n    effect: allow\n  - action: "*"\n    resource: "*"\n    effect: deny\n',
      expected: { read: true },
    },
  ]

  for (const { name, frontmatter, expected } of cases) {
    const root = tempDir(t, `static-allow-${name.replaceAll(" ", "-")}-`)
    writePack(path.join(root, "packs", "policy"), {
      "agents/caller.md": agent(`mode: primary\n${frontmatter}`),
      ...Object.fromEntries(["read", "grep", "glob"].map(tool => [`tools/policy/${tool}.ts`, ""])),
    }, { name: "policy" })

    const view = describePackFlows(root, "policy")!
    for (const [key, denied] of Object.entries(expected)) {
      assert.equal(view.availableTools.find(tool => tool.key === key)?.staticallyDeniedByCaller, denied, `${name}: ${key}`)
      assert.equal(view.staticDeniedTools.has(key), denied, `${name}: warning set for ${key}`)
    }
  }
})
