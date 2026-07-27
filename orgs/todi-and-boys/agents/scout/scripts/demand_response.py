#!/usr/bin/env python3
"""
DEMAND/RESPONSE WEDGE DETECTOR  (shadow / read-and-print only)

WHY THIS EXISTS — the three-signal detector cannot be fixed.
Its signals (cpu, session_write, context_gate) are all ABSENCE signals: they
measure that the agent is NOT doing something. They have unbounded healthy
distributions (measured 27 Jul: healthy session_write staleness went 776s ->
2213s in 26 minutes and was still climbing) and, worse, a COMMON CAUSE.
skiffy: "they are not three independent witnesses, they are one witness --
the agent is not doing anything -- reported three times."
An all-absence instrument has NO KNOWN-POSITIVE, and no known-positive means
no validation, ever.

THE SHAPE INSTEAD: record an event that created an OBLIGATION (a DEMAND), then
look for an artefact the agent PRODUCED afterwards (a RESPONSE).
An idle agent has no obligation, so IDLENESS IS EXCLUDED BY CONSTRUCTION
rather than by a threshold -- the exact discrimination CPU and session-write
can never make.

  DEMAND   = a delivery in  <ctxRoot>/processed/<agent>/
             keyed on ctime (stat st_ctime), NEVER mtime: the file is moved
             from inbox/ on ACK and `mv` PRESERVES MTIME. mtime is the time the
             sender wrote it; ctime is the time it was delivered. Measured
             delta on a live file: 268ms. On a redelivery it is much larger.
  RESPONSE = an artefact written by a process THE AGENT ITSELF RAN.

THE WRITERS CHECK (done at source -- this is what makes or breaks the tool;
a counterfeitable response signal makes the instrument WORSE THAN NOTHING,
because it fails toward "healthy" exactly when the subject is wedged):

  .last-send                      PASSES. stampLastSend (bus/message.ts:100) is
                                  module-private with exactly ONE caller,
                                  sendMessage:90, resolved in the CLI process
                                  the agent itself ran.
  outbound-messages.jsonl         PASSES ONLY WITH A FILTER. Two writers:
                                  (a) cli/bus.ts:1031 via logOutboundMessage --
                                      the agent's own `bus send-telegram`. Valid.
                                  (b) cli/bus.ts:1680 -- the `mobile-reply`
                                      command, which writes under the AGENT's
                                      name when a HUMAN replies from the iOS
                                      app. COUNTERFEIT. It is distinguishable:
                                      those entries carry message_id
                                      "mobile-reply-*", so they are excluded
                                      below. daemon/agent-manager.ts imports
                                      logOutboundMessage at :14 but NEVER CALLS
                                      it -- a dead import, and a latent hazard
                                      if anyone ever wires it up.
  analytics/events/<agent>/*.jsonl REJECTED -- COUNTERFEITABLE, do not use.
                                  telegram/logging.ts:109 logs
                                  'telegram_received' under the agent's name
                                  from daemon/agent-manager.ts:336 -- the
                                  DAEMON, on message ARRIVAL, before the agent
                                  does anything. A wedged agent that merely gets
                                  texted appends to its own log. That is the
                                  precise false negative that would hide the
                                  wedge we are hunting.
  heartbeat.json                  REJECTED -- actively counterfeit. fast-checker
                                  refreshes last_heartbeat on a timer regardless
                                  of REPL state (now in-process
                                  refreshHeartbeatTimestamp, bus/event.ts:82).

VERDICTS
  RESPONDED      response after the demand. Healthy, and PROVEN so -- this is a
                 real positive observation, not an absence.
  NO_DEMAND      no delivery on record. NOT healthy: excluded by construction.
                 An idle agent lands here, which is the entire point.
  CENSORED       could not read a required input. Never scored as healthy, and
                 makes WEDGED unreachable (same rule as the coverage sweep).
  PENDING        demand outstanding but younger than the grace window.
  WEDGED         demand older than the grace window with no response after it.

KNOWN BLIND SPOT -- SHIPPED IN THE SAME BREATH AS THE SIGNAL, NOT AFTER IT.
An agent whose demand arrived as a CRON produces no processed/ delivery at all,
so no demand is recorded and this detector is silent for it. It cannot false-
positive there; it simply cannot see it. `--blind-spot` measures the size of
that hole rather than asserting it is small.

SHADOW ONLY. Read-and-print. It never restarts anything, and a verdict from it
is not an action. Cutover is a decision, not a drift.
"""

import argparse
import json
import os
import sys
import time

CTX_ROOT = "/root/.cortextos/default"


def newest_demand(agent, inject=None):
    """Newest delivery ctime in processed/<agent>/. Returns (ts, label)."""
    if inject and "demand" in inject:
        return inject["demand"], "INJ"
    d = os.path.join(CTX_ROOT, "processed", agent)
    if not os.path.isdir(d):
        return None, "no processed/ dir"
    newest, name = None, None
    try:
        for fn in os.listdir(d):
            if not fn.endswith(".json"):
                continue
            p = os.path.join(d, fn)
            try:
                # ctime = when it was MOVED here (delivery). mtime is the
                # sender's write time and `mv` preserves it -- using mtime
                # would silently age every demand backwards.
                c = os.stat(p).st_ctime
            except (FileNotFoundError, PermissionError):
                continue
            if newest is None or c > newest:
                newest, name = c, fn
    except (FileNotFoundError, PermissionError) as e:
        raise
    return newest, name


def newest_response(agent, inject=None):
    """max(.last-send, legit outbound telegram). Returns (ts, which)."""
    if inject and "response" in inject:
        return inject["response"], "INJ"
    best, which = None, None

    ls = os.path.join(CTX_ROOT, "state", agent, ".last-send")
    try:
        if os.path.exists(ls):
            # File CONTENT is epoch ms, written by the agent's own CLI.
            # Prefer content over mtime: mtime would also move if anything
            # ever touched the file without the agent sending.
            raw = open(ls).read().strip()
            ts = int(raw) / 1000.0 if raw.isdigit() else os.path.getmtime(ls)
            best, which = ts, ".last-send"
    except (OSError, ValueError):
        pass

    ob = os.path.join(CTX_ROOT, "logs", agent, "outbound-messages.jsonl")
    try:
        if os.path.exists(ob):
            with open(ob, errors="replace") as fh:
                lines = fh.readlines()
            for line in reversed(lines[-400:]):
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                # EXCLUDE the counterfeit writer (human via iOS mobile-reply).
                if str(e.get("message_id", "")).startswith("mobile-reply-"):
                    continue
                t = e.get("timestamp")
                if not t:
                    continue
                try:
                    ts = time.mktime(time.strptime(t, "%Y-%m-%dT%H:%M:%SZ")) - time.timezone
                except ValueError:
                    continue
                if best is None or ts > best:
                    best, which = ts, "outbound"
                break
    except OSError:
        pass
    return best, which


ORGS_ROOT = "/root/cortextos/orgs"


def runtime_of(agent):
    """Agent runtime from orgs/<org>/agents/<agent>/config.json.

    FOUND BY RUNNING IT: the first version read state/<agent>/config.json,
    which DOES NOT EXIST. It therefore returned None for every agent and
    defaulted the whole fleet to 'claude' -- so the exclude-by-class guard
    silently protected nobody, and otis was scored on claude-shaped rules.
    A missing config must not be readable as a runtime.
    """
    try:
        for org in os.listdir(ORGS_ROOT):
            p = os.path.join(ORGS_ROOT, org, "agents", agent, "config.json")
            if os.path.exists(p):
                return (json.load(open(p)) or {}).get("runtime") or "claude-code"
    except (OSError, json.JSONDecodeError):
        pass
    return None  # unknown -- NOT silently 'claude'


def live_pids_by_agent():
    """agent -> pid for direct children of the daemon.

    Liveness is a PRECONDITION, not a signal. Without it a non-existent agent
    (sazed: enabled in json, no agent dir, no process) reads as WEDGED forever,
    because it has an ancient unanswered demand and will never respond. That is
    a DOWN agent, and telling anyone to restart it is the false positive that
    would discredit the whole instrument.

    Enumerated as DIRECT CHILDREN OF THE DAEMON + CTX_AGENT_NAME, never
    `pgrep -f 'claude|codex'`: that matches every bash child sourcing
    /root/.claude/shell-snapshots/* because the PATH contains '.claude'
    (measured 27 Jul: 16 processes vs a true 12). CTX_AGENT_NAME alone is also
    insufficient -- child shells INHERIT it; it only discriminates because the
    ppid filter already removed them.
    """
    out = {}
    dpid = None
    try:
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                cl = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode()
            except OSError:
                continue
            if "dist/daemon.js" in cl:
                dpid = int(pid)
                break
    except OSError:
        return out
    if dpid is None:
        return out
    try:
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                stat = open(f"/proc/{pid}/stat").read()
                ppid = int(stat[stat.rindex(")") + 2:].split()[1])
                if ppid != dpid:
                    continue
                env = open(f"/proc/{pid}/environ", "rb").read().decode(errors="replace")
            except (OSError, ValueError, IndexError):
                continue
            for kv in env.split("\0"):
                if kv.startswith("CTX_AGENT_NAME="):
                    out[kv.split("=", 1)[1]] = int(pid)
    except OSError:
        pass
    return out


def evaluate(agent, grace, now, inject=None, live=None):
    # LIVENESS IS A PRECONDITION, CHECKED BEFORE ANYTHING ELSE.
    # A wedge means "alive but not responding". An agent with no process is
    # DOWN, which is a different problem with a different owner. Without this
    # gate sazed -- enabled in json, no agent directory, no process -- scored
    # WEDGED on a 32-day-old unanswered demand on the very first real run.
    if live is not None and inject is None and agent not in live:
        return "DOWN", "no live process (not a wedge -- cannot be one)", None, None

    try:
        demand, dname = newest_demand(agent, inject)
    except (PermissionError, OSError) as e:
        return "CENSORED", f"demand unreadable ({type(e).__name__})", None, None
    resp, rwhich = newest_response(agent, inject)

    if demand is None:
        return "NO_DEMAND", dname or "no deliveries on record", None, resp
    age = now - demand
    if resp is not None and resp >= demand:
        return "RESPONDED", f"responded via {rwhich} {int(resp-demand)}s after demand", age, resp
    if age < grace:
        return "PENDING", f"demand {int(age)}s old, inside {int(grace)}s grace", age, resp
    return "WEDGED", f"demand {int(age)}s old, no response since", age, resp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--grace-seconds", type=float, default=1800)
    ap.add_argument("--agents", default=None, help="comma list; default = all with a processed/ dir")
    ap.add_argument("--inject", action="append", default=[],
                    help="agent:demand=<epoch|now-Ns>,response=<epoch|now-Ns|none>")
    ap.add_argument("--blind-spot", action="store_true",
                    help="measure how many agents this detector is structurally blind to")
    a = ap.parse_args()

    now = time.time()

    inj = {}
    for spec in a.inject:
        agent, _, rest = spec.partition(":")
        d = {}
        for part in rest.split(","):
            if not part:
                continue
            k, _, v = part.partition("=")
            if v == "none":
                d[k] = None
            elif v.startswith("now-") and v.endswith("s"):
                d[k] = now - float(v[4:-1])
            else:
                d[k] = float(v)
        inj[agent] = d

    if a.agents:
        agents = [x for x in a.agents.split(",") if x]
    else:
        pd = os.path.join(CTX_ROOT, "processed")
        agents = sorted(d for d in os.listdir(pd) if os.path.isdir(os.path.join(pd, d)))

    live = live_pids_by_agent()

    print(f"{'agent':9} {'runtime':8} {'verdict':10} detail")
    print("-" * 88)
    counts = {}
    for ag in agents:
        rt = runtime_of(ag)
        if rt == "codex-app-server":
            # Excluded BY CLASS, never by name. A named single-agent exception
            # is exactly the row the next tidy-up removes, comment or no comment.
            print(f"{ag:9} {'codex':8} {'N/A':10} codex runtime: excluded by class")
            counts["N/A"] = counts.get("N/A", 0) + 1
            continue
        v, detail, age, resp = evaluate(ag, a.grace_seconds, now, inj.get(ag), live)
        tag = "[INJ]" if ag in inj else ""
        print(f"{ag:9} {'claude':8} {v:10} {detail} {tag}")
        counts[v] = counts.get(v, 0) + 1

    print("\nSUMMARY: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    wedged = counts.get("WEDGED", 0)
    print(f"WEDGED: {wedged}" + ("  <-- INVESTIGATE (shadow only; do NOT restart off this)" if wedged else ""))

    if a.blind_spot:
        print("\n--- BLIND SPOT (measured, not asserted) ---")
        tot = blind = 0
        for ag in agents:
            if runtime_of(ag) == "codex-app-server":
                continue
            tot += 1
            d, _ = newest_demand(ag)
            if d is None or (now - d) > 86400:
                blind += 1
        print(f"{blind}/{tot} claude agents have no demand on record in the last 24h.")
        print("For those agents this detector is STRUCTURALLY SILENT: their work arrives")
        print("by cron, which creates no processed/ delivery. It cannot false-positive")
        print("there -- it simply cannot see them. That is the disclosed hole, and it is")
        print("the price of refusing the counterfeitable events log.")


if __name__ == "__main__":
    sys.exit(main())
