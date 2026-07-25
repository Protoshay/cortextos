---
name: worker-agents
description: "You have a task that would benefit from running in a separate isolated Claude Code session — either because it is long-running and you do not want it to consume your context window, or because you want multiple pieces of work running in parallel that each require a full Claude Code session with its own tools, memory, and context (not just a subagent call). You will spawn one or more ephemeral worker sessions, give each a focused task, monitor their progress via the bus, and collect their outputs when done."
triggers: ["worker", "parallelize", "spawn worker", "spin up", "parallel work", "background task", "isolated session", "separate session", "long running task", "run in background", "parallel research", "multiple workers", "worker session", "spawn session", "full claude code session", "context window", "parallel tasks", "run simultaneously", "independent sessions"]
---

# Worker Agents

> Spawn ephemeral Claude Code sessions for parallelized long-running tasks. Workers get a scoped task, produce deliverables, and are cleaned up when done. Use when work requires a full independent Claude Code session — not just a subagent tool call.

> Worker session spawn is fully implemented. Use `cortextos spawn-worker` to launch isolated Claude Code sessions for parallelized tasks.

---

## When to Use

**Good fit:**
- Independent work that does not touch files another agent is editing
- Research or design docs in a new directory
- Scaffolding a new feature in isolation
- Any task > 5 minutes that can run while you do other work

**Bad fit:**
- Editing files another agent or worker is actively touching (merge conflicts)
- Tasks needing real-time back-and-forth (just do it yourself)
- Very short tasks < 2 minutes (overhead not worth it)

---

## How Workers Differ from Persistent Agents

| | Persistent Agent | Worker Agent |
|---|---|---|
| Lifetime | 24/7, survives restarts | Dies when task is done |
| Identity | IDENTITY.md, SOUL.md, GOALS.md | None — just a task prompt |
| Heartbeat | Updates every 4h | None |
| Crons | config.json scheduled tasks | None |
| Inbox | Bus messages via check-inbox | Bus messages (optional) |
| Telegram | Yes | No |
| Memory | Daily journals, MEMORY.md | None |

---

## Workflow (Concepts — Implementation TBD)

### Step 1: Scope the Work

Before spawning, answer:
1. What specific deliverables should the worker produce?
2. Which files/directories will it create or modify?
3. Does this overlap with any active agent or worker? **If yes, do NOT parallelize.**
4. What context does the worker need?

### Step 2: Spawn Worker Session

```bash
cortextos spawn-worker <worker-name> \
  --dir <absolute-path-to-project-dir> \
  --prompt "Read AGENTS.md for your task. Deliverables: <list>. When done: cortextos bus send-message $CTX_AGENT_NAME normal 'Done: <summary>'" \
  --parent $CTX_AGENT_NAME
```

The worker:
- Runs `claude --dangerously-skip-permissions` in the given directory
- Gets a bus identity (`CTX_AGENT_NAME=<worker-name>`) for two-way communication
- Logs to `~/.cortextos/<instance>/logs/<worker-name>/stdout.log`
- Is tracked by the daemon — use `cortextos list-workers` to monitor status

### Step 3: Inject Task Prompt

A good worker task prompt includes:
- Exact deliverables (specific files or outputs to produce)
- What NOT to touch (files other agents own)
- Working directory scope
- How to communicate back (`cortextos bus send-message <parent> normal '<update>'`)
- Completion signal ("when done, send me a summary")

### Step 4: Log the Spawn

```bash
cortextos bus log-event action worker_spawned info \
  --meta '{"worker":"<worker-name>","parent":"'$CTX_AGENT_NAME'","task":"<title>"}'
```

### Step 5: Monitor

Workers communicate back via the bus. Check your inbox:

```bash
cortextos bus check-inbox
```

Check all worker statuses:
```bash
cortextos list-workers
# Output: worker-name  running (pid 12345) ← parent-agent  42s  /path/to/dir
```

Check git progress in the worker's directory:
```bash
cd <work-dir> && git log --oneline | head -5
```

Nudge a stuck worker (equivalent of tmux send-keys):
```bash
cortextos inject-worker <worker-name> "Continue with phase 3. What's blocking you?"
```

### Step 6: Cleanup

```bash
# Terminate a running worker
cortextos terminate-worker <worker-name>

# Log completion
cortextos bus log-event action worker_completed info \
  --meta '{"worker":"<worker-name>","deliverables":"<summary>"}'
```

---

## Scaling Rules

| Workers | Risk | Notes |
|---------|------|-------|
| 1-2 | Low | Safe for most tasks |
| 3-4 | Medium | Ensure zero file overlap |
| 5+ | High | Resource contention, monitor closely |

**Hard rules:**
- NEVER spawn workers for overlapping file sets
- NEVER let workers modify files you or other agents are editing
- ALWAYS log spawns and completions
- Workers should NOT spawn their own workers (no worker-ception)

---


## Isolation Safety — MANDATORY (added 2026-07-24 after a main-contamination near-miss)

**Incident:** a code worker launched with `Agent(isolation:"worktree")` did NOT get an isolated worktree, ran in the real `/root/cortextos` checkout, committed onto `main`, and its `npm run build` overwrote the live `dist/`. Caught after the fact. (See MISTAKES_LOG 2026-07-24.) **Never trust that isolation held — verify it, structurally, at both ends.**

### Rule 1 — Worker self-asserts its location (put this in EVERY code-worker brief)
The worker's FIRST commands must be:
```bash
pwd
git rev-parse --show-toplevel
git rev-parse --abbrev-ref HEAD
```
Then assert the toplevel is an **isolated worktree**, not the main checkout: the path must contain `.claude/worktrees/agent-`, or the branch must match `worktree-agent-*`. If it resolves to the main repo root (`/root/cortextos`) or the branch is `main`, the worker must **STOP and report — do NOT commit, do NOT run `npm run build`.**

### Rule 2 — Parent diffs the main tip before/after EVERY code-worker run (make the catch structural)
Before launching any code worker, record the target repo's main tip:
```bash
git -C /root/cortextos rev-parse main   # record BASE (e.g. 743cb66)
```
After the worker completes, re-check BOTH:
```bash
git -C /root/cortextos rev-parse main     # must equal BASE
git -C /root/cortextos worktree list      # worker must be on worktree-agent-*, NOT main
```
Also confirm the completion notification carried a `<worktree>` tag / `worktreePath` — its **absence** signals isolation did NOT provision. If `main` advanced, or `dist/daemon.js` mtime changed, without authorization → the worker contaminated shared state.

### Recovery if contaminated
1. `git branch <preserve-name> <worker-commit>` FIRST — additive/safe, preserves the work.
2. Flag skiffy with the blast radius (main tip, dist state, whether the running daemon is affected).
3. Only on skiffy's **explicit** go: `git reset --hard <base>` + `npm run build` to restore the gated dist. Reset (not revert) so a nightly merge isn't poisoned by a revert/re-apply tangle — but `reset --hard` on shared main is destructive and requires skiffy's explicit authorization **every time**.
4. Verify after: main tip = base; `grep -c` new symbols in `dist/daemon.js` = 0; `sanitizeForPtyInjection` still present in dist (canonical-branch discipline); preserved branch still at the worker commit.

### Why this matters
`scout`'s cwd lives inside the main repo, so any worker that does NOT get an isolated worktree defaults to operating on live main + dist. On the next daemon restart that ungated dist would load unreviewed — defeating the entire gate-review process, which depends on code changes staying on a branch until skiffy gates them.
