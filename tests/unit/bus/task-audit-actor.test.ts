/**
 * Audit-log actor attribution on update/complete.
 *
 * Before this fix, `updateTask` and `completeTask` wrote `task.assigned_to`
 * into the audit entry's `agent` field instead of the caller. The write itself
 * always succeeded — only the attribution was wrong — so nothing failed, and
 * the wrong name was always the assignee, i.e. exactly the name a reader
 * expects to see. The audit log could therefore never show a second agent
 * touching someone else's task.
 *
 * That is why every test here uses an actor who is NOT the assignee. A test
 * where the two coincide passes identically before and after the fix and would
 * prove nothing — the coincidence is precisely what let the bug survive.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createTask,
  updateTask,
  completeTask,
  claimTask,
  readTaskAudit,
  findTaskFile,
} from '../../../src/bus/task';
import type { BusPaths } from '../../../src/types';

const ASSIGNEE = 'rocky';
const OTHER = 'skiffy';

describe('task audit actor attribution', () => {
  let testDir: string;
  let paths: BusPaths;

  const makeTask = () =>
    createTask(paths, ASSIGNEE, 'testorg', 'a task owned by the assignee', {
      assignee: ASSIGNEE,
    });

  const auditFor = (id: string, event: string) =>
    readTaskAudit(paths, id).filter(e => e.event === event);

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-audit-actor-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', ASSIGNEE),
      inflight: join(testDir, 'inflight', ASSIGNEE),
      processed: join(testDir, 'processed', ASSIGNEE),
      logDir: join(testDir, 'logs', ASSIGNEE),
      stateDir: join(testDir, 'state', ASSIGNEE),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('records the ACTOR when another agent updates the assignee\'s task', () => {
    const id = makeTask();
    updateTask(paths, OTHER, id, 'blocked');

    const updates = auditFor(id, 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].agent).toBe(OTHER);
    // The precise regression: it must NOT be the assignee.
    expect(updates[0].agent).not.toBe(ASSIGNEE);
  });

  it('records the ACTOR when another agent completes the assignee\'s task', () => {
    const id = makeTask();
    completeTask(paths, OTHER, id, 'done by someone else');

    const completes = auditFor(id, 'complete');
    expect(completes).toHaveLength(1);
    expect(completes[0].agent).toBe(OTHER);
    expect(completes[0].agent).not.toBe(ASSIGNEE);
  });

  it('distinguishes two different agents writing to the same task', () => {
    const id = makeTask();
    updateTask(paths, OTHER, id, 'blocked');
    updateTask(paths, ASSIGNEE, id, 'in_progress');
    updateTask(paths, 'otis', id, 'pending');

    expect(auditFor(id, 'update').map(e => e.agent)).toEqual([
      OTHER,
      ASSIGNEE,
      'otis',
    ]);
  });

  it('leaves assigned_to alone — attribution is not ownership', () => {
    const id = makeTask();
    updateTask(paths, OTHER, id, 'blocked');

    const file = findTaskFile(paths, id)!;
    const task = JSON.parse(readFileSync(file, 'utf-8'));
    expect(task.assigned_to).toBe(ASSIGNEE);
    expect(task.status).toBe('blocked');
  });

  it('still records status transitions and description edits correctly', () => {
    const id = makeTask();
    updateTask(paths, OTHER, id, 'blocked', 'edited by the other agent');

    const [entry] = auditFor(id, 'update');
    expect(entry.from).toBe('pending');
    expect(entry.to).toBe('blocked');

    const task = JSON.parse(readFileSync(findTaskFile(paths, id)!, 'utf-8'));
    expect(task.description).toBe('edited by the other agent');
  });

  it('create and claim attribution is unchanged (they were never broken)', () => {
    const id = makeTask();
    claimTask(paths, id, OTHER);

    expect(auditFor(id, 'create')[0].agent).toBe(ASSIGNEE);
    expect(auditFor(id, 'claim')[0].agent).toBe(OTHER);
  });

  it('a stale positional call fails loudly rather than filing the status as the actor', () => {
    const id = makeTask();
    // The pre-fix shape: updateTask(paths, id, status). With `actor` second,
    // the id lands in `actor` and the status string lands in `taskId`, which
    // cannot resolve to a file. This is why `actor` sits second and not last —
    // completeTask's old third argument was also a string, so appending the
    // parameter would have let an un-migrated call compile AND silently file
    // the result text as the actor.
    expect(() =>
      (updateTask as unknown as (...a: unknown[]) => void)(paths, id, 'in_progress'),
    ).toThrow();
    expect(() =>
      (completeTask as unknown as (...a: unknown[]) => void)(paths, id, 'some result text'),
    ).toThrow();
  });
});
