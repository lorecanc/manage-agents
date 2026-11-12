// manage-agents-router: applies conditional IF/OR flows (subagent models, tools, permissions and delegations).
// Installed and kept up to date by `manage-agents reconcile`; the rules are in ./router.js and the data in the
// generated ./routing.json. Fail-open on unexpected errors; explicit "deny" rules reject prohibited actions.
// OPENCODE_AGENT_ROUTER=off disables it.

import fs from "node:fs"
import { fileURLToPath } from "node:url"

import { Plugin } from "@opencode/plugin"

import { decidePermission, decideSessionTools, decideToolExecution, validateRouting } from "./router.js"

const MAX_SESSIONS = 1000
// Hidden system agents run on their own small model inside a session; they must not hide the owner's model.
const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"])

export async function setupRouter(ctx, options = {}) {
  if (options.disabled === true || String(process.env.OPENCODE_AGENT_ROUTER ?? "").toLowerCase() === "off") return () => {}
  const routingPath = fileURLToPath(new URL("./routing.json", import.meta.url))
  const sessions = new Map()
  const disposers = []
  const keep = async (registrationPromise) => {
    try {
      const registration = await registrationPromise
      if (typeof registration === "function") disposers.push(registration)
      else if (registration && typeof registration.dispose === "function") disposers.push(() => registration.dispose())
    } catch {
      /* optional hook domain unavailable in host version */
    }
  }

  // Read on every hook evaluation (a few KB); parse only when it changed.
  let cached = { text: null, routing: null }
  const routing = () => {
    try {
      const text = fs.readFileSync(routingPath, "utf8")
      if (text !== cached.text) cached = { text, routing: validateRouting(JSON.parse(text)) }
    } catch {
      cached = { text: null, routing: null }
    }
    return cached.routing
  }

  const recordSession = (id, agent, model) => {
    if (!id || typeof agent !== "string" || INTERNAL_AGENTS.has(agent)) return
    if (sessions.size >= MAX_SESSIONS && !sessions.has(id)) sessions.delete(sessions.keys().next().value)
    sessions.set(id, { agent, model })
  }

  await keep(ctx.session?.hook?.("model.request", async (event) => {
    try {
      if (event?.kind && event.kind !== "primary") return
      recordSession(event?.sessionID || event?.sessionId, event?.agent, event?.model)
    } catch {
      /* fail open */
    }
  }))

  await keep(ctx.session?.hook?.("context", async (event) => {
    try {
      const id = event?.sessionID || event?.sessionId
      recordSession(id, event?.agent, event?.model)
      if (!event?.tools || typeof event.tools !== "object") return
      const denied = decideSessionTools(routing(), {
        agent: event.agent,
        model: event.model,
        toolNames: Object.keys(event.tools),
      })
      for (const name of denied) delete event.tools[name]
    } catch {
      /* fail open */
    }
  }))

  await keep(ctx.permission?.hook?.("evaluate", async (event) => {
    try {
      if (!event || typeof event !== "object") return
      const session = sessions.get(event.sessionID || event.sessionId)
      const decision = decidePermission(routing(), {
        agent: typeof event.agent === "string" && event.agent ? event.agent : session?.agent,
        model: session?.model,
        action: event.action,
      })
      if (!decision) return
      event.effect = decision.effect
      if (decision.message) event.message = decision.message
    } catch {
      /* fail open */
    }
  }))

  await keep(ctx.tool?.hook?.("execute.before", async (event) => {
    let decision = null
    try {
      const session = sessions.get(event?.sessionID || event?.sessionId)
      decision = decideToolExecution(routing(), {
        callerAgent: typeof event?.agent === "string" && event.agent ? event.agent : session?.agent,
        callerModel: session?.model,
        tool: event?.tool,
        input: event?.input,
      })
      if (decision && !decision.blocked && decision.model && event?.input && typeof event.input === "object") {
        event.input.model = decision.model
      }
    } catch {
      /* fail open on unexpected internal errors */
    }
    if (decision?.blocked) throw new Error(decision.reason)
  }))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    sessions.clear()
  }
}

export default Plugin.define({
  id: "manage-agents-router",
  setup: setupRouter,
})
