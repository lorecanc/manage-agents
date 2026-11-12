import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { tempDir } from "../../test/helpers.js"
import { extractHttpsHost, inspectGhAuth, listGhRepos, parseGitHubShorthand, runGhWebLogin, type GhRunner } from "./github.js"

test("parseGitHubShorthand expands owner/repo and github: prefixes while preserving local paths", (t) => {
  const dir = tempDir(t, "gh-shorthand-")
  fs.mkdirSync(path.join(dir, "localorg", "localrepo"), { recursive: true })

  assert.deepEqual(parseGitHubShorthand("lorecanc/agents", { checkLocalExists: () => false }), {
    owner: "lorecanc",
    repo: "agents",
    url: "https://github.com/lorecanc/agents.git",
  })
  assert.deepEqual(parseGitHubShorthand("github:lorecanc/agents.git#v2.1.0", { checkLocalExists: () => true }), {
    owner: "lorecanc",
    repo: "agents",
    url: "https://github.com/lorecanc/agents.git",
    ref: "v2.1.0",
  })
  assert.deepEqual(parseGitHubShorthand("gh:my-org/team_packs#feature/auth", { checkLocalExists: () => false }), {
    owner: "my-org",
    repo: "team_packs",
    url: "https://github.com/my-org/team_packs.git",
    ref: "feature/auth",
  })

  // Existing local directory with two segments is NOT hijacked unless prefixed with github:/gh:
  assert.equal(parseGitHubShorthand("localorg/localrepo", {
    checkLocalExists: candidate => fs.existsSync(path.join(dir, candidate)),
  }), null)

  for (const invalid of [
    "",
    "./lorecanc/agents",
    "../lorecanc/agents",
    "/abs/repo",
    "~/lorecanc/agents",
    "https://github.com/lorecanc/agents.git",
    "lorecanc/agents/extra",
    "-flag/repo",
    "lorecanc/-repo",
    "lorecanc/..",
    "lorecanc/agents#--upload-pack=x",
    "lorecanc/agents#bad..ref",
  ]) {
    assert.equal(parseGitHubShorthand(invalid, { checkLocalExists: () => false }), null, JSON.stringify(invalid))
  }
})

test("extractHttpsHost validates clean HTTPS hosts and rejects credentials or non-HTTPS URLs", () => {
  assert.equal(extractHttpsHost("https://github.com/lorecanc/agents.git"), "github.com")
  assert.equal(extractHttpsHost("https://GitHub.Enterprise.Internal/org/packs.git"), "github.enterprise.internal")
  assert.equal(extractHttpsHost("https://token@github.com/lorecanc/agents.git"), null)
  assert.equal(extractHttpsHost("https://github.com:8443/lorecanc/agents.git"), null)
  assert.equal(extractHttpsHost("ssh://git@github.com/lorecanc/agents.git"), null)
  assert.equal(extractHttpsHost("http://github.com/lorecanc/agents.git"), null)
})

test("inspectGhAuth never passes --show-token and handles authenticated, expired and missing gh states", () => {
  const seenArgs: string[][] = []
  const authedRunner: GhRunner = {
    run(args) {
      seenArgs.push(args)
      return {
        status: 0,
        stdout: JSON.stringify({
          hosts: {
            "github.com": [
              { login: "inactive-user", active: false, state: "success" },
              { login: "lorecanc", active: true, state: "success" },
            ],
          },
        }),
        stderr: "",
      }
    },
  }
  const status = inspectGhAuth("github.com", authedRunner)
  assert.equal(status.available, true)
  assert.equal(status.authenticated, true)
  assert.equal(status.login, "lorecanc")
  assert.ok(!seenArgs[0].includes("--show-token"))

  const expiredRunner: GhRunner = {
    run: () => ({
      status: 0,
      stdout: JSON.stringify({ hosts: { "github.com": [{ login: "lorecanc", active: true, state: "failed" }] } }),
      stderr: "",
    }),
  }
  const expired = inspectGhAuth("github.com", expiredRunner)
  assert.equal(expired.authenticated, false)
  assert.match(expired.message, /re-authentication/)

  const missingRunner: GhRunner = {
    run: () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) }),
  }
  const missing = inspectGhAuth("github.com", missingRunner)
  assert.equal(missing.available, false)
  assert.equal(missing.authenticated, false)

  assert.throws(() => inspectGhAuth("-bad-host", authedRunner), /invalid GitHub hostname/)
})

test("listGhRepos returns sanitized repositories and blocks flag injection on owner/hostname", () => {
  const calls: Array<{ args: string[]; stdio?: string }> = []
  const runner: GhRunner = {
    run(args, options) {
      calls.push({ args, stdio: options?.stdio })
      if (args[0] === "repo") {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              nameWithOwner: "lorecanc/agents",
              description: "OpenCode packs",
              isPrivate: true,
              updatedAt: "2026-11-12T10:00:00Z",
              url: "https://github.com/lorecanc/agents",
            },
            {
              nameWithOwner: "../invalid",
              description: "ignored",
              isPrivate: false,
            },
          ]),
          stderr: "",
        }
      }
      return {
        status: 0,
        stdout: JSON.stringify({ hosts: { "github.com": [{ login: "lorecanc", active: true, state: "success" }] } }),
        stderr: "",
      }
    },
  }

  const repos = listGhRepos({ owner: "lorecanc", limit: 25 }, runner)
  assert.equal(repos.length, 1)
  assert.equal(repos[0].nameWithOwner, "lorecanc/agents")
  assert.equal(repos[0].url, "https://github.com/lorecanc/agents.git")
  assert.equal(repos[0].isPrivate, true)
  assert.deepEqual(calls[0].args.slice(0, 5), ["repo", "list", "lorecanc", "--limit", "25"])

  assert.throws(() => listGhRepos({ owner: "--jq=." }, runner), /invalid GitHub owner/)
  assert.throws(() => listGhRepos({ hostname: "-oProxyCommand=x" }, runner), /invalid GitHub hostname/)

  const login = runGhWebLogin("github.com", runner)
  assert.equal(login.ok, true)
  assert.equal(calls[1].stdio, "inherit")
  assert.deepEqual(calls[1].args, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"])
})
