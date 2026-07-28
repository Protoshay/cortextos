#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [reply text]; or pipe text on stdin" >&2
  exit 2
fi

reply_text="${1:-$(cat)}"

python3 - "$reply_text" <<'PY'
import re
import sys

text = sys.argv[1]
failures = []
words = len(text.split())

if words > 50:
    failures.append(f"{words} words (maximum 50)")

emoji = re.compile(
    "["
    "\U0001F1E6-\U0001F1FF"
    "\U0001F300-\U0001FAFF"
    "\U00002600-\U000027BF"
    "]"
)
if emoji.search(text):
    failures.append("emoji detected")

backstage = (
    r"/root/|cortextos bus|msg_id|tool call|scratchpad|proof receipt|"
    r"chain[- ]of[- ]thought|internal reasoning|session bootstrap"
)
if re.search(backstage, text, re.IGNORECASE):
    failures.append("backstage/system wording detected")

if failures:
    print("FAIL: " + "; ".join(failures))
    raise SystemExit(1)

print(f"PASS: {words} words")
PY
