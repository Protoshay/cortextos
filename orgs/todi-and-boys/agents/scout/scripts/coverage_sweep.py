#!/usr/bin/env python3
"""
Signal-coverage matrix sweep  (scout, 2026-07-27)

Produces an explicit agent x signal matrix. Every cell is exactly one of:

    APPLIED(value)   the signal genuinely applies to this agent and was read
    N/A(reason)      the signal STRUCTURALLY cannot apply to this agent
    FAILED(error)    the signal SHOULD have applied and errored  <-- a BUG, not a limit
    CENSORED(reason) the subject disappeared mid-measurement      <-- neither of the above

Why this exists
---------------
The wedge verdict requires TWO concurring signals (one over-triggers; proven 27 Jul).
So an agent with fewer than two APPLICABLE signals CANNOT be declared wedged by
construction -- "healthy" for that agent is an artefact of the arithmetic, the only
verdict the instrument can physically emit. That is the `UNDER-INSTRUMENTED` verdict.
The threshold of 2 is derived from the wedge rule; it is NOT a tuned heuristic.

FAILED must never collapse into N/A. N/A is a known structural limit; FAILED is a bug.
Collapsing them rebuilds the "no data scores as healthy" sink one level up with
better labelling.

CENSORED (D5, fixed 2026-07-27) must collapse into NEITHER. A process that vanishes
between the two CPU samples has been RESTARTED, not broken: rocky's pid was 25s old
when it went, and skiffy's went mid-sample during his announced context handoff --
twice in one hour, which makes it a defect in the instrument rather than an incident.
Filing it under FAILED accuses the daemon of a bug every time an agent restarts on
schedule, and the FAILED bucket's own banner says "these are BUGS".

skiffy's ruling on what kind of value it is: a CENSORED OBSERVATION carrying a LOWER
BOUND -- the agent was alive for at least the part of the window it was present for,
and we do not know the rest. It is not a measurement and must never be averaged in.
It scores as NOT APPLIED, so it lowers the judgeable-signal count and degrades the
verdict toward UNDER-INSTRUMENTED. That is the honest direction: a restart is the one
moment we can say least about, and a restarting agent must never read as WEDGED --
the remedy for WEDGED is a restart, which it has just had.

Applicability is decided by RUNTIME, never by file presence and never by a name list.
  - Name lists: hardcoding "otis" re-opens the hole the moment a second codex agent boots.
  - File presence: otis HAS a context_status.json. It reads used_percentage=100 off a
    cumulative token counter and never returns. Present != applicable.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

STATE = Path("/root/.cortextos/default/state")
CLAUDE_PROJECTS = Path("/root/.claude/projects")
SIGNALS = ["cpu", "session_write", "context_gate"]

APPLIED, NA, FAILED, CENSORED = "APPLIED", "N/A", "FAILED", "CENSORED"

# Wedge verdict needs two concurring signals, so two is the minimum judgeable coverage.
MIN_JUDGEABLE_SIGNALS = 2
# D4 (2026-07-27): this was a FIXED 300s constant, which the durable sweep rule
# explicitly forbids -- "against a LIVE CONTROL in the same sweep, never a fixed
# constant". Third instance of re-deriving a threshold I was supposed to inherit
# (cf. the 20s floor, and WEDGED at >=2). Caught by the shadow diff, cycle 2: zig
# flipped from not-fired at 103s to fired at 332s by crossing an arbitrary line,
# while the live control sat at 5s the whole time.
#
# NOTE the deeper problem, unresolved and flagged to skiffy rather than invented:
# session_write staleness is UNBOUNDED for a healthy idle agent exactly as CPU is
# (rimu, healthy, 1311s). So this signal has no safe absolute threshold either, and
# the durable rule does not specify a RATIO. Reported as a ratio to the live control;
# the firing multiple is deliberately conservative and is NOT presented as derived.
STALE_WRITE_RATIO = 20.0
STALE_WRITE_MIN_SECONDS = 300

# MEASUREMENT SANITY ONLY -- this is NOT a safety threshold, and it cannot be one.
#
# Measured 2026-07-27 (scripts/measure_idle_jiffy_gaps.py, 240s @1s over 12 agents):
# actively-working agents increment every 1-12s, but mason -- heartbeat 11:10:25Z,
# memory written 11:10:35Z, unambiguously HEALTHY -- was CPU-silent for 224s and still
# counting when the run ended. An agent blocked waiting on input consumes no CPU, so
# the healthy quiet period is UNBOUNDED and no floor exists above it.
#
# The earlier 20s floor was 22 rounded down, fitted to a single observation. It would
# NOT have prevented D2: at any window under 224s mason reads 0 jiffies.
#
# There is therefore no window at which cpu-alone distinguishes idle from frozen. The
# real protection is the all-three-signals rule below, not this number.
MIN_CPU_SAMPLE_SECONDS = 20


class Cell:
    __slots__ = ("state", "value", "reason", "fired", "age")

    def __init__(self, state, value=None, reason=None, fired=False):
        self.state, self.value, self.reason, self.fired = state, value, reason, fired
        self.age = None

    def render(self):
        if self.state == APPLIED:
            return f"APPLIED({self.value})" + ("!" if self.fired else "")
        if self.state == NA:
            return f"N/A({self.reason})"
        if self.state == CENSORED:
            return f"CENSORED({self.reason})"
        return f"**FAILED({self.reason})**"


# ---------------------------------------------------------------- enumeration

def detect_runtime(pid):
    """Runtime from /proc/PID/cmdline. Returns 'claude' | 'codex' | None.

    Deliberately inspects argv[0] (and argv[1] for node) by BASENAME. A naive
    substring test for 'claude' over the whole cmdline matches every bash process
    that sources a snapshot out of /root/.claude/, which silently injects phantom
    agents into the sweep.
    """
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except (OSError, IOError):
        return None
    argv = [a for a in raw.decode("utf-8", "replace").split("\0") if a]
    if not argv:
        return None

    def base(p):
        return os.path.basename(p)

    b0 = base(argv[0])
    if b0 == "claude":
        return "claude"
    if b0.startswith("codex"):
        return "codex"
    if b0 in ("node", "nodejs") and len(argv) > 1 and base(argv[1]).startswith("codex"):
        return "codex"
    return None


def agent_from_cwd(pid, roster):
    try:
        cwd = os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return None
    parts = cwd.strip("/").split("/")
    for anchor in ("agents", "state"):
        if anchor in parts:
            i = parts.index(anchor)
            if i + 1 < len(parts):
                cand = parts[i + 1]
                if cand in roster:
                    return cand
    return None


def get_roster():
    out = subprocess.run(
        ["cortextos", "bus", "list-agents", "--format", "json"],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"list-agents failed: {out.stderr[:200]}")
    return json.loads(out.stdout)


def enumerate_processes(roster_names):
    """agent -> {'runtime': str, 'pids': [int]}"""
    pg = subprocess.run(["pgrep", "-f", "claude|codex"], capture_output=True, text=True)
    found = {}
    for line in pg.stdout.split():
        pid = int(line)
        runtime = detect_runtime(pid)
        if runtime is None:
            continue
        agent = agent_from_cwd(pid, roster_names)
        if agent is None:
            continue
        e = found.setdefault(agent, {"runtime": runtime, "pids": []})
        e["pids"].append(pid)
    return found


# ------------------------------------------------------------------- signals

def cpu_jiffies(pids):
    total = 0
    for pid in pids:
        s = Path(f"/proc/{pid}/stat").read_text()
        rest = s[s.rindex(")") + 2:].split()
        total += int(rest[11]) + int(rest[12])  # utime + stime
    return total


def mangled_project_dir(agent, cwd_hint=None):
    for d in CLAUDE_PROJECTS.iterdir():
        if d.is_dir() and d.name.endswith(f"-agents-{agent}"):
            return d
    return None


def newest_jsonl_age(d, now):
    newest = None
    for f in d.glob("*.jsonl"):
        m = f.stat().st_mtime
        if newest is None or m > newest:
            newest = m
    if newest is None:
        return None
    return now - newest


# ---------------------------------------------------------------- the sweep

def build_matrix(roster, procs, sample_seconds, inject):
    matrix = {}

    def injected(agent, sig):
        return inject.get((agent, sig))

    # --- CPU needs two samples; take the first for every agent before sleeping.
    first = {}
    for a, info in procs.items():
        try:
            first[a] = cpu_jiffies(info["pids"])
        except Exception as e:
            first[a] = e
        # 'vanished' is injected HERE, not as a pre-built Cell, so the real except
        # clause in the cpu branch is what runs. A control that hand-builds the
        # outcome tests the label, not the code path that produces it.
        if inject.get((a, "cpu")) == "vanished":
            first[a] = FileNotFoundError("[INJ] /proc/<pid>/stat")

    if procs:
        time.sleep(sample_seconds)

    # Capture the clock AFTER the CPU sample window. Taking it before makes every
    # session_write age short by up to sample_seconds and can render it negative --
    # an error that biases staleness DOWNWARD, i.e. toward reporting healthy.
    now = time.time()

    for entry in roster:
        agent = entry["name"]
        cells = {}
        info = procs.get(agent)

        if info is None:
            # Enabled but no live runtime process. This is DETERMINATE (down), not a
            # coverage gap -- do not let it become UNDER-INSTRUMENTED.
            for s in SIGNALS:
                cells[s] = Cell(NA, reason="no live process")
            matrix[agent] = {"runtime": None, "cells": cells,
                             "verdict": "DOWN" if entry.get("enabled") else "DISABLED"}
            continue

        runtime = info["runtime"]

        # ---- signal 1: cpu (applies to every runtime)
        inj = injected(agent, "cpu")
        if inj == "missing":
            cells["cpu"] = Cell(NA, reason="INJECTED unavailable")
        elif inj == "error":
            cells["cpu"] = Cell(FAILED, reason="INJECTED error")
        elif inj == "fired":
            cells["cpu"] = Cell(APPLIED, value="0j[INJ]", fired=True)
        elif inj == "quiet":
            cells["cpu"] = Cell(APPLIED, value="q[INJ]", fired=False)
        elif sample_seconds < MIN_CPU_SAMPLE_SECONDS:
            # Below the floor the signal cannot discriminate idle-healthy from frozen,
            # so it does not apply. Degrade to UNDER-INSTRUMENTED, never to WEDGED.
            cells["cpu"] = Cell(NA, reason=f"sample window {sample_seconds}s < "
                                           f"{MIN_CPU_SAMPLE_SECONDS}s, cannot discriminate")
        else:
            try:
                f = first.get(agent)
                if isinstance(f, Exception):
                    raise f
                delta = cpu_jiffies(info["pids"]) - f
                cells["cpu"] = Cell(APPLIED, value=f"{delta}j", fired=(delta == 0))
            except (FileNotFoundError, ProcessLookupError):
                # The pid went away between the two samples -- the agent restarted.
                # NOT a failed read: /proc/<pid>/stat is missing because the subject
                # is gone, not because the instrument broke. See the CENSORED note
                # in the module docstring.
                cells["cpu"] = Cell(CENSORED,
                                    reason=f"pid vanished during {sample_seconds}s window")
            except Exception as e:
                cells["cpu"] = Cell(FAILED, reason=type(e).__name__)

        # ---- signal 2: session_write (claude only)
        inj = injected(agent, "session_write")
        if inj == "missing":
            cells["session_write"] = Cell(NA, reason="INJECTED unavailable")
        elif inj == "error":
            cells["session_write"] = Cell(FAILED, reason="INJECTED error")
        elif inj == "fired":
            # age deliberately left None: a synthetic value must never enter the
            # live-control min() in the second pass, and leaving age None also stops
            # that pass overwriting this injected fired flag.
            cells["session_write"] = Cell(APPLIED, value="stale[INJ]", fired=True)
        elif inj == "quiet":
            cells["session_write"] = Cell(APPLIED, value="q[INJ]", fired=False)
        elif runtime != "claude":
            cells["session_write"] = Cell(
                NA, reason=f"{runtime}: no ~/.claude/projects record exists")
        else:
            try:
                d = mangled_project_dir(agent)
                if d is None:
                    cells["session_write"] = Cell(FAILED, reason="claude agent w/ no project dir")
                else:
                    age = newest_jsonl_age(d, now)
                    if age is None:
                        cells["session_write"] = Cell(FAILED, reason="project dir has no jsonl")
                    else:
                        # fired is decided in a SECOND PASS below, once the live
                        # control (the freshest write in this same sweep) is known.
                        c = Cell(APPLIED, value=f"{int(age)}s")
                        c.age = age
                        cells["session_write"] = c
            except Exception as e:
                cells["session_write"] = Cell(FAILED, reason=type(e).__name__)

        # ---- signal 3: context_gate (claude only)
        inj = injected(agent, "context_gate")
        if inj == "missing":
            cells["context_gate"] = Cell(NA, reason="INJECTED unavailable")
        elif inj == "error":
            cells["context_gate"] = Cell(FAILED, reason="INJECTED error")
        elif inj == "fired":
            cells["context_gate"] = Cell(APPLIED, value="99%[INJ]", fired=True)
        elif inj == "quiet":
            cells["context_gate"] = Cell(APPLIED, value="q[INJ]", fired=False)
        elif runtime != "claude":
            # NOTE: the file EXISTS for codex agents and reads 100%. Applicability is
            # decided by runtime, not by whether a file is sitting there.
            cells["context_gate"] = Cell(
                NA, reason=f"{runtime}: cumulative counter, any % is a permanent false positive")
        else:
            try:
                p = STATE / agent / "context_status.json"
                if not p.exists():
                    cells["context_gate"] = Cell(FAILED, reason="claude agent w/ no context_status")
                else:
                    pct = json.loads(p.read_text())["used_percentage"]
                    cells["context_gate"] = Cell(APPLIED, value=f"{pct}%", fired=(pct >= 95))
            except Exception as e:
                cells["context_gate"] = Cell(FAILED, reason=type(e).__name__)

        matrix[agent] = {"runtime": runtime, "cells": cells}

    # ---- SECOND PASS: the live control is the freshest session write in THIS sweep.
    ages = [m["cells"]["session_write"].age for m in matrix.values()
            if m.get("cells") and m["cells"].get("session_write")
            and m["cells"]["session_write"].age is not None]
    control = min(ages) if ages else None
    for m in matrix.values():
        if "verdict" in m:
            continue
        c = m["cells"].get("session_write")
        if c is not None and c.age is not None and control is not None:
            c.fired = (c.age > max(control * STALE_WRITE_RATIO, STALE_WRITE_MIN_SECONDS))
            c.value = f"{int(c.age)}s/{int(control)}s"

    for agent, m in matrix.items():
        if "verdict" in m:
            continue
        cells = m["cells"]
        applied = [s for s in SIGNALS if cells[s].state == APPLIED]
        fired = [s for s in applied if cells[s].fired]

        # Thresholds are inherited from the durable sweep rule, not re-invented here:
        # two signals OVER-TRIGGER (proven 27 Jul), so two fired means INVESTIGATE the
        # TUI buffer; only all three justify the destructive path (dump buffer, then
        # restart). An earlier revision of this script declared WEDGED at >=2, which was
        # strictly more trigger-happy than the rule it implements.
        if len(applied) < MIN_JUDGEABLE_SIGNALS:
            verdict = "UNDER-INSTRUMENTED"
        elif len(fired) == len(SIGNALS) and len(applied) == len(SIGNALS):
            verdict = "WEDGED"
        elif len(fired) >= 2:
            verdict = "SUSPECT"
        else:
            verdict = "healthy"

        m["verdict"] = verdict
        m["applied"] = applied
        m["fired"] = fired
    return matrix


def report(matrix):
    lines = []
    w = max(len(a) for a in matrix)
    header = f"{'agent'.ljust(w)}  {'runtime':8}  " + "  ".join(s.ljust(26) for s in SIGNALS)
    lines.append(header)
    lines.append("-" * len(header))

    slots = applied_n = na_n = failed_n = censored_n = 0
    censored = []
    under = []
    wedged = []
    suspect = []
    failures = []

    for agent in sorted(matrix):
        m = matrix[agent]
        cells = m["cells"]
        row = f"{agent.ljust(w)}  {str(m['runtime'] or '-'):8}  " + "  ".join(
            cells[s].render().ljust(26) for s in SIGNALS)
        lines.append(row + "  => " + m["verdict"])
        for s in SIGNALS:
            slots += 1
            st = cells[s].state
            applied_n += st == APPLIED
            na_n += st == NA
            failed_n += st == FAILED
            censored_n += st == CENSORED
            if st == FAILED:
                failures.append(f"{agent}.{s}: {cells[s].reason}")
            if st == CENSORED:
                censored.append(f"{agent}.{s}: {cells[s].reason}")
        if m["verdict"] == "UNDER-INSTRUMENTED":
            under.append(agent)
        if m["verdict"] == "WEDGED":
            wedged.append(agent)
        if m["verdict"] == "SUSPECT":
            suspect.append(agent)

    lines.append("")
    lines.append(f"COVERAGE: {len(matrix)} agents, {slots} slots, "
                 f"{applied_n} applied, {na_n} N/A, {failed_n} FAILED, "
                 f"{censored_n} CENSORED")
    if failed_n:
        lines.append("")
        lines.append(f"!!! {failed_n} FAILED CELL(S) -- these are BUGS, not structural limits:")
        for f in failures:
            lines.append(f"      {f}")
    if censored_n:
        lines.append("")
        lines.append(f"{censored_n} CENSORED CELL(S) -- subject restarted mid-measurement. "
                     f"NOT bugs, NOT measurements: lower bounds only, never averaged in.")
        for c in censored:
            lines.append(f"      {c}")
    lines.append(f"UNDER-INSTRUMENTED: {', '.join(under) if under else 'none'}")
    lines.append(f"SUSPECT (2 signals, investigate buffer -- do NOT restart): "
                 f"{', '.join(suspect) if suspect else 'none'}")
    lines.append(f"WEDGED (all 3, dump buffer THEN restart): "
                 f"{', '.join(wedged) if wedged else 'none'}")
    return "\n".join(lines), {"slots": slots, "applied": applied_n, "na": na_n,
                              "failed": failed_n, "censored": censored_n,
                              "censored_cells": censored, "under": under,
                              "suspect": suspect, "wedged": wedged}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample-seconds", type=int, default=22)
    ap.add_argument("--inject", action="append", default=[],
                    help="CONTROL ONLY. agent:signal=missing|error|fired|quiet")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    inject = {}
    for spec in args.inject:
        target, mode = spec.split("=")
        agent, sig = target.split(":")
        if sig not in SIGNALS:
            sys.exit(f"unknown signal {sig}")
        # A mistyped mode used to fall through to the REAL signal and produce a clean
        # run -- i.e. a control that silently tests nothing while looking like the
        # detector failed to fire. Fail loudly instead.
        if mode not in ("missing", "error", "fired", "quiet", "vanished"):
            sys.exit(f"unknown inject mode {mode!r} "
                     f"(missing|error|fired|quiet|vanished)")
        inject[(agent, sig)] = mode

    roster = get_roster()
    procs = enumerate_processes({a["name"] for a in roster})
    matrix = build_matrix(roster, procs, args.sample_seconds, inject)
    text, summary = report(matrix)

    if inject:
        print("### CONTROL RUN -- fault injection active: "
              + ", ".join(f"{a}:{s}={m}" for (a, s), m in inject.items()))
    print(text)
    if args.json:
        print(json.dumps(summary))


if __name__ == "__main__":
    main()
