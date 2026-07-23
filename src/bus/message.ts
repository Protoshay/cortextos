import { readdirSync, readFileSync, renameSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { createHmac, timingSafeEqual } from 'crypto';
import type { InboxMessage, Priority, BusPaths } from '../types/index.js';
import { PRIORITY_MAP } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { randomString } from '../utils/random.js';
import { validateAgentName, validatePriority } from '../utils/validate.js';

// ---------------------------------------------------------------------------
// Security (H10): HMAC-SHA256 message signing
// ---------------------------------------------------------------------------

/**
 * Load the shared bus signing key from config.
 * Returns null if the key file doesn't exist (legacy installs without signing).
 */
function loadSigningKey(ctxRoot: string): string | null {
  const keyPath = join(ctxRoot, 'config', 'bus-signing-key');
  if (!existsSync(keyPath)) return null;
  try {
    return readFileSync(keyPath, 'utf-8').trim();
  } catch {
    return null;
  }
}

function hmacSign(key: string, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

function hmacVerify(key: string, payload: string, sig: string): boolean {
  const expected = hmacSign(key, payload);
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

function signPayload(msgId: string, from: string, to: string, text: string): string {
  return `${msgId}:${from}:${to}:${text}`;
}

/**
 * Send a message to another agent's inbox.
 * Creates a JSON file with format: {pnum}-{epochMs}-from-{sender}-{rand5}.json
 * Identical to bash send-message.sh output.
 */
export function sendMessage(
  paths: BusPaths,
  from: string,
  to: string,
  priority: Priority,
  text: string,
  replyTo?: string,
): string {
  validateAgentName(from);
  validateAgentName(to);
  validatePriority(priority);

  const pnum = PRIORITY_MAP[priority];
  const epochMs = Date.now();
  const rand = randomString(5);
  const msgId = `${epochMs}-${from}-${rand}`;
  const filename = `${pnum}-${epochMs}-from-${from}-${rand}.json`;

  // Security (H10): Sign message with HMAC-SHA256.
  const signingKey = loadSigningKey(paths.ctxRoot);
  const message: InboxMessage = {
    id: msgId,
    from,
    to,
    priority,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    text,
    reply_to: replyTo || null,
    ...(signingKey ? { sig: hmacSign(signingKey, signPayload(msgId, from, to, text)) } : {}),
  };

  // Write to target agent's inbox
  const inboxDir = join(paths.ctxRoot, 'inbox', to);
  ensureDir(inboxDir);
  atomicWriteSync(join(inboxDir, filename), JSON.stringify(message));

  // Wedge-recovery bookkeeping: stamp the SENDER's last-send time. This is the
  // "last confirmed outbound" signal used to bound the re-queue window when a
  // wedged session is force-fresh restarted (see requeueWedgedMessages).
  stampLastSend(paths.ctxRoot, from, epochMs);

  return msgId;
}

/**
 * Record the timestamp of an agent's most recent outbound message.
 * Written to state/<agent>/.last-send. Used as a "last confirmed live" signal
 * to bound the wedge-recovery re-queue window. Best-effort — never throws.
 */
function stampLastSend(ctxRoot: string, from: string, epochMs: number): void {
  try {
    const stateDir = join(ctxRoot, 'state', from);
    ensureDir(stateDir);
    atomicWriteSync(join(stateDir, '.last-send'), String(epochMs));
  } catch {
    // Non-fatal: the re-queue window falls back to other live signals.
  }
}

/**
 * Check inbox for pending messages.
 * Reads inbox directory, moves messages to inflight, returns sorted array.
 * Recovers stale inflight messages (>5 minutes old).
 * Identical to bash check-inbox.sh behavior.
 */
export function checkInbox(paths: BusPaths): InboxMessage[] {
  const { inbox, inflight } = paths;
  ensureDir(inbox);
  ensureDir(inflight);

  // Acquire lock
  if (!acquireLock(inbox)) {
    return [];
  }

  try {
    // Recover stale inflight messages (>5 min old)
    recoverStaleInflight(inflight, inbox, 300);

    // Read and sort messages by filename (priority then timestamp)
    const files = readdirSync(inbox)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .sort();

    if (files.length === 0) {
      return [];
    }

    // Security (H10): Load signing key for HMAC verification.
    const signingKey = loadSigningKey(paths.ctxRoot);

    const messages: InboxMessage[] = [];
    for (const file of files) {
      const srcPath = join(inbox, file);
      try {
        const content = readFileSync(srcPath, 'utf-8');
        const msg: InboxMessage = JSON.parse(content);

        // Security (H10): Verify HMAC signature if key is available and message has sig.
        if (signingKey && msg.sig) {
          const valid = hmacVerify(signingKey, signPayload(msg.id, msg.from, msg.to, msg.text), msg.sig);
          if (!valid) {
            console.error(`[bus/message] SECURITY: Message ${msg.id} from '${msg.from}' failed HMAC verification — rejecting`);
            const errDir = join(inbox, '.errors');
            ensureDir(errDir);
            try { renameSync(srcPath, join(errDir, file)); } catch { /* ignore */ }
            continue;
          }
        } else if (signingKey && !msg.sig) {
          // Signing key exists but message has no sig — legacy message, log warning
          console.warn(`[bus/message] WARNING: Unsigned message ${msg.id} from '${msg.from}' — accepted (legacy)`);
        }

        // Move to inflight
        const destPath = join(inflight, file);
        renameSync(srcPath, destPath);
        messages.push(msg);
      } catch {
        // Move corrupt files to .errors/
        const errDir = join(inbox, '.errors');
        ensureDir(errDir);
        try {
          renameSync(srcPath, join(errDir, file));
        } catch {
          // Ignore if move fails
        }
      }
    }

    return messages;
  } finally {
    releaseLock(inbox);
  }
}

/**
 * Acknowledge a message by moving it from inflight to processed.
 * Identical to bash ack-inbox.sh behavior.
 */
export function ackInbox(paths: BusPaths, messageId: string): void {
  const { inflight, processed } = paths;
  ensureDir(processed);

  // Find the file in inflight that contains this message ID
  let files: string[];
  try {
    files = readdirSync(inflight).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = join(inflight, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const msg = JSON.parse(content);
      if (msg.id === messageId) {
        renameSync(filePath, join(processed, file));
        return;
      }
    } catch {
      // Skip corrupt files
    }
  }
}

/**
 * Wedge-recovery: determine the newest moment an agent was confirmed alive.
 *
 * Used to LOWER-bound the re-queue window on a force-fresh restart. We only want
 * to re-queue messages that were auto-ACK'd *after* the agent last proved it was
 * processing work — anything ACK'd before that was genuinely consumed.
 *
 * Takes the max of three independent "live" signals:
 *   1. state/<agent>/.last-send   — last confirmed OUTBOUND message (see stampLastSend)
 *   2. state/<agent>/heartbeat.json mtime — last heartbeat write
 *   3. analytics/events/<agent>/<today>.jsonl mtime — last logged event
 *
 * Returns 0 if no signal is available (caller must fall back to a fixed window cap).
 */
export function getLastConfirmedLive(ctxRoot: string, agentName: string): number {
  let newest = 0;

  // Signal 1: last confirmed outbound (.last-send holds epochMs as a string)
  try {
    const lastSendPath = join(ctxRoot, 'state', agentName, '.last-send');
    if (existsSync(lastSendPath)) {
      const val = parseInt(readFileSync(lastSendPath, 'utf-8').trim(), 10);
      if (Number.isFinite(val) && val > newest) newest = val;
    }
  } catch { /* ignore */ }

  // Signal 2: heartbeat.json mtime
  try {
    const hbPath = join(ctxRoot, 'state', agentName, 'heartbeat.json');
    if (existsSync(hbPath)) {
      const m = statSync(hbPath).mtimeMs;
      if (m > newest) newest = m;
    }
  } catch { /* ignore */ }

  // Signal 3: today's event-log mtime
  try {
    const today = new Date().toISOString().slice(0, 10);
    const evPath = join(ctxRoot, 'analytics', 'events', agentName, `${today}.jsonl`);
    if (existsSync(evPath)) {
      const m = statSync(evPath).mtimeMs;
      if (m > newest) newest = m;
    }
  } catch { /* ignore */ }

  return newest;
}

/**
 * Wedge-recovery: re-queue messages that were auto-ACK'd while an agent's session
 * was wedged (frozen), so a force-fresh restart re-delivers them instead of
 * silently discarding them with the dead input buffer.
 *
 * Background: injectMessage() writes keystrokes to a PTY whose status is still
 * 'running' even when the session is frozen at a context-limit / auto-update
 * banner. The write "succeeds" (returns true) but is never CONSUMED, so the
 * fast-checker auto-ACKs the message (inbox -> inflight -> processed) in the same
 * poll cycle. The 5-min un-ACK'd redelivery therefore never fires, and the
 * force-fresh restart drops the frozen buffer — the message is lost.
 *
 * This moves any processed/<agent>/*.json whose ACK happened at or after sinceMs
 * back into inbox/<agent>/ so the fresh session receives it. We key on ctime, not
 * mtime: renameSync (the inbox->inflight->processed path) PRESERVES mtime but
 * updates ctime, so ctime is the true ACK/move timestamp.
 *
 * Returns the list of message filenames re-queued.
 */
export function requeueWedgedMessages(ctxRoot: string, agentName: string, sinceMs: number): string[] {
  const processedDir = join(ctxRoot, 'processed', agentName);
  const inboxDir = join(ctxRoot, 'inbox', agentName);
  const requeued: string[] = [];

  let files: string[];
  try {
    files = readdirSync(processedDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return requeued;
  }
  if (files.length === 0) return requeued;

  ensureDir(inboxDir);

  for (const file of files) {
    const srcPath = join(processedDir, file);
    try {
      const ctimeMs = statSync(srcPath).ctimeMs;
      // Only re-queue messages ACK'd within the wedge window [sinceMs, now].
      if (ctimeMs >= sinceMs) {
        renameSync(srcPath, join(inboxDir, file));
        requeued.push(file);
      }
    } catch {
      // Ignore stat/move errors — best-effort recovery.
    }
  }

  return requeued;
}

/**
 * Recover stale inflight messages (older than thresholdSeconds) back to inbox.
 */
function recoverStaleInflight(
  inflightDir: string,
  inboxDir: string,
  thresholdSeconds: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  let files: string[];
  try {
    files = readdirSync(inflightDir).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = join(inflightDir, file);
    try {
      const stat = statSync(filePath);
      const mtime = Math.floor(stat.mtimeMs / 1000);
      if (now - mtime > thresholdSeconds) {
        renameSync(filePath, join(inboxDir, file));
      }
    } catch {
      // Ignore stat/move errors
    }
  }
}
