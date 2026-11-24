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

- **Explorer layout.** The left explorer navigates *across* tasks: a task expands into its Supervisor, Overview (plan), subtasks and, under each, the agents. The big main pane navigates only *within* the selected task, with tabs for Supervisor, Overview and each of its agents. The Supervisor page is the chat plus a live roster of that task's subagents. Every page has a URL (`#/T1/chat`, `#/T1/overview`, `#/T1/agent/a2`, `#/T1/sub/T3`, `#/general`), so Back/Forward and refresh work.
- **One supervisor per task.** Every top-level task gets its own supervisor (own Claude session, own chat, own agent pool). Tasks run fully in parallel. A **General overview** chat (top of the explorer) is a read-only assistant for questions about everything ("what is running?").
- **You talk only to supervisors.** `@a1` or `@agent-name` attaches that agent's status and recent activity to your message (scoped to that task's agents).
- **New task** gives a supervisor a prompt, plus optionally a plan, open points and a number of agents.
- **No plan, no work.** If you supply no plan, the supervisor drafts one and waits for you to click *Approve plan*. The server rejects status changes and agent spawns for any task without an approved plan (enforced in code, not only in the prompt).
- **Solo or multi.** Easy tasks the supervisor does itself. Otherwise it picks an agent count (or uses yours, up to `maxAgentsPerTask`), creates subtasks and spawns agents.
- **No overlap between agents.** Each agent must declare `owns`: the workspace paths it may write (or `[]` for read-only). The server rejects a claim that overlaps any running agent, across all tasks. This catches supervisor mistakes and tells the agent its boundary; it is not a sandbox.
- **No global agent cap, but you are told.** Each spawn burst raises a notice ("T2 is starting 2 subagents. 4 agents running now across 2 tasks.") and the header always shows the live total. Every agent is a full Claude Code process using your usage budget.
- **Only supervisors set task statuses.** Agents only keep their own checklist (shown on their card) and send a final report; the owning supervisor is woken when they finish.
- **Open points** from the plan are passed to every agent as "non-blocking, keep it flexible".
- Agent panels are read-only (live activity log, checklist, report). The only control is *Stop*.

## Config (`config.json`)

| key | meaning |
| --- | --- |
| `workspace` | folder where all supervisors and agents work (default `./workspace`) |
| `permissionMode` | `acceptEdits` by default; headless agents cannot answer prompts |
| `tools` | built-in tools every supervisor/agent gets (default: Bash, Read, Write, Edit, Glob, Grep). `Bash` makes this effectively full access to your user account. Keep it short: see *Token usage* |
| `maxAgentsPerTask` | cap on agents running at once for ONE task (there is no global cap) |
| `supervisorModel`, `agentModel` | model for task supervisors / default for agents (`null` = CLI default). A supervisor can still pick `haiku`/`sonnet`/`opus` per agent |
| `generalModel` | model for the read-only General chat (default `haiku`) |

Environment overrides (to run a second, isolated instance): `AGENT_MANAGER_DATA`, `AGENT_MANAGER_PORT`, `AGENT_MANAGER_WORKSPACE`.

## Token usage

Every request re-sends the whole context, and every `claude` process starts cold, so the defaults are tuned for it (measured on a trivial "introduce yourself" run):

- **Only 6 built-in tools** (`--tools`). Claude Code ships ~30 tool schemas; sending them cost ~24k input tokens on *every* request (33k down to 9k for a one-request agent). Web tools are opt-in per agent (`web: true`).
- **Headless runs ignore your personal hooks/plugins** (`--setting-sources project`) and share a stable prompt prefix for caching (`--exclude-dynamic-system-prompt-sections`).
- **Cheapest model that works.** Supervisors choose `haiku` for trivial work, `sonnet` by default, `opus` only for hard or high-accuracy jobs; General chat runs on Haiku.
- **Fewer round trips.** `spawn_subagent` creates the subtask itself (no separate `create_task`), agents skip their checklist on 1-2 step jobs, and reports are capped at ~100 words.
- **See it.** Token totals show in the header, on each task, and on each agent (hover for the split and the API-equivalent cost, which is informational on a subscription).

A 3-agent "introduce yourself" scenario went from roughly 450k+ input tokens to about 84k.

State lives in `data/state.json` (gitignored). Agents running when the server stops are marked interrupted on the next start.

Note: every spawned `claude` also runs your own Claude Code hooks/plugins from `~/.claude`, which may write files into the workspace.
