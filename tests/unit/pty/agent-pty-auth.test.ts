import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentPTY } from '../../../src/pty/agent-pty.js';

describe('AgentPTY Claude authentication precedence', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    if (originalOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauth;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('drops an inherited API key when an agent has an OAuth token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-pty-auth-'));
    tempDirs.push(root);
    const agentDir = join(root, 'orgs', 'test-org', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=oauth-test-token\n');

    process.env.ANTHROPIC_API_KEY = 'stale-api-key';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    let spawnedEnv: Record<string, string> | undefined;
    const fakePty = {
      pid: 123,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
    };
    const pty = new AgentPTY({
      instanceId: 'default',
      ctxRoot: join(root, 'state'),
      frameworkRoot: root,
      projectRoot: root,
      agentName: 'alice',
      org: 'test-org',
      agentDir,
    } as any, {} as any);
    (pty as any).spawnFn = (_cmd: string, _args: string[], options: { env: Record<string, string> }) => {
      spawnedEnv = options.env;
      return fakePty;
    };

    await pty.spawn('fresh', 'test');

    expect(spawnedEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-test-token');
    expect(spawnedEnv).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(spawnedEnv).not.toHaveProperty('CLAUDE_API_KEY');
  });
});
