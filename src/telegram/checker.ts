/**
 * Message Checker — mandatory pre-send reviewer for human-facing Telegram messages.
 *
 * Pure functions only. No daemon state, no global singletons.
 * All I/O is injected via parameters so every function is unit-testable
 * with a mocked ModelClient and a temp directory.
 *
 * Two-stage pipeline:
 *   Stage 1 — runDeterministicChecks(): fast regex-based absolute rejects.
 *   Stage 2 — runSemanticCheck(): small OpenAI model via Responses API.
 *
 * Fail-closed: any error in stage 2 returns a rejection, never a pass.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CheckerConfig {
  /** OpenAI model name. Default: 'gpt-4o-mini'. */
  model: string;
  /** Network + model timeout in ms. Default: 8000. */
  timeoutMs: number;
  /** max_output_tokens sent to the model. Default: 200. */
  tokenCap: number;
}

export type CheckerResult =
  | { pass: true }
  | { pass: false; reason: string; rewrite: string };

/** Injected model client interface — mocked in tests, real OpenAI in prod. */
export interface ModelClient {
  check(systemPrompt: string, userContent: string): Promise<CheckerResult>;
}

export interface CheckerAuditEntry {
  timestamp: string;
  agent: string;
  chat_id: string;
  source: string;
  stage: 'deterministic' | 'semantic' | 'error';
  result: 'pass' | 'reject' | 'error';
  reason?: string;
  rewrite?: string;
  /** Present ONLY on reject/error — stored locally, never forwarded. */
  full_draft?: string;
  latency_ms?: number;
  est_input_tokens?: number;
  est_output_tokens?: number;
  /** First 100 chars, always present. */
  draft_preview: string;
}

export interface DeterministicResult {
  /** Non-null → hard reject, stop. No semantic call. */
  reject: string | null;
  /** Forwarded to semantic prompt as context hints. */
  contextFlags: string[];
}

export interface AudienceProfile {
  chatId: string;
  name: string;
  systemPrompt: string;
  /** Terms that trigger a jargon context flag (not a hard reject). */
  jargonTerms: string[];
}

// ---------------------------------------------------------------------------
// Audience profiles
// ---------------------------------------------------------------------------

/** Shay's numeric Telegram chat ID. */
const SHAY_CHAT_ID = '8721344756';

const SHAY_JARGON_TERMS: string[] = [
  'send path',
  'deterministic block',
  'release hold',
  'repo authority',
  'semantic check',
  'guardrail',
  'gate',
  'runtime',
  'bootstrap',
  'injection',
];

const SHAY_SYSTEM_PROMPT = `You are a mandatory pre-send reviewer for human-facing Telegram messages.
The agent already passed word-limit, cadence, and question checks.
Catch the failures those checks miss.

Rules for Shay:
- REJECT if this just restates what Shay said without adding anything new.
- REJECT if the draft leads with internal machinery, process names, status labels,
  or implementation detail instead of the ordinary human answer. A requested
  technical explanation may include those details only after the plain answer.
- REJECT vague category answers such as "reliability fixes", "review work", or
  "the system is being reconciled" when the draft could say what actually
  happened or what is being changed.
- REJECT requests for approval or a decision that do not name the exact action
  Shay is being asked to approve or take.
- REJECT dense bundles of decisions, dependencies, or updates when the next
  useful move can be explained one step at a time.
- REJECT abstract, receipt-like wording for a simple action. Replacing technical
  terms with softer synonyms is not enough if the answer remains vague.
- A passing rewrite gives the plain answer or cause first, says what it means
  for Shay, names one concrete next action, and plainly says when he need do nothing.
- REJECT if it exposes internal work, routes, commands, system IDs, or plans,
  UNLESS context flags show this is a requested technical explanation.
- REJECT if it claims a behaviour is fixed without real runtime evidence.
- REJECT if a short direct answer is natural but the reply pads it out.
- REJECT if it promises future behaviour instead of answering now.
- For completion or outcome claims, compare the draft with Recent activity records.
  If a specific recent record directly supports the claim, do not reject merely
  because the conversation itself lacks the evidence. If no record supports it,
  reject the claim rather than inventing a different answer.
- Recent conversation reflects only this Telegram thread, not everything the
  agent legitimately needs to tell Shay, such as something relayed from
  another agent that has never come up here. When the draft has no real
  connection to Recent conversation, evaluate it as its own topic against
  the rules above rather than rejecting it for not continuing the last
  exchange. Never invent a rewrite anchored to Recent conversation's topic
  when that topic has nothing to do with the draft.
- PASS if it is a direct, honest, short answer that moves things forward.
- PASS if the triggering inbound message confirms this is a requested deliverable.
- PASS if context flags indicate jargon but the message is a requested technical brief.

Return {"pass":true,"reason":null,"rewrite":null}
    or {"pass":false,"reason":"one sentence","rewrite":"fixed version"}.
JSON only. No prose.`;

const DEFAULT_SYSTEM_PROMPT = `You are a mandatory pre-send reviewer for human-facing Telegram messages.
Rules:
- REJECT if the reply only echoes what the human said without adding value.
- REJECT if it exposes internal system details without being asked for them.
- REJECT if it claims a behaviour is fixed without real runtime evidence.
- REJECT if a naturally short answer is padded unnecessarily.
- Recent conversation reflects only this Telegram thread. When the draft has
  no real connection to Recent conversation, evaluate it as its own topic
  rather than rejecting it for not continuing the last exchange. Never
  invent a rewrite anchored to Recent conversation's topic when that topic
  has nothing to do with the draft.
- PASS if it answers the human question directly.
- PASS if the triggering inbound message confirms this is a requested deliverable.
Return {"pass":true,"reason":null,"rewrite":null}
    or {"pass":false,"reason":"one sentence","rewrite":"fixed version"}.
JSON only. No prose.`;

/**
 * Resolve the audience profile for a given chat ID.
 * Unknown chat IDs get the default (generic) profile.
 */
export function resolveAudience(chatId: string | number): AudienceProfile {
  const id = String(chatId);
  if (id === SHAY_CHAT_ID) {
    return {
      chatId: id,
      name: 'shay',
      systemPrompt: SHAY_SYSTEM_PROMPT,
      jargonTerms: SHAY_JARGON_TERMS,
    };
  }
  return {
    chatId: id,
    name: 'default',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    jargonTerms: [],
  };
}

// ---------------------------------------------------------------------------
// Stage 1: Deterministic checks
// ---------------------------------------------------------------------------

/**
 * Behaviour-promise pattern. Reuses the same regex as logging.ts so
 * existing tests remain the source of truth for what phrases are caught.
 */
export function containsBehaviourPromise(text: string): boolean {
  return /\b(?:i|we)(?:['']ll| will)\s+(?:do better|change|make sure|be (?:more|less|better)|stop\b|never\b|remember\b|keep (?:it|things|my)\b|not (?:do|say|send|repeat)\b|avoid\b)|\b(?:it|that)\s+won['']?t happen again\b|\bgoing forward\b|\bfrom now on\b/i.test(
    text,
  );
}

/**
 * "Done. The skill and fleet are updated." pattern — claims a behaviour
 * is fixed merely because files, tests, or configs were changed.
 *
 * Two alternatives:
 *   1. Same clause: `\bfixed\b[^.!?]{0,80}\bconfig\b` — no sentence boundary between words.
 *   2. Cross-sentence (≤ 5 words bridge): `\bdone\b.\s+(?:\w+\s+){0,5}\bskill\b` —
 *      catches "Done. The skill and fleet are updated." where period separates the clauses.
 */
export const FALSE_FIXED_REGEX =
  /\b(?:done|fixed|updated|corrected|changed|adjusted)\b(?:[^.!?]{0,80}|\.?\s+(?:\w+\s+){0,5})\b(?:skill|prompt|instruction|rule|test|config|guardrail|fleet)\b/i;

/**
 * "You're right. I'll change that." + padding — accountability paragraph.
 * Only triggers when word count > 20 to let a short "You're right. Got it." pass.
 */
export const ACCOUNTABILITY_REGEX =
  /\b(?:you(?:'re| are) right|i apologize|i'?m sorry|my mistake|that was wrong)\b/i;

/**
 * Empty accountability phrases that spend trust without communicating the
 * failure or its consequence. These are blocked even when short: the live
 * 2026-07-31 failure was a nine-word reply containing "That's on me", which
 * the former >20-word accountability rule deliberately allowed.
 */
export const EMPTY_APOLOGY_REGEX =
  /\b(?:that(?:'s| is) on me|this is on me|i (?:fully )?(?:own|take responsibility for) (?:that|this)|i take full responsibility)\b/i;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Run deterministic checks on a draft before any model call.
 *
 * Returns `reject: string` (hard block, stop) or `reject: null` (pass through
 * to semantic stage) plus `contextFlags` forwarded to the model prompt.
 */
export function runDeterministicChecks(
  chatId: string | number,
  text: string,
  deliverable: boolean,
): DeterministicResult {
  const contextFlags: string[] = [];

  if (!deliverable) {
    // 1. Behaviour promise
    if (containsBehaviourPromise(text)) {
      return {
        reject:
          'Blocked by checker: do not promise future behaviour to a person. Acknowledge briefly; improvement is proved only by later real conversations that offered a genuine chance to repeat the mistake.',
        contextFlags,
      };
    }

    // 2. False "fixed" claim
    if (FALSE_FIXED_REGEX.test(text)) {
      return {
        reject:
          'Blocked by checker: do not claim a behaviour is fixed merely because instructions, tests, or config changed. Improvement is proved only by real runtime behaviour.',
        contextFlags,
      };
    }

    // 3. Empty apology — block regardless of length.
    if (EMPTY_APOLOGY_REGEX.test(text)) {
      return {
        reject:
          'Blocked by checker: empty accountability phrase detected. State the concrete failure or useful status; do not spend another apology phrase.',
        contextFlags,
      };
    }

    // 4. Accountability paragraph (apology + padding)
    if (ACCOUNTABILITY_REGEX.test(text) && countWords(text) > 20) {
      return {
        reject:
          'Blocked by checker: accountability paragraph with padding detected. A short, honest acknowledgement is enough.',
        contextFlags,
      };
    }
  }

  // Jargon context flags for Shay (not a hard reject — semantic stage decides)
  const profile = resolveAudience(chatId);
  const detectedJargon = profile.jargonTerms.filter((term) =>
    text.toLowerCase().includes(term.toLowerCase()),
  );
  if (detectedJargon.length > 0) {
    contextFlags.push(
      `potential jargon detected: ${detectedJargon.map((t) => `"${t}"`).join(', ')}`,
    );
  }

  return { reject: null, contextFlags };
}

// ---------------------------------------------------------------------------
// Recent activity evidence
// ---------------------------------------------------------------------------

const EVIDENCE_EVENTS = new Set([
  'task_completed',
  'cron_completed',
  'output_created',
  'secret_rotated',
  'interaction_review_completed',
]);

/**
 * Read a bounded set of recent activity records for the semantic reviewer.
 * This keeps backend evidence backstage while giving the checker enough
 * context to distinguish a supported completion update from an invented one.
 *
 * Records are still agent-produced and therefore contextual support, not an
 * independent attestation. The system prompt requires a specific record that
 * directly matches the draft claim.
 */
export function buildRecentEvidence(
  analyticsDir: string,
  agentName: string,
  nowMs = Date.now(),
  maxAgeMs = 2 * 60 * 60 * 1000,
  limit = 6,
): string | null {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const eventPath = join(analyticsDir, 'events', agentName, `${day}.jsonl`);
  if (!existsSync(eventPath)) return null;

  try {
    const rows = readFileSync(eventPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as {
            timestamp?: string;
            event?: string;
            severity?: string;
            metadata?: Record<string, unknown>;
          };
        } catch {
          return null;
        }
      })
      .filter((row): row is NonNullable<typeof row> => {
        if (!row?.timestamp || !row.event || !EVIDENCE_EVENTS.has(row.event)) return false;
        const timestampMs = Date.parse(row.timestamp);
        return Number.isFinite(timestampMs) && timestampMs <= nowMs && nowMs - timestampMs <= maxAgeMs;
      })
      .slice(-limit)
      .map((row) => {
        const metadata = JSON.stringify(row.metadata ?? {});
        return `${row.timestamp} | ${row.event} | ${metadata.slice(0, 500)}`;
      });

    return rows.length > 0 ? rows.join('\n') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deliverable claim validation
// ---------------------------------------------------------------------------

/**
 * Validate a `--deliverable-for <inbound-msg-id>` claim against the inbound
 * message log for the given agent and chat.
 *
 * Returns:
 *   `deliverable: true` + `triggeringText` when the ID is found within the
 *   bounded window (last 10 messages for this chat, within 24 h).
 *
 *   `deliverable: false` + `triggeringText: null` for missing/stale/wrong-chat
 *   IDs. This is NOT an error — ordinary chat rules simply apply.
 */
export function validateDeliverableClaim(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  inboundMsgId: number | undefined,
): { deliverable: boolean; triggeringText: string | null } {
  if (inboundMsgId === undefined || !Number.isInteger(inboundMsgId)) {
    return { deliverable: false, triggeringText: null };
  }

  const logPath = join(ctxRoot, 'logs', agentName, 'inbound-messages.jsonl');
  if (!existsSync(logPath)) {
    return { deliverable: false, triggeringText: null };
  }

  const chatIdStr = String(chatId);
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000; // 24-h window

  try {
    const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);

    // Look in the last 10 inbound messages for this chat (bounded window)
    const forChat = lines
      .map((l) => {
        try {
          return JSON.parse(l) as {
            message_id?: number;
            chat_id?: string | number;
            text?: string;
            timestamp?: string;
            archived_at?: string;
          };
        } catch {
          return null;
        }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null && String(e.chat_id) === chatIdStr)
      .slice(-10);

    for (const entry of forChat) {
      if (entry.message_id !== inboundMsgId) continue;
      const tsRaw = entry.timestamp ?? entry.archived_at;
      const entryMs = tsRaw ? Date.parse(tsRaw) : 0;
      if (entryMs < cutoffMs) break; // too old
      return { deliverable: true, triggeringText: entry.text ?? '' };
    }
  } catch {
    // Unreadable log — treat as no claim
  }

  return { deliverable: false, triggeringText: null };
}

// ---------------------------------------------------------------------------
// Gerald told-gate shadow log (STEP 2 — record-only, non-enforcing)
// ---------------------------------------------------------------------------

/** Gerald's Telegram chat ID. The shadow log fires for this chat only. */
const GERALD_CHAT_ID = '8602224961';

/**
 * Record-only "told-gate" declaration for Gerald-facing sends.
 *
 * STEP 2 of the staged told-gate rollout (see
 * orgs/todi-and-boys/agents/rimu/scripts/plan_told_gate_shared_state.md §4).
 * This function is pure record-keeping: it appends a shadow-log entry
 * describing what the producer declared, so a later diff can compare the
 * declaration against what was actually sent. It NEVER blocks, rejects, or
 * alters a send, and it has no return value. Enforcement is a separate,
 * not-yet-approved step 3.
 *
 * True no-op for every chat other than Gerald's — no file I/O occurs.
 * Never throws: failures are swallowed, mirroring writeCheckerAudit above.
 */
export function recordGeraldToldGateShadow(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
  geraldItems: string | undefined,
): void {
  if (String(chatId) !== GERALD_CHAT_ID) return;

  try {
    const itemsDeclared = typeof geraldItems === 'string' && geraldItems.trim().length > 0;
    const items = itemsDeclared
      ? geraldItems!
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : null;

    const entry = {
      timestamp: new Date().toISOString(),
      agent: agentName,
      chat_id: String(chatId),
      items_declared: itemsDeclared,
      items,
      text_preview: text.slice(0, 100),
    };

    const logDir = join(ctxRoot, 'logs', agentName);
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      join(logDir, 'gerald-told-gate-shadow.jsonl'),
      JSON.stringify(entry) + '\n',
      'utf-8',
    );
  } catch {
    // Non-fatal: shadow-log write failures are swallowed and never block a send.
  }
}

// ---------------------------------------------------------------------------
// Stage 2: Semantic check
// ---------------------------------------------------------------------------

/**
 * Run the semantic check using the injected ModelClient.
 * Fail-closed: any exception from the client becomes a checker error
 * (the caller must treat that as a rejection).
 */
export async function runSemanticCheck(
  profile: AudienceProfile,
  userContent: string,
  client: ModelClient,
): Promise<CheckerResult> {
  return client.check(profile.systemPrompt, userContent);
}

// ---------------------------------------------------------------------------
// New-topic detection
// ---------------------------------------------------------------------------

/**
 * Small stopword list for detectTopicShift. Only needs to cover common words
 * that are 4+ chars (the tokenizer already drops anything shorter) and would
 * otherwise create a false "shared topic" signal between two genuinely
 * unrelated messages.
 */
const TOPIC_SHIFT_STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'your', 'need', 'know', 'just', 'been',
  'they', 'them', 'then', 'than', 'what', 'when', 'where', 'which', 'about',
  'there', 'here', 'still', 'also', 'into', 'only', 'some', 'more', 'send',
  'sent', 'message', 'draft', 'will', 'have', 'want', 'like', 'good', 'today',
  'told', 'said', 'right', 'sure', 'okay', 'yeah', 'done', 'thing', 'things',
]);

function tokenizeForTopicShift(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !TOPIC_SHIFT_STOPWORDS.has(w)),
  );
}

/**
 * Heuristic, advisory-only detector for "this draft is probably not a
 * continuation of Recent conversation."
 *
 * `recentHistory` (buildRecentHistory) only ever reflects the Telegram
 * thread — it has zero visibility into topics an agent legitimately needs
 * to relay from elsewhere (most commonly the internal agent-to-agent bus).
 * When a draft on one of those topics is checked against a stale, unrelated
 * `recentHistory`, the semantic reviewer has no signal that it should judge
 * the draft on its own merits rather than forcing a rewrite anchored to
 * whatever topic Recent conversation happens to contain.
 *
 * Deliberately conservative: returns true only when both texts have
 * extractable significant words and share none of them. A false negative
 * just leaves today's behaviour unchanged; a false positive only adds an
 * advisory note ahead of the (still fully included) Recent conversation
 * text, so the model can disregard it if the content is, in fact, related.
 */
export function detectTopicShift(draftText: string, recentHistory: string | null): boolean {
  if (!recentHistory) return false;
  const draftWords = tokenizeForTopicShift(draftText);
  const historyWords = tokenizeForTopicShift(recentHistory);
  if (draftWords.size === 0 || historyWords.size === 0) return false;
  for (const word of draftWords) {
    if (historyWords.has(word)) return false;
  }
  return true;
}

/** Advisory note injected into the checker's user content when detectTopicShift fires. */
const NEW_TOPIC_NOTE =
  "Note: Recent conversation below reflects only this Telegram thread, not everything " +
  "the agent legitimately needs to relay (for example, something surfaced by another " +
  "agent that has never come up here). This draft shares no obvious subject-matter " +
  "with Recent conversation — evaluate it as an independent topic on its own merits. " +
  "Do not select or invent a rewrite that recites or is anchored to Recent " +
  "conversation's topic; any rewrite must address this draft's own subject.";

// ---------------------------------------------------------------------------
// User content assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the user content block sent to the semantic model.
 * Minimal context — only what's needed for the check.
 */
export function assembleUserContent(opts: {
  contextFlags: string[];
  triggeringText: string | null;
  recentHistory: string | null;
  recentEvidence?: string | null;
  draftText: string;
}): string {
  const parts: string[] = [];

  if (opts.contextFlags.length > 0) {
    parts.push(opts.contextFlags.join('\n'));
  }

  if (detectTopicShift(opts.draftText, opts.recentHistory)) {
    parts.push(NEW_TOPIC_NOTE);
  }

  if (opts.triggeringText) {
    parts.push(`Requested deliverable (triggering inbound message):\n"${opts.triggeringText}"`);
  }

  if (opts.recentHistory) {
    parts.push(`Recent conversation:\n${opts.recentHistory}`);
  } else {
    parts.push('Recent conversation:\n(no prior history)');
  }

  if (opts.recentEvidence) {
    parts.push(
      `Recent activity records (contextual support; require a specific matching record):\n${opts.recentEvidence}`,
    );
  } else {
    parts.push('Recent activity records:\n(none)');
  }

  parts.push(`Draft reply:\n${opts.draftText}`);

  return parts.join('\n\n');
}

/**
 * Assemble the semantic-review context from the live analytics path.
 * Keeping the evidence read and prompt assembly in one tested function makes
 * it harder for the daemon send path to silently drop completion evidence.
 */
export function assembleCheckerContext(opts: {
  analyticsDir: string;
  agentName: string;
  contextFlags: string[];
  triggeringText: string | null;
  recentHistory: string | null;
  draftText: string;
  nowMs?: number;
}): string {
  return assembleUserContent({
    contextFlags: opts.contextFlags,
    triggeringText: opts.triggeringText,
    recentHistory: opts.recentHistory,
    recentEvidence: buildRecentEvidence(opts.analyticsDir, opts.agentName, opts.nowMs),
    draftText: opts.draftText,
  });
}

// ---------------------------------------------------------------------------
// OpenAI Responses API client
// ---------------------------------------------------------------------------

/**
 * Create a real ModelClient backed by the OpenAI Responses API.
 * Uses native fetch — no extra package dependency.
 * Fail-closed: API errors and timeouts throw, causing the caller to reject.
 */
export function createOpenAIClient(apiKey: string, config: CheckerConfig): ModelClient {
  return {
    async check(systemPrompt: string, userContent: string): Promise<CheckerResult> {
      const body = {
        model: config.model,
        reasoning: { effort: 'none' },
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'checker_result',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                pass: { type: 'boolean' },
                reason: { type: ['string', 'null'] },
                rewrite: { type: ['string', 'null'] },
              },
              required: ['pass', 'reason', 'rewrite'],
              additionalProperties: false,
            },
          },
        },
        max_output_tokens: config.tokenCap,
      };

      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        config.timeoutMs,
      );

      let resp: Response;
      try {
        resp = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        if ((err as Error)?.name === 'AbortError') {
          throw new Error(`Checker model timed out after ${config.timeoutMs}ms`);
        }
        throw new Error(`Checker network error: ${(err as Error).message ?? String(err)}`);
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(
          `Checker API error ${resp.status}: ${errText.slice(0, 200)}`,
        );
      }

      const data = (await resp.json()) as {
        output?: Array<{ content?: Array<{ text?: string }> }>;
        output_text?: string;
      };

      // Responses API: output[0].content[0].text holds the JSON
      const outputText =
        data?.output?.[0]?.content?.[0]?.text ?? data?.output_text ?? '';

      if (!outputText) {
        throw new Error('Empty response from checker model');
      }

      let parsed: { pass: boolean; reason: string | null; rewrite: string | null };
      try {
        parsed = JSON.parse(outputText);
      } catch {
        throw new Error(`Invalid JSON from checker model: ${outputText.slice(0, 100)}`);
      }

      if (typeof parsed.pass !== 'boolean') {
        throw new Error('Checker model response missing required "pass" field');
      }

      if (parsed.pass) {
        return { pass: true };
      }

      return {
        pass: false,
        reason: String(parsed.reason ?? 'Rejected by semantic checker'),
        rewrite: String(parsed.rewrite ?? ''),
      };
    },
  };
}

/**
 * Create a ModelClient backed by the host's locally authenticated Codex CLI.
 * The paid API key is deliberately removed so reviewer availability does not
 * depend on a separate API credit balance.
 */
export function createCodexClient(config: CheckerConfig): ModelClient {
  return {
    async check(systemPrompt: string, userContent: string): Promise<CheckerResult> {
      const prompt = [
        systemPrompt,
        '',
        userContent,
        '',
        'Return only one JSON object with exactly these keys:',
        '{"pass":boolean,"reason":string|null,"rewrite":string|null}',
      ].join('\n');
      const childEnv = { ...process.env };
      delete childEnv.OPENAI_API_KEY;

      const timeoutMs = Math.max(config.timeoutMs, 20_000);
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn('codex', [
          'exec',
          '--skip-git-repo-check',
          '--model', config.model,
          '--sandbox', 'read-only',
          '--json',
          prompt,
        ], {
          cwd: '/tmp',
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdin.end();
        let output = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Codex checker timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on('data', (chunk) => { output += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(new Error(`Codex checker error: ${err.message}`));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(output);
          else reject(new Error(`Codex checker exited ${code}: ${stderr.slice(0, 200)}`));
        });
      });

      let outputText = '';
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as {
            type?: string;
            item?: { type?: string; text?: string };
          };
          if (event.type === 'item.completed'
            && event.item?.type === 'agent_message'
            && typeof event.item.text === 'string') {
            outputText = event.item.text;
          }
        } catch {
          // Ignore CLI diagnostics; missing agent output fails closed below.
        }
      }

      if (!outputText) throw new Error('Empty response from Codex checker');

      let parsed: { pass: boolean; reason: string | null; rewrite: string | null };
      try {
        parsed = JSON.parse(outputText);
      } catch {
        throw new Error(`Invalid JSON from Codex checker: ${outputText.slice(0, 100)}`);
      }
      if (typeof parsed.pass !== 'boolean') {
        throw new Error('Codex checker response missing required "pass" field');
      }
      return parsed.pass
        ? { pass: true }
        : {
            pass: false,
            reason: String(parsed.reason ?? 'Rejected by semantic checker'),
            rewrite: String(parsed.rewrite ?? ''),
          };
    },
  };
}

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

/**
 * Append a checker audit entry to {ctxRoot}/logs/{agentName}/message-checker-audit.jsonl.
 * Never throws — audit failures must not block sends.
 */
export function writeCheckerAudit(
  ctxRoot: string,
  agentName: string,
  entry: CheckerAuditEntry,
): void {
  try {
    const logDir = join(ctxRoot, 'logs', agentName);
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      join(logDir, 'message-checker-audit.jsonl'),
      JSON.stringify(entry) + '\n',
      'utf-8',
    );
  } catch {
    // Non-fatal: audit write failures are swallowed
  }
}
