/**
 * tests/unit/daemon/ipc-spawn-worker-gate.test.ts
 *
 * Working-hours admission gate for the 'spawn-worker' IPC command.
 *
 * e4b7ce6 ("feat(daemon): working-hours admission gate for injections")
 * added AgentManager#isAutonomousWorkAllowed() and gated spawnWorker(),
 * injectWorker(), and the 'cron' origin tag on injectAgent() in
 * src/daemon/agent-manager.ts — but did NOT update the spawn-worker IPC
 * handler in src/daemon/ipc-server.ts, which performs the same worker-spawn
 * action via a separate code path (CLI -> IPCClient -> daemon socket).
 *
 * This test drives the real IPCServer over a real Unix socket (using a
 * throwaway instanceId so it never collides with a live daemon) with a
 * fake AgentManager, and asserts the 'spawn-worker' handler:
 *   - rejects with the same "Working-hours gate" error when
 *     isAutonomousWorkAllowed() returns false, and never calls spawnWorker
 *   - proceeds to call spawnWorker() when isAutonomousWorkAllowed() returns
 *     true
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { randomBytes } from 'crypto';

let tmpRoot: string;
let instanceId: string;
let ipcDir: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ipc-spawn-gate-'));
  process.env.CTX_ROOT = tmpRoot;
  instanceId = `test-spawn-gate-${randomBytes(4).toString('hex')}`;
  // getIpcPath() resolves to ~/.cortextos/<instanceId>/daemon.sock. Node's
  // unix-socket bind fails EACCES (not ENOENT) when the parent dir is
  // missing, so the directory must exist before IPCServer#start().
  ipcDir = join(homedir(), '.cortextos', instanceId);
  mkdirSync(ipcDir, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
  try { rmSync(ipcDir, { recursive: true }); } catch { /* ignore */ }
});

// Build a fake AgentManager-like object with enough surface for the IPC
// server's 'spawn-worker' case, mirroring the fakeAgentManager() helper used
// in ipc-list-executions.test.ts.
function fakeAgentManager(opts: { autonomousWorkAllowed: boolean }) {
  const spawnWorker = vi.fn(async () => {});
  return {
    getAllStatuses: () => [],
    getAgentNames: () => [],
    startAgent: async () => {},
    stopAgent: async () => {},
    restartAgent: async () => {},
    getFastChecker: () => null,
    spawnWorker,
    terminateWorker: async () => {},
    listWorkers: () => [],
    injectWorker: () => false,
    injectAgent: () => true,
    reloadCrons: () => {},
    isAutonomousWorkAllowed: () => opts.autonomousWorkAllowed,
  };
}

describe('spawn-worker IPC — working-hours admission gate', () => {
  it('blocks the spawn and never calls agentManager.spawnWorker when the gate is closed', async () => {
    const { IPCServer, IPCClient } = await import('../../../src/daemon/ipc-server.js');
    const manager = fakeAgentManager({ autonomousWorkAllowed: false });
    const server = new IPCServer(manager as never, instanceId);
    await server.start();

    try {
      const client = new IPCClient(instanceId);
      const response = await client.send({
        type: 'spawn-worker',
        data: { name: 'test-worker', dir: tmpRoot, prompt: 'do work' },
      });

      expect(response.success).toBe(false);
      expect(response.error).toBe(
        'Working-hours gate: worker spawn blocked outside Europe/London weekday 07:00-19:00',
      );
      expect(manager.spawnWorker).not.toHaveBeenCalled();
    } finally {
      server.stop();
    }
  });

  it('allows the spawn and calls agentManager.spawnWorker when the gate is open', async () => {
    const { IPCServer, IPCClient } = await import('../../../src/daemon/ipc-server.js');
    const manager = fakeAgentManager({ autonomousWorkAllowed: true });
    const server = new IPCServer(manager as never, instanceId);
    await server.start();

    try {
      const client = new IPCClient(instanceId);
      const response = await client.send({
        type: 'spawn-worker',
        data: { name: 'test-worker', dir: tmpRoot, prompt: 'do work' },
      });

      expect(response.success).toBe(true);
      expect(manager.spawnWorker).toHaveBeenCalledWith('test-worker', tmpRoot, 'do work', undefined, undefined);
    } finally {
      server.stop();
    }
  });
});
