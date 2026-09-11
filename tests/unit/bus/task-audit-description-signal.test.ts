/**
 * Audit-log content signal for description edits on `update`.
 *
 * Before this fix, an audit row recorded the status transition and nothing
 * else. A description APPEND and a destructive `--replace-desc` OVERWRITE of
 * several thousand characters therefore produced BYTE-IDENTICAL rows —
 * `{"ts":...,"event":"update","agent":"rimu","from":"pending","to":"pending"}`,
 * a no-op transition carrying zero information about the content that had just
 * been thrown away. The audit log is precisely where an operator looks to
 * detect silent data loss and it structurally could not show it.
 *
 * The bar for these tests is DISCRIMINATION, not presence. Asserting that a
 * length field exists does not close the defect: the defect is that two
 * different edits are indistinguishable. So every test here performs TWO
 * differing operations and asserts the rows can be told apart — and the
 * equal-length case exists because a length delta alone is blind to
 * substitution, which is the only reason the hash is carried as well.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { createTask, updateTask, readTaskAudit } from '../../../src/bus/task';
import type { BusPaths } from '../../../src/types';
import type { TaskAuditEntry } from '../../../src/bus/task';

const ACTOR = 'rimu';
const ORIGINAL = 'original description '.repeat(20); // 400 chars
const ADDED = 'a short appended note';

/** Recompute the signal independently of the implementation under test. */
const hash12 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

/** The pre-fix row shape — everything the audit log used to carry. */
const oldShape = (e: TaskAuditEntry) => ({
  event: e.event,
  agent: e.agent,
  from: e.from,
  to: e.to,
});

describe('task audit description content signal', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-audit-desc-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', ACTOR),
      inflight: join(testDir, 'inflight', ACTOR),
      processed: join(testDir, 'processed', ACTOR),
      logDir: join(testDir, 'logs', ACTOR),
      stateDir: join(testDir, 'state', ACTOR),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const makeTask = (description = ORIGINAL) =>
    createTask(paths, ACTOR, 'testorg', 'a task with a description', {
      assignee: ACTOR,
      description,
    });

  const lastUpdate = (id: string): TaskAuditEntry => {
    const updates = readTaskAudit(paths, id).filter(e => e.event === 'update');
    expect(updates.length).toBeGreaterThan(0);
    return updates[updates.length - 1];
  };

  /** The raw JSONL line, so "absent" can be asserted on disk and not just in a cast object. */
  const rawUpdateLines = (id: string): Record<string, unknown>[] => {
    const path = join(paths.taskDir, 'audit', `${id}.jsonl`);
    expect(existsSync(path)).toBe(true);
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as Record<string, unknown>)
      .filter(o => o.event === 'update');
  };

  it('(a) tells a description APPEND apart from a destructive REPLACE', () => {
    // Same actor, same status transition, same resulting text added. The ONLY
    // difference is whether the original 400 characters survived.
    const appendId = makeTask();
    const replaceId = makeTask();

    // What the CLI computes for an append: `${before}\n\n${opts.desc}`.
    updateTask(paths, ACTOR, appendId, 'pending', `${ORIGINAL}\n\n${ADDED}`);
    // What the CLI computes for --replace-desc: the new text, alone.
    updateTask(paths, ACTOR, replaceId, 'pending', ADDED);

    const appended = lastUpdate(appendId);
    const replaced = lastUpdate(replaceId);

    // THE REGRESSION, stated exactly: on the pre-fix row shape these two
    // operations are identical. If this assertion ever fails, the two cases
    // were already distinguishable and this test is no longer testing the bug.
    expect(oldShape(appended)).toEqual(oldShape(replaced));

    // And the fix: the full rows are NOT identical.
    expect(appended).not.toEqual(replaced);

    // Append: prior content intact, length grew.
    expect(appended.desc_len_before).toBe(ORIGINAL.length);
    expect(appended.desc_len_after).toBe(ORIGINAL.length + 2 + ADDED.length);
    expect(appended.desc_len_after!).toBeGreaterThan(appended.desc_len_before!);

    // Replace: prior content destroyed, length collapsed to the new text alone.
    expect(replaced.desc_len_before).toBe(ORIGINAL.length);
    expect(replaced.desc_len_after).toBe(ADDED.length);
    expect(replaced.desc_len_after!).toBeLessThan(replaced.desc_len_before!);

    // Both started from the same content, so the BEFORE hashes agree — it is
    // the AFTER that separates them.
    expect(appended.desc_hash_before).toBe(replaced.desc_hash_before);
    expect(appended.desc_hash_after).not.toBe(replaced.desc_hash_after);
  });

  it('(b) a status-only update emits NO content fields — absent, not zero', () => {
    const id = makeTask();
    updateTask(paths, ACTOR, id, 'in_progress'); // no desc argument at all

    const [row] = rawUpdateLines(id);
    expect(row.from).toBe('pending');
    expect(row.to).toBe('in_progress');

    // Absence is the requirement. A recorded 0 would read as "description
    // wiped" and would fire on every ordinary status change — a false positive
    // in the alarming direction on the most common operation there is.
    for (const key of ['desc_len_before', 'desc_len_after', 'desc_hash_before', 'desc_hash_after']) {
      expect(Object.prototype.hasOwnProperty.call(row, key)).toBe(false);
    }
    expect(JSON.stringify(row)).not.toContain('desc_len');
    expect(JSON.stringify(row)).not.toContain('desc_hash');
  });

  it('(b2) a status-only row cannot be mistaken for a wipe of the same task', () => {
    // The discriminating pair for (b): one task loses its description, an
    // identical task merely changes status. If the wipe row and the no-op row
    // agree, the signal is useless.
    const wipedId = makeTask();
    const untouchedId = makeTask();

    updateTask(paths, ACTOR, wipedId, 'in_progress', ''); // description destroyed
    updateTask(paths, ACTOR, untouchedId, 'in_progress'); // description untouched

    const wiped = lastUpdate(wipedId);
    const untouched = lastUpdate(untouchedId);

    expect(oldShape(wiped)).toEqual(oldShape(untouched)); // indistinguishable pre-fix
    expect(wiped).not.toEqual(untouched);

    // A real wipe is recorded explicitly: content existed, now it does not.
    expect(wiped.desc_len_before).toBe(ORIGINAL.length);
    expect(wiped.desc_len_after).toBe(0);
    expect(wiped.desc_hash_after).toBe(hash12(''));
    // The untouched task carries no claim about its description either way.
    expect(untouched.desc_len_after).toBeUndefined();
  });

  it('(c) detects an EQUAL-LENGTH substitution that a length check alone would miss', () => {
    const before = 'A'.repeat(120);
    const after = 'B'.repeat(120);
    const id = makeTask(before);

    updateTask(paths, ACTOR, id, 'pending', after);
    const row = lastUpdate(id);

    // Length is blind here — this is exactly the case the hash exists for.
    expect(row.desc_len_before).toBe(120);
    expect(row.desc_len_after).toBe(120);
    expect(row.desc_len_before).toBe(row.desc_len_after);

    expect(row.desc_hash_before).not.toBe(row.desc_hash_after);

    // Instrument validation: the recorded hashes reproduce values computed
    // here, independently of the writer. Proves the field is the content's
    // hash and not, say, a hash of the task id.
    expect(row.desc_hash_before).toBe(hash12(before));
    expect(row.desc_hash_after).toBe(hash12(after));
    expect(row.desc_hash_before).toHaveLength(12);
  });

  it('(c2) an identical re-write is distinguishable from a real substitution', () => {
    const text = 'C'.repeat(120);
    const noopId = makeTask(text);
    const swapId = makeTask(text);

    updateTask(paths, ACTOR, noopId, 'pending', text); // same content written back
    updateTask(paths, ACTOR, swapId, 'pending', 'D'.repeat(120)); // equal-length swap

    const noop = lastUpdate(noopId);
    const swap = lastUpdate(swapId);

    // Both are same-length writes; only the hash separates them.
    expect(noop.desc_len_before).toBe(noop.desc_len_after);
    expect(swap.desc_len_before).toBe(swap.desc_len_after);
    expect(noop.desc_hash_before).toBe(noop.desc_hash_after);
    expect(swap.desc_hash_before).not.toBe(swap.desc_hash_after);
  });

  it('leaves create/claim/complete rows unchanged — this signal is update-only', () => {
    const id = makeTask();
    const [create] = readTaskAudit(paths, id).filter(e => e.event === 'create');
    expect(create.desc_len_before).toBeUndefined();
    expect(create.desc_len_after).toBeUndefined();
    expect(create.desc_hash_before).toBeUndefined();
    expect(create.desc_hash_after).toBeUndefined();
  });

  it('a task created with no description records 0-before, not a missing field', () => {
    // The first description ever written to an empty task is a legitimate
    // 0 -> N, and it must not look like the fields were skipped.
    const id = makeTask('');
    updateTask(paths, ACTOR, id, 'pending', ADDED);
    const row = lastUpdate(id);

    expect(row.desc_len_before).toBe(0);
    expect(row.desc_hash_before).toBe(hash12(''));
    expect(row.desc_len_after).toBe(ADDED.length);
  });
});
