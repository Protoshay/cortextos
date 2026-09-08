/**
 * tests/unit/cli/bus-hard-restart.test.ts
 *
 * Regression coverage for task_1788862054035_41937914 (found by rimu,
 * verified by skiffy): `cortextos bus hard-restart --handoff-doc <path>`
 * silently proceeded to a clean "Hard restart triggered" success line even
 * when the given path did not exist. The agent would restart contextless
 * while believing its handoff was saved — and the session that could have
 * reported the drop is exactly the one that never comes back.
 *
 * Fix: the `--handoff-doc` existence check now runs BEFORE hardRestart()
 * fires. If the flag was passed but the path doesn't resolve, the command
 * refuses the whole restart with a loud console.error + non-zero exit —
 * no markers written, no IPC restart sent, no success line.
 *
 * Three cases pinned here:
 *   (i)   nonexistent --handoff-doc path -> loud refusal, no restart at all
 *   (ii)  valid --handoff-doc path -> marker still written correctly (regression guard)
 *   (iii) no --handoff-doc at all -> unaffected, clean restart, no marker
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// IPC mock — daemon not running, so the command takes the
// "Hard restart planned (daemon not running...)" branch without touching a
// real socket.
// ---------------------------------------------------------------------------
const mockIpcSend = vi.fn().mockResolvedValue({ success: true, data: 'mocked' });
const mockIpcIsDaemonRunning = vi.fn().mockResolvedValue(false);

vi.mock('../../../src/daemon/ipc-server.js', () => {
  class MockIPCClient {
    send = mockIpcSend;
    isDaemonRunning = mockIpcIsDaemonRunning;
  }
  return { IPCClient: MockIPCClient };
});

import { busCommand } from '../../../src/cli/bus';

// resolvePaths() (src/utils/paths.ts) ignores CTX_ROOT and always resolves
// under homedir()/.cortextos/<instanceId> — so isolation here comes from a
// unique CTX_INSTANCE_ID per test run, not from a tmpdir env override.
const TEST_INSTANCE = `bus-hard-restart-test-${process.pid}`;
const TEST_AGENT = 'hard-restart-test-agent';

function ctxRoot(): string {
  return join(homedir(), '.cortextos', TEST_INSTANCE);
}
function stateDir(): string {
  return join(ctxRoot(), 'state', TEST_AGENT);
}
function logDir(): string {
  return join(ctxRoot(), 'logs', TEST_AGENT);
}
function markerPath(): string {
  return join(stateDir(), '.handoff-doc-path');
}
function forceFreshPath(): string {
  return join(stateDir(), '.force-fresh');
}
function restartsLogPath(): string {
  return join(logDir(), 'restarts.log');
}

const original = {
  instanceId: process.env.CTX_INSTANCE_ID,
  agentName: process.env.CTX_AGENT_NAME,
  org: process.env.CTX_ORG,
};

let tmpDocRoot: string;

beforeEach(() => {
  tmpDocRoot = mkdtempSync(join(tmpdir(), 'bus-hard-restart-doc-'));
  process.env.CTX_INSTANCE_ID = TEST_INSTANCE;
  process.env.CTX_AGENT_NAME = TEST_AGENT;
  process.env.CTX_ORG = '';
  mockIpcSend.mockClear();
  mockIpcIsDaemonRunning.mockClear().mockResolvedValue(false);
});

afterEach(() => {
  if (original.instanceId === undefined) delete process.env.CTX_INSTANCE_ID;
  else process.env.CTX_INSTANCE_ID = original.instanceId;
  if (original.agentName === undefined) delete process.env.CTX_AGENT_NAME;
  else process.env.CTX_AGENT_NAME = original.agentName;
  if (original.org === undefined) delete process.env.CTX_ORG;
  else process.env.CTX_ORG = original.org;

  try { rmSync(tmpDocRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(ctxRoot(), { recursive: true, force: true }); } catch { /* ignore */ }

  vi.restoreAllMocks();
});

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

describe('bus hard-restart --handoff-doc', () => {
  it('(i) nonexistent path: refuses the restart loudly, writes no markers, sends no IPC restart', async () => {
    const badPath = join(tmpDocRoot, 'does-not-exist.md');
    expect(existsSync(badPath)).toBe(false);

    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync([
        'node', 'bus', 'hard-restart',
        '--reason', 'test bad handoff path',
        '--handoff-doc', badPath,
      ])
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain(badPath);
    expect(errOut.toLowerCase()).toContain('does not exist');

    // The whole restart must be refused — no "Hard restart triggered" success
    // line, no .force-fresh / restarts.log from hardRestart(), no handoff
    // marker, and the daemon must never be asked to restart the agent.
    const logOut = logSpy.mock.calls.flat().join(' ');
    expect(logOut).not.toContain('Hard restart triggered');
    expect(existsSync(forceFreshPath())).toBe(false);
    expect(existsSync(restartsLogPath())).toBe(false);
    expect(existsSync(markerPath())).toBe(false);
    expect(mockIpcSend).not.toHaveBeenCalled();
  });

  it('(ii) valid path: still writes the handoff marker correctly (regression guard)', async () => {
    const goodPath = join(tmpDocRoot, 'handoff.md');
    writeFileSync(goodPath, '# Handoff\n\n## Current Tasks\n- finish the thing\n', 'utf-8');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'hard-restart',
      '--reason', 'test good handoff path',
      '--handoff-doc', goodPath,
    ]);

    expect(errSpy).not.toHaveBeenCalled();

    expect(existsSync(forceFreshPath())).toBe(true);
    expect(existsSync(restartsLogPath())).toBe(true);
    expect(existsSync(markerPath())).toBe(true);
    expect(readFileSync(markerPath(), 'utf-8').trim()).toBe(goodPath);

    const logOut = logSpy.mock.calls.flat().join(' ');
    expect(logOut).toContain('Hard restart planned');
  });

  it('(iii) no --handoff-doc at all: restarts cleanly, no marker, no error (unchanged behavior)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'hard-restart',
      '--reason', 'test no handoff doc',
    ]);

    expect(errSpy).not.toHaveBeenCalled();
    expect(existsSync(forceFreshPath())).toBe(true);
    expect(existsSync(restartsLogPath())).toBe(true);
    expect(existsSync(markerPath())).toBe(false);

    const logOut = logSpy.mock.calls.flat().join(' ');
    expect(logOut).toContain('Hard restart planned');
  });
});
