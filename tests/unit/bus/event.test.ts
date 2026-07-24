import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logEvent, refreshHeartbeatTimestamp } from '../../../src/bus/event';
import type { BusPaths, Heartbeat } from '../../../src/types';

/**
 * Tests for the heartbeat-refresh side-effect on logEvent. The data
 * point that motivated this behavior: 76.4% of fleet activity events
 * landed while the agent's heartbeat was >5min stale — every event
 * implies the agent is alive, so the stale-monitor should never fire
 * on an agent that is actively logging activity.
 */
describe('Bus events', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-event-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'spark'),
      inflight: join(testDir, 'inflight', 'spark'),
      processed: join(testDir, 'processed', 'spark'),
      logDir: join(testDir, 'logs', 'spark'),
      stateDir: join(testDir, 'state', 'spark'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    mkdirSync(paths.stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('logEvent appends a JSONL entry to the daily events file', () => {
    logEvent(paths, 'spark', 'eros-os', 'action', 'test_event', 'info', { foo: 'bar' });

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    expect(existsSync(eventFile)).toBe(true);

    const entries = readFileSync(eventFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agent: 'spark',
      org: 'eros-os',
      category: 'action',
      event: 'test_event',
      severity: 'info',
      metadata: { foo: 'bar' },
    });
  });

  describe('heartbeat refresh side-effect', () => {
    it('bumps last_heartbeat on an existing heartbeat.json without overwriting other fields', async () => {
      const oldHeartbeat: Heartbeat = {
        agent: 'spark',
        org: 'eros-os',
        status: 'online',
        current_task: 'fix/log-event-refreshes-heartbeat',
        mode: 'day',
        last_heartbeat: '2026-04-23T12:00:00Z',
        loop_interval: '4h',
      };
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), JSON.stringify(oldHeartbeat));

      // Let one millisecond tick so the new timestamp is strictly newer.
      await new Promise((resolve) => setTimeout(resolve, 2));
      logEvent(paths, 'spark', 'eros-os', 'action', 'activity_tick', 'info');

      const refreshed = JSON.parse(
        readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'),
      ) as Heartbeat;

      // Timestamp bumped…
      expect(new Date(refreshed.last_heartbeat).getTime()).toBeGreaterThan(
        new Date(oldHeartbeat.last_heartbeat).getTime(),
      );
      // …other fields preserved intact.
      expect(refreshed.status).toBe('online');
      expect(refreshed.current_task).toBe('fix/log-event-refreshes-heartbeat');
      expect(refreshed.mode).toBe('day');
      expect(refreshed.loop_interval).toBe('4h');
      expect(refreshed.agent).toBe('spark');
      expect(refreshed.org).toBe('eros-os');
    });

    it('is a no-op when no heartbeat.json exists yet', () => {
      // Fresh agent — no heartbeat file written yet.
      expect(existsSync(join(paths.stateDir, 'heartbeat.json'))).toBe(false);

      logEvent(paths, 'spark', 'eros-os', 'action', 'first_boot', 'info');

      // Still no heartbeat file — refresh is a no-op when nothing exists.
      expect(existsSync(join(paths.stateDir, 'heartbeat.json'))).toBe(false);

      // But the event itself was written.
      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
      expect(existsSync(eventFile)).toBe(true);
    });

    it('never blocks event persistence when the heartbeat refresh fails', () => {
      // Write a corrupt heartbeat.json to exercise the error path.
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), '{not valid json');

      // Must not throw.
      expect(() =>
        logEvent(paths, 'spark', 'eros-os', 'action', 'after_corrupt_hb', 'info'),
      ).not.toThrow();

      // Event still written.
      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
      const entries = readFileSync(eventFile, 'utf-8').trim().split('\n');
      expect(entries).toHaveLength(1);
    });
  });

  describe('refreshHeartbeatTimestamp (idle-session watchdog bump)', () => {
    // The FastChecker idle-session watchdog fires every 50min and now calls
    // refreshHeartbeatTimestamp(this.paths, ts) DIRECTLY (in-process, on the
    // agent's own resolved paths) instead of shelling out to
    // `cortextos bus update-heartbeat`. That shell-out had two bugs:
    //   1) cross-write — all 11 FastCheckers share the one daemon process env, so
    //      the CLI resolved the target from ambient CTX_AGENT_NAME and every
    //      watchdog stamp landed on ONE shared heartbeat.json.
    //   2) status-clobber — update-heartbeat overwrote the agent's meaningful
    //      status line every 50min (this is what buried a live agent's real
    //      status under "[watchdog] X alive").
    // This test locks the contract the watchdog now depends on: bump
    // last_heartbeat ONLY, preserve status and every other field.
    it('bumps last_heartbeat while preserving status and all other fields', async () => {
      const before: Heartbeat = {
        agent: 'spark',
        org: 'eros-os',
        status: 'Live session — closing Rosie Ingram deal',
        current_task: 'deal/rosie-ingram',
        mode: 'day',
        last_heartbeat: '2026-04-23T12:00:00Z',
        loop_interval: '4h',
      };
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), JSON.stringify(before));

      await new Promise((resolve) => setTimeout(resolve, 2));
      const ts = new Date().toISOString();
      refreshHeartbeatTimestamp(paths, ts);

      const after = JSON.parse(
        readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'),
      ) as Heartbeat;

      // Timestamp bumped to exactly the value the watchdog passed…
      expect(after.last_heartbeat).toBe(ts);
      expect(new Date(after.last_heartbeat).getTime()).toBeGreaterThan(
        new Date(before.last_heartbeat).getTime(),
      );
      // …and the meaningful status line is NOT clobbered (the regression skiffy hit).
      expect(after.status).toBe('Live session — closing Rosie Ingram deal');
      expect(after.current_task).toBe('deal/rosie-ingram');
      expect(after.mode).toBe('day');
      expect(after.loop_interval).toBe('4h');
      expect(after.agent).toBe('spark');
      expect(after.org).toBe('eros-os');
    });

    it('is a no-op when no heartbeat.json exists yet (does not create one)', () => {
      expect(existsSync(join(paths.stateDir, 'heartbeat.json'))).toBe(false);
      expect(() => refreshHeartbeatTimestamp(paths, new Date().toISOString())).not.toThrow();
      expect(existsSync(join(paths.stateDir, 'heartbeat.json'))).toBe(false);
    });

    // Optional status param: the watchdog stamps `context-limit-wedged` when a
    // session is context-wedged so the dashboard stops showing it healthy.
    it('sets hb.status when the optional status param is provided', () => {
      const before: Heartbeat = {
        agent: 'spark',
        org: 'eros-os',
        status: 'online',
        current_task: 'deal/rosie-ingram',
        mode: 'day',
        last_heartbeat: '2026-04-23T12:00:00Z',
        loop_interval: '4h',
      };
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), JSON.stringify(before));

      const ts = new Date().toISOString();
      refreshHeartbeatTimestamp(paths, ts, 'context-limit-wedged');

      const after = JSON.parse(
        readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'),
      ) as Heartbeat;
      expect(after.status).toBe('context-limit-wedged');
      expect(after.last_heartbeat).toBe(ts);
      // Other fields untouched.
      expect(after.current_task).toBe('deal/rosie-ingram');
      expect(after.mode).toBe('day');
    });

    it('leaves hb.status untouched when the status param is omitted', () => {
      const before: Heartbeat = {
        agent: 'spark',
        org: 'eros-os',
        status: 'Live session — closing Rosie Ingram deal',
        current_task: 'deal/rosie-ingram',
        mode: 'day',
        last_heartbeat: '2026-04-23T12:00:00Z',
        loop_interval: '4h',
      };
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), JSON.stringify(before));

      refreshHeartbeatTimestamp(paths, new Date().toISOString());

      const after = JSON.parse(
        readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'),
      ) as Heartbeat;
      expect(after.status).toBe('Live session — closing Rosie Ingram deal');
    });
  });
});
