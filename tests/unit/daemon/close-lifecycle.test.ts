import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendCloseReceipt,
  CloseLifecycleCoordinator,
  closeDeadlinePassed,
  createCloseState,
  markCloseFailed,
  markFreshSessionVerified,
  markRestartRequested,
  nextCloseStage,
  previousLondonWeekday,
  shouldPrepareClose,
  readCloseState,
  verifyCloseArtifacts,
  waitForReadySession,
  writeCloseState,
} from '../../../src/daemon/close-lifecycle.js';

const artifact = (path: string) => ({ path, size: 10, mtimeMs: Date.parse('2026-08-05T17:31:00Z'), sha256: 'a'.repeat(64) });
const roots = (root: string) => ({ memory: [root], 'task-truth': [root], knowledge: [root] });

describe('weekday close lifecycle', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['Monday before', '2026-08-03T17:29:00Z', false],
    ['Monday prepare', '2026-08-03T17:30:00Z', true],
    ['Friday prepare', '2026-08-07T17:59:00Z', true],
    ['Friday deadline', '2026-08-07T18:00:00Z', false],
    ['Saturday', '2026-08-08T17:30:00Z', false],
    ['Sunday', '2026-08-09T17:30:00Z', false],
  ])('%s', (_name, iso, expected) => {
    expect(shouldPrepareClose(new Date(iso))).toBe(expected);
  });

  it('uses Europe/London across GMT and BST', () => {
    expect(shouldPrepareClose(new Date('2026-01-05T18:30:00Z'))).toBe(true);
    expect(shouldPrepareClose(new Date('2026-08-03T17:30:00Z'))).toBe(true);
  });

  it('does not treat running as ready until bootstrap is observed', async () => {
    let reads = 0;
    const identity = await waitForReadySession(() => {
      reads++;
      return { bootstrapped: reads >= 3, identity: '42:new-session' };
    }, 50, 1);
    expect(identity).toBe('42:new-session');
    expect(await waitForReadySession(() => ({ bootstrapped: false, identity: '42:running-only' }), 2, 1)).toBeNull();
  });

  it('carries prior close reconciliation across weekends', () => {
    expect(previousLondonWeekday('2026-08-10')).toBe('2026-08-07');
    expect(previousLondonWeekday('2026-08-05')).toBe('2026-08-04');
  });

  it('is once per London date', () => {
    const at = new Date('2026-08-03T17:30:00Z');
    const state = createCloseState('scout', at);
    expect(shouldPrepareClose(new Date('2026-08-03T17:45:00Z'), state)).toBe(false);
    expect(shouldPrepareClose(new Date('2026-08-04T17:30:00Z'), state)).toBe(true);
  });

  it('requires ordered, artifact-backed receipts before restart', () => {
    let state = createCloseState('scout', new Date('2026-08-05T17:30:00Z'));
    expect(nextCloseStage(state)).toBe('memory');
    expect(() => appendCloseReceipt(state, 'knowledge', [artifact('/knowledge.md')], new Date())).toThrow(/expected memory/);
    expect(() => appendCloseReceipt(state, 'memory', [], new Date())).toThrow(/requires at least one/);
    state = appendCloseReceipt(state, 'memory', [artifact('/memory.md')], new Date('2026-08-05T17:35:00Z'));
    state = appendCloseReceipt(state, 'task-truth', [artifact('/tasks.json')], new Date('2026-08-05T17:40:00Z'));
    state = appendCloseReceipt(state, 'knowledge', [artifact('/knowledge.md')], new Date('2026-08-05T17:45:00Z'));
    expect(state.status).toBe('ready-to-restart');
    state = markRestartRequested(state, new Date('2026-08-05T17:46:00Z'));
    state = markFreshSessionVerified(state, state.restartAttempt!.id, 'new-session', new Date('2026-08-05T17:47:00Z'));
    expect(state.status).toBe('complete');
  });

  it('makes deadline failure explicit but still restartable', () => {
    let state = createCloseState('scout', new Date('2026-08-05T17:30:00Z'));
    expect(closeDeadlinePassed(new Date('2026-08-05T17:59:00Z'), state)).toBe(false);
    expect(closeDeadlinePassed(new Date('2026-08-05T18:00:00Z'), state)).toBe(true);
    state = markCloseFailed(state, 'deadline reached before durable receipts completed');
    expect(state.status).toBe('failed');
    expect(markRestartRequested(state, new Date('2026-08-05T18:00:01Z')).status).toBe('restarting');
  });

  it('persists atomic state and append-only audit events', () => {
    const root = mkdtempSync(join(tmpdir(), 'close-lifecycle-'));
    tempDirs.push(root);
    const state = createCloseState('scout', new Date('2026-08-05T17:30:00Z'));
    writeCloseState(root, state, 'started');
    expect(readCloseState(root, 'scout')).toEqual(state);
    const audit = readFileSync(join(root, 'logs', 'scout', 'close-lifecycle.jsonl'), 'utf-8')
      .trim().split('\n').map(line => JSON.parse(line));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ agent: 'scout', event: 'started', status: 'preparing' });
  });

  it('verifies artifacts are regular, approved, and written after close began', () => {
    const root = mkdtempSync(join(tmpdir(), 'close-artifacts-'));
    const outside = mkdtempSync(join(tmpdir(), 'close-outside-'));
    tempDirs.push(root, outside);
    mkdirSync(join(root, 'memory'));
    const good = join(root, 'memory', '2026-08-05.md');
    const escaped = join(outside, 'secret.md');
    const empty = join(root, 'memory', 'empty.md');
    writeFileSync(good, 'saved');
    writeFileSync(empty, '');
    writeFileSync(escaped, 'outside');
    const startedAt = new Date(Date.now() - 1_000).toISOString();
    const verified = verifyCloseArtifacts([good], [root], startedAt)[0];
    expect(verified).toMatchObject({ path: good, size: 5, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(() => verifyCloseArtifacts([escaped], [root], startedAt)).toThrow(/outside approved roots/);
    expect(() => verifyCloseArtifacts([join(root, 'memory')], [root], startedAt)).toThrow(/not a regular file/);
    expect(() => verifyCloseArtifacts([empty], [root], startedAt)).toThrow(/empty/);
    expect(() => verifyCloseArtifacts([good], [root], startedAt, [verified])).toThrow(/already used/);
    expect(() => verifyCloseArtifacts([good], [root], new Date(Date.now() + 60_000).toISOString())).toThrow(/predates/);
  });

  it('rejects artifacts that do not prove the named stage outcome', () => {
    const root = mkdtempSync(join(tmpdir(), 'close-predicates-'));
    tempDirs.push(root);
    const memory = join(root, 'memory');
    const tasks = join(root, 'tasks');
    const wiki = join(root, 'wiki');
    mkdirSync(memory); mkdirSync(tasks); mkdirSync(wiki);
    const arbitraryMemory = join(memory, 'notes.md');
    const wrongOwnerTask = join(tasks, 'task_wrong.json');
    const arbitraryWiki = join(wiki, 'blob.txt');
    writeFileSync(arbitraryMemory, 'notes');
    writeFileSync(wrongOwnerTask, JSON.stringify({ assigned_to: 'otis' }));
    writeFileSync(arbitraryWiki, 'not markdown');
    const startedAt = new Date(Date.now() - 1_000).toISOString();
    expect(() => verifyCloseArtifacts([arbitraryMemory], [memory], startedAt, [], { agent: 'scout', stage: 'memory' })).toThrow(/daily memory or handoff/);
    expect(() => verifyCloseArtifacts([wrongOwnerTask], [tasks], startedAt, [], { agent: 'scout', stage: 'task-truth' })).toThrow(/not assigned to scout/);
    expect(() => verifyCloseArtifacts([arbitraryWiki], [wiki], startedAt, [], { agent: 'scout', stage: 'knowledge' })).toThrow(/canonical knowledge/);
  });

  it('coordinates ordered receipts, one daemon restart, and fresh-session completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'close-coordinator-'));
    tempDirs.push(root);
    const memoryRoot = join(root, 'memory');
    const taskRoot = join(root, 'tasks');
    mkdirSync(memoryRoot);
    mkdirSync(taskRoot);
    const paths = [join(memoryRoot, '2026-08-05.md'), join(taskRoot, 'task_1.json'), join(root, 'knowledge.md')];
    const contents = ['durable memory', JSON.stringify({ assigned_to: 'scout', status: 'in_progress' }), 'durable knowledge'];
    for (let i = 0; i < paths.length; i++) {
      writeFileSync(paths[i], contents[i]);
      utimesSync(paths[i], new Date('2026-08-05T17:31:00Z'), new Date('2026-08-05T17:31:00Z'));
    }
    const prompts: string[] = [];
    const restarts: string[] = [];
    const agent = { name: 'scout', artifactRoots: { memory: [memoryRoot], 'task-truth': [taskRoot], knowledge: [paths[2]] } };
    const coordinator = new CloseLifecycleCoordinator({
      ctxRoot: root,
      listAgents: () => [agent],
      injectPrompt: (_agent, prompt) => { prompts.push(prompt); return true; },
      currentSessionIdentity: () => 'old-session',
      requestFreshRestart: async (_agent, reason, _attemptId) => {
        restarts.push(reason);
        return 'new-session';
      },
    });

    await coordinator.tick(new Date('2026-08-05T17:30:00Z'));
    await coordinator.tick(new Date('2026-08-05T17:35:00Z'));
    expect(prompts).toHaveLength(1);
    await coordinator.receipt(agent, 'memory', [paths[0]], new Date('2026-08-05T17:35:00Z'));
    await coordinator.receipt(agent, 'task-truth', [paths[1]], new Date('2026-08-05T17:40:00Z'));
    const restarting = await coordinator.receipt(agent, 'knowledge', [paths[2]], new Date('2026-08-05T17:45:00Z'));
    expect(restarting.status).toBe('complete');
    expect(restarts).toEqual(['weekday close 2026-08-05']);
    expect((await coordinator.confirmFreshSession('scout', 'spent-attempt', 'another-session', new Date('2026-08-05T17:46:00Z')))?.status).toBe('complete');
  });

  it('records a missed close after downtime and requests only one fresh restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'close-missed-'));
    tempDirs.push(root);
    const restarts: string[] = [];
    const coordinator = new CloseLifecycleCoordinator({
      ctxRoot: root,
      listAgents: () => [{ name: 'scout', artifactRoots: roots(root) }],
      injectPrompt: () => true,
      requestFreshRestart: async (_agent, reason, _attemptId) => {
        restarts.push(reason);
        return 'new-session';
      },
    });
    await coordinator.tick(new Date('2026-08-05T18:05:00Z'));
    await coordinator.tick(new Date('2026-08-05T18:10:00Z'));
    expect(restarts).toEqual(['weekday close 2026-08-05']);
    expect(readCloseState(root, 'scout')).toMatchObject({ status: 'complete', failure: expect.stringContaining('not started') });
  });

  it('reconciles an absent Friday close when Monday work opens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'close-weekend-'));
    tempDirs.push(root);
    const restarts: string[] = [];
    const coordinator = new CloseLifecycleCoordinator({
      ctxRoot: root,
      listAgents: () => [{ name: 'scout', artifactRoots: roots(root) }],
      injectPrompt: () => true,
      requestFreshRestart: async (_agent, reason, _attemptId) => {
        restarts.push(reason);
        return 'new-session';
      },
    });
    await coordinator.tick(new Date('2026-08-10T06:00:00Z'));
    expect(restarts).toEqual(['weekday close 2026-08-07']);
    expect(readCloseState(root, 'scout')).toMatchObject({ londonDate: '2026-08-07', status: 'complete' });
  });

  it('retries a stranded restart with a new attempt identity after timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'close-retry-'));
    tempDirs.push(root);
    const attempts: string[] = [];
    const coordinator = new CloseLifecycleCoordinator({
      ctxRoot: root,
      listAgents: () => [{ name: 'scout', artifactRoots: roots(root) }],
      injectPrompt: () => true,
      requestFreshRestart: (_agent, _reason, attemptId) => { attempts.push(attemptId); return null; },
    });
    await coordinator.tick(new Date('2026-08-05T18:05:00Z'));
    await coordinator.tick(new Date('2026-08-05T18:08:00Z'));
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).not.toBe(attempts[0]);
    expect(readCloseState(root, 'scout')).toMatchObject({ status: 'restarting', restartAttempt: { attempts: 2 } });
    await expect(coordinator.confirmFreshSession('scout', attempts[0], 'new-session')).rejects.toThrow(/does not match/);
  });

  it('serializes overlapping ticks when readiness arrives at the retry boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'close-overlap-'));
    tempDirs.push(root);
    const attempts: string[] = [];
    let release!: () => void;
    const readyBoundary = new Promise<void>(resolve => { release = resolve; });
    const coordinator = new CloseLifecycleCoordinator({
      ctxRoot: root,
      listAgents: () => [{ name: 'scout', artifactRoots: roots(root) }],
      injectPrompt: () => true,
      requestFreshRestart: async (_agent, _reason, attemptId) => {
        attempts.push(attemptId);
        await readyBoundary;
        return 'bootstrapped-session';
      },
    });

    const firstTick = coordinator.tick(new Date('2026-08-05T18:05:00Z'));
    await Promise.resolve();
    const boundaryTick = coordinator.tick(new Date('2026-08-05T18:08:00Z'));
    expect(boundaryTick).toBe(firstTick);
    release();
    await Promise.all([firstTick, boundaryTick]);
    expect(attempts).toHaveLength(1);
    expect(readCloseState(root, 'scout')).toMatchObject({
      status: 'complete',
      restartAttempt: { id: attempts[0], attempts: 1 },
      freshSessionIdentity: 'bootstrapped-session',
    });
  });

  it('serializes the final receipt against the deadline transition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'close-receipt-boundary-'));
    tempDirs.push(root);
    const memoryRoot = join(root, 'memory');
    const taskRoot = join(root, 'tasks');
    mkdirSync(memoryRoot); mkdirSync(taskRoot);
    const memoryPath = join(memoryRoot, '2026-08-05.md');
    const taskPath = join(taskRoot, 'task_1.json');
    const knowledgePath = join(root, 'knowledge.md');
    writeFileSync(memoryPath, 'memory');
    writeFileSync(taskPath, JSON.stringify({ assigned_to: 'scout' }));
    writeFileSync(knowledgePath, 'knowledge');
    for (const path of [memoryPath, taskPath, knowledgePath]) {
      utimesSync(path, new Date('2026-08-05T17:31:00Z'), new Date('2026-08-05T17:31:00Z'));
    }
    const agent = {
      name: 'scout',
      artifactRoots: { memory: [memoryRoot], 'task-truth': [taskRoot], knowledge: [knowledgePath] },
    };
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const attempts: string[] = [];
    const coordinator = new CloseLifecycleCoordinator({
      ctxRoot: root,
      listAgents: () => [agent],
      injectPrompt: () => true,
      requestFreshRestart: async (_agent, _reason, attemptId) => {
        attempts.push(attemptId);
        await ready;
        return 'ready-session';
      },
    });
    await coordinator.tick(new Date('2026-08-05T17:30:00Z'));
    await coordinator.receipt(agent, 'memory', [memoryPath], new Date('2026-08-05T17:35:00Z'));
    await coordinator.receipt(agent, 'task-truth', [taskPath], new Date('2026-08-05T17:40:00Z'));

    const finalReceipt = coordinator.receipt(agent, 'knowledge', [knowledgePath], new Date('2026-08-05T17:59:59Z'));
    const deadlineTick = coordinator.tick(new Date('2026-08-05T18:00:00Z'));
    release();
    await Promise.all([finalReceipt, deadlineTick]);

    const state = readCloseState(root, 'scout');
    expect(attempts).toHaveLength(1);
    expect(state).toMatchObject({ status: 'complete', restartAttempt: { attempts: 1 } });
    expect(state?.receipts.map(receipt => receipt.stage)).toEqual(['memory', 'task-truth', 'knowledge']);
  });
});
