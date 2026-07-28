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
    pg = subprocess.run(["pgrep", "-f", "claude|codex"],
                        capture_output=True, text=True, timeout=30)
    # rc WAS DISCARDED HERE. pgrep: 0 = matched, 1 = genuinely no match, >=2 = ERROR.
    # Reading only stdout collapses "pgrep failed" into "no agents are running", because
    # both arrive as an empty string. That is a refusal rendered as an answer -- the same
    # shape as a rate-limited API call returning rows=0 (skiffy fleet broadcast, 10:20Z,
    # found by zig on gog 403s). This sweep feeds an ESCALATING 30-minute cron, so it must
    # never be able to emit a zero it cannot stand behind: ABORT rather than under-report.
    # Deliberately NOT merging stderr into stdout -- merging is what destroys the
    # distinction in the first place. get_roster() above already uses this pattern.
    # ENUMERATION CITED SO THE NEXT READER CAN CHECK IT RATHER THAN TRUST IT:
    #   `man 1 pgrep`, EXIT STATUS, procps-ng 4.0.4 (verified at source on this box):
    #     0 = one or more processes matched
    #     1 = no processes matched or none of them could be signalled
    #     2 = syntax error in the command line
    #     3 = fatal error: out of memory etc
    # Admitting {0,1} is the ALLOW-LIST form: exactly two codes, both with documented
    # meanings, and rc=1 is a genuine ANSWER ("nothing matched"), not a refusal.
    # Deliberately NOT `!= 0`, which would abort on the real possible world where no
    # agent is running. The safety property is: DO NOT ADMIT AN EXIT CODE YOU CANNOT
    # ENUMERATE -- not "always use != 0".
    if pg.returncode not in (0, 1):
        raise RuntimeError(
            f"pgrep failed rc={pg.returncode} -- process enumeration UNKNOWN, "
            f"NOT empty: {pg.stderr.strip()[:200]}")
    # ENUMERATING THE CODE IS NOT ENUMERATING THE OBSERVATION (skiffy, 10:41Z).
    # A documented rc=1 arriving WITH stderr output is not the documented case, and
    # accepting it would launder an unknown into a clean "no agents running" -- the same
    # shape one level down from the rc check itself.
    if pg.returncode == 1 and pg.stderr.strip():
        raise RuntimeError(
            f"pgrep rc=1 (documented 'no match') but stderr is NON-EMPTY, so this is "
            f"NOT the documented case -- enumeration UNKNOWN: {pg.stderr.strip()[:200]}")
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
            # LOAD-BEARING: applicability is keyed on RUNTIME, never on file presence.
            # DO NOT "fix" this to check whether ~/.claude/projects/*-agents-<a>/ has
            # jsonls. It does, for codex agents, and they are NOT written by the agent
            # session. Verified 2026-07-27: otis's dir held fresh jsonls produced by his
            # own `claude -p "Reply with exactly AUTH_OK"` auth probes. Reading them gave
            # a plausible, healthy-looking 191s age belonging to a different process.
            #
            # That is a THIRD state beyond present/absent: CONTAMINATED — present, fresh,
            # and not his. The distinction decides which way the signal fails. An ABSENT
            # signal fails SAFE (you know you are blind). A CONTAMINATED one fails toward
            # HEALTHY, so a genuinely wedged codex agent would show a fresh write age
            # forever and never trip anything.
            #
            # Compounding risk, also verified 2026-07-27: the CPU signal reads a false
            # FROZEN for codex if it samples only the `node codex app-server` wrapper PID
            # (0 ticks) instead of the whole process group (worker child burned 48 ticks
            # in the same 23s window). If someone converts this N/A into a real signal by
            # file presence, a false FROZEN plus a contaminated-fresh write age is TWO
            # signals agreeing on a wrong answer, and otis gets declared WEDGED while
            # perfectly healthy. The runtime key is the only thing preventing that today.
            #
            # The old reason string here claimed "no ~/.claude/projects record exists".
            # That was FALSE from ~15:24Z on 2026-07-27 and is corrected below: the
            # verdict was landing correctly for a reason the text misdescribed, which is
            # precisely what invites the wrong "fix".
            cells["session_write"] = Cell(
                NA, reason=f"{runtime}: N/A by runtime — jsonls may exist but are "
                           f"auth-probe artefacts, not agent-session writes")
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
            # Early-verdict agents (e.g. DOWN: no live process) still need a
            # coverage value. Leaving it blank would render them identically to
            # an agent that passed -- the exact defect this axis exists to close.
            if "coverage" not in m:
                cells0 = m.get("cells") or {}
                miss0 = [s for s in SIGNALS
                         if s not in cells0 or cells0[s].state != APPLIED]
                m["coverage"] = "UNCOVERABLE" if len(miss0) == len(SIGNALS) else "PARTIAL"
                m["coverage_why"] = "; ".join(
                    f"{s}: {cells0[s].reason}" for s in miss0 if s in cells0
                ) or f"verdict {m['verdict']} assigned before any signal applied"
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

        # COVERAGE IS A SEPARATE AXIS FROM HEALTH (skiffy ruling, 2026-07-27, from
        # cycle 6 on). The health verdict answers "is this agent wedged?". Coverage
        # answers "could I have told?". They are independent, and collapsing them is
        # the otis defect: an agent whose signals are structurally unavailable was
        # rendering the same as one that actively passed. Appearing monitored is
        # WORSE than appearing unmonitored, because nobody goes looking.
        missing = [s for s in SIGNALS if cells[s].state != APPLIED]
        if not missing:
            coverage, why = "COVERED", ""
        elif len(applied) == 0:
            coverage = "UNCOVERABLE"
            why = "; ".join(f"{s}: {cells[s].reason}" for s in missing)
        else:
            coverage = "PARTIAL"
            why = "; ".join(f"{s}: {cells[s].reason}" for s in missing)
        m["coverage"] = coverage
        m["coverage_why"] = why
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
    # COVERAGE AXIS -- reported SEPARATELY from the health verdict, and printed
    # before it, because "could I have told?" has to be answered before "was it
    # fine?" means anything. An UNCOVERABLE or PARTIAL agent must never read the
    # same as one that actively passed.
    lines.append("")
    lines.append("COVERAGE AXIS (independent of health verdict):")
    for agent, m in matrix.items():
        cov = m.get("coverage", "?")
        if cov == "COVERED":
            lines.append(f"      {agent.ljust(w)}  COVERED      all {len(SIGNALS)} signals applied")
        else:
            lines.append(f"      {agent.ljust(w)}  {cov.ljust(12)} {m.get('coverage_why','')}")
    part = [a for a, m in matrix.items() if m.get("coverage") == "PARTIAL"]
    unc = [a for a, m in matrix.items() if m.get("coverage") == "UNCOVERABLE"]
    if part or unc:
        lines.append(f"      -> PARTIAL: {', '.join(part) if part else 'none'}"
                     f" | UNCOVERABLE: {', '.join(unc) if unc else 'none'}")
        lines.append("      -> A non-COVERED agent's 'healthy' is an artefact of the "
                     "arithmetic, not a finding.")
    lines.append("")
    lines.append(f"UNDER-INSTRUMENTED: {', '.join(under) if under else 'none'}")
    lines.append(f"SUSPECT (2 signals, investigate buffer -- do NOT restart): "
                 f"{', '.join(suspect) if suspect else 'none'}")
    lines.append(f"WEDGED (all 3, dump buffer THEN restart): "
                 f"{', '.join(wedged) if wedged else 'none'}")
    return "\n".join(lines), {"slots": slots, "applied": applied_n, "na": na_n,
                              "failed": failed_n, "censored": censored_n,
                              "censored_cells": censored, "under": under,
                              "suspect": suspect, "wedged": wedged}


def provenance():
    """Ruling #2(c): capture the SHA AT RUN TIME, BY THE SCRIPT. A SHA typed into a
    header by hand is an assertion, not a measurement.

    THE FINGERPRINT IS `git hash-object` OF THIS FILE ON DISK -- DELIBERATELY NOT HEAD.
    HEAD describes what was COMMITTED; it does not describe what EXECUTED. With a dirty
    working copy those are different objects, and printing HEAD would attach a clean,
    committed-looking identifier to code that is not that code. That is a FAKE
    PROVENANCE, and it is strictly worse than none: a header carrying a plausible SHA
    reads as settled and nobody re-opens it, whereas a missing one still looks missing.
    Hashing the on-disk bytes is true in every state -- clean, dirty, or untracked.

    `state` is therefore the load-bearing field, not the SHA. CLEAN means the bytes that
    ran are the bytes that are committed; anything else means the run is NOT reproducible
    from the repo alone and the cycle must not be treated as SHA-pinned.

    Every failure path emits an explicit UNRESOLVED marker rather than returning None or
    an empty string. An ABSENT provenance line is indistinguishable from a clean one to
    anyone reading the log months later -- the same fake-zero shape this script exists to
    catch elsewhere -- so the failure must be loud and IN the header.
    """
    path = os.path.realpath(__file__)
    run_utc = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def git(*args):
        return subprocess.run(("git",) + args, cwd=os.path.dirname(path),
                              capture_output=True, text=True, timeout=10)

    def line(**kw):
        return "### PROVENANCE — " + " ".join(f"{k}={v}" for k, v in kw.items())

    try:
        ran = git("hash-object", path)
        if ran.returncode != 0:
            return line(script_sha="UNRESOLVED", state="UNRESOLVED", run_utc=run_utc,
                        detail=repr(ran.stderr.strip()[:80] or "git hash-object failed"))
        ran_sha = ran.stdout.strip()

        committed = git("rev-parse", f"HEAD:./{os.path.basename(path)}")
        head = git("rev-parse", "--short=12", "HEAD")
        head_sha = head.stdout.strip() if head.returncode == 0 else "UNRESOLVED"

        if committed.returncode != 0:
            # DO NOT INFER A CAUSE FROM A FAILURE. An earlier version of this branch
            # mapped EVERY non-zero rc to "UNTRACKED-IN-HEAD" -- one specific, benign
            # cause read off an unenumerated failure space. `git rev-parse HEAD:<file>`
            # also fails when there is NO REPO, when HEAD is unborn, when git is missing
            # and on permission errors. The /tmp control proved the mislabel: run outside
            # any repo it announced UNTRACKED-IN-HEAD, which is a claim about a
            # repository that did not exist.
            # That is skiffy's amendment-3 shape (10:34Z): enumerating the case you
            # thought of and letting every unpredicted one wear its label. Only claim
            # UNTRACKED when a HEAD positively resolved -- i.e. enumerate the GOOD
            # precondition -- and fail to UNRESOLVED otherwise.
            if head.returncode == 0:
                state = "UNTRACKED-IN-HEAD"   # repo confirmed; file genuinely absent
                detail = None
            else:
                state = "UNRESOLVED"          # cannot even establish a repo
                detail = repr((head.stderr or committed.stderr).strip()[:80]
                              or "no resolvable HEAD")
            kw = dict(script_sha=ran_sha[:12], state=state, committed_sha="NONE",
                      repo_head=head_sha, run_utc=run_utc)
            if detail:
                kw["detail"] = detail
            return line(**kw)

        committed_sha = committed.stdout.strip()
        state = "CLEAN" if committed_sha == ran_sha else "DIRTY-NOT-SHA-PINNED"
        return line(script_sha=ran_sha[:12], state=state,
                    committed_sha=committed_sha[:12], repo_head=head_sha,
                    run_utc=run_utc)
    except Exception as exc:  # subprocess timeout, git absent, permissions
        return line(script_sha="UNRESOLVED", state="UNRESOLVED", run_utc=run_utc,
                    detail=repr(f"{type(exc).__name__}: {exc}"[:80]))


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

    # Emitted FIRST, and unconditionally, so every cycle in the log carries the identity
    # of the code that produced it -- including runs that later error out mid-report.
    print(provenance())
    if inject:
        print("### CONTROL RUN -- fault injection active: "
              + ", ".join(f"{a}:{s}={m}" for (a, s), m in inject.items()))
    print(text)
    if args.json:
        print(json.dumps(summary))


if __name__ == "__main__":
    main()
