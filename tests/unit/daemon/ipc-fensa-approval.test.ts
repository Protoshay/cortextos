import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { mkdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

let instanceId: string;
let ipcDir: string;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stable(obj[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payload(seq = 9) {
  return {
    seq,
    customer_name: 'Dr Test',
    customer_phone: '',
    customer_email: '',
    address: { AddressLine1: '1 Test Road', Postcode: 'SW1 1AA' },
    completion: '2026-06-01',
    contract_value_vat_inc: 1234.56,
    windows: 2,
    doors_over50: 0,
    doors_under50: 0,
    installer_reference: '',
  };
}

function manager() {
  const registerFensaApproval = vi.fn(() => '0123456789abcdef');
  const consumeFensaApproval = vi.fn()
    .mockReturnValueOnce(true)
    .mockReturnValue(false);
  const handleSendRequest = vi.fn(async () => ({ ok: true, sentMessageId: 77 }));
  return {
    registerFensaApproval,
    consumeFensaApproval,
    handleSendRequest,
    api: {
      getFastChecker: () => ({ registerFensaApproval, consumeFensaApproval }),
      getTelegramSendService: () => ({ handleSendRequest }),
      getAllStatuses: () => [], getAgentNames: () => [], startAgent: async () => {},
      stopAgent: async () => {}, restartAgent: async () => {}, spawnWorker: async () => {},
      terminateWorker: async () => {}, listWorkers: () => [], injectWorker: () => false,
      injectAgent: () => true, reloadCrons: () => {},
    },
  };
}

beforeEach(() => {
  instanceId = `test-fensa-approval-${randomBytes(4).toString('hex')}`;
  ipcDir = join(homedir(), '.cortextos', instanceId);
  mkdirSync(ipcDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(ipcDir, { recursive: true }); } catch { /* ignore */ }
});

describe('FENSA approval IPC anti-tampering', () => {
  it('recomputes the hash, scopes Rocky to Shab, and renders from the exact payload', async () => {
    const { IPCServer, IPCClient } = await import('../../../src/daemon/ipc-server.js');
    const m = manager();
    const server = new IPCServer(m.api as never, instanceId);
    await server.start();
    try {
      const p = payload();
      const hash = createHash('sha256').update(stable(p)).digest('hex');
      const response = await new IPCClient(instanceId).send({
        type: 'request-fensa-approval', agent: 'rocky',
        data: { chatId: '8915751414', seq: 9, payloadHash: hash, payload: p },
      });
      expect(response.success).toBe(true);
      expect(m.registerFensaApproval).toHaveBeenCalledWith(hash, 9);
      const request = m.handleSendRequest.mock.calls[0][0];
      expect(request.text).toContain('Dr Test');
      expect(request.text).toContain('1 Test Road');
      expect(request.text).toContain('Reference: (none)');
      expect(request.text).not.toContain('?');
      expect(request.text).not.toMatch(/fensa/i);
      expect(request.replyMarkup.inline_keyboard[0][0].callback_data)
        .toBe('fensa_allow_0123456789abcdef');
    } finally { server.stop(); }
  });

  it.each([
    ['wrong agent', 'otis', '8915751414', 9, false],
    ['wrong chat', 'rocky', '8721344756', 9, false],
    ['hash mismatch', 'rocky', '8915751414', 9, false],
    ['seq mismatch', 'rocky', '8915751414', 10, true],
  ])('rejects %s before registering', async (_label, agent, chatId, seq, hashMatchesPayload) => {
    const { IPCServer, IPCClient } = await import('../../../src/daemon/ipc-server.js');
    const m = manager();
    const server = new IPCServer(m.api as never, instanceId);
    await server.start();
    try {
      const p = payload(9);
      const hash = hashMatchesPayload
        ? createHash('sha256').update(stable(p)).digest('hex')
        : 'f'.repeat(64);
      const response = await new IPCClient(instanceId).send({
        type: 'request-fensa-approval', agent,
        data: { chatId, seq, payloadHash: hash, payload: p },
      });
      expect(response.success).toBe(false);
      expect(m.registerFensaApproval).not.toHaveBeenCalled();
    } finally { server.stop(); }
  });

  it('consumes once and refuses reuse through the real IPC handler', async () => {
    const { IPCServer, IPCClient } = await import('../../../src/daemon/ipc-server.js');
    const m = manager();
    const server = new IPCServer(m.api as never, instanceId);
    await server.start();
    try {
      const client = new IPCClient(instanceId);
      const first = await client.send({
        type: 'consume-fensa-approval', agent: 'rocky',
        data: { seq: 9, payloadHash: 'a'.repeat(64) },
      });
      const second = await client.send({
        type: 'consume-fensa-approval', agent: 'rocky',
        data: { seq: 9, payloadHash: 'a'.repeat(64) },
      });
      expect(first.success).toBe(true);
      expect(second.success).toBe(false);
    } finally { server.stop(); }
  });
});
