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
 */
export interface OutboundLogMetadata {
  parseMode?: 'html' | 'none';
}

function openQuestionPath(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
): string {
  const safeChatId = String(chatId).replace(/[^0-9-]/g, '_');
  return join(ctxRoot, 'state', agentName, `.telegram-open-question-${safeChatId}.json`);
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
    return `Blocked: conversational Telegram replies may not exceed 50 words (received ${words}). Shorten it or use --deliverable for a requested report/document.`;
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

  if (!deliverable && questionCount > 1) {
    return 'Blocked: conversational Telegram messages may ask only one question. Use one useful question now, or --deliverable for a requested document/report.';
  }

  return null;
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
