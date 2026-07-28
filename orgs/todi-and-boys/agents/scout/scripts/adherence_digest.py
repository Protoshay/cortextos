#!/usr/bin/env python3
"""
adherence digest — REDUCTION ONLY. The agent judges off the digest; this script
does not decide whether the fleet is healthy and deliberately has no "clean" verdict.

WHY THIS EXISTS (skiffy ruling 2026-07-28 09:24Z, approved 2-3x/day, NOT hourly):
the adherence-check cron was priced wrong, not under-run. Read directly it costs
40-60% of a fresh context window (13 agents x memory file + a 63k-line daemon log +
per-agent session jsonl), so it lost three consecutive cycles to context pressure.
The expensive half is REDUCTION and reduction is scriptable; the judgment half is
small once the evidence is a digest.

THE DESIGN RULE THAT MATTERS — the tool EMITS the discrimination statement rather
than the operator REMEMBERING it. Every count below is printed next to the evidence
that the count could have been non-zero. A zero is only reported as a finding when
the detector has been PROVEN to fire; otherwise it prints NOT DISCRIMINATED.
That is the same shape as health_sweep.py's "SET-DIFFERENCE NOT COMPUTED, NOT 'none'":
fixing an instrument without fixing how its FAILURE RENDERS leaves the next failure silent.

SOURCES — each used ONLY for what it actually carries. Do not re-simplify to one log:
  (a) API/auth errors, and anything the MODEL itself saw:
      ~/.claude/projects/<agent-dir>/*.jsonl. Discriminated on RECORD TYPE + FLAG
      (type=='assistant' AND isApiErrorMessage is True), NEVER on string presence.
      Verified 2026-07-27: a "strict" string filter still returned scout n=17 because
      tool_use/tool_result records carried the investigator's own text — including the
      handoff doc DOCUMENTING the outage. A filter cannot exclude an author who writes
      in the filter's own vocabulary. A record type cannot be contaminated that way.
  (b) lifecycle/daemon events (crashes, restarts): the agent's crashes.log.
  NOT stdout.log — a raw ANSI TUI buffer. A text pattern against it returns 0 hits
  forever (verified across 11 agents, still 0 when widened to 2000 lines of a live
  15.7MB file), so a broken check reads as a clean fleet. Fake-zero factory.

Usage: adherence_digest.py [--hours N] [--json]
"""
import argparse, glob, json, os, sys, time
from datetime import datetime, timezone

AGENTS_DIR = "/root/cortextos/orgs/todi-and-boys/agents"
CTX_ROOT = os.environ.get("CTX_ROOT", "/root/.cortextos/default")
PROJ = os.path.expanduser("~/.claude/projects")
PROJ_PREFIX = "-root-cortextos-orgs-todi-and-boys-agents-"
SELF = os.environ.get("CTX_AGENT_NAME", "scout")


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def agent_dirs():
    """Map agent name -> project dir. Keyed on the projects layout, NOT on /proc cwd:
    verified 2026-07-28, a /proc-cwd-keyed enumeration silently drops every
    codex-layout agent (otis lives under state/, not orgs/*/agents/)."""
    out = {}
    for p in sorted(glob.glob(os.path.join(PROJ, PROJ_PREFIX + "*"))):
        name = os.path.basename(p)[len(PROJ_PREFIX):]
        if name and "-" not in name:
            out[name] = p
    return out


def self_test_detector():
    """KNOWN-INNOCENT + KNOWN-GUILTY CONTROL, run every time on synthetic records.

    Proves the DETECTOR fires before any real zero is reported. Without this a run
    over a quiet window and a run with a broken parser are indistinguishable —
    both print 0. This is what converts "0 errors" from a fake zero into an
    EXPLAINED zero. Returns (ok, detail)."""
    guilty = {"type": "assistant", "isApiErrorMessage": True,
              "timestamp": "2026-07-28T01:24:07.981Z",
              "message": {"content": [{"type": "text", "text": "You've hit your limit"}]}}
    innocent_flag = {"type": "assistant", "isApiErrorMessage": False,
                     "timestamp": "2026-07-28T01:24:07.981Z",
                     "message": {"content": [{"type": "text", "text": "No response requested."}]}}
    # The exact contamination that defeated the string filter: investigator text
    # quoting the error inside a tool_result. MUST NOT be counted.
    contaminant = {"type": "user", "isApiErrorMessage": False,
                   "timestamp": "2026-07-28T01:24:07.981Z",
                   "message": {"content": [{"type": "tool_result",
                                            "content": "You've hit your limit · resets Jul 30"}]}}
    checks = [(guilty, True, "guilty(assistant+flag)"),
              (innocent_flag, False, "innocent(assistant, flag False)"),
              (contaminant, False, "contaminant(tool_result quoting the error text)")]
    fails = []
    for rec, want, label in checks:
        got = is_api_error(rec)
        if got != want:
            fails.append(f"{label} expected {want} got {got}")
    return (not fails), ("; ".join(fails) if fails else
                         "detector fires on a crafted error, ignores a False flag, "
                         "and REJECTS investigator text quoting the same error")


def is_api_error(rec):
    """THE discriminator. Record TYPE + FLAG only."""
    return rec.get("type") == "assistant" and rec.get("isApiErrorMessage") is True


def err_text(rec):
    try:
        c = rec.get("message", {}).get("content")
        if isinstance(c, list):
            for part in c:
                if isinstance(part, dict) and part.get("type") == "text":
                    return " ".join(part.get("text", "").split())[:110]
        return " ".join(str(c).split())[:110]
    except Exception:
        return "<unparseable>"


def scan_agent(name, pdir, cutoff):
    """Returns dict with errors, and the CONTROL counts that make a zero readable."""
    errors, sessions = [], set()
    field_seen = 0      # assistant records CARRYING the flag (proves we reached real records)
    files_scanned = 0
    files_skipped_old = 0
    for f in glob.glob(os.path.join(pdir, "*.jsonl")):
        try:
            if os.path.getmtime(f) < cutoff:
                files_skipped_old += 1
                continue
        except OSError:
            continue
        files_scanned += 1
        try:
            with open(f, errors="replace") as fh:
                for line in fh:
                    # substring is a SPEED PREFILTER ONLY; the DECISION is type+flag
                    # below. A record without the field can never be True.
                    if "isApiErrorMessage" not in line:
                        continue
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue
                    if rec.get("type") != "assistant":
                        continue
                    field_seen += 1
                    if not is_api_error(rec):
                        continue
                    ts = parse_ts(rec.get("timestamp"))
                    if ts is None or ts < cutoff:
                        continue
                    errors.append((ts, err_text(rec)))
                    if rec.get("sessionId"):
                        sessions.add(str(rec["sessionId"])[:8])
        except Exception as e:
            print(f"!! {name}: unreadable {os.path.basename(f)}: {e}", file=sys.stderr)
    errors.sort()
    return {"errors": errors, "sessions": sorted(sessions), "field_seen": field_seen,
            "files_scanned": files_scanned, "files_skipped_old": files_skipped_old}


def crash_lines(name, cutoff):
    """Lifecycle evidence. crashes.log holds crashes AND planned context-handoff restarts."""
    p = os.path.join(CTX_ROOT, "logs", name, "crashes.log")
    if not os.path.exists(p):
        return None  # None => file absent, distinct from [] => present and empty
    out = []
    try:
        with open(p, errors="replace") as fh:
            for line in fh.readlines()[-400:]:
                ts = parse_ts(line[:24].strip().split(" ")[0])
                if ts is None or ts >= cutoff:
                    out.append(" ".join(line.split())[:150])
    except Exception:
        return None
    return out[-6:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=12.0,
                    help="lookback window; default 12h to cover a 2-3x/day cadence")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    now = time.time()
    cutoff = now - args.hours * 3600
    nows = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    ok, detail = self_test_detector()
    dirs = agent_dirs()

    results = {}
    for name, pdir in dirs.items():
        results[name] = scan_agent(name, pdir, cutoff)
        results[name]["crashes"] = crash_lines(name, cutoff)

    total_err = sum(len(r["errors"]) for r in results.values())
    total_field = sum(r["field_seen"] for r in results.values())

    if args.json:
        print(json.dumps({"generated": nows, "hours": args.hours,
                          "detector_ok": ok, "agents": {
                              k: {"errors": len(v["errors"]), "sessions": v["sessions"],
                                  "field_seen": v["field_seen"]}
                              for k, v in results.items()}}, indent=1))
        return 0 if ok else 2

    print(f"=== ADHERENCE DIGEST — {nows} — window {args.hours:g}h ===")
    print(f"agents enumerated: {len(dirs)}  (source: {PROJ}/{PROJ_PREFIX}*)")

    # ---- discrimination statement, PRINTED, never remembered ----
    print("\n--- CAN THIS CHECK FIRE? ---")
    print(f"  detector self-test : {'PASS' if ok else 'FAIL'} — {detail}")
    print(f"  live control       : {total_field} assistant record(s) carrying isApiErrorMessage "
          f"were read in-window")
    if not ok:
        print("  >> VERDICT: NOT DISCRIMINATED — detector self-test FAILED. Any zero below is "
              "meaningless. Do NOT report clean.")
    elif total_field == 0:
        print("  >> VERDICT: NOT DISCRIMINATED — detector works on synthetic records but read "
              "ZERO real flagged records in-window, so this run cannot tell "
              "'no problems' from 'not looking'. Widen --hours. Do NOT report clean.")
    else:
        print(f"  >> VERDICT: DISCRIMINATED — detector proven on synthetic records AND "
              f"{total_field} real records carrying the flag were read. "
              f"A zero below is an EXPLAINED zero.")

    print(f"\n--- API/AUTH ERRORS (type=='assistant' AND isApiErrorMessage) — total {total_err} ---")
    for name in sorted(results):
        r = results[name]
        if not r["errors"]:
            continue
        first = datetime.fromtimestamp(r["errors"][0][0], timezone.utc).strftime("%H:%M:%SZ")
        last = datetime.fromtimestamp(r["errors"][-1][0], timezone.utc).strftime("%H:%M:%SZ")
        selfnote = "  [SELF-AUTHORED DIR]" if name == SELF else ""
        print(f"  {name:<9} n={len(r['errors']):<4} {first}..{last}  "
              f"sessions={','.join(r['sessions']) or '-'}{selfnote}")
        print(f"    e.g. {r['errors'][-1][1]}")
    if total_err == 0:
        print("  none in window.")

    print("\n--- COVERAGE OF THE SCAN (a low file count is itself a finding) ---")
    for name in sorted(results):
        r = results[name]
        flag = "  <-- NO FILES IN WINDOW" if r["files_scanned"] == 0 else ""
        print(f"  {name:<9} files_in_window={r['files_scanned']:<3} "
              f"skipped_old={r['files_skipped_old']:<4} flagged_records_read={r['field_seen']}{flag}")

    print("\n--- LIFECYCLE (crashes.log; None = FILE ABSENT, not 'no crashes') ---")
    for name in sorted(results):
        c = results[name]["crashes"]
        if c is None:
            print(f"  {name:<9} crashes.log ABSENT — lifecycle NOT CHECKED for this agent")
        elif c:
            print(f"  {name:<9} {len(c)} recent line(s):")
            for line in c:
                print(f"      {line}")
    print("\nNOTE: this digest REDUCES evidence. It does not certify the fleet. "
          "Judge stale-data violations, unactioned guardrails and repeat patterns off it.\n"
          "Do NOT rank agents by error counts — a high count can mean the agent was "
          "documented better, not that it behaved worse.")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
