export const CLOSE_TIMEZONE = 'Europe/London';
export const CLOSE_PREPARE_MINUTE = 18 * 60 + 30;
export const CLOSE_DEADLINE_MINUTE = 19 * 60;
export const WORKDAY_START_MINUTE = 7 * 60;

export type CloseStage = 'memory' | 'task-truth' | 'knowledge';
export type CloseStatus = 'preparing' | 'ready-to-restart' | 'restarting' | 'complete' | 'failed';

export interface CloseArtifact {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface CloseReceipt {
  stage: CloseStage;
  at: string;
  artifacts: CloseArtifact[];
}

export interface CloseLifecycleState {
  agent: string;
  londonDate: string;
  status: CloseStatus;
  startedAt: string;
  deadlineAt: string;
  receipts: CloseReceipt[];
  restartRequestedAt?: string;
  freshSessionVerifiedAt?: string;
  failure?: string;
  promptInjectedAt?: string;
  restartAttempt?: { id: string; attempts: number; requestedAt: string; priorSessionIdentity?: string };
  freshSessionIdentity?: string;
}

export interface CloseLifecycleAgent {
  name: string;
  artifactRoots: Record<CloseStage, string[]>;
}

export interface CloseLifecycleDependencies {
  ctxRoot: string;
  listAgents: () => CloseLifecycleAgent[] | Promise<CloseLifecycleAgent[]>;
  injectPrompt: (agent: string, prompt: string) => boolean | Promise<boolean>;
  requestFreshRestart: (agent: string, reason: string, attemptId: string) => string | null | Promise<string | null>;
  currentSessionIdentity?: (agent: string) => string | undefined;
  log?: (message: string) => void;
}

export interface LondonClock {
  londonDate: string;
  weekday: string;
  minuteOfDay: number;
}

export interface CloseAuditEvent {
  at: string;
  agent: string;
  londonDate: string;
  event: 'started' | 'receipt' | 'restart-requested' | 'fresh-session-verified' | 'failed';
  status: CloseStatus;
  stage?: CloseStage;
  failure?: string;
}

const STAGE_ORDER: readonly CloseStage[] = ['memory', 'task-truth', 'knowledge'];
const RESTART_RETRY_AFTER_MS = 180_000;
const MAX_RESTART_ATTEMPTS = 3;

export function londonClock(at: Date): LondonClock {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CLOSE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value ?? '';
  return {
    londonDate: `${value('year')}-${value('month')}-${value('day')}`,
    weekday: value('weekday'),
    minuteOfDay: Number(value('hour')) * 60 + Number(value('minute')),
  };
}

export function isLondonWeekday(clock: LondonClock): boolean {
  return clock.weekday !== 'Sat' && clock.weekday !== 'Sun';
}

export async function waitForReadySession(
  read: () => { bootstrapped: boolean; identity?: string },
  timeoutMs: number,
  intervalMs = 250,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = read();
    if (state.bootstrapped && state.identity) return state.identity;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  } while (true);
  return null;
}

export function shouldPrepareClose(at: Date, state?: CloseLifecycleState): boolean {
  const clock = londonClock(at);
  if (!isLondonWeekday(clock)) return false;
  if (clock.minuteOfDay < CLOSE_PREPARE_MINUTE || clock.minuteOfDay >= CLOSE_DEADLINE_MINUTE) return false;
  return state?.londonDate !== clock.londonDate;
}

export function closeDeadlinePassed(at: Date, state: CloseLifecycleState): boolean {
  const clock = londonClock(at);
  return clock.londonDate === state.londonDate && clock.minuteOfDay >= CLOSE_DEADLINE_MINUTE;
}

export function createCloseState(agent: string, at: Date): CloseLifecycleState {
  const clock = londonClock(at);
  if (!isLondonWeekday(clock)) throw new Error('Close lifecycle is weekday-only');
  if (clock.minuteOfDay < CLOSE_PREPARE_MINUTE || clock.minuteOfDay >= CLOSE_DEADLINE_MINUTE) {
    throw new Error('Close lifecycle can only start during the 18:30-19:00 Europe/London preparation window');
  }
  const deadline = new Date(
    at.getTime()
      + (CLOSE_DEADLINE_MINUTE - clock.minuteOfDay) * 60_000
      - at.getUTCSeconds() * 1_000
      - at.getUTCMilliseconds(),
  );
  return {
    agent,
    londonDate: clock.londonDate,
    status: 'preparing',
    startedAt: at.toISOString(),
    deadlineAt: deadline.toISOString(),
    receipts: [],
  };
}

export function createMissedCloseState(agent: string, at: Date): CloseLifecycleState {
  const clock = londonClock(at);
  if (!isLondonWeekday(clock) || clock.minuteOfDay < CLOSE_DEADLINE_MINUTE) {
    throw new Error('Missed close can only be recorded after the weekday 19:00 Europe/London deadline');
  }
  return {
    agent,
    londonDate: clock.londonDate,
    status: 'failed',
    startedAt: at.toISOString(),
    deadlineAt: at.toISOString(),
    receipts: [],
    failure: 'close lifecycle was not started before the 19:00 Europe/London deadline',
  };
}

export function previousLondonWeekday(londonDate: string): string {
  const cursor = new Date(`${londonDate}T12:00:00Z`);
  do cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  return cursor.toISOString().slice(0, 10);
}

function createPriorMissedCloseState(agent: string, londonDate: string, at: Date): CloseLifecycleState {
  return {
    agent,
    londonDate,
    status: 'failed',
    startedAt: at.toISOString(),
    deadlineAt: at.toISOString(),
    receipts: [],
    failure: `close lifecycle for ${londonDate} was not completed before the next workday opened`,
  };
}

export function nextCloseStage(state: CloseLifecycleState): CloseStage | null {
  return STAGE_ORDER[state.receipts.length] ?? null;
}

export function appendCloseReceipt(
  state: CloseLifecycleState,
  stage: CloseStage,
  artifacts: CloseArtifact[],
  at: Date,
): CloseLifecycleState {
  if (state.status !== 'preparing') throw new Error(`Cannot receipt stage while close status is ${state.status}`);
  const expected = nextCloseStage(state);
  if (stage !== expected) throw new Error(`Out-of-order close receipt: expected ${expected ?? 'none'}, got ${stage}`);
  if (artifacts.length === 0) throw new Error(`Close receipt ${stage} requires at least one verified durable artifact`);
  for (const artifact of artifacts) {
    if (!artifact.path || artifact.size < 0 || !Number.isFinite(artifact.mtimeMs)) {
      throw new Error(`Invalid artifact in ${stage} receipt`);
    }
  }
  const receipts = [...state.receipts, { stage, at: at.toISOString(), artifacts }];
  return {
    ...state,
    receipts,
    status: receipts.length === STAGE_ORDER.length ? 'ready-to-restart' : 'preparing',
  };
}

export function markRestartRequested(state: CloseLifecycleState, at: Date, priorSessionIdentity?: string): CloseLifecycleState {
  if (state.status !== 'ready-to-restart' && state.status !== 'failed') {
    throw new Error(`Cannot request restart while close status is ${state.status}`);
  }
  return {
    ...state,
    status: 'restarting',
    restartRequestedAt: at.toISOString(),
    restartAttempt: {
      id: randomUUID(),
      attempts: (state.restartAttempt?.attempts ?? 0) + 1,
      requestedAt: at.toISOString(),
      priorSessionIdentity,
    },
  };
}

export function markFreshSessionVerified(state: CloseLifecycleState, attemptId: string, sessionIdentity: string, at: Date): CloseLifecycleState {
  if (state.status !== 'restarting') throw new Error(`Cannot verify fresh session while close status is ${state.status}`);
  if (!state.restartAttempt || state.restartAttempt.id !== attemptId) throw new Error('Fresh-session receipt does not match active restart attempt');
  if (!sessionIdentity || sessionIdentity === state.restartAttempt.priorSessionIdentity) throw new Error('Fresh-session receipt must identify a new ready session');
  return { ...state, status: 'complete', freshSessionVerifiedAt: at.toISOString(), freshSessionIdentity: sessionIdentity };
}

export function markCloseFailed(state: CloseLifecycleState, failure: string): CloseLifecycleState {
  if (state.status === 'complete') throw new Error('Cannot fail a completed close lifecycle');
  return { ...state, status: 'failed', failure };
}

function assertAgentName(agent: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agent)) throw new Error(`Invalid agent name: ${agent}`);
}

export function closeStatePath(ctxRoot: string, agent: string): string {
  assertAgentName(agent);
  return join(ctxRoot, 'state', agent, 'close-lifecycle.json');
}

export function closeAuditPath(ctxRoot: string, agent: string): string {
  assertAgentName(agent);
  return join(ctxRoot, 'logs', agent, 'close-lifecycle.jsonl');
}

export function readCloseState(ctxRoot: string, agent: string): CloseLifecycleState | null {
  const path = closeStatePath(ctxRoot, agent);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as CloseLifecycleState;
  if (parsed.agent !== agent || !parsed.londonDate || !Array.isArray(parsed.receipts)) {
    throw new Error(`Invalid close lifecycle state at ${path}`);
  }
  return parsed;
}

export function writeCloseState(
  ctxRoot: string,
  state: CloseLifecycleState,
  event: CloseAuditEvent['event'],
  options: { stage?: CloseStage; failure?: string } = {},
): void {
  atomicWriteSync(closeStatePath(ctxRoot, state.agent), JSON.stringify(state, null, 2), true);
  const auditPath = closeAuditPath(ctxRoot, state.agent);
  ensureDir(dirname(auditPath));
  const audit: CloseAuditEvent = {
    at: new Date().toISOString(),
    agent: state.agent,
    londonDate: state.londonDate,
    event,
    status: state.status,
    ...options,
  };
  appendFileSync(auditPath, JSON.stringify(audit) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

function isWithin(path: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  return path === resolvedRoot || path.startsWith(resolvedRoot + sep);
}

export function verifyCloseArtifacts(
  artifactPaths: string[],
  allowedRoots: string[],
  startedAt: string,
  priorArtifacts: CloseArtifact[] = [],
  constraint?: { agent: string; stage: CloseStage },
): CloseArtifact[] {
  if (artifactPaths.length === 0) throw new Error('At least one artifact path is required');
  if (allowedRoots.length === 0) throw new Error('At least one allowed artifact root is required');
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) throw new Error(`Invalid close start timestamp: ${startedAt}`);
  const realRoots = allowedRoots.map(root => realpathSync(root));
  return artifactPaths.map(input => {
    const real = realpathSync(input);
    if (!realRoots.some(root => isWithin(real, root))) {
      throw new Error(`Close artifact is outside approved roots: ${input}`);
    }
    const stat = statSync(real);
    if (!stat.isFile()) throw new Error(`Close artifact is not a regular file: ${input}`);
    if (stat.size === 0) throw new Error(`Close artifact is empty: ${input}`);
    if (stat.mtimeMs < startedMs) throw new Error(`Close artifact predates lifecycle start: ${input}`);
    if (priorArtifacts.some(artifact => artifact.path === real)) throw new Error(`Close artifact was already used by an earlier stage: ${input}`);
    if (constraint) assertStageArtifact(constraint.agent, constraint.stage, real, realRoots);
    return { path: real, size: stat.size, mtimeMs: stat.mtimeMs, sha256: createHash('sha256').update(readFileSync(real)).digest('hex') };
  });
}

function assertStageArtifact(agent: string, stage: CloseStage, path: string, roots: string[]): void {
  if (stage === 'memory') {
    const rel = relative(roots[0], path);
    const daily = /^\d{4}-\d{2}-\d{2}\.md$/.test(basename(path));
    const handoff = rel.split(sep).includes('handoffs') && /^handoff-.*\.md$/.test(basename(path));
    if (!daily && !handoff) throw new Error(`Memory receipt requires a daily memory or handoff markdown artifact: ${path}`);
    return;
  }
  if (stage === 'task-truth') {
    if (extname(path) !== '.json') throw new Error(`Task-truth receipt requires a task JSON artifact: ${path}`);
    let assignedTo: unknown;
    try { assignedTo = (JSON.parse(readFileSync(path, 'utf-8')) as { assigned_to?: unknown }).assigned_to; }
    catch { throw new Error(`Task-truth artifact is not valid JSON: ${path}`); }
    if (assignedTo !== agent) throw new Error(`Task-truth artifact is not assigned to ${agent}: ${path}`);
    return;
  }
  const canonicalKnowledge = roots.some(root => path === root && basename(root) === 'knowledge.md');
  const wikiMarkdown = roots.some(root => basename(root) === 'wiki' && isWithin(path, root) && extname(path) === '.md');
  if (!canonicalKnowledge && !wikiMarkdown) throw new Error(`Knowledge receipt requires canonical knowledge.md or wiki markdown: ${path}`);
}

export function closePreparationPrompt(state: CloseLifecycleState): string {
  return `[WEEKDAY CLOSE PREPARATION] London date ${state.londonDate}. Complete these stages in order before 19:00 Europe/London:\n` +
    `1. Save durable memory, then run: cortextos bus close-receipt memory <artifact-path...>\n` +
    `2. Update task truth, then run: cortextos bus close-receipt task-truth <artifact-path...>\n` +
    `3. Promote durable knowledge/wiki material, then run: cortextos bus close-receipt knowledge <artifact-path...>\n` +
    `Do not restart yourself. The daemon verifies each artifact and owns the fresh-session restart.`;
}

export class CloseLifecycleCoordinator {
  private activeTick: Promise<void> | null = null;
  private agentQueues = new Map<string, Promise<void>>();

  constructor(private readonly deps: CloseLifecycleDependencies) {}

  tick(at = new Date()): Promise<void> {
    if (this.activeTick) return this.activeTick;
    const run = this.runTick(at).finally(() => {
      if (this.activeTick === run) this.activeTick = null;
    });
    this.activeTick = run;
    return run;
  }

  private async runTick(at: Date): Promise<void> {
    const clock = londonClock(at);
    if (!isLondonWeekday(clock) || clock.minuteOfDay < WORKDAY_START_MINUTE) return;
    const agents = await this.deps.listAgents();
    for (const agent of agents) {
      try {
        await this.withAgentLock(agent.name, () => this.tickAgent(agent, at, clock));
      } catch (error) {
        this.deps.log?.(`[close-lifecycle] ${agent.name} tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async tickAgent(agent: CloseLifecycleAgent, at: Date, clock: LondonClock): Promise<void> {
    let state = readCloseState(this.deps.ctxRoot, agent.name);
    if (clock.minuteOfDay < CLOSE_PREPARE_MINUTE) {
      const expected = previousLondonWeekday(clock.londonDate);
      if (!state || state.londonDate < expected || (state.londonDate === expected && state.status !== 'complete')) {
        state = state?.londonDate === expected
          ? markCloseFailed(state, `close lifecycle for ${expected} was not completed before the next workday opened`)
          : createPriorMissedCloseState(agent.name, expected, at);
        writeCloseState(this.deps.ctxRoot, state, 'failed', { failure: state.failure });
        await this.requestRestart(state, at);
      }
      return;
    }
    if (state?.londonDate === clock.londonDate) {
      if (state.status === 'restarting') {
        const requestedMs = Date.parse(state.restartAttempt?.requestedAt ?? '');
        if (Number.isFinite(requestedMs) && at.getTime() - requestedMs >= RESTART_RETRY_AFTER_MS) {
          const latest = readCloseState(this.deps.ctxRoot, agent.name);
          if (!latest || latest.status !== 'restarting' || latest.restartAttempt?.id !== state.restartAttempt?.id) return;
          state = latest;
          if ((state.restartAttempt?.attempts ?? 0) >= MAX_RESTART_ATTEMPTS) {
            state = markCloseFailed(state, 'restart attempts exhausted without a matching fresh-session receipt');
            writeCloseState(this.deps.ctxRoot, state, 'failed', { failure: state.failure });
          } else {
            state = markCloseFailed(state, 'restart attempt timed out without a matching fresh-session receipt');
            writeCloseState(this.deps.ctxRoot, state, 'failed', { failure: state.failure });
            await this.requestRestart(state, at);
          }
        }
      } else if (state.status === 'preparing' && !state.promptInjectedAt && !closeDeadlinePassed(at, state)) {
        const injected = await this.deps.injectPrompt(agent.name, closePreparationPrompt(state));
        if (injected) {
          state = { ...state, promptInjectedAt: at.toISOString() };
          writeCloseState(this.deps.ctxRoot, state, 'started');
        }
      } else if (state.status === 'preparing' && closeDeadlinePassed(at, state)) {
        state = markCloseFailed(state, 'deadline reached before durable receipts completed');
        writeCloseState(this.deps.ctxRoot, state, 'failed', { failure: state.failure });
        await this.requestRestart(state, at);
      } else if (state.status === 'failed' && !state.failure?.startsWith('restart attempts exhausted')) {
        await this.requestRestart(state, at);
      }
      return;
    }

    if (clock.minuteOfDay >= CLOSE_DEADLINE_MINUTE) {
      state = createMissedCloseState(agent.name, at);
      writeCloseState(this.deps.ctxRoot, state, 'failed', { failure: state.failure });
      await this.requestRestart(state, at);
      return;
    }

    state = createCloseState(agent.name, at);
    writeCloseState(this.deps.ctxRoot, state, 'started');
    const injected = await this.deps.injectPrompt(agent.name, closePreparationPrompt(state));
    if (injected) {
      state = { ...state, promptInjectedAt: at.toISOString() };
      writeCloseState(this.deps.ctxRoot, state, 'started');
    } else {
      this.deps.log?.(`[close-lifecycle] prompt injection deferred for ${agent.name}`);
    }
  }

  async receipt(agent: CloseLifecycleAgent, stage: CloseStage, paths: string[], at = new Date()): Promise<CloseLifecycleState> {
    return this.withAgentLock(agent.name, () => this.receiptUnlocked(agent, stage, paths, at));
  }

  private async receiptUnlocked(agent: CloseLifecycleAgent, stage: CloseStage, paths: string[], at: Date): Promise<CloseLifecycleState> {
    let state = readCloseState(this.deps.ctxRoot, agent.name);
    if (!state) throw new Error(`No close lifecycle exists for ${agent.name}`);
    const priorArtifacts = state.receipts.flatMap(receipt => receipt.artifacts);
    const artifacts = verifyCloseArtifacts(paths, agent.artifactRoots[stage], state.startedAt, priorArtifacts, { agent: agent.name, stage });
    state = appendCloseReceipt(state, stage, artifacts, at);
    writeCloseState(this.deps.ctxRoot, state, 'receipt', { stage });
    if (state.status === 'ready-to-restart') state = await this.requestRestart(state, at);
    return state;
  }

  async confirmFreshSession(agent: string, attemptId: string, sessionIdentity: string, at = new Date()): Promise<CloseLifecycleState | null> {
    return this.withAgentLock(agent, () => this.confirmFreshSessionUnlocked(agent, attemptId, sessionIdentity, at));
  }

  private async confirmFreshSessionUnlocked(agent: string, attemptId: string, sessionIdentity: string, at: Date): Promise<CloseLifecycleState | null> {
    let state = readCloseState(this.deps.ctxRoot, agent);
    if (!state || state.status !== 'restarting') return state;
    state = markFreshSessionVerified(state, attemptId, sessionIdentity, at);
    writeCloseState(this.deps.ctxRoot, state, 'fresh-session-verified');
    return state;
  }

  private async requestRestart(state: CloseLifecycleState, at: Date): Promise<CloseLifecycleState> {
    if (state.status === 'restarting' || state.status === 'complete') return state;
    let restarting = markRestartRequested(state, at, this.deps.currentSessionIdentity?.(state.agent));
    writeCloseState(this.deps.ctxRoot, restarting, 'restart-requested');
    const sessionIdentity = await this.deps.requestFreshRestart(state.agent, `weekday close ${state.londonDate}`, restarting.restartAttempt!.id);
    const latest = readCloseState(this.deps.ctxRoot, state.agent);
    if (!sessionIdentity || !latest || latest.status !== 'restarting' || latest.restartAttempt?.id !== restarting.restartAttempt!.id) {
      return latest ?? restarting;
    }
    restarting = markFreshSessionVerified(latest, restarting.restartAttempt!.id, sessionIdentity, new Date());
    writeCloseState(this.deps.ctxRoot, restarting, 'fresh-session-verified');
    return restarting;
  }

  private async withAgentLock<T>(agent: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.agentQueues.get(agent) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    this.agentQueues.set(agent, tail);
    try {
      return await run;
    } finally {
      if (this.agentQueues.get(agent) === tail) this.agentQueues.delete(agent);
    }
  }
}
import { createHash, randomUUID } from 'crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
