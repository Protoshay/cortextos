/**
 * Regression test: weekday-close restarts were misclassified as crashes.
 *
 * src/daemon/close-lifecycle.ts's CloseLifecycleCoordinator drives an
 * end-of-day fresh-session restart for every agent via the
 * `requestFreshRestart` closure that AgentManager wires up in its
 * constructor (src/daemon/agent-manager.ts). That closure used to write only
 * the `.force-fresh` marker before restarting the agent. The SessionEnd hook
 * src/hooks/hook-crash-alert.ts classifies a session's end type purely by
 * scanning for marker files in state/<agent>/ — `.force-fresh` is not one of
 * the markers it looks for, so with no `.restart-planned` marker present it
 * fell through to its `endType = 'crash'` default and fired a false
 * "🚨 CRASH: X died unexpectedly" Telegram alert on every weekday close,
 * even though the session ended cleanly (12 Aug, 13 Aug).
 *
 * Fix: requestFreshRestart now also writes `.restart-planned` (mirroring
 * src/bus/system.ts's hardRestart(), which already writes both markers for
 * the same reason) so the hook classifies the end type as
 * 'planned-restart' and suppresses the human-facing alert.
 *
 * hook-crash-alert.ts's marker-scanning loop lives inside its unexported
 * main() and is not itself unit-testable in isolation (main() also touches
 * process.env, IPC, and Telegram). `classifyEndTypeFromMarkers` below is a
 * deliberate line-for-line mirror of that loop (src/hooks/hook-crash-alert.ts
 * lines ~179-205) used purely to prove, at the unit level, what endType the
 * real hook would derive from a given state directory. If the marker list or
 * scan order in hook-crash-alert.ts ever changes, this mirror must be
 * updated to match or this test stops being meaningful.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { execFileSync, spawn } from 'child_process';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { shouldNotifyHuman } from '../../../src/hooks/hook-crash-alert';

// Mock the PTY layer so we don't load native bindings or spawn real processes.
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    dir: string;
    constructor(name: string, dir: string) {
      this.name = name;
      this.dir = dir;
    }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'stopped' }; }
    isBootstrapped() { return false; }
    onExit() { /* no-op */ }
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    start() { /* no-op */ }
    stop() { /* no-op */ }
    wake() { /* no-op */ }
  },
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor() { /* no-op */ }
  },
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    start() { /* no-op */ }
    stop() { /* no-op */ }
  },
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

// Mirror of hook-crash-alert.ts's marker-scanning loop (see file header).
function classifyEndTypeFromMarkers(stateDir: string): { endType: string; reason: string } {
  const markers = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    { file: '.user-disable', type: 'user-disable' },
    { file: '.user-stop', type: 'user-stop' },
    { file: '.daemon-crashed', type: 'daemon-crashed' },
    { file: '.daemon-stop', type: 'daemon-stop' },
  ];
  let endType = 'crash';
  let reason = '';
  for (const marker of markers) {
    const markerPath = join(stateDir, marker.file);
    if (existsSync(markerPath)) {
      endType = marker.type;
      reason = readFileSync(markerPath, 'utf-8').trim();
      break;
    }
  }
  return { endType, reason };
}

describe('AgentManager weekday-close requestFreshRestart marker fix', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-close-restart-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('POSITIVE: writes .restart-planned alongside .force-fresh, so the hook classifies the close restart as planned-restart, not crash', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    // requestFreshRestart calls this.restartAgent(agent) — stub it so we don't
    // spin up the real (mocked) AgentProcess start/stop machinery, and instead
    // simulate the agent coming back up cleanly.
    const restartSpy = vi.spyOn(am, 'restartAgent').mockResolvedValue();
    (am as any).agents.set('alice', {
      process: {
        getStatus: () => ({ status: 'running', pid: 4242, sessionStart: 1_700_000_000 }),
        isBootstrapped: () => true,
      },
    });

    const stateDir = join(ctxRoot, 'state', 'alice');
    const reason = 'weekday close 2026-08-14';

    // Exercise the actual closure wired up in the AgentManager constructor —
    // this is the exact code path the CloseLifecycleCoordinator invokes.
    const closeLifecycle = (am as any).closeLifecycle;
    const identity = await closeLifecycle.deps.requestFreshRestart('alice', reason, 'attempt-1');

    expect(restartSpy).toHaveBeenCalledWith('alice');
    expect(identity).toBe('4242:1700000000');

    // .force-fresh must still be written exactly as before (agent-process.ts
    // reads this to decide the session should start truly fresh, no
    // --continue) — the fix must not change this existing behavior.
    expect(existsSync(join(stateDir, '.force-fresh'))).toBe(true);
    expect(readFileSync(join(stateDir, '.force-fresh'), 'utf-8')).toBe(reason + '\n');

    // The fix: .restart-planned must now also be present with the same reason.
    expect(existsSync(join(stateDir, '.restart-planned'))).toBe(true);
    expect(readFileSync(join(stateDir, '.restart-planned'), 'utf-8')).toBe(reason + '\n');

    // Drive the (mirrored) hook classification logic against the resulting
    // state dir and confirm it resolves to 'planned-restart', not 'crash'.
    const classified = classifyEndTypeFromMarkers(stateDir);
    expect(classified.endType).toBe('planned-restart');
    expect(classified.reason).toBe(reason);
  });

  it('NEGATIVE: a real crash with no marker files still classifies as crash (must keep alerting)', () => {
    // No requestFreshRestart call here at all — this simulates a genuine
    // unplanned process death: state dir exists (from prior runs) but no
    // lifecycle marker was ever written, exactly as happens when the agent
    // process dies without any of the CLI/system.ts/agent-manager.ts code
    // paths that write markers running first.
    const stateDir = join(ctxRoot, 'state', 'bob');
    mkdirSync(stateDir, { recursive: true });

    const classified = classifyEndTypeFromMarkers(stateDir);

    expect(classified.endType).toBe('crash');
    expect(classified.reason).toBe('');
  });
});

/**
 * Real-execution regression test.
 *
 * The two tests above prove the FIX (agent-manager.ts writes both markers)
 * and a MIRROR of the hook's classification logic. Neither actually runs
 * src/hooks/hook-crash-alert.ts — a reviewer (rimu) correctly flagged that
 * "the mirror agrees with itself" is not proof the real hook (a) actually
 * consumes the `.restart-planned` marker via its real unlinkSync call inside
 * a try/catch that could silently swallow a failure, and (b) does not leave
 * some latent state behind that would cause a SUBSEQUENT, unrelated real
 * crash of the newly-restarted session to also be misclassified as
 * 'planned-restart' — a false all-clear, worse than the original false alarm.
 *
 * This block executes the REAL src/hooks/hook-crash-alert.ts as a child
 * process (via the `tsx` CLI already vendored in node_modules — no compiled
 * dist/ dependency, since dist/ is gitignored and not guaranteed to exist in
 * every environment this test runs in, e.g. CI's "test" job does not share
 * build artifacts with its separate "build" job) and a REAL child process
 * killed with a REAL SIGKILL, per this repo's standing distrust of "should
 * work by reading the code" claims that were never actually executed.
 *
 * Isolation: hook-crash-alert.ts's main() resolves its own ctxRoot via
 * `join(homedir(), '.cortextos', instanceId)` — it cannot be pointed at an
 * arbitrary fixture directory directly. Node's `os.homedir()` respects
 * `process.env.HOME` on POSIX (the same pattern already used by
 * tests/unit/cli/lifecycle-markers.test.ts for a sibling hook-adjacent
 * helper), so the fixture builds its own HOME dir and derives ctxRoot as
 * `join(HOME, '.cortextos', instanceId)` so the AgentManager closure (which
 * takes ctxRoot as a plain argument, no homedir() involved) and the real
 * hook subprocess (which only knows homedir()+instanceId) necessarily agree
 * on the same state dir.
 *
 * BOT_TOKEN / CHAT_ID are deliberately left unset in the child's env: reading
 * main()'s source top to bottom, the `if (!botToken || !chatId) return;`
 * guard sits BEFORE both the Telegram-IPC send block and the
 * `notifyAgents(...)` bus-message block, so an unset token exercises the
 * real marker-scan/consume/log path in full while guaranteeing no outbound
 * network call or `cortextos bus send-message` subprocess spawn — this was
 * verified by reading main()'s control flow above, not assumed.
 */
describe('AgentManager weekday-close restart marker — REAL hook-crash-alert.ts subprocess execution', () => {
  let tmpHome: string;
  let instanceId: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let stateDir: string;
  let logDir: string;

  // Resolve the tsx CLI the same way node's own module resolution would from
  // this test file's location — this repo vendors tsx (package.json
  // devDependencies) specifically so TS sources can be run directly without
  // a build step (see tests/playwright/*.spec.ts's `require('tsx/cjs')`).
  const require = createRequire(import.meta.url);
  const TSX_CLI_PATH = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
  const HOOK_SCRIPT_PATH = fileURLToPath(
    new URL('../../../src/hooks/hook-crash-alert.ts', import.meta.url),
  );

  function runHookOnce(): { stdout: string } {
    // Explicitly build the child env rather than spreading process.env
    // wholesale — BOT_TOKEN/CHAT_ID must be ABSENT (see file-header note),
    // and HOME must point at the fixture, not the real machine's home dir.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: tmpHome,
      CTX_INSTANCE_ID: instanceId,
      CTX_AGENT_NAME: 'alice',
    };
    const stdout = execFileSync(process.execPath, [TSX_CLI_PATH, HOOK_SCRIPT_PATH], {
      env,
      timeout: 20_000,
      encoding: 'utf-8',
    });
    return { stdout };
  }

  function readCrashLogLines(): string[] {
    const raw = readFileSync(join(logDir, 'crashes.log'), 'utf-8');
    return raw.split('\n').filter((l) => l.length > 0);
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cortextos-am-close-restart-realhook-home-'));
    instanceId = 'realhook-test';
    ctxRoot = join(tmpHome, '.cortextos', instanceId);
    frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-am-close-restart-realhook-fw-'));
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    stateDir = join(ctxRoot, 'state', 'alice');
    logDir = join(ctxRoot, 'logs', 'alice');
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  it(
    'REAL EXECUTION: the real hook consumes .restart-planned and logs planned-restart, then genuinely still alerts on a subsequent real crash of the new session',
    async () => {
      const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
      const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
      vi.spyOn(am, 'restartAgent').mockResolvedValue();
      (am as any).agents.set('alice', {
        process: {
          getStatus: () => ({ status: 'running', pid: 5151, sessionStart: 1_700_000_100 }),
          isBootstrapped: () => true,
        },
      });

      const reason = 'weekday close 2026-08-14 real-hook-subprocess-test';
      const closeLifecycle = (am as any).closeLifecycle;
      await closeLifecycle.deps.requestFreshRestart('alice', reason, 'attempt-1');

      // Sanity: both markers landed before we ever invoke the real hook.
      expect(existsSync(join(stateDir, '.force-fresh'))).toBe(true);
      expect(existsSync(join(stateDir, '.restart-planned'))).toBe(true);

      // --- Step 1: run the REAL hook script as a child process. ---
      runHookOnce();

      // Proves real consumption (unlinkSync), not the mirror's assumption of
      // it: the marker file must actually be gone from disk.
      expect(existsSync(join(stateDir, '.restart-planned'))).toBe(false);
      // The hook's marker-scan loop only touches the marker it matched —
      // .force-fresh (read by agent-process.ts, not this hook) must survive.
      expect(existsSync(join(stateDir, '.force-fresh'))).toBe(true);

      let lines = readCrashLogLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('type=planned-restart');
      expect(lines[0]).toContain(`reason=${reason}`);

      // --- Step 2: stand in for "the new session" with a REAL process, and
      // kill it with a REAL SIGKILL (not a mock, per the reviewer's ask). ---
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      const killed = child.kill('SIGKILL');
      expect(killed).toBe(true);
      const { signal } = await exited;
      expect(signal).toBe('SIGKILL');

      // --- Step 3: fire the real hook AGAIN against the SAME state dir. No
      // new marker was written — the close's .restart-planned marker was
      // already consumed in step 1 — simulating the new session's SessionEnd
      // hook firing for this genuine, unrelated crash. ---
      runHookOnce();

      lines = readCrashLogLines();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('type=crash');
      expect(lines[1]).toContain('reason=none');

      // The marker-consumption fix must not create a false all-clear for a
      // real subsequent crash: confirm via the REAL exported function
      // (not re-derived by hand) that this endType is still alert-worthy.
      expect(shouldNotifyHuman('crash')).toBe(true);
      // And confirm the type the close restart produced is exactly the one
      // designed to be suppressed — the two must differ, or the fix would
      // have simply moved the false-alarm problem rather than fixed it.
      expect(shouldNotifyHuman('planned-restart')).toBe(false);
    },
    30_000,
  );
});
