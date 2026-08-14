/**
 * End-to-end wiring harness for Gate 7 (FENSA time-window gate).
 *
 * WHY THIS FILE EXISTS — and it is a narrower reason than "test the gate".
 * The gate's LOGIC is already covered by unit tests in
 * tests/unit/telegram/logging.test.ts, which call checkFensaWindowGate()
 * directly. Those tests cannot tell you whether the gate is REACHED. A gate
 * that is correct and unwired is indistinguishable from a gate that is correct
 * and wired, if you only ever call it directly.
 *
 * So every test here drives the real TelegramSendService.handleSendRequest()
 * and asserts on the pipeline's return value, never on the gate function.
 *
 * SAFE TO RUN: the refusal path returns before any Telegram call, and the pass
 * path hits a stub API that never touches the network.
 *
 * THE DISCRIMINATOR IS THE PAIR, NOT EITHER TEST ALONE. A refusal on its own
 * proves nothing — Gates 4/5/6 could have produced it. Each refusal assertion
 * therefore checks the Gate 7 reason SPECIFICALLY, and is paired with a
 * near-identical message that differs only in stating a window and which comes
 * back ok:true with a sent message id. If Gate 7 were removed, the refusing
 * half of every pair would flip to ok:true.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramSendService } from '../../../src/daemon/telegram-send-service.js';
import type { HumanSendRequest } from '../../../src/daemon/telegram-send-service.js';

/** Shab's chat. Deliberately NOT Shay's id: the style gate has extra
 *  Shay-only clauses that would confound which gate produced a refusal. */
const SHAB = '8915751414';

/** Fragment unique to Gate 7's refusal — no other gate mentions FENSA. */
const GATE7 = 'FENSA count or list with no time range stated';

/** Stub API: records calls, never sends. */
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

describe('Gate 7 wiring — checkFensaWindowGate reached via handleSendRequest', () => {
  let dir: string;
  let sent: { text: string }[];
  let svc: TelegramSendService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fensa-gate-wiring-'));
    const s = stubApi();
    sent = s.calls;
    // agentName 'agent1' is deliberately NOT in MESSAGE_CHECKER_AGENTS, so the
    // semantic checker never runs and no model client is needed. This mirrors
    // rocky, whose lane never hits the checker either.
    svc = new TelegramSendService({
      api: s.api,
      ctxRoot: dir,
      agentName: 'agent1',
      instanceId: 'default',
      org: 'test-org',
      checkerConfig: { model: 'gpt-4o-mini', timeoutMs: 8000, tokenCap: 200 },
      openaiKey: 'sk-test',
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const send = (text: string): Promise<any> =>
    svc.handleSendRequest({
      agentName: 'agent1',
      chatId: SHAB,
      text,
      source: 'cli',
    } as HumanSendRequest);

  // -------------------------------------------------------------------------
  // Receipt 1 + 2: the pair. Same claim, one states its window.
  // -------------------------------------------------------------------------

  it('REFUSES a bare FENSA count, and the refusal comes from Gate 7 specifically', async () => {
    const res = await send('Here are the outstanding FENSAs. 8 jobs still need registering.');
    expect(res.ok).toBe(false);
    expect(res.rejection?.reason).toContain(GATE7);
    // Nothing left the building.
    expect(sent).toHaveLength(0);
  });

  it('PASSES the same count once it states its window — proving the refusal was the window, not the topic', async () => {
    const res = await send(
      'Here are the outstanding FENSAs for 2025-09-01 to 2026-08-12. 8 jobs still need registering.',
    );
    expect(res.ok).toBe(true);
    expect(res.sentMessageId).toBe(999);
    expect(sent).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Receipt 3: discrimination. A FENSA message that is not a count must pass,
  // or the gate is just a FENSA keyword ban.
  // -------------------------------------------------------------------------

  it('PASSES a FENSA message that is not a count or list', async () => {
    const res = await send('The FENSA certificate for Ignaz came through this morning.');
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Receipt 4: homograph regression. This is a joinery business — "windows"
  // is the product. The product noun must never satisfy a time-range test.
  // -------------------------------------------------------------------------

  it('REFUSES a FENSA count phrased with the product noun "windows"', async () => {
    const res = await send('FENSA: 4 windows and 2 doors still outstanding.');
    expect(res.ok).toBe(false);
    expect(res.rejection?.reason).toContain(GATE7);
    expect(sent).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Receipt 5: the derived-span anti-pattern. A range computed FROM the answer
  // moves with the answer and can never contradict it.
  // -------------------------------------------------------------------------

  it('REFUSES a count whose only "range" is the span of its own results', async () => {
    const res = await send('8 real FENSA jobs, from Ming Ming last Sept to Alysha in December.');
    expect(res.ok).toBe(false);
    expect(res.rejection?.reason).toContain(GATE7);
  });

  // -------------------------------------------------------------------------
  // Receipt 6: explicit unbounded is a stated window, not an absent one.
  // -------------------------------------------------------------------------

  it('PASSES a count that states it is unbounded on purpose', async () => {
    const res = await send('FENSA registrations, all time with no date cut-off: 44 jobs.');
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Receipt 7: the gate is NOT deliverable-exempt. Gates 4/5/6 all return early
  // when deliverable is true; Gate 7 deliberately does not, because a requested
  // report is exactly where an unwindowed count does the most damage.
  //
  // NOTE: deliverableForMsgId is unvalidatable here (no inbound log), so this
  // asserts the ORDERING property that matters — Gate 7 sits after the gates
  // that do exempt deliverables, and still fires.
  // -------------------------------------------------------------------------

  it('REFUSES a bare count even when sent as a claimed deliverable', async () => {
    const res = await svc.handleSendRequest({
      agentName: 'agent1',
      chatId: SHAB,
      text: 'FENSA report as requested: 12 jobs outstanding, 30 registered.',
      deliverableForMsgId: 1,
      source: 'cli',
    } as HumanSendRequest);
    expect(res.ok).toBe(false);
    expect(res.rejection?.reason).toContain(GATE7);
  });

  // -------------------------------------------------------------------------
  // Receipt 8: inertness. The overwhelming majority of traffic must be
  // untouched, or the gate is a tax rather than a guard.
  // -------------------------------------------------------------------------

  it('is inert for ordinary traffic with no FENSA mention', async () => {
    const res = await send('Ben Morris survey is booked for Thursday morning.');
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
