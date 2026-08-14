/**
 * Regression fixture suite for the message checker.
 *
 * All 8 BRAINDUMP cases are pre-loaded as fixtures.
 * No real API calls. No daemon. Extend by adding entries to FIXTURES.
 *
 * To add a new case from an audit log:
 *   1. Copy `full_draft` from the audit JSONL entry into a fixture object.
 *   2. Set `expectedStage` and `expectedOutcome` based on the audit `stage`/`result`.
 *   3. If `expectedOutcome` is `'reject'` at deterministic stage, set `semanticNeeded: false`.
 *
 * Run: npx vitest run tests/regression/message-checker.regression.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  runDeterministicChecks,
  runSemanticCheck,
  resolveAudience,
} from '../../src/telegram/checker.js';
import type { ModelClient, CheckerResult } from '../../src/telegram/checker.js';

const SHAY = '8721344756';
const OTHER = '9999999999';

// ---------------------------------------------------------------------------
// Mock semantic clients
// ---------------------------------------------------------------------------

function mockSemanticPass(): ModelClient {
  return { async check(): Promise<CheckerResult> { return { pass: true }; } };
}

function mockSemanticReject(reason: string, rewrite: string): ModelClient {
  return { async check(): Promise<CheckerResult> { return { pass: false, reason, rewrite }; } };
}

// ---------------------------------------------------------------------------
// Fixture type
// ---------------------------------------------------------------------------

interface Fixture {
  /** Human-readable description matching the BRAINDUMP case. */
  description: string;
  chatId: string;
  text: string;
  deliverable: boolean;
  /**
   * Expected outcome at the deterministic stage.
   * 'reject' means deterministic should block (no semantic call needed).
   * 'pass' means deterministic passes and semantic is needed.
   */
  deterministicOutcome: 'reject' | 'pass';
  /**
   * Mock semantic result to inject when deterministicOutcome is 'pass'.
   * Ignored when deterministicOutcome is 'reject'.
   */
  semanticMock?: ModelClient;
  /** Final expected outcome across the pipeline. */
  finalOutcome: 'pass' | 'reject';
}

// ---------------------------------------------------------------------------
// BRAINDUMP fixtures
// ---------------------------------------------------------------------------

const FIXTURES: Fixture[] = [
  // Case 1: Echo of Shay's proposal → semantic reject
  {
    description: 'Case 1 — echo of proposal',
    chatId: SHAY,
    text: 'Yes, that sounds like a good approach. We can do it that way.',
    deliverable: false,
    deterministicOutcome: 'pass',
    semanticMock: mockSemanticReject('Echoes the proposal without adding value.', 'Respond with your own assessment.'),
    finalOutcome: 'reject',
  },

  // Case 2: Jargon to Shay → semantic reject
  {
    description: 'Case 2 — send paths / release holds jargon to Shay',
    chatId: SHAY,
    text: 'The send path is open and the release hold is cleared.',
    deliverable: false,
    deterministicOutcome: 'pass', // jargon is a context flag, not a hard reject
    semanticMock: mockSemanticReject('Jargon without a request for technical detail.', 'Speak plainly.'),
    finalOutcome: 'reject',
  },

  // Case 3: "You're right. I'll change that going forward." → deterministic reject
  {
    description: 'Case 3 — behaviour promise "going forward"',
    chatId: SHAY,
    text: "You're right. I'll change that going forward.",
    deliverable: false,
    deterministicOutcome: 'reject',
    finalOutcome: 'reject',
  },

  // Case 4: false "fixed" claim → deterministic reject
  // Uses the canonical cross-sentence form "Done. The skill and fleet are updated."
  // The regex second alternative \.?\s+(?:\w+\s+){0,5} crosses sentence boundaries.
  {
    description: 'Case 4 — false "fixed" claim (canonical cross-sentence form)',
    chatId: SHAY,
    text: 'Done. The skill and fleet are updated.',
    deliverable: false,
    deterministicOutcome: 'reject',
    finalOutcome: 'reject',
  },

  // Case 5: 37-word accountability paragraph → deterministic reject
  {
    description: 'Case 5 — accountability paragraph',
    chatId: SHAY,
    text:
      "You're right. I apologize for the confusion. I should have known better " +
      "and will ensure this doesn't happen again by carefully reviewing all messages " +
      'before sending them to you in future interactions.',
    deliverable: false,
    deterministicOutcome: 'reject',
    finalOutcome: 'reject',
  },

  // Case 6: Honest short acknowledgement → pass
  {
    description: 'Case 6 — honest short acknowledgement',
    chatId: SHAY,
    text: 'Yes. I knew the rule, ignored it twice, proved your point.',
    deliverable: false,
    deterministicOutcome: 'pass',
    semanticMock: mockSemanticPass(),
    finalOutcome: 'pass',
  },

  // Case 7: Direct answer with brief explanation → pass
  {
    description: 'Case 7 — direct answer, brief explanation',
    chatId: OTHER,
    text: 'Not if we keep it tight. One message per cycle, no echoes.',
    deliverable: false,
    deterministicOutcome: 'pass',
    semanticMock: mockSemanticPass(),
    finalOutcome: 'pass',
  },

  // Case 8: Long email with validated deliverable-for → pass (deliverable=true skips blocks)
  {
    description: 'Case 8 — long deliverable with validated inbound ID',
    chatId: SHAY,
    text: 'Here is the full architecture brief:\n\n' + 'Detail sentence. '.repeat(100),
    deliverable: true,
    deterministicOutcome: 'pass',
    semanticMock: mockSemanticPass(),
    finalOutcome: 'pass',
  },

  // Case 9: live 31 Jul repeat — short wording previously bypassed the
  // >20-word accountability rule and reached Shay.
  {
    description: 'Case 9 — short empty apology "That\'s on me"',
    chatId: SHAY,
    text: "You're right. I finished it and didn't tell you until you asked. That's on me.",
    deliverable: false,
    deterministicOutcome: 'reject',
    finalOutcome: 'reject',
  },
];

// ---------------------------------------------------------------------------
// Run fixtures
// ---------------------------------------------------------------------------

describe('message-checker regression fixtures', () => {
  for (const fixture of FIXTURES) {
    it(fixture.description, async () => {
      // Stage 1: Deterministic
      const det = runDeterministicChecks(fixture.chatId, fixture.text, fixture.deliverable);

      if (fixture.deterministicOutcome === 'reject') {
        expect(det.reject, `Expected deterministic reject for: ${fixture.description}`).not.toBeNull();
        expect(fixture.finalOutcome).toBe('reject');
        return; // no semantic call needed
      }

      // Stage 1 passed
      expect(det.reject, `Expected deterministic pass for: ${fixture.description}`).toBeNull();

      if (fixture.finalOutcome === 'reject' && fixture.deterministicOutcome === 'pass') {
        // Semantic is expected to reject
        expect(fixture.semanticMock, 'semanticMock required when final=reject + det=pass').toBeDefined();
      }

      if (!fixture.semanticMock) {
        // No semantic mock provided; deterministic pass is the final pass
        expect(fixture.finalOutcome).toBe('pass');
        return;
      }

      // Stage 2: Semantic
      const profile = resolveAudience(fixture.chatId);
      const result = await runSemanticCheck(profile, `Draft reply:\n${fixture.text}`, fixture.semanticMock);

      if (fixture.finalOutcome === 'pass') {
        expect(result.pass).toBe(true);
      } else {
        expect(result.pass).toBe(false);
      }
    });
  }
});
