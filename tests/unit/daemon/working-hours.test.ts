import { describe, expect, it } from 'vitest';
import { admitInjection, isLondonWeekdayWorkingTime } from '../../../src/daemon/working-hours.js';
import type { AgentConfig } from '../../../src/types/index.js';

const policy: AgentConfig = {
  timezone: 'Europe/London',
  day_mode_start: '07:00',
  day_mode_end: '19:00',
};

describe('fleet working-hours admission', () => {
  it.each([
    ['winter before open', '2026-01-05T06:59:00Z', false],
    ['winter opens', '2026-01-05T07:00:00Z', true],
    ['winter before close', '2026-01-09T18:59:00Z', true],
    ['winter closes', '2026-01-09T19:00:00Z', false],
    ['summer before open', '2026-08-03T05:59:00Z', false],
    ['summer opens at 07:00 BST', '2026-08-03T06:00:00Z', true],
    ['summer closes at 19:00 BST', '2026-08-03T18:00:00Z', false],
    ['Saturday', '2026-08-08T10:00:00Z', false],
    ['Sunday', '2026-08-09T10:00:00Z', false],
  ])('%s', (_label, iso, expected) => {
    expect(isLondonWeekdayWorkingTime(new Date(iso))).toBe(expected);
  });

  it('allows direct human messages at every time but blocks autonomous origins', () => {
    const closed = new Date('2026-08-08T10:00:00Z');
    expect(admitInjection(policy, 'direct-human', closed)).toBe(true);
    for (const origin of ['cron', 'agent-inbox', 'reminder', 'startup-proactive', 'worker', 'system', 'unknown'] as const) {
      expect(admitInjection(policy, origin, closed)).toBe(false);
    }
  });

  it('does not apply the fleet policy to unrelated configurations', () => {
    const closed = new Date('2026-08-08T10:00:00Z');
    expect(admitInjection({ timezone: 'UTC' }, 'cron', closed)).toBe(true);
  });
});
