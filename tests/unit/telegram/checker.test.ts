/**
 * Unit tests for src/telegram/checker.ts
 *
 * All model calls are mocked via the ModelClient interface.
 * No real OpenAI API calls. No network. No daemon.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runDeterministicChecks,
  validateDeliverableClaim,
  runSemanticCheck,
  writeCheckerAudit,
  resolveAudience,
  assembleUserContent,
  containsBehaviourPromise,
  FALSE_FIXED_REGEX,
  ACCOUNTABILITY_REGEX,
  EMPTY_APOLOGY_REGEX,
  buildRecentEvidence,
  assembleCheckerContext,
  recordGeraldToldGateShadow,
  detectTopicShift,
} from '../../../src/telegram/checker.js';
import type {
  ModelClient,
  CheckerResult,
  CheckerAuditEntry,
} from '../../../src/telegram/checker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'checker-test-'));
}

const SHAY = '8721344756';
const OTHER = '1234567890';

function mockPass(): ModelClient {
  return {
    async check(): Promise<CheckerResult> {
      return { pass: true };
    },
  };
}

function mockReject(reason: string, rewrite: string): ModelClient {
  return {
    async check(): Promise<CheckerResult> {
      return { pass: false, reason, rewrite };
    },
  };
}

function mockThrow(message: string): ModelClient {
  return {
    async check(): Promise<CheckerResult> {
      throw new Error(message);
    },
  };
}

// Write a fake inbound JSONL log
function writeInboundLog(
  ctxRoot: string,
  agentName: string,
  entries: object[],
): void {
  const dir = join(ctxRoot, 'logs', agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'inbound-messages.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

// ---------------------------------------------------------------------------
// 1. runDeterministicChecks
// ---------------------------------------------------------------------------

describe('runDeterministicChecks', () => {
  // --- Behaviour promise ---
  it('rejects "I will change that" when not deliverable', () => {
    const r = runDeterministicChecks(SHAY, "I will change that going forward.", false);
    expect(r.reject).not.toBeNull();
    expect(r.reject).toMatch(/behaviour/i);
  });

  it('rejects "going forward" phrase', () => {
    const r = runDeterministicChecks(OTHER, "Going forward I will make sure to do better.", false);
    expect(r.reject).not.toBeNull();
  });

  it('rejects "from now on" phrase', () => {
    const r = runDeterministicChecks(OTHER, "From now on I will avoid this.", false);
    expect(r.reject).not.toBeNull();
  });

  it('rejects "won\'t happen again" phrase', () => {
    const r = runDeterministicChecks(OTHER, "That won't happen again.", false);
    expect(r.reject).not.toBeNull();
  });

  it('passes behaviour promise when deliverable=true (deliverable exempts absolute blocks)', () => {
    // Deliverable mode skips all three deterministic blocks
    const r = runDeterministicChecks(SHAY, "I will change that going forward.", true);
    // deliverable=true skips behaviour promise check
    expect(r.reject).toBeNull();
  });

  // --- False "fixed" claim ---
  it('rejects "Done updating the skill config" when not deliverable', () => {
    // FALSE_FIXED_REGEX matches within a single sentence (no . crossing).
    // "Done updating the skill config." — "done...skill" in same clause.
    const r = runDeterministicChecks(SHAY, "Done updating the skill config.", false);
    expect(r.reject).not.toBeNull();
    expect(r.reject).toMatch(/fixed/i);
  });

  it('rejects "Fixed the guardrail" when not deliverable', () => {
    const r = runDeterministicChecks(OTHER, "Fixed the guardrail in the config.", false);
    expect(r.reject).not.toBeNull();
  });

  it('rejects canonical "Done. The skill and fleet are updated." (cross-sentence)', () => {
    // The regex second alternative \.?\s+(?:\w+\s+){0,5} crosses a sentence
    // boundary so "Done. The skill and fleet are updated." is caught.
    const r = runDeterministicChecks(SHAY, "Done. The skill and fleet are updated.", false);
    expect(r.reject).not.toBeNull();
    expect(r.reject).toMatch(/fixed/i);
  });

  it('does not reject "Done." without a skill/config noun', () => {
    const r = runDeterministicChecks(OTHER, "Done.", false);
    expect(r.reject).toBeNull();
  });

  it('false-fixed check skipped when deliverable=true', () => {
    const r = runDeterministicChecks(SHAY, "Done. The skill and fleet are updated.", true);
    expect(r.reject).toBeNull();
  });

  // --- Accountability paragraph ---
  it('rejects 37-word accountability paragraph', () => {
    const text =
      "You're right. I apologize for the confusion. I should have known better and " +
      "will ensure this doesn't happen again by carefully reviewing all messages " +
      "before sending them to you in future interactions.";
    const r = runDeterministicChecks(SHAY, text, false);
    expect(r.reject).not.toBeNull();
    expect(r.reject).toMatch(/accountability/i);
  });

  it('allows short honest acknowledgement (word count ≤ 20)', () => {
    const r = runDeterministicChecks(OTHER, "You're right. Got it.", false);
    expect(r.reject).toBeNull();
  });

  it('hard-blocks the live empty-apology phrase even when the reply is short', () => {
    const r = runDeterministicChecks(
      SHAY,
      "You're right. I missed the update. That's on me.",
      false,
    );
    expect(r.reject).toMatch(/empty accountability/i);
    expect(EMPTY_APOLOGY_REGEX.test("That's on me.")).toBe(true);
  });

  it('hard-blocks equivalent empty-apology spellings', () => {
    for (const text of [
      'That is on me.',
      'This is on me.',
      'I take full responsibility.',
      'I own that.',
    ]) {
      expect(runDeterministicChecks(SHAY, text, false).reject).not.toBeNull();
    }
  });

  it('does not block a concrete failure statement without an empty apology', () => {
    const r = runDeterministicChecks(
      SHAY,
      'I completed the work but failed to send the result until you asked.',
      false,
    );
    expect(r.reject).toBeNull();
  });

  it('accountability check skipped when deliverable=true', () => {
    const text =
      "You're right. I apologize for the confusion. I should have reviewed messages more carefully.";
    const r = runDeterministicChecks(SHAY, text, true);
    expect(r.reject).toBeNull();
  });

  // --- Jargon context flags (Shay only) ---
  it('adds jargon contextFlag when draft contains "guardrail" for Shay', () => {
    const r = runDeterministicChecks(SHAY, "The guardrail is working.", false);
    expect(r.reject).toBeNull();
    expect(r.contextFlags.some((f) => f.includes('guardrail'))).toBe(true);
  });

  it('adds contextFlag for "send path" and "gate" for Shay', () => {
    const r = runDeterministicChecks(SHAY, "The send path is gated correctly.", false);
    expect(r.reject).toBeNull();
    expect(r.contextFlags.length).toBeGreaterThan(0);
  });

  it('does NOT add jargon flags for non-Shay chat ID', () => {
    const r = runDeterministicChecks(OTHER, "The guardrail is working.", false);
    expect(r.contextFlags).toHaveLength(0);
  });

  it('short honest reply — no reject, no flags for default chat', () => {
    const r = runDeterministicChecks(OTHER, "Yes, that makes sense.", false);
    expect(r.reject).toBeNull();
    expect(r.contextFlags).toHaveLength(0);
  });
});

describe('Shay plain-language review contract', () => {
  it('puts the five observed jargon failure classes in the mandatory reviewer prompt', () => {
    const prompt = resolveAudience(SHAY).systemPrompt;

    expect(prompt).toContain('leads with internal machinery');
    expect(prompt).toContain('vague category answers');
    expect(prompt).toContain('do not name the exact action');
    expect(prompt).toContain('one step at a time');
    expect(prompt).toContain('abstract, receipt-like wording');
    expect(prompt).toContain('plain answer or cause first');
  });
});

// ---------------------------------------------------------------------------
// 1b. buildRecentEvidence
// ---------------------------------------------------------------------------

describe('buildRecentEvidence', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns only recent completion-shaped records in a bounded block', () => {
    const now = Date.parse('2026-07-31T10:00:00Z');
    const eventDir = join(dir, 'events', 'otis');
    mkdirSync(eventDir, { recursive: true });
    writeFileSync(
      join(eventDir, '2026-07-31.jsonl'),
      [
        JSON.stringify({ timestamp: '2026-07-31T09:30:00Z', event: 'session_start', metadata: {} }),
        JSON.stringify({ timestamp: '2026-07-31T09:40:00Z', event: 'task_completed', metadata: { summary: 'five agents restored' } }),
        JSON.stringify({ timestamp: '2026-07-31T07:00:00Z', event: 'task_completed', metadata: { summary: 'too old' } }),
        '{malformed',
      ].join('\n') + '\n',
    );

    const evidence = buildRecentEvidence(dir, 'otis', now);
    expect(evidence).toContain('five agents restored');
    expect(evidence).not.toContain('session_start');
    expect(evidence).not.toContain('too old');
  });

  it('returns null when no relevant recent record exists', () => {
    expect(buildRecentEvidence(dir, 'otis', Date.now())).toBeNull();
  });

  it('includes recent evidence in semantic user content', () => {
    const content = assembleUserContent({
      contextFlags: [],
      triggeringText: null,
      recentHistory: null,
      recentEvidence: '2026-07-31T09:40:00Z | task_completed | {"summary":"done"}',
      draftText: 'It is done.',
    });
    expect(content).toContain('Recent activity records');
    expect(content).toContain('task_completed');
    expect(content).toContain('Draft reply:\nIt is done.');
  });

  it('wires live analytics evidence into the checker context', () => {
    const now = Date.parse('2026-07-31T10:00:00Z');
    const eventDir = join(dir, 'events', 'otis');
    mkdirSync(eventDir, { recursive: true });
    writeFileSync(
      join(eventDir, '2026-07-31.jsonl'),
      JSON.stringify({
        timestamp: '2026-07-31T09:55:00Z',
        event: 'task_completed',
        metadata: { summary: 'restored five agents' },
      }) + '\n',
    );

    const content = assembleCheckerContext({
      analyticsDir: dir,
      agentName: 'otis',
      contextFlags: [],
      triggeringText: null,
      recentHistory: null,
      draftText: 'All five are restored.',
      nowMs: now,
    });

    expect(content).toContain('restored five agents');
    expect(content).toContain('Draft reply:\nAll five are restored.');
  });
});

// ---------------------------------------------------------------------------
// 2. validateDeliverableClaim
// ---------------------------------------------------------------------------

describe('validateDeliverableClaim', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns deliverable=true when ID matches and is within 24h', () => {
    writeInboundLog(dir, 'agent1', [
      {
        message_id: 42,
        chat_id: SHAY,
        text: 'Please send me the full report.',
        timestamp: new Date().toISOString(),
      },
    ]);
    const r = validateDeliverableClaim(dir, 'agent1', SHAY, 42);
    expect(r.deliverable).toBe(true);
    expect(r.triggeringText).toBe('Please send me the full report.');
  });

  it('returns deliverable=false when ID not in log', () => {
    writeInboundLog(dir, 'agent1', [
      { message_id: 99, chat_id: SHAY, text: 'Something else', timestamp: new Date().toISOString() },
    ]);
    const r = validateDeliverableClaim(dir, 'agent1', SHAY, 42);
    expect(r.deliverable).toBe(false);
    expect(r.triggeringText).toBeNull();
  });

  it('returns deliverable=false when log has message from different chatId', () => {
    writeInboundLog(dir, 'agent1', [
      { message_id: 42, chat_id: OTHER, text: 'From someone else', timestamp: new Date().toISOString() },
    ]);
    const r = validateDeliverableClaim(dir, 'agent1', SHAY, 42);
    expect(r.deliverable).toBe(false);
  });

  it('returns deliverable=false when message is older than 24h', () => {
    const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeInboundLog(dir, 'agent1', [
      { message_id: 42, chat_id: SHAY, text: 'Old request', timestamp: oldTimestamp },
    ]);
    const r = validateDeliverableClaim(dir, 'agent1', SHAY, 42);
    expect(r.deliverable).toBe(false);
  });

  it('returns deliverable=false when no inboundMsgId provided', () => {
    writeInboundLog(dir, 'agent1', [
      { message_id: 42, chat_id: SHAY, text: 'Hi', timestamp: new Date().toISOString() },
    ]);
    const r = validateDeliverableClaim(dir, 'agent1', SHAY, undefined);
    expect(r.deliverable).toBe(false);
  });

  it('returns deliverable=false when log file does not exist', () => {
    const r = validateDeliverableClaim(dir, 'no-such-agent', SHAY, 42);
    expect(r.deliverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2b. recordGeraldToldGateShadow — STEP 2, record-only told-gate shadow log
// ---------------------------------------------------------------------------

describe('recordGeraldToldGateShadow', () => {
  const GERALD = '8602224961';
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readShadowLog(d: string, agent: string): any[] {
    const path = join(d, 'logs', agent, 'gerald-told-gate-shadow.jsonl');
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('writes one entry with items_declared=true and parsed items when geraldItems is set', () => {
    recordGeraldToldGateShadow(dir, 'rimu', GERALD, 'Here is the digest.', '123,456');
    const rows = readShadowLog(dir, 'rimu');
    expect(rows).toHaveLength(1);
    expect(rows[0].items_declared).toBe(true);
    expect(rows[0].items).toEqual(['123', '456']);
    expect(rows[0].chat_id).toBe(GERALD);
    expect(rows[0].agent).toBe('rimu');
    expect(rows[0].text_preview).toBe('Here is the digest.');
  });

  it('writes one entry with items_declared=false and items=null when geraldItems is undefined', () => {
    recordGeraldToldGateShadow(dir, 'rimu', GERALD, 'Nothing new today.', undefined);
    const rows = readShadowLog(dir, 'rimu');
    expect(rows).toHaveLength(1);
    expect(rows[0].items_declared).toBe(false);
    expect(rows[0].items).toBeNull();
  });

  it('is a true no-op for any chat other than Gerald — no log file is created', () => {
    recordGeraldToldGateShadow(dir, 'rimu', SHAY, 'Some unrelated message.', '123');
    const path = join(dir, 'logs', 'rimu', 'gerald-told-gate-shadow.jsonl');
    expect(existsSync(path)).toBe(false);
  });

  it('never throws even when the log directory cannot be created', () => {
    const file = join(dir, 'blocker');
    writeFileSync(file, 'block');
    expect(() =>
      recordGeraldToldGateShadow(file, 'rimu', GERALD, 'x', undefined),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. runSemanticCheck
// ---------------------------------------------------------------------------

describe('runSemanticCheck', () => {
  const profile = resolveAudience(SHAY);
  const userContent = 'Draft reply:\nHere is the answer.';

  it('passes when model returns { pass: true }', async () => {
    const result = await runSemanticCheck(profile, userContent, mockPass());
    expect(result.pass).toBe(true);
  });

  it('rejects when model returns { pass: false }', async () => {
    const result = await runSemanticCheck(
      profile,
      userContent,
      mockReject('Echo without value', 'Try again.'),
    );
    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.reason).toBe('Echo without value');
      expect(result.rewrite).toBe('Try again.');
    }
  });

  it('throws (fail-closed) when model throws (timeout simulation)', async () => {
    await expect(
      runSemanticCheck(profile, userContent, mockThrow('Checker model timed out after 8000ms')),
    ).rejects.toThrow('timed out');
  });

  it('throws (fail-closed) when model returns invalid JSON', async () => {
    const badClient: ModelClient = {
      async check(): Promise<CheckerResult> {
        throw new Error('Invalid JSON from checker model: }{');
      },
    };
    await expect(runSemanticCheck(profile, userContent, badClient)).rejects.toThrow();
  });

  it('throws (fail-closed) when model has network error', async () => {
    await expect(
      runSemanticCheck(profile, userContent, mockThrow('Checker network error: ECONNREFUSED')),
    ).rejects.toThrow('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// 4. writeCheckerAudit
// ---------------------------------------------------------------------------

describe('writeCheckerAudit', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readAudit(d: string, agent: string): CheckerAuditEntry[] {
    const path = join(d, 'logs', agent, 'message-checker-audit.jsonl');
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('appends a pass entry without full_draft', () => {
    const entry: CheckerAuditEntry = {
      timestamp: new Date().toISOString(),
      agent: 'agent1',
      chat_id: SHAY,
      source: 'cli',
      stage: 'semantic',
      result: 'pass',
      draft_preview: 'Hello there',
    };
    writeCheckerAudit(dir, 'agent1', entry);
    const rows = readAudit(dir, 'agent1');
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe('pass');
    expect(rows[0].full_draft).toBeUndefined();
  });

  it('appends a reject entry with full_draft present and complete', () => {
    const fullDraft = 'This is the complete rejected draft text.';
    const entry: CheckerAuditEntry = {
      timestamp: new Date().toISOString(),
      agent: 'agent1',
      chat_id: SHAY,
      source: 'cli',
      stage: 'deterministic',
      result: 'reject',
      reason: 'behaviour promise',
      full_draft: fullDraft,
      draft_preview: fullDraft.slice(0, 100),
    };
    writeCheckerAudit(dir, 'agent1', entry);
    const rows = readAudit(dir, 'agent1');
    expect(rows[0].full_draft).toBe(fullDraft);
    expect(rows[0].reason).toBe('behaviour promise');
  });

  it('appends multiple entries correctly', () => {
    for (let i = 0; i < 3; i++) {
      writeCheckerAudit(dir, 'agent1', {
        timestamp: new Date().toISOString(),
        agent: 'agent1',
        chat_id: OTHER,
        source: 'hook',
        stage: 'deterministic',
        result: 'pass',
        draft_preview: `entry ${i}`,
      });
    }
    expect(readAudit(dir, 'agent1')).toHaveLength(3);
  });

  it('never throws even when the log directory cannot be created', () => {
    // Pass a path that would be a file, not a directory
    const file = join(dir, 'blocker');
    writeFileSync(file, 'block');
    expect(() =>
      writeCheckerAudit(file, 'agent1', {
        timestamp: new Date().toISOString(),
        agent: 'agent1',
        chat_id: OTHER,
        source: 'cli',
        stage: 'semantic',
        result: 'pass',
        draft_preview: 'x',
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. assembleUserContent
// ---------------------------------------------------------------------------

describe('assembleUserContent', () => {
  it('includes all sections when all opts provided', () => {
    const content = assembleUserContent({
      contextFlags: ['potential jargon detected: "guardrail"'],
      triggeringText: 'Send me the report.',
      recentHistory: 'User: ok',
      draftText: 'Here is the report.',
    });
    expect(content).toContain('potential jargon');
    expect(content).toContain('Requested deliverable');
    expect(content).toContain('Recent conversation');
    expect(content).toContain('Draft reply');
  });

  it('falls back to "(no prior history)" when recentHistory is null', () => {
    const content = assembleUserContent({
      contextFlags: [],
      triggeringText: null,
      recentHistory: null,
      draftText: 'Draft.',
    });
    expect(content).toContain('(no prior history)');
  });

  it('omits triggering-text section when triggeringText is null', () => {
    const content = assembleUserContent({
      contextFlags: [],
      triggeringText: null,
      recentHistory: null,
      draftText: 'Draft.',
    });
    expect(content).not.toContain('Requested deliverable');
  });
});

// ---------------------------------------------------------------------------
// 5b. detectTopicShift — proactive new-topic vs stale/unrelated recentHistory
//
// Reproduces the first-party skiffy failure: at 2026-08-20T16:12:36Z and
// 2026-08-20T16:26:44Z, a draft about an unrelated checker bug relayed from
// scout over the agent bus was rejected with the IDENTICAL, stale, unrelated
// rewrite ("The five post-install follow-up emails remain unsent...") because
// buildRecentHistory only ever reflects the Telegram thread, which at that
// moment was the resolved five-post-install-emails exchange.
// (logs/skiffy/message-checker-audit.jsonl:143-144)
// ---------------------------------------------------------------------------

describe('detectTopicShift', () => {
  const STALE_TELEGRAM_HISTORY =
    'user: Leave the five post-install follow-up emails unsent for now. No action needed from you.\n' +
    "skiffy: I'm continuing yesterday's priorities today. The five post-install follow-up emails will remain unsent, so you don't need to do anything.";

  it('flags the live first-party repro draft (16:12:36Z) as a topic shift', () => {
    const draft =
      "Otis's checker rejected 3 drafts today, ~36min gap. Scout says you want the filter removed. " +
      "Heads up: otis's code isn't mine to touch, by your own call. Let me know if you want me on it " +
      'anyway, or have otis/scout loosen it directly.';
    expect(detectTopicShift(draft, STALE_TELEGRAM_HISTORY)).toBe(true);
  });

  it('flags the live first-party repro draft (16:26:44Z) as a topic shift', () => {
    const draft =
      "Got it from scout - on the otis checker fix. Found the real issue: it's rejecting otis's honest " +
      "updates because it can't tell fast-changing status apart from unproven claims. Building the fix " +
      "now, will verify it's live and let you know.";
    expect(detectTopicShift(draft, STALE_TELEGRAM_HISTORY)).toBe(true);
  });

  it('does not flag a draft that continues the same topic (shared vocabulary)', () => {
    const history =
      'user: is Sol back on?\notis: Kami and Sol are the only active agents; everyone else remains disabled.';
    const draft =
      'Sol is back on and running now. Kami and Sol are the only active agents; everyone else remains disabled.';
    expect(detectTopicShift(draft, history)).toBe(false);
  });

  it('returns false when recentHistory is null (no prior history is not a topic shift)', () => {
    expect(detectTopicShift('Anything at all.', null)).toBe(false);
  });

  it('returns false when either side has no extractable significant words', () => {
    expect(detectTopicShift('ok', 'user: ok\nagent: ok')).toBe(false);
    expect(detectTopicShift('A brand new unrelated topic here.', 'ok')).toBe(false);
  });
});

describe('assembleUserContent — new-topic note', () => {
  const STALE_TELEGRAM_HISTORY =
    'user: Leave the five post-install follow-up emails unsent for now. No action needed from you.\n' +
    "skiffy: I'm continuing yesterday's priorities today. The five post-install follow-up emails will remain unsent, so you don't need to do anything.";

  it('adds an advisory note (and still includes Recent conversation in full) when the draft looks unrelated', () => {
    const draft =
      "Got it from scout - on the otis checker fix. Found the real issue: it's rejecting otis's honest " +
      "updates because it can't tell fast-changing status apart from unproven claims.";
    const content = assembleUserContent({
      contextFlags: [],
      triggeringText: null,
      recentHistory: STALE_TELEGRAM_HISTORY,
      draftText: draft,
    });
    expect(content).toContain('evaluate it as an independent topic');
    expect(content).toContain('Recent conversation:\n' + STALE_TELEGRAM_HISTORY);
    expect(content).toContain('Draft reply:\n' + draft);
  });

  it('does not add the note when the draft shares vocabulary with recentHistory', () => {
    const history = 'user: is Sol back on?\notis: Sol is disabled right now.';
    const draft = 'Sol is back on and running.';
    const content = assembleUserContent({
      contextFlags: [],
      triggeringText: null,
      recentHistory: history,
      draftText: draft,
    });
    expect(content).not.toContain('evaluate it as an independent topic');
  });

  it('does not add the note when there is no prior history', () => {
    const content = assembleUserContent({
      contextFlags: [],
      triggeringText: null,
      recentHistory: null,
      draftText: 'A brand new topic with no history at all.',
    });
    expect(content).not.toContain('evaluate it as an independent topic');
  });

  it('the new-topic note coexists with jargon context flags', () => {
    const content = assembleUserContent({
      contextFlags: ['potential jargon detected: "guardrail"'],
      triggeringText: null,
      recentHistory: STALE_TELEGRAM_HISTORY,
      draftText: 'The guardrail caught something totally unrelated to that topic.',
    });
    expect(content).toContain('potential jargon');
    expect(content).toContain('evaluate it as an independent topic');
  });
});

describe('system prompts carry the new-topic rule', () => {
  it('SHAY_SYSTEM_PROMPT instructs the reviewer not to anchor rewrites to an unrelated Recent conversation', () => {
    const prompt = resolveAudience(SHAY).systemPrompt;
    expect(prompt).toContain('evaluate it as its own topic');
    expect(prompt).toContain("invent a rewrite anchored to Recent conversation's topic");
  });

  it('the new-topic rule also reaches the Otis pilot prompt (derived from SHAY_SYSTEM_PROMPT)', () => {
    const prompt = resolveAudience(SHAY, 'otis').systemPrompt;
    expect(prompt).toContain('evaluate it as its own topic');
  });

  it('DEFAULT_SYSTEM_PROMPT (non-Shay chats) carries an equivalent rule', () => {
    const prompt = resolveAudience(OTHER).systemPrompt;
    expect(prompt).toContain('evaluate it as its own topic');
  });
});

// ---------------------------------------------------------------------------
// 5c. Regression: legitimate rejections (unproven claims, jargon) are unaffected
//
// The fix must not weaken the checks that were working as intended — see the
// same-day otis rejections (logs/otis/message-checker-audit.jsonl, 15:05-16:09Z
// on 2026-08-20) blocking premature "it's fixed" claims and internal jargon.
// These are wiring-level regression checks: the mocked ModelClient stands in
// for the real semantic judgment (as in the rest of this suite), and asserts
// that on-topic drafts do NOT get the new-topic note, and that a semantic
// reject/rewrite that stays on the draft's own topic still flows through
// unchanged end to end.
// ---------------------------------------------------------------------------

describe('on-topic rejections remain unaffected by the new-topic note', () => {
  it('an unproven "it is fixed" style claim against matching Recent conversation still rejects, on-topic', async () => {
    const history =
      'user: is Kami back on yet?\notis: Kami is disabled right now, still checking.';
    const draft = 'Yes. I will manually restart Sol and restore Kami, then verify both.';
    const content = assembleUserContent({
      contextFlags: [],
      triggeringText: null,
      recentHistory: history,
      draftText: draft,
    });
    // Shares "Kami" with Recent conversation — this is the literal continuation
    // of the same thread, so it must NOT get the unrelated-topic note.
    expect(content).not.toContain('evaluate it as an independent topic');

    const profile = resolveAudience(SHAY);
    const result = await runSemanticCheck(
      profile,
      content,
      mockReject(
        'It promises a future action instead of answering now.',
        "I'm turning Sol back on now so you can ask him directly. You don't need to do anything.",
      ),
    );
    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.rewrite).toContain('Sol');
    }
  });

  it('a jargon-laden reply against on-topic history still rejects for jargon', async () => {
    const text = 'The send path is open and the release hold is cleared.';
    const det = runDeterministicChecks(SHAY, text, false);
    expect(det.reject).toBeNull();
    const content = assembleUserContent({
      contextFlags: det.contextFlags,
      triggeringText: null,
      recentHistory: 'user: is it ready to ship?\nskiffy: still checking the release status.',
      draftText: text,
    });
    expect(content).not.toContain('evaluate it as an independent topic');
    const profile = resolveAudience(SHAY);
    const result = await runSemanticCheck(
      profile,
      content,
      mockReject('Jargon without request', 'Remove system terms.'),
    );
    expect(result.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. All 8 BRAINDUMP regression cases
// ---------------------------------------------------------------------------

describe('BRAINDUMP regression cases', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Case 1: Echo of Shay's proposal → semantic reject
  it('Case 1: echo of proposal → semantic reject', async () => {
    const text = "Yes, that sounds like a good approach. We can do it that way.";
    const det = runDeterministicChecks(SHAY, text, false);
    expect(det.reject).toBeNull();
    const profile = resolveAudience(SHAY);
    const uc = assembleUserContent({ contextFlags: det.contextFlags, triggeringText: null, recentHistory: null, draftText: text });
    const result = await runSemanticCheck(profile, uc, mockReject('Echo without value', 'Add something new.'));
    expect(result.pass).toBe(false);
  });

  // Case 2: "send paths", "release holds" to Shay → jargon flag → semantic reject
  it('Case 2: jargon to Shay → context flag + semantic reject', async () => {
    const text = "The send path is open and the release hold is cleared.";
    const det = runDeterministicChecks(SHAY, text, false);
    expect(det.reject).toBeNull();
    expect(det.contextFlags.some((f) => f.includes('send path'))).toBe(true);
    const profile = resolveAudience(SHAY);
    const uc = assembleUserContent({ contextFlags: det.contextFlags, triggeringText: null, recentHistory: null, draftText: text });
    const result = await runSemanticCheck(profile, uc, mockReject('Jargon without request', 'Remove system terms.'));
    expect(result.pass).toBe(false);
  });

  // Case 3: "You're right. I'll change that going forward." → deterministic reject
  it('Case 3: behaviour promise → deterministic reject', () => {
    const text = "You're right. I'll change that going forward.";
    const det = runDeterministicChecks(SHAY, text, false);
    expect(det.reject).not.toBeNull();
  });

  // Case 4: false "fixed" claim → deterministic reject
  it('Case 4: false fixed claim → deterministic reject', () => {
    // FALSE_FIXED_REGEX matches within the same sentence clause.
    const text = "Done updating the skill config — this resolves it.";
    const det = runDeterministicChecks(SHAY, text, false);
    expect(det.reject).not.toBeNull();
  });

  // Case 5: 37-word accountability paragraph → deterministic reject
  it('Case 5: accountability paragraph → deterministic reject', () => {
    const text =
      "You're right. I apologize for the confusion. I should have known better " +
      "and will ensure this doesn't happen again by carefully reviewing all messages " +
      "before sending them to you in future interactions.";
    const det = runDeterministicChecks(SHAY, text, false);
    expect(det.reject).not.toBeNull();
  });

  // Case 6: "Yes. I knew the rule, ignored it twice, proved your point." → pass
  it('Case 6: short honest acknowledgement → deterministic pass + semantic pass', async () => {
    const text = "Yes. I knew the rule, ignored it twice, proved your point.";
    const det = runDeterministicChecks(SHAY, text, false);
    expect(det.reject).toBeNull();
    const profile = resolveAudience(SHAY);
    const uc = assembleUserContent({ contextFlags: det.contextFlags, triggeringText: null, recentHistory: null, draftText: text });
    const result = await runSemanticCheck(profile, uc, mockPass());
    expect(result.pass).toBe(true);
  });

  // Case 7: "Not if we keep it tight." + brief explanation → pass
  it('Case 7: direct answer with brief explanation → pass', async () => {
    const text = "Not if we keep it tight. One message per cycle, no echoes.";
    const det = runDeterministicChecks(OTHER, text, false);
    expect(det.reject).toBeNull();
    const profile = resolveAudience(OTHER);
    const uc = assembleUserContent({ contextFlags: det.contextFlags, triggeringText: null, recentHistory: null, draftText: text });
    const result = await runSemanticCheck(profile, uc, mockPass());
    expect(result.pass).toBe(true);
  });

  // Case 8: Long email, validated deliverable-for ID → all gates pass
  it('Case 8: long email with valid deliverable-for → pass', async () => {
    writeInboundLog(dir, 'agent1', [
      {
        message_id: 77,
        chat_id: SHAY,
        text: 'Can you write up the full architecture brief?',
        timestamp: new Date().toISOString(),
      },
    ]);
    const { deliverable, triggeringText } = validateDeliverableClaim(dir, 'agent1', SHAY, 77);
    expect(deliverable).toBe(true);
    expect(triggeringText).toContain('architecture brief');

    const text = 'Here is the full architecture brief:\n\n' + 'Long content '.repeat(50);
    const det = runDeterministicChecks(SHAY, text, deliverable);
    expect(det.reject).toBeNull(); // deliverable=true skips all blocks

    const profile = resolveAudience(SHAY);
    const uc = assembleUserContent({ contextFlags: det.contextFlags, triggeringText, recentHistory: null, draftText: text });
    const result = await runSemanticCheck(profile, uc, mockPass());
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. resolveAudience
// ---------------------------------------------------------------------------

describe('resolveAudience', () => {
  it('returns Shay profile for Shay chat ID (string)', () => {
    const p = resolveAudience(SHAY);
    expect(p.name).toBe('shay');
    expect(p.jargonTerms).toContain('guardrail');
  });

  it('returns Shay profile for Shay chat ID (number)', () => {
    const p = resolveAudience(8721344756);
    expect(p.name).toBe('shay');
  });

  it('returns default profile for unknown chat ID', () => {
    const p = resolveAudience(OTHER);
    expect(p.name).toBe('default');
    expect(p.jargonTerms).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Regex exports
// ---------------------------------------------------------------------------

describe('FALSE_FIXED_REGEX', () => {
  it('matches "done updating the skill" (same sentence)', () => {
    // The regex requires the "done/fixed/etc" word and the noun to be in the
    // same sentence clause — [^.!?]{0,80} does not cross sentence boundaries.
    expect(FALSE_FIXED_REGEX.test("Done updating the skill config.")).toBe(true);
  });

  it('matches "fixed … config"', () => {
    expect(FALSE_FIXED_REGEX.test("Fixed the config.")).toBe(true);
  });

  it('does not match "done cooking dinner"', () => {
    expect(FALSE_FIXED_REGEX.test("Done cooking dinner.")).toBe(false);
  });
});

describe('ACCOUNTABILITY_REGEX', () => {
  it('matches "you\'re right"', () => {
    expect(ACCOUNTABILITY_REGEX.test("You're right, that was off.")).toBe(true);
  });

  it('matches "i apologize"', () => {
    expect(ACCOUNTABILITY_REGEX.test("I apologize for the error.")).toBe(true);
  });

  it('does not match "keep the right approach"', () => {
    expect(ACCOUNTABILITY_REGEX.test("Keep the right approach.")).toBe(false);
  });
});

describe('containsBehaviourPromise', () => {
  it('matches "I will do better"', () => {
    expect(containsBehaviourPromise("I will do better.")).toBe(true);
  });

  it('matches "going forward"', () => {
    expect(containsBehaviourPromise("Going forward I will be careful.")).toBe(true);
  });

  it('matches "from now on"', () => {
    expect(containsBehaviourPromise("From now on I won't repeat this.")).toBe(true);
  });

  it('does not match a normal sentence', () => {
    expect(containsBehaviourPromise("The result is correct.")).toBe(false);
  });
});
