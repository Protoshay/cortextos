#!/usr/bin/env python3
"""
KB auth canary — S2 (queued 2026-07-22, promoted 2026-07-26 theta-wave).

Probes the knowledge-base Gemini embed call twice a day so an auth restoration
(or a NEW, different failure) surfaces proactively instead of on next kb-ingest
attempt. Positive-control discipline: must distinguish "still 401" (probe
reached Google, confirmed still down) from "probe itself broken" (some other
exception — local/env/network — which is NOT evidence either way about the
Gemini outage and must not be reported as such).

State file: reports/kb-canary-state.json
On any transition INTO "restored", alerts skiffy immediately (the only
consumer of a green signal per the agreed restoration playbook — a canary
nobody acts on is just a blinking LED).
On a NEW, different failure class (probe_error), also alerts immediately —
do not silently fold it into the known/expected auth_down state.
Repeated same-state pings do NOT re-alert (avoid noise); a daily summary
line is written to the state file regardless.
"""
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

STATE_FILE = Path(__file__).parent.parent / "reports" / "kb-canary-state.json"
PROBE_QUERY = "kb auth canary probe — do not action, monitoring only"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_probe():
    try:
        result = subprocess.run(
            ["cortextos", "bus", "kb-query", PROBE_QUERY, "--org", "todi-and-boys", "--agent", "analyst"],
            capture_output=True, text=True, timeout=60,
        )
        combined = (result.stdout or "") + (result.stderr or "")
        return result.returncode, combined
    except subprocess.TimeoutExpired:
        return -1, "PROBE_TIMEOUT: kb-query did not return within 60s"
    except Exception as e:
        return -2, f"PROBE_EXEC_FAILURE: {e}"


def classify(returncode, output):
    # Positive control: the 401/UNAUTHENTICATED string only appears if the
    # probe actually reached Google's embed endpoint and got a real auth
    # rejection back — that IS proof the probe itself works, just that auth
    # is still broken.
    if "401" in output and "UNAUTHENTICATED" in output:
        return "auth_down"
    if returncode == 0 and "Traceback" not in output:
        return "restored"
    # Anything else (a different traceback, timeout, exec failure, non-zero
    # exit without the known 401 signature) is a NEW/DIFFERENT failure mode —
    # must not be conflated with the known Gemini outage.
    return "probe_error"


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"last_status": None, "last_checked": None, "history": []}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def send_skiffy(msg):
    subprocess.run(["cortextos", "bus", "send-message", "skiffy", "high", msg])


def main():
    state = load_state()
    prev_status = state.get("last_status")

    returncode, output = run_probe()
    status = classify(returncode, output)
    ts = now_iso()

    state["last_status"] = status
    state["last_checked"] = ts
    state.setdefault("history", []).append({"ts": ts, "status": status})
    state["history"] = state["history"][-50:]  # keep it bounded

    transitioned = (prev_status is not None) and (prev_status != status)

    if status == "restored" and (transitioned or prev_status is None):
        send_skiffy(
            f"KB AUTH CANARY: Gemini embed call SUCCEEDED (200, no auth error) at {ts}. "
            "Outage since 2026-07-22 13:31Z appears resolved. Restoration playbook: "
            "please lift the fleet-wide note-and-skip standing, re-enable kb-ingest, "
            "and close the [HUMAN] key-reissue task. (First green ping — will not "
            "repeat-alert on subsequent restored checks.)"
        )
    elif status == "probe_error" and transitioned:
        send_skiffy(
            f"KB AUTH CANARY: probe failure at {ts} that is NOT the known 401 pattern "
            f"(status=probe_error, exit={returncode}). This is a different failure mode "
            "from the tracked Gemini-401 outage — needs its own look, not folded into "
            f"the existing note-and-skip. Raw signal: {output[-300:]}"
        )
    # auth_down (steady-state, expected) and unchanged states: no alert, just log.

    save_state(state)
    print(json.dumps({"status": status, "prev_status": prev_status, "transitioned": transitioned, "ts": ts}))


if __name__ == "__main__":
    main()
