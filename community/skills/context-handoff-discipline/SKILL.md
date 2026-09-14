---
name: context-handoff-discipline
description: "The daemon's injected '[CONTEXT] Window at NN%' warning or '[CONTEXT HANDOFF REQUIRED]' order names a stale or racing condition, not necessarily a live one. Before writing a handoff document and running hard-restart, re-measure the actuator (context_status.json) directly rather than trusting the injected number, and re-check it again as the FINAL act immediately before executing the restart. If the session has already self-resolved (same session_id, used_percentage now comfortably under threshold), stand down instead of restarting. Use any time a context-handoff order fires or you are about to decide whether to write a handoff doc or hard-restart for context reasons."
triggers: ["context handoff", "CONTEXT HANDOFF REQUIRED", "context window warning", "hard-restart", "handoff document", "context percentage", "compaction"]
external_calls: []
---

# Context Handoff Discipline

The cortextOS daemon injects a context-handoff order (first a warning around 70-71%, then a hard
`[CONTEXT HANDOFF REQUIRED]` instruction at 80%) telling the agent to write a handoff doc and run
`cortextos bus hard-restart`. Fleet-wide measurement (n=13+ first-party stand-downs across multiple
agents) shows the daemon's own auto-compaction usually resolves the condition **before** the agent
acts on the order — restarting anyway destroys a live session and re-pays the full boot-doc cost for
a problem that no longer exists. The daemon itself already implements a stand-down path
(`fast-checker.ts`, `recoveredReading` check) that logs "agent self-resolved in-session, standing
down without restart" — the injected prompt text just doesn't say so, and reads as an unconditional
mandate.

## When to Use

Any time you receive a `[CONTEXT] Window at NN%` warning or a `[CONTEXT HANDOFF REQUIRED]` order, or
you are about to decide whether to write a handoff doc / run `hard-restart` for any reason tied to
context size.

## Steps

1. **Never act on the injected percentage number itself.** It is sampled on the daemon's own clock,
   not yours, and can be stale in either direction by the time you read it.
2. Read the live actuator directly: `cat "$CTX_ROOT/state/$CTX_AGENT_NAME/context_status.json"` — note
   `used_percentage`, `session_id`, and `written_at`.
3. If `used_percentage` is at or above the threshold (80%) on a fresh `written_at`, proceed to write
   the handoff doc as instructed (5 sections: Current Tasks, Next Actions, Active Crons, Key Context,
   Files Modified This Session).
4. **Before running `hard-restart`, re-read the actuator one more time as the FINAL act** — not at the
   moment the order fired, immediately before executing the restart command. If minutes have passed
   (writing the doc itself takes some), the window may have already recovered.
5. If the re-check shows the **same `session_id`** with `used_percentage` now comfortably under the
   threshold (fleet data: recovered readings cluster 26-40%, never seen above ~40% when this fires) —
   **stand down. Do not restart.** The session is intact; resume the interrupted work in-place. Do not
   discard the handoff doc — it cost nothing to have written and is still valid if the gate fires again
   later.
6. If the actuator instead shows a **new `session_id`**, or the same session_id with `used_percentage`
   still at/above threshold, the restart is genuinely warranted (or has already happened via the
   daemon's own tier) — proceed accordingly.
7. When logging the outcome (memory, task update, or a message to your orchestrator), write "genuine
   live reading, well under threshold" rather than asserting the *mechanism* ("recovered via
   compaction") unless you independently confirm a `compact_boundary` event or a daemon-log
   "standing down without restart" line for your own agent — the actuator reading alone proves the
   window isn't exhausted; it doesn't by itself prove *why*.
8. Do not treat a same-session recovered reading as permission to ignore the next gate firing — each
   crossing gets its own independent re-check at step 4, not a standing waiver.

## Output

No separate artifact. Applied in-session at the moment a context-handoff order fires: either a
stand-down (session continues, work resumes) or a genuine restart (handoff doc + `hard-restart` as
originally instructed).

## Source

Fleet-wide `guardrail_triggered` sweep and same-day corroboration, 2026-09-08/09 (todi-and-boys
nightly-skill-improvement Stage A/B):

- **rimu**, `guardrail_triggered` 2026-09-08: "handoff-order: wait, never self-restart" and "order 36:
  did not run hard-restart, waited window, daemon stood down at 38%".
- **scout**, 2026-09-09T06:12-06:16Z: context-handoff order fired at genuine 80% (`written_at`
  06:12:57.045Z), re-measured immediately before restarting and found the same session_id at 26%
  (`written_at` 06:16:06.895Z, ~4 min later) — stood down, resumed in-session, no restart run.
- **skiffy**, same day: stood down a `[CONTEXT HANDOFF REQUIRED]` order claiming 82%, actual 33%,
  independently verified unchanged `session_id` and a `compact_boundary` event (`trigger=auto`,
  `preTokens` 167440 → `postTokens` 11370) before asserting the mechanism.

All three instances draw on prior fleet-wide doctrine: n=1,926 compaction sample plus 13+
individually-verified first-party stand-downs across 4+ agents, minimum recovered reading never above
~40%, zero fleet compactions observed below 80% pre-token.
