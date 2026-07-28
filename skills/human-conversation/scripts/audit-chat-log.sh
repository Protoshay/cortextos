#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Usage: $0 <inbound.jsonl> <outbound.jsonl> [start-iso]" >&2
  exit 2
fi

INBOUND="$1"
OUTBOUND="$2"
START_ISO="${3:-0000-01-01T00:00:00Z}"

for file in "$INBOUND" "$OUTBOUND"; do
  [ -f "$file" ] || { echo "Missing log: $file" >&2; exit 2; }
  jq -e . "$file" >/dev/null
done

cumulative=0

while IFS= read -r row; do
  decoded="$(printf '%s' "$row" | base64 -d)"
  direction="$(jq -r '.direction' <<<"$decoded")"

  if [ "$direction" = "human" ]; then
    cumulative=0
    continue
  fi

  text_value="$(jq -r '.text // ""' <<<"$decoded")"
  words="$(awk '{n += NF} END {print n + 0}' <<<"$text_value")"
  cumulative=$((cumulative + words))

  if [ "$words" -gt 50 ] || [ "$cumulative" -gt 200 ]; then
    jq -n \
      --arg timestamp "$(jq -r '.timestamp' <<<"$decoded")" \
      --arg message_id "$(jq -r '.message_id // "" | tostring' <<<"$decoded")" \
      --argjson words "$words" \
      --argjson cumulative_words "$cumulative" \
      '{
        timestamp: $timestamp,
        message_id: $message_id,
        words: $words,
        cumulative_agent_words: $cumulative_words,
        reply_over_50: ($words > 50),
        run_over_200: ($cumulative_words > 200),
        classification: "review_scope",
        note: "Candidate only: confirm this is conversational chat, not a requested deliverable or a recorded preference exception."
      }'
  fi
done < <(
  jq -nr \
    --slurpfile inbound "$INBOUND" \
    --slurpfile outbound "$OUTBOUND" \
    --arg start "$START_ISO" '
    [
      ($inbound[] | select((.timestamp // "") >= $start)
        | {timestamp, message_id, text, direction:"human"}),
      ($outbound[] | select((.timestamp // "") >= $start)
        | {timestamp, message_id, text, direction:"agent"})
    ]
    | sort_by(.timestamp)
    | .[]
    | @base64
  '
)
