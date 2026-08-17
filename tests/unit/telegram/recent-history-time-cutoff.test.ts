/**
 * `buildRecentHistory` time cutoff — the frozen-window deadlock.
 *
 * The semantic send gate judges each draft against a snippet of recent
 * conversation. The outbound log only gains an entry when a send SUCCEEDS, so
 * once a draft is rejected the snippet is a FIXED POINT: the next draft is
 * judged against byte-identical history, is rejected for the same reason, and
 * writes nothing. skiffy's Shay channel sat on one closed thread for three days
 * and 15+ rejected sends.
 *
 * The first test below is the control that makes the rest mean anything: it
 * asserts the deadlock is REAL with the count-only window, i.e. that these
 * tests can distinguish a fix from a no-op. A count limit cannot break the
 * loop — two stale entries are still two entries — so the axis under test has
 * to be TIME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildRecentHistory } from '../../../src/telegram/logging';

const CHAT = '8721344756';
const AGENT = 'skiffy';

describe('buildRecentHistory time cutoff', () => {
  let ctxRoot: string;
  let logDir: string;

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  const write = (file: string, rows: Array<Record<string, unknown>>) => {
    writeFileSync(join(logDir, file), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  };

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-history-cutoff-'));
    logDir = join(ctxRoot, 'logs', AGENT);
    mkdirSync(logDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  /** The exact shape that froze: a closed thread, days old, nothing since. */
  const seedFrozenThread = () => {
    write('inbound-messages.jsonl', [
      { timestamp: hoursAgo(75), chat_id: CHAT, text: 'not my job.' },
    ]);
    write('outbound-messages.jsonl', [
      {
        timestamp: hoursAgo(74),
        chat_id: CHAT,
        text: "Understood — I won't pursue this. You don't need to do anything.",
      },
    ]);
  };

  it('CONTROL: without a cutoff the stale thread is still returned (deadlock is real)', () => {
    seedFrozenThread();
    const history = buildRecentHistory(ctxRoot, AGENT, CHAT, 2);
    expect(history).not.toBeNull();
    expect(history).toContain("I won't pursue this");
  });

  it('drops entries older than the cutoff, returning null when nothing is left', () => {
    seedFrozenThread();
    expect(buildRecentHistory(ctxRoot, AGENT, CHAT, 2, 24)).toBeNull();
  });

  it('keeps entries inside the window', () => {
    write('inbound-messages.jsonl', [
      { timestamp: hoursAgo(2), chat_id: CHAT, text: 'whats the state of the L15396 fit' },
    ]);
    const history = buildRecentHistory(ctxRoot, AGENT, CHAT, 2, 24);
    expect(history).toContain('L15396');
  });

  it('keeps the fresh entry and drops the stale one from the same file', () => {
    write('outbound-messages.jsonl', [
      { timestamp: hoursAgo(74), chat_id: CHAT, text: 'STALE closed thread' },
      { timestamp: hoursAgo(1), chat_id: CHAT, text: 'FRESH live thread' },
    ]);
    const history = buildRecentHistory(ctxRoot, AGENT, CHAT, 2, 24);
    expect(history).toContain('FRESH live thread');
    expect(history).not.toContain('STALE closed thread');
  });

  it('treats an entry with no usable timestamp as outside the window', () => {
    write('outbound-messages.jsonl', [
      { chat_id: CHAT, text: 'undated entry' },
      { timestamp: 'not-a-date', chat_id: CHAT, text: 'unparseable entry' },
    ]);
    // Undatable cannot be shown to be recent, and dropping history is the safe
    // direction — the checker then judges the draft on its own merits.
    expect(buildRecentHistory(ctxRoot, AGENT, CHAT, 2, 24)).toBeNull();
    // ...but with no cutoff requested, the old behaviour is untouched.
    expect(buildRecentHistory(ctxRoot, AGENT, CHAT, 2)).toContain('undated entry');
  });

  it('still filters by chat_id inside the window', () => {
    write('outbound-messages.jsonl', [
      { timestamp: hoursAgo(1), chat_id: '9999999999', text: 'other chat' },
      { timestamp: hoursAgo(1), chat_id: CHAT, text: 'this chat' },
    ]);
    const history = buildRecentHistory(ctxRoot, AGENT, CHAT, 2, 24);
    expect(history).toContain('this chat');
    expect(history).not.toContain('other chat');
  });

  it('the cutoff is evaluated per call, not fixed at module load', () => {
    write('outbound-messages.jsonl', [
      { timestamp: hoursAgo(5), chat_id: CHAT, text: 'five hours old' },
    ]);
    expect(buildRecentHistory(ctxRoot, AGENT, CHAT, 2, 6)).toContain('five hours old');
    expect(buildRecentHistory(ctxRoot, AGENT, CHAT, 2, 4)).toBeNull();
  });

  it('missing log files are still tolerated when a cutoff is set', () => {
    expect(buildRecentHistory(ctxRoot, AGENT, CHAT, 2, 24)).toBeNull();
  });
});
