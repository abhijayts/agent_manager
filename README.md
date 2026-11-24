# Agent Manager

A personal, local web dashboard for supervising Claude Code agents. It uses the `claude` CLI in headless
mode (your Claude Code login, no API key). Bound to `127.0.0.1` only.

## Run

```
npm install
npm start          # http://localhost:4800
```

Needs Node 20+ and the `claude` CLI on PATH, already logged in.

## How it works

- **You talk only to the supervisor** (right panel). `@a1` or `@agent-name` attaches that agent's status and recent activity to your message.
- **New task** gives the supervisor a prompt, plus optionally a plan, open points and a number of agents.
- **No plan, no work.** If you supply no plan, the supervisor drafts one and waits for you to click *Approve plan*. The server rejects status changes and agent spawns for any task without an approved plan (it is enforced in code, not only in the prompt).
- **Solo or multi.** Easy tasks the supervisor does itself. Otherwise it picks an agent count (or uses yours, max `maxConcurrentAgents`), creates subtasks and spawns agents.
- **Only the supervisor sets task statuses.** Agents only keep their own checklist (shown on their card) and send a final report; the supervisor is woken when they finish.
- **Open points** from the plan are passed to every agent as "non-blocking, keep it flexible".
- Agent panels are read-only (live activity log, checklist, report). The only controls are *Stop*.

## Config (`config.json`)

| key | meaning |
| --- | --- |
| `workspace` | folder where supervisor and agents work (default `./workspace`) |
| `permissionMode` | `acceptEdits` by default; headless agents cannot answer prompts |
| `allowedTools` | tools agents may use without asking. `Bash` makes this effectively full access to your user account, so keep the workspace to things you are OK with agents touching |
| `maxConcurrentAgents` | cap on running agents |
| `model` | optional model override |

State lives in `data/state.json` (gitignored). Agents running when the server stops are marked interrupted on the next start.
