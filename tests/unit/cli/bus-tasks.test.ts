import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTask } from '../../../src/bus/task';
import { resolvePaths } from '../../../src/utils/paths';
import type { Task } from '../../../src/types';
import { busCommand } from '../../../src/cli/bus';

let tmpRoot: string;
const previous = {
  root: process.env.CTX_ROOT,
  agent: process.env.CTX_AGENT_NAME,
  org: process.env.CTX_ORG,
  instanceId: process.env.CTX_INSTANCE_ID,
};

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bus-tasks-test-'));
  process.env.CTX_ROOT = tmpRoot;
  process.env.CTX_AGENT_NAME = 'alice';
  process.env.CTX_ORG = 'acme';
  // resolvePaths() builds ctxRoot from instanceId, not from CTX_ROOT - seedTask() below
  // hardcodes resolvePaths('alice', 'default', 'acme'). Without pinning CTX_INSTANCE_ID here
  // too, busCommand's own resolveEnv() picks up whatever CTX_INSTANCE_ID is set in the real
  // environment (e.g. CI sets CTX_INSTANCE_ID=ci-test), landing on a different ctxRoot than
  // the one seedTask() just wrote the task under - a mismatch invisible outside CI.
  process.env.CTX_INSTANCE_ID = 'default';
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (previous.root === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = previous.root;
  if (previous.agent === undefined) delete process.env.CTX_AGENT_NAME;
  else process.env.CTX_AGENT_NAME = previous.agent;
  if (previous.org === undefined) delete process.env.CTX_ORG;
  else process.env.CTX_ORG = previous.org;
  if (previous.instanceId === undefined) delete process.env.CTX_INSTANCE_ID;
  else process.env.CTX_INSTANCE_ID = previous.instanceId;
  vi.restoreAllMocks();
});

function seedTask(): { id: string; path: string } {
  const paths = resolvePaths('alice', 'default', 'acme');
  const id = createTask(paths, 'alice', 'acme', 'Description semantics', {
    assignee: 'alice',
    description: 'original',
  });
  return { id, path: join(paths.taskDir, `${id}.json`) };
}

describe('bus update-task description semantics', () => {
  it('appends --desc by default and reports the length change', async () => {
    const { id, path } = seedTask();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'update-task', id, '--desc', 'follow-up']);

    const task = JSON.parse(readFileSync(path, 'utf-8')) as Task;
    expect(task.description).toBe('original\n\nfollow-up');
    expect(log).toHaveBeenCalledWith('Description appended: 8 -> 19 chars');
  });

  it('replaces only when --replace-desc is explicit', async () => {
    const { id, path } = seedTask();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'update-task', id, '--desc', 'replacement', '--replace-desc',
    ]);

    const task = JSON.parse(readFileSync(path, 'utf-8')) as Task;
    expect(task.description).toBe('replacement');
  });
});

describe('bus list-tasks text rendering', () => {
  it('prints the complete task ID with a separator before the assignee', async () => {
    const { id } = seedTask();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value = '') => lines.push(String(value)));

    await busCommand.parseAsync(['node', 'bus', 'list-tasks']);

    const row = lines.find((line) => line.includes(id));
    expect(id).toHaveLength(27);
    expect(row).toBeDefined();
    expect(row).toContain(`${id} alice`);
  });

  it('marks a clipped title with an ellipsis while leaving short titles unchanged', async () => {
    const paths = resolvePaths('alice', 'default', 'acme');
    createTask(paths, 'alice', 'acme', 'x'.repeat(51), { assignee: 'alice' });
    createTask(paths, 'alice', 'acme', 'short title', { assignee: 'alice' });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value = '') => lines.push(String(value)));

    await busCommand.parseAsync(['node', 'bus', 'list-tasks']);

    expect(lines.some((line) => line.endsWith(`${'x'.repeat(49)}…`))).toBe(true);
    expect(lines.some((line) => line.endsWith('short title'))).toBe(true);
  });
});
