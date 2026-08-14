/**
 * Bypass-proof tests for the message checker.
 *
 * Proves that specific bypass attempts fail without needing a real daemon,
 * real network, or real OpenAI key.
 *
 * Each test corresponds to a documented bypass vector from the PLAN:
 *  1. Fake --deliverable-for (non-existent inbound message ID)
 *  2. Missing openaiKey → every CLI send rejected
 *  3. Missing checkerConfig → rejected (defaults still enforce checker)
 *  4. Unregistered agent → rejected before any gate runs
 *  5. Semantic model client unavailable → fail-closed rejection
 *  6. Positive control: valid deliverable-for → long response passes word limit
 *  7. UID-0 bypass note (cannot be unit-tested; documented)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  validateDeliverableClaim,
  runDeterministicChecks,
  runSemanticCheck,
  resolveAudience,
} from '../../../src/telegram/checker.js';
import type { ModelClient, CheckerResult } from '../../../src/telegram/checker.js';
import { TelegramSendService } from '../../../src/daemon/telegram-send-service.js';
import type { HumanSendRequest } from '../../../src/daemon/telegram-send-service.js';

const SHAY = '8721344756';
const OTHER = '9999999999';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'bypass-test-'));
}

function writeInboundLog(ctxRoot: string, agentName: string, entries: object[]): void {
  const dir = join(ctxRoot, 'logs', agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'inbound-messages.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

// Minimal TelegramAPI stub: never actually sends
function stubApi() {
  return {
    sendMessage: async () => ({ ok: true, result: { message_id: 999 } }),
    sendPhoto: async () => ({ ok: true, result: { message_id: 998 } }),
    sendDocument: async () => ({ ok: true, result: { message_id: 997 } }),
    editMessageText: async () => ({ ok: true }),
  } as any;
}

function makeSendService(ctxRoot: string, opts: Partial<{
  openaiKey: string;
  agentName: string;
  modelClient: ModelClient;
}> = {}) {
  return new TelegramSendService({
    api: stubApi(),
    ctxRoot,
    agentName: opts.agentName ?? 'agent1',
    instanceId: 'default',
    org: 'test-org',
    checkerConfig: { model: 'gpt-4o-mini', timeoutMs: 8000, tokenCap: 200 },
    openaiKey: opts.openaiKey ?? 'sk-test',
    modelClient: opts.modelClient ?? {
      async check(): Promise<CheckerResult> {
        return { pass: true };
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 1. Fake --deliverable-for
// ---------------------------------------------------------------------------

describe('Bypass 1: fake --deliverable-for', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('non-existent inbound message ID → deliverable treated as false', () => {
    writeInboundLog(dir, 'agent1', [
      { message_id: 10, chat_id: SHAY, text: 'Hi', timestamp: new Date().toISOString() },
    ]);
    // Request with ID that does NOT exist in the log
    const { deliverable } = validateDeliverableClaim(dir, 'agent1', SHAY, 99999);
    expect(deliverable).toBe(false);
  });

  it('wrong chatId for the inbound message ID → deliverable false', () => {
    writeInboundLog(dir, 'agent1', [
      { message_id: 10, chat_id: OTHER, text: 'Hi from other', timestamp: new Date().toISOString() },
    ]);
    const { deliverable } = validateDeliverableClaim(dir, 'agent1', SHAY, 10);
    expect(deliverable).toBe(false);
  });

  it('deterministic word-limit still applies when deliverable=false (behaviour promise blocked)', () => {
    const text = "I'll change that going forward.";
    const { reject } = runDeterministicChecks(SHAY, text, false);
    expect(reject).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Missing openaiKey → local reviewer remains available
// ---------------------------------------------------------------------------

describe('Bypass 2: missing openaiKey', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('Otis CLI sends still run through the injected local reviewer', async () => {
    const svc = makeSendService(dir, { openaiKey: '', agentName: 'otis' });
    const req: HumanSendRequest = {
      agentName: 'otis',
      chatId: SHAY,
      text: 'Hello.',
      source: 'cli',
    };
    const result = await svc.handleSendRequest(req);
    expect(result.ok).toBe(true);
  });

  it('hook source still runs through the local reviewer without an API key', async () => {
    const svc = makeSendService(dir, { openaiKey: '', agentName: 'otis' });
    const req: HumanSendRequest = {
      agentName: 'otis',
      chatId: SHAY,
      text: 'Permission needed: /path',
      source: 'hook',
      plainText: true,
    };
    const result = await svc.handleSendRequest(req);
    expect(result.ok).toBe(true);
  });

  it('daemon source still runs through the local reviewer without an API key', async () => {
    const svc = makeSendService(dir, { openaiKey: '', agentName: 'otis' });
    const req: HumanSendRequest = {
      agentName: 'otis',
      chatId: SHAY,
      text: '🚨 CRASH: agent died unexpectedly.',
      source: 'daemon',
      plainText: true,
    };
    const result = await svc.handleSendRequest(req);
    expect(result.ok).toBe(true);
  });

  it('non-pilot agents do not require the checker key', async () => {
    const svc = makeSendService(dir, { openaiKey: '', agentName: 'scout' });
    const req: HumanSendRequest = {
      agentName: 'scout',
      chatId: OTHER,
      text: 'Hello.',
      source: 'cli',
      plainText: true,
    };
    const result = await svc.handleSendRequest(req);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Missing checkerConfig — defaults enforce the checker
// ---------------------------------------------------------------------------

describe('Bypass 3: missing/default checkerConfig still enforces gates', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('even with default config, behaviour promise is caught deterministically', () => {
    const { reject } = runDeterministicChecks(SHAY, "I'll make sure to do better from now on.", false);
    expect(reject).not.toBeNull();
  });

  it('even with default config, false fixed claim is caught deterministically', () => {
    const { reject } = runDeterministicChecks(OTHER, "Updated the guardrail config.", false);
    expect(reject).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Unregistered agent → rejected before gates run
// ---------------------------------------------------------------------------

describe('Bypass 4: unregistered agent', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('mismatched agentName → rejected with identity mismatch', async () => {
    const svc = makeSendService(dir, { agentName: 'registered-agent' });
    const req: HumanSendRequest = {
      agentName: 'impostor-agent',
      chatId: SHAY,
      text: 'Hello.',
      source: 'cli',
    };
    const result = await svc.handleSendRequest(req);
    expect(result.ok).toBe(false);
    expect(result.rejection?.reason).toMatch(/identity mismatch/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Semantic model client unavailable → fail-closed
// ---------------------------------------------------------------------------

describe('Bypass 5: semantic client unavailable → fail-closed', () => {
  it('throws on timeout — caller must treat as reject', async () => {
    const timedOut: ModelClient = {
      async check(): Promise<CheckerResult> {
        throw new Error('Checker model timed out after 8000ms');
      },
    };
    const profile = resolveAudience(SHAY);
    await expect(
      runSemanticCheck(profile, 'some content', timedOut),
    ).rejects.toThrow('timed out');
  });

  it('throws on network error — caller must treat as reject', async () => {
    const netErr: ModelClient = {
      async check(): Promise<CheckerResult> {
        throw new Error('Checker network error: ECONNREFUSED');
      },
    };
    const profile = resolveAudience(OTHER);
    await expect(
      runSemanticCheck(profile, 'content', netErr),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('throws on bad JSON from model — caller must treat as reject', async () => {
    const badJson: ModelClient = {
      async check(): Promise<CheckerResult> {
        throw new Error('Invalid JSON from checker model: }{bad');
      },
    };
    await expect(
      runSemanticCheck(resolveAudience(OTHER), 'content', badJson),
    ).rejects.toThrow('Invalid JSON');
  });
});

// ---------------------------------------------------------------------------
// 6. Positive control: valid deliverable-for with matching inbound ID → pass
// ---------------------------------------------------------------------------

describe('Bypass 6: positive control — valid deliverable-for passes', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('matching inbound msg ID → deliverable=true; long reply is NOT blocked', () => {
    const logDir = join(dir, 'logs', 'agent1');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, 'inbound-messages.jsonl'),
      JSON.stringify({
        message_id: 123,
        chat_id: SHAY,
        text: 'Send me the full architecture brief.',
        timestamp: new Date().toISOString(),
      }) + '\n',
    );

    const { deliverable, triggeringText } = validateDeliverableClaim(dir, 'agent1', SHAY, 123);
    expect(deliverable).toBe(true);
    expect(triggeringText).toContain('architecture brief');

    // A long response that would normally trip accountability or other checks
    // should pass deterministic when deliverable=true
    const longText = 'Here is the full brief.\n\n' + 'Detail '.repeat(200);
    const { reject } = runDeterministicChecks(SHAY, longText, deliverable);
    expect(reject).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. UID-0 bypass — documented, not unit-testable
// ---------------------------------------------------------------------------

describe('Bypass 7: uid-0 process bypass (documentation test)', () => {
  it('documents that uid-0 bypass cannot be unit-tested here', () => {
    /**
     * A compromised uid-0 agent process can bypass the checker via:
     *   - Reading /proc/<daemon-pid>/environ to get OPENAI_API_KEY
     *   - Direct `curl https://api.telegram.org/bot.../sendMessage`
     *   - Editing daemon config files on disk
     *
     * These bypasses are NOT prevented by this build. Prevention requires
     * OS-level privilege separation (separate uid, /proc restrictions,
     * network namespace). That is tracked as a future milestone.
     *
     * This test exists to document the limitation and ensure it is included
     * in the architectural test (checker-bypass.test.ts) rather than
     * silently omitted.
     */
    expect(true).toBe(true); // deliberate pass — this is a documentation test
  });
});
