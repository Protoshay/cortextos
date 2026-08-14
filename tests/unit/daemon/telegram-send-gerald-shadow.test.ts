/**
 * End-to-end wiring harness for the Gerald told-gate shadow record
 * (STEP 2 of orgs/todi-and-boys/agents/rimu/scripts/plan_told_gate_shared_state.md).
 *
 * WHY THIS FILE EXISTS — same reasoning as telegram-send-fensa-gate.test.ts:
 * recordGeraldToldGateShadow's own logic is unit-tested directly against
 * temp dirs in tests/unit/telegram/checker.test.ts. Those tests cannot tell
 * you whether the daemon send path actually calls it. So every test here
 * drives the real TelegramSendService.handleSendRequest() and asserts on
 * the shadow-log file, never on the checker function directly.
 *
 * THE INVARIANT UNDER TEST IS "RECORD-ONLY": the shadow log must be written
 * (or not) exactly per the STEP-2 rules, and it must never change what
 * handleSendRequest returns — a rejected send and an accepted send both get
 * recorded identically.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramSendService } from '../../../src/daemon/telegram-send-service.js';
import type { HumanSendRequest } from '../../../src/daemon/telegram-send-service.js';

/** Gerald's chat id — see src/telegram/checker.ts GERALD_CHAT_ID. */
const GERALD = '8602224961';
/** Shay's chat id, used elsewhere in the suite as a non-Gerald control. */
const SHAY = '8721344756';

function stubApi() {
  const calls: { text: string }[] = [];
  return {
    calls,
    api: {
      sendMessage: async (_chatId: string, text: string) => {
        calls.push({ text });
        return { ok: true, result: { message_id: 999 } };
      },
      sendPhoto: async () => ({ ok: true, result: { message_id: 998 } }),
      sendDocument: async () => ({ ok: true, result: { message_id: 997 } }),
      editMessageText: async () => ({ ok: true }),
    } as any,
  };
}

function readShadowLog(dir: string, agent: string): any[] {
  const path = join(dir, 'logs', agent, 'gerald-told-gate-shadow.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('Gerald told-gate shadow record — wired via handleSendRequest', () => {
  let dir: string;
  let sent: { text: string }[];
  let svc: TelegramSendService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gerald-shadow-wiring-'));
    const s = stubApi();
    sent = s.calls;
    // 'rimu' is the real-world producer for Gerald sends and is deliberately
    // NOT in MESSAGE_CHECKER_AGENTS, so this exercises the shadow record
    // independent of the semantic checker.
    svc = new TelegramSendService({
      api: s.api,
      ctxRoot: dir,
      agentName: 'rimu',
      instanceId: 'default',
      org: 'test-org',
      checkerConfig: { model: 'gpt-4o-mini', timeoutMs: 8000, tokenCap: 200 },
      openaiKey: 'sk-test',
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('produces no shadow-log entry for a non-Gerald chat_id', async () => {
    const res = await svc.handleSendRequest({
      agentName: 'rimu',
      chatId: SHAY,
      text: 'Ben Morris survey is booked for Thursday morning.',
      source: 'cli',
    } as HumanSendRequest);

    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(readShadowLog(dir, 'rimu')).toHaveLength(0);
  });

  it('produces one shadow-log entry for a Gerald send with geraldItems declared, without altering the send result', async () => {
    const res = await svc.handleSendRequest({
      agentName: 'rimu',
      chatId: GERALD,
      text: 'Focus list update for today.',
      geraldItems: '12336231918,12291776556',
      source: 'cli',
    } as HumanSendRequest);

    expect(res.ok).toBe(true);
    expect(res.sentMessageId).toBe(999);
    expect(sent).toHaveLength(1);

    const rows = readShadowLog(dir, 'rimu');
    expect(rows).toHaveLength(1);
    expect(rows[0].items_declared).toBe(true);
    expect(rows[0].items).toEqual(['12336231918', '12291776556']);
    expect(rows[0].chat_id).toBe(GERALD);
  });

  it('still records the shadow entry when a later gate rejects the send — record fires on every attempt', async () => {
    // A word-cap-busting message to Gerald with no deliverable claim will be
    // rejected by the conversation style gate. The shadow record must still
    // have fired, because it sits before that gate.
    const longText = Array(60).fill('word').join(' ');
    const res = await svc.handleSendRequest({
      agentName: 'rimu',
      chatId: GERALD,
      text: longText,
      geraldItems: '999',
      source: 'cli',
    } as HumanSendRequest);

    expect(res.ok).toBe(false);
    expect(sent).toHaveLength(0);

    const rows = readShadowLog(dir, 'rimu');
    expect(rows).toHaveLength(1);
    expect(rows[0].items_declared).toBe(true);
    expect(rows[0].items).toEqual(['999']);
  });
});
