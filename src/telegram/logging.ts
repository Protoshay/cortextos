/**
 * Telegram message logging and last-sent context caching.
 * Matches the bash send-telegram.sh outbound logging (lines 100-108)
 * and last-sent cache (lines 111-113).
 */

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { logEvent } from '../bus/event.js';
import type { BusPaths, TelegramMessage } from '../types/index.js';

/**
 * Optional metadata attached to an outbound Telegram message log entry.
 * Fields are all optional so existing callers that pass nothing still
 * produce the same JSONL shape as before this extension.
 *
 * - `parseMode`: which parse_mode the first send attempt used. "html"
 *   for the default path (Markdown-to-HTML conversion), "none" when the
 *   caller used --plain-text.
 * - `correctionOf`: the message ID of the immediately preceding outbound
 *   message this send corrects, allowing only the cadence bypass.
 */
export interface OutboundLogMetadata {
  parseMode?: 'html' | 'none';
  correctionOf?: number;
}

function openQuestionPath(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
): string {
  const safeChatId = String(chatId).replace(/[^0-9-]/g, '_');
  return join(ctxRoot, 'state', agentName, `.telegram-open-question-${safeChatId}.json`);
}

interface HumanLogEntry {
  chat_id?: string | number;
  message_id?: number;
  text?: string;
  timestamp?: string;
  archived_at?: string;
}

function readHumanLog(
  ctxRoot: string,
  agentName: string,
  direction: 'inbound' | 'outbound',
): HumanLogEntry[] {
  const path = join(ctxRoot, 'logs', agentName, `${direction}-messages.jsonl`);
  if (!existsSync(path)) return [];

  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HumanLogEntry);
  } catch (err) {
    throw new Error(`Could not verify recent ${direction} Telegram history: ${err}`);
  }
}

function entryTime(entry: HumanLogEntry): number {
  const raw = entry.timestamp ?? entry.archived_at;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error('Could not verify Telegram history because an entry has no valid timestamp');
  }
  return parsed;
}

function latestEntryTime(entries: HumanLogEntry[], chatId: string | number): number | null {
  const matching = entries.filter((entry) => String(entry.chat_id) === String(chatId));
  if (matching.length === 0) return null;
  return Math.max(...matching.map(entryTime));
}

export function containsBehaviourPromise(text: string): boolean {
  return /\b(?:i|we)(?:['’]ll| will)\s+(?:do better|change|make sure|be (?:more|less|better)|stop\b|never\b|remember\b|keep (?:it|things|my)\b|not (?:do|say|send|repeat)\b|avoid\b)|\b(?:it|that)\s+won['’]?t happen again\b|\bgoing forward\b|\bfrom now on\b/i.test(text);
}

/**
 * Count direct questions in human-facing chat text.
 * URL query strings are removed first so links do not trip the gate.
 */
export function countHumanQuestions(text: string): number {
  const withoutUrls = text.replace(/https?:\/\/\S+/gi, '');
  return (withoutUrls.match(/\?/g) ?? []).length;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Reject common human-conversation failures before Telegram delivery.
 *
 * This is intentionally narrow: code can reliably catch word ceilings and
 * backstage narration, while tone still belongs to the conversation skills.
 */
export function checkHumanConversationGate(
  chatId: string | number,
  text: string,
  deliverable = false,
): string | null {
  if (deliverable) return null;

  const words = countWords(text);
  if (words > 50) {
    return `Blocked: conversational Telegram replies may not exceed 50 words (received ${words}). Shorten it, or if this is a report/document the person actually asked for, resend with --deliverable-for <inbound-message-id> naming the message that requested it.`;
  }

  if (containsBehaviourPromise(text)) {
    return 'Blocked: do not promise future behaviour to a person. Acknowledge briefly. Improvement is proved only by later real conversations that offered a genuine chance to repeat the mistake.';
  }

  const thinkingAloud = /\b(?:i(?:['’]m| am)|we(?:['’]re| are))\s+(?:checking|investigating|looking into|tracing|reviewing|comparing|verifying)\b|\bi(?:['’]ll| will)\s+(?:check|investigate|look into|trace|review|compare|verify)\b/i;
  if (thinkingAloud.test(text) && words > 20) {
    return 'Blocked: this narrates backstage work. Investigate silently and send the useful result; if an immediate acknowledgement is required, use a brief natural acknowledgement such as “On it.”';
  }

  // Shay explicitly wants simple confirmations to sound like normal speech,
  // not padded mini-reports. Keep this narrow to messages that already begin
  // as a direct confirmation.
  if (
    String(chatId) === '8721344756'
    && /^(?:yes|no|yep|nope|done|sure|correct|exactly)\b/i.test(text.trim())
    && words > 16
  ) {
    return `Blocked: this direct confirmation to Shay is padded (${words} words). Keep it to one short sentence (16 words maximum), then wait.`;
  }

  if (
    String(chatId) === '8721344756'
    && /\b(?:guardrail|gate|protection|authori[sz]ed|scope|directive|runtime|bootstrap|handoff|injection|process environment)\b/i.test(text)
  ) {
    return 'Blocked: this uses internal or formal language with Shay. Rewrite the human point in ordinary words and keep the machinery backstage.';
  }

  return null;
}

/**
 * A FENSA count or list sent to a person must state the time range it covers.
 *
 * Measured 2026-08-12 across this agent's own outbound log: of 148 FENSA-
 * mentioning messages to the ops lead between 2026-05-21 and 2026-08-11, ZERO
 * contained any terminal output and ZERO stated a time range. The generating
 * script was fixed the same day to require an explicit --window and to print it
 * in a header, but that header never reaches the person: every count is relayed
 * as a conversational sentence. The guard therefore has to live here, in the
 * writer, because the terminal and the conversation are different surfaces.
 *
 * ⛔ `window` IS DELIBERATELY NOT A SATISFYING TOKEN. This is a joinery
 * business: "window" is the product. A first attempt at measuring the problem
 * scored 6 of 13 messages as carrying a time window and all six were glazing
 * units. If the product noun satisfied this gate, "4 windows and 2 doors" would
 * satisfy it, and the gate would pass precisely the message it exists to stop.
 *
 * Deliberately NOT exempt for deliverables, unlike the style and cadence gates:
 * the historical failure was a requested list, so exempting requested lists
 * would exempt the only case that has actually gone wrong.
 *
 * Fail direction is toward refusal. A false block costs one rewrite and is
 * visible; a false pass is invisible and is the defect itself.
 */
const FENSA_COUNT_NOUNS = 'jobs?|installs?|installations?|registrations?|certificates?|submissions?|rows?|entries|outstanding|pending|unticked|awaiting|done|fitted';

/** A number quantifying a set of jobs, or an enumerated list of 2+ rows. */
function looksLikeFensaCount(text: string): boolean {
  // Digit quantifying a job-ish noun within the same clause.
  if (new RegExp(String.raw`\b\d{1,3}\b[^.\n]{0,45}\b(?:${FENSA_COUNT_NOUNS})\b`, 'i').test(text)) {
    return true;
  }
  // Spelled-out number immediately quantifying a job-ish noun. Kept tight so a
  // single-job product description ("one set of doors and two windows") does
  // not trip it — that is a legitimate message, not a count answer.
  if (new RegExp(String.raw`\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:${FENSA_COUNT_NOUNS})\b`, 'i').test(text)) {
    return true;
  }
  // An enumerated list of two or more rows.
  const rows = text.match(/^\s*\d+[.)]\s+\S/gm);
  return (rows?.length ?? 0) >= 2;
}

const MONTH = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';

/** An explicitly stated time range, or an explicit statement of unboundedness. */
function statesTimeRange(text: string): boolean {
  const JOIN = String.raw`\s*(?:to|and|until|through|–|—|-|\.\.)\s*`;
  const ISO = String.raw`\d{4}-\d{2}-\d{2}`;
  const TEXTUAL = String.raw`(?:\d{1,2}\s+)?(?:${MONTH})[a-z]*\.?\s+\d{4}`;
  const patterns = [
    // 2025-09-01 to 2026-08-12
    new RegExp(ISO + JOIN + ISO, 'i'),
    // Sept 2025 to Dec 2025 / 17 Sep 2025 — 19 Dec 2025
    new RegExp(TEXTUAL + JOIN + TEXTUAL, 'i'),
    // in the last 3 months / over the past 90 days
    /\b(?:in|over|during|for|from)\s+the\s+(?:last|past)\s+\d+\s+(?:days?|weeks?|months?|years?)\b/i,
    // since 2025-09-01 / since Sept 2025 / up to 12 Aug 2026
    new RegExp(String.raw`\b(?:since|before|after|up\s+to|as\s+(?:at|of))\s+(?:${ISO}|${TEXTUAL})`, 'i'),
    // explicit unboundedness — the counterpart of the script's `--window ALL`
    /\b(?:all\s+time|all\s+dates|any\s+date|no\s+(?:date\s+)?(?:cut-?off|limit|filter|range)|unbounded|regardless\s+of\s+date|every\s+job\s+on\s+the\s+board|going\s+back\s+to\s+the\s+start)\b/i,
  ];
  return patterns.some((p) => p.test(text));
}

export function checkFensaWindowGate(text: string): string | null {
  // Substring, NOT /\bfensa\b/. The real message this gate exists to catch
  // opened "Here are the outstanding FENSAs" — a trailing word boundary misses
  // the plural, and the tighter form was silently inert on it.
  if (!/fensa/i.test(text)) return null;
  if (!looksLikeFensaCount(text)) return null;
  if (statesTimeRange(text)) return null;

  return 'Blocked: this is a FENSA count or list with no time range stated. Say which period it covers (for example "since Sept 2025", "2025-09-01 to 2026-08-12", or "all time, no date cut-off"). A count without its window is not a smaller answer to the same question — it answers a different question and looks identical on the page. Note that "windows" as a product does not count as stating a range, and neither does the span of the results themselves ("from Ming Ming last Sept to Alysha in December"): a range derived from the answer moves with the answer and can never contradict it.';
}

/**
 * Enforce one open conversational question per human/chat.
 *
 * A requested deliverable may contain a question list in one message, but it
 * still cannot be sent while an earlier conversational question is unanswered.
 */
export function checkHumanQuestionGate(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
  deliverable = false,
): string | null {
  const questionCount = countHumanQuestions(text);
  if (questionCount === 0) return null;

  if (existsSync(openQuestionPath(ctxRoot, agentName, chatId))) {
    return 'Blocked: the previous question to this person is still unanswered. Wait for their reply before opening another question.';
  }

  try {
    const inbound = readHumanLog(ctxRoot, agentName, 'inbound');
    const lastInboundAt = latestEntryTime(inbound, chatId) ?? Number.NEGATIVE_INFINITY;
    const hasUnansweredLoggedQuestion = readHumanLog(ctxRoot, agentName, 'outbound')
      .filter((entry) => String(entry.chat_id) === String(chatId))
      .some((entry) => entryTime(entry) > lastInboundAt && countHumanQuestions(entry.text ?? '') > 0);
    if (hasUnansweredLoggedQuestion) {
      return 'Blocked: the conversation log shows an earlier question to this person is still unanswered. Wait for their reply before opening another question.';
    }
  } catch (err) {
    return `Blocked: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (!deliverable && questionCount > 1) {
    return 'Blocked: conversational Telegram messages may ask only one question. Ask the one useful question now, or if this is a document/report the person actually asked for, resend with --deliverable-for <inbound-message-id> naming the message that requested it.';
  }

  return null;
}

/**
 * Prevent rapid successive conversational sends from becoming a multi-message
 * dump. A human reply opens a new turn. Requested deliverables are exempt.
 */
export function checkHumanMessageCadenceGate(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  deliverable = false,
  correctionOf?: number,
  now = Date.now(),
): string | null {
  if (deliverable) return null;

  try {
    const outbound = readHumanLog(ctxRoot, agentName, 'outbound')
      .filter((entry) => String(entry.chat_id) === String(chatId))
      .sort((a, b) => entryTime(b) - entryTime(a));
    const lastOutbound = outbound[0];
    const lastOutboundAt = lastOutbound ? entryTime(lastOutbound) : null;
    if (lastOutboundAt === null) return null;

    if (correctionOf !== undefined) {
      if (!Number.isInteger(correctionOf) || correctionOf <= 0) {
        return 'Blocked: --correction-of must name a valid Telegram message ID.';
      }
      if (lastOutbound?.message_id !== correctionOf) {
        return 'Blocked: --correction-of must name your immediately preceding message in this chat.';
      }
      return null;
    }

    const lastInboundAt = latestEntryTime(readHumanLog(ctxRoot, agentName, 'inbound'), chatId);
    if (lastInboundAt !== null && lastInboundAt > lastOutboundAt) return null;

    const elapsed = now - lastOutboundAt;
    if (elapsed < 0) {
      return 'Blocked: recent Telegram timing could not be verified because the last message is dated in the future.';
    }
    if (elapsed < 10_000) {
      return 'Blocked: another message was sent to this person less than 10 seconds ago without a reply. Combine the thought into one message or wait.';
    }
    return null;
  } catch (err) {
    return `Blocked: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Record a successfully delivered human-facing question. */
export function markHumanQuestionOpen(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
  messageId: number,
): void {
  if (countHumanQuestions(text) === 0) return;
  const path = openQuestionPath(ctxRoot, agentName, chatId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    opened_at: new Date().toISOString(),
    message_id: messageId,
  }), 'utf-8');
}

/** Any inbound human message resolves the prior conversational turn. */
export function clearHumanQuestion(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
): void {
  try {
    unlinkSync(openQuestionPath(ctxRoot, agentName, chatId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Append an outbound message to the agent's JSONL log.
 * Path: {ctxRoot}/logs/{agentName}/outbound-messages.jsonl
 */
export function logOutboundMessage(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
  messageId: number,
  metadata?: OutboundLogMetadata,
): void {
  const logDir = join(ctxRoot, 'logs', agentName);
  mkdirSync(logDir, { recursive: true });

  // Only emit metadata fields that were actually set so the base log shape
  // stays unchanged for callers that pass nothing (backwards compat).
  const meta: Record<string, unknown> = {};
  if (metadata?.parseMode !== undefined) meta.parse_mode = metadata.parseMode;
  if (metadata?.correctionOf !== undefined) meta.correction_of = metadata.correctionOf;

  const entry = JSON.stringify({
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: agentName,
    chat_id: String(chatId),
    text,
    message_id: messageId,
    ...meta,
  });

  appendFileSync(join(logDir, 'outbound-messages.jsonl'), entry + '\n', 'utf-8');
}

/**
 * Append an inbound message to the agent's JSONL log.
 * Path: {ctxRoot}/logs/{agentName}/inbound-messages.jsonl
 */
export function logInboundMessage(
  ctxRoot: string,
  agentName: string,
  rawMessage: object,
): void {
  const logDir = join(ctxRoot, 'logs', agentName);
  mkdirSync(logDir, { recursive: true });

  const entry = JSON.stringify({
    ...rawMessage,
    archived_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: agentName,
  });

  appendFileSync(join(logDir, 'inbound-messages.jsonl'), entry + '\n', 'utf-8');
}

/**
 * Persist an inbound Telegram message to the daemon's JSONL archive AND
 * emit a `message/telegram_received` bus event so dashboards and
 * experiment cycles can count fleet-wide inbound traffic. Symmetric with
 * `telegram_sent` emitted from the outbound path in `cortextos bus
 * send-telegram`.
 *
 * Wrapped: a logEvent failure (e.g. unwritable analytics dir) must not
 * break message processing — the logged inbound JSONL still goes through.
 */
export function recordInboundTelegram(
  paths: BusPaths,
  ctxRoot: string,
  agentName: string,
  org: string,
  fromName: string,
  msg: TelegramMessage,
  log?: (m: string) => void,
): void {
  const text = (msg.text || msg.caption || '').toString();
  logInboundMessage(ctxRoot, agentName, {
    message_id: msg.message_id,
    from: msg.from?.id,
    from_name: fromName,
    chat_id: msg.chat?.id,
    text,
    timestamp: new Date().toISOString(),
  });
  clearHumanQuestion(ctxRoot, agentName, msg.chat?.id ?? '');

  const hasMedia = !!(msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.video_note);
  try {
    logEvent(paths, agentName, org, 'message', 'telegram_received', 'info', {
      chat_id: String(msg.chat?.id ?? ''),
      message_id: msg.message_id,
      from_id: msg.from?.id,
      from_name: fromName,
      has_media: hasMedia,
      text_chars: text.length,
    });
  } catch (err) {
    log?.(`logEvent(telegram_received) failed: ${err}`);
  }
}

/**
 * Cache the last-sent text for a given chat.
 * Path: {ctxRoot}/state/{agentName}/last-telegram-{chatId}.txt
 */
export function cacheLastSent(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
): void {
  const stateDir = join(ctxRoot, 'state', agentName);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `last-telegram-${chatId}.txt`), text, 'utf-8');
}

/**
 * Read the last-sent text for a given chat, or null if not cached.
 */
export function readLastSent(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
): string | null {
  const filePath = join(ctxRoot, 'state', agentName, `last-telegram-${chatId}.txt`);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, 'utf-8');
}

/**
 * Build a short recent conversation snippet for context injection.
 * Reads the last cputime         unlimited
filesize        unlimited
datasize        unlimited
stacksize       7MB


/**
 * Build a short recent conversation snippet for context injection.
 * Reads the last `limit` messages (combined inbound + outbound) for the
 * given agent/chatId, sorts by timestamp, and returns a formatted string.
 * Returns null if no history is available.
 */
export function buildRecentHistory(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  limit: number = 6,
): string | null {
  const logDir = join(ctxRoot, 'logs', agentName);
  const inboundPath = join(logDir, 'inbound-messages.jsonl');
  const outboundPath = join(logDir, 'outbound-messages.jsonl');
  const chatIdStr = String(chatId);

  interface Entry { ts: string; speaker: string; text: string; }
  const entries: Entry[] = [];

  const readLines = (filePath: string, speaker: string) => {
    if (!existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, 'utf-8').trim();
      if (!raw) return;
      const lines = raw.split('\n').filter(Boolean);
      const tail = lines.slice(-(limit * 2));
      for (const line of tail) {
        try {
          const obj = JSON.parse(line);
          if (String(obj.chat_id) !== chatIdStr) continue;
          const text = (obj.text || '').trim();
          if (!text) continue;
          entries.push({ ts: obj.timestamp || obj.archived_at || '', speaker, text });
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  };

  readLines(inboundPath, process.env.ADMIN_USERNAME ?? 'user');
  readLines(outboundPath, agentName);

  if (entries.length === 0) return null;

  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const recent = entries.slice(-limit);

  const formatted = recent.map(e => {
    const preview = e.text.length > 200 ? e.text.slice(0, 200) + '...' : e.text;
    return '[' + e.speaker + ']: ' + preview;
  });

  return formatted.join('\n');
}
