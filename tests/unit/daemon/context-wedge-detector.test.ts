import { describe, it, expect } from 'vitest';
import { isContextWedged } from '../../../src/daemon/fast-checker';

/**
 * Tests for the shared context-wedge predicate.
 *
 * The client-side fixture is derived from an authentic rendered line captured in
 * a live agent's stdout.log:
 *   "Context limit reached \u00B7 /compact or /clear to continue"
 * (\u00B7 is the U+00B7 middle-dot separator Claude Code renders between the
 * phrase and the /compact tail). The client arm scans only the buffer TAIL
 * (last 1500 chars) because the prompt is redrawn sticky at the buffer end.
 */

// Authentic client-limit phrase (middle-dot + full tail).
const CLIENT_LINE = 'Context limit reached \u00B7 /compact or /clear to continue';

describe('isContextWedged', () => {
  it('detects the authentic client line at the END of the buffer', () => {
    const buffer = 'some earlier output\nmore output\n' + CLIENT_LINE;
    expect(isContextWedged(buffer)).toBe(true);
  });

  it('does NOT detect the client line when it falls outside the 1500-char tail', () => {
    // Client line early, then >2000 chars of other text pushes it out of the tail.
    const buffer = CLIENT_LINE + '\n' + 'x'.repeat(2000);
    expect(isContextWedged(buffer)).toBe(false);
  });

  it('does NOT detect the short form (no "or /clear to continue" tail)', () => {
    const shortForm = 'Context limit reached \u00B7 /compact';
    const buffer = 'earlier output\n' + shortForm;
    expect(isContextWedged(buffer)).toBe(false);
  });

  it('detects the API "1M context" overflow string early in a long buffer', () => {
    // API arm scans the full window, not just the tail.
    const apiLine = 'extra usage required for 1M context window';
    const buffer = apiLine + '\n' + 'y'.repeat(2500);
    expect(isContextWedged(buffer)).toBe(true);
  });

  it('detects the API "conversation too long … compaction" string', () => {
    const buffer = 'error: conversation too long, please run compaction to continue';
    expect(isContextWedged(buffer)).toBe(true);
  });

  it('does NOT detect ordinary context-percentage output', () => {
    const buffer = 'Context is at 72%\nstill working fine';
    expect(isContextWedged(buffer)).toBe(false);
  });
});
