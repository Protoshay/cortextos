/**
 * Codex semantic-checker hardening (2026-10-05 incident):
 *  - the real failure reason is read from `codex exec --json` stdout events
 *    (stderr HEAD only held startup noise, so "model at capacity" was hidden)
 *  - one retry on overload inside a shared 45 s budget
 *  - a timeout kills the whole process group (no orphaned rust child)
 *  - the IPC client budget exceeds checker budget + Telegram API timeout
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import {
  createCodexClient,
  extractCodexError,
  formatCodexFailure,
  isCodexOverload,
  CODEX_TOTAL_BUDGET_MS,
  CODEX_MAX_BUDGET_MS,
  CODEX_RETRY_MIN_BUDGET_MS,
  HUMAN_MESSAGE_IPC_TIMEOUT_MS,
} from '../../../src/telegram/checker.js';

const CONFIG = { model: 'gpt-test', timeoutMs: 8000, tokenCap: 200 };

const OVERLOAD_STDOUT = [
  '{"type":"thread.started","thread_id":"t"}',
  '{"type":"turn.started"}',
  '{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model.","codex_error_info":"server_overloaded"}}',
].join('\n');

const OK_STDOUT = [
  '{"type":"thread.started","thread_id":"t"}',
  '{"type":"item.completed","item":{"id":"i0","type":"error","message":"Skill descriptions were shortened to fit the 2% skills context budget."}}',
  `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":${JSON.stringify('{"pass":true,"reason":null,"rewrite":null}')}}}`,
  '{"type":"turn.completed"}',
].join('\n');

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn> };
  pid: number;
  kill: ReturnType<typeof vi.fn>;
}

let nextPid = 4000;
function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.stdin = { end: vi.fn() };
  c.pid = nextPid++;
  c.kill = vi.fn();
  return c;
}

/** Queue a child that, after delayMs, writes stdout/stderr and closes with `code`. */
function queueChild(opts: { stdout?: string; stderr?: string; code?: number; delayMs?: number; never?: boolean }): FakeChild {
  const c = fakeChild();
  spawnMock.mockImplementationOnce(() => {
    if (!opts.never) {
      setTimeout(() => {
        if (opts.stdout) c.stdout.emit('data', Buffer.from(opts.stdout));
        if (opts.stderr) c.stderr.emit('data', Buffer.from(opts.stderr));
        c.emit('close', opts.code ?? 0);
      }, opts.delayMs ?? 0);
    }
    return c;
  });
  return c;
}

describe('extractCodexError', () => {
  it('reads turn.failed message and codex_error_info', () => {
    expect(extractCodexError(OVERLOAD_STDOUT)).toBe(
      'Selected model is at capacity. Please try a different model. [server_overloaded]',
    );
  });

  it('falls back to a bare error event', () => {
    const out = '{"type":"turn.started"}\n{"type":"error","message":"boom"}';
    expect(extractCodexError(out)).toBe('boom');
  });

  it('prefers turn.failed over a bare error event', () => {
    const out = '{"type":"error","message":"bare"}\n{"type":"turn.failed","error":{"message":"final"}}';
    expect(extractCodexError(out)).toBe('final');
  });

  it('IGNORES item.completed/item.type=error (non-fatal noise on success runs)', () => {
    expect(extractCodexError(OK_STDOUT)).toBeNull();
  });

  it('returns null for empty or non-JSON stdout', () => {
    expect(extractCodexError('')).toBeNull();
    expect(extractCodexError('not json\n{broken')).toBeNull();
  });
});

describe('formatCodexFailure', () => {
  it('uses the stdout error even when stderr head is pure startup noise', () => {
    const noise = 'Reading additional input from stdin...\n' + 'ERROR failed to load skill x\n'.repeat(20);
    const msg = formatCodexFailure(OVERLOAD_STDOUT, noise, 1);
    expect(msg).toContain('Codex checker exited 1');
    expect(msg).toContain('at capacity');
    expect(msg).not.toContain('Reading additional input');
  });

  it('falls back to the stderr TAIL, not the head', () => {
    const stderr = 'HEAD-NOISE\n' + 'x'.repeat(500) + '\nREAL-ERROR-AT-END';
    const msg = formatCodexFailure('', stderr, 2);
    expect(msg).toContain('REAL-ERROR-AT-END');
    expect(msg).not.toContain('HEAD-NOISE');
  });

  it('caps the detail length', () => {
    expect(formatCodexFailure('', 'y'.repeat(2000), 1).length).toBeLessThan(400);
  });
});

describe('isCodexOverload', () => {
  it('matches capacity / server_overloaded text only', () => {
    expect(isCodexOverload('Selected model is at capacity')).toBe(true);
    expect(isCodexOverload('x [server_overloaded]')).toBe(true);
    expect(isCodexOverload('Codex checker timed out after 45000ms')).toBe(false);
    expect(isCodexOverload('invalid_request_error')).toBe(false);
  });
});

describe('createCodexClient', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnMock.mockReset();
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    killSpy.mockRestore();
  });

  it('passes on a clean run, spawns detached, ignores item-level error noise', async () => {
    queueChild({ stdout: OK_STDOUT });
    const p = createCodexClient(CONFIG).check('sys', 'user');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ pass: true });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const opts = spawnMock.mock.calls[0][2] as { detached?: boolean; cwd?: string };
    expect(opts.detached).toBe(true);
    expect(opts.cwd).toBe('/tmp');
  });

  it('retries ONCE on overload and then passes', async () => {
    queueChild({ stdout: OVERLOAD_STDOUT, code: 1, delayMs: 5000 });
    queueChild({ stdout: OK_STDOUT, delayMs: 20000 });
    const p = createCodexClient(CONFIG).check('sys', 'user');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ pass: true });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('rejects with the REAL error after two overloads (no third attempt)', async () => {
    queueChild({ stdout: OVERLOAD_STDOUT, code: 1, delayMs: 5000 });
    queueChild({ stdout: OVERLOAD_STDOUT, code: 1, delayMs: 5000 });
    const p = createCodexClient(CONFIG).check('sys', 'user');
    const assertion = expect(p).rejects.toThrow(/at capacity/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a non-overload failure', async () => {
    queueChild({ stdout: '{"type":"turn.failed","error":{"message":"invalid model"}}', code: 1 });
    const p = createCodexClient(CONFIG).check('sys', 'user');
    const assertion = expect(p).rejects.toThrow(/invalid model/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when less than the minimum budget remains', async () => {
    const lateMs = CODEX_TOTAL_BUDGET_MS - CODEX_RETRY_MIN_BUDGET_MS + 1000; // leaves < 15 s
    queueChild({ stdout: OVERLOAD_STDOUT, code: 1, delayMs: lateMs });
    const p = createCodexClient(CONFIG).check('sys', 'user');
    const assertion = expect(p).rejects.toThrow(/at capacity/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('on timeout kills the whole process GROUP, rejects, and does not retry', async () => {
    const child = queueChild({ never: true });
    const p = createCodexClient(CONFIG).check('sys', 'user');
    const assertion = expect(p).rejects.toThrow(/timed out after 45000ms/);
    await vi.advanceTimersByTimeAsync(CODEX_TOTAL_BUDGET_MS);
    await assertion;
    expect(killSpy).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('honours a larger configured timeout than the default budget (up to the cap)', async () => {
    const child = queueChild({ never: true });
    const p = createCodexClient({ ...CONFIG, timeoutMs: 50_000 }).check('sys', 'user');
    const assertion = expect(p).rejects.toThrow(/timed out after 50000ms/);
    await vi.advanceTimersByTimeAsync(49_000);
    expect(killSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(killSpy).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  });

  it('config below the default (old 8 s, 30 s stopgap) does NOT shrink the budget', async () => {
    queueChild({ never: true });
    const p = createCodexClient({ ...CONFIG, timeoutMs: 30_000 }).check('sys', 'user');
    const assertion = expect(p).rejects.toThrow(/timed out after 45000ms/);
    await vi.advanceTimersByTimeAsync(44_000);
    expect(killSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('config above the ceiling is clamped so the IPC timeout stays the larger bound', async () => {
    queueChild({ never: true });
    const p = createCodexClient({ ...CONFIG, timeoutMs: 600_000 }).check('sys', 'user');
    const assertion = expect(p).rejects.toThrow(new RegExp(`timed out after ${CODEX_MAX_BUDGET_MS}ms`));
    await vi.advanceTimersByTimeAsync(CODEX_MAX_BUDGET_MS);
    await assertion;
  });

  it('kills the group on a spawn error too', async () => {
    const c = fakeChild();
    spawnMock.mockImplementationOnce(() => {
      setTimeout(() => c.emit('error', new Error('ENOENT')), 0);
      return c;
    });
    const p = createCodexClient(CONFIG).check('sys', 'user');
    const assertion = expect(p).rejects.toThrow(/Codex checker error: ENOENT/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(killSpy).toHaveBeenCalledWith(-c.pid, 'SIGKILL');
  });
});

describe('IPC budget', () => {
  it('human-send IPC timeout exceeds checker budget + Telegram API timeout (15 s)', () => {
    expect(HUMAN_MESSAGE_IPC_TIMEOUT_MS).toBeGreaterThan(CODEX_TOTAL_BUDGET_MS + 15_000);
    // even at the clamp ceiling
    expect(HUMAN_MESSAGE_IPC_TIMEOUT_MS).toBeGreaterThan(CODEX_MAX_BUDGET_MS + 15_000);
  });
});
