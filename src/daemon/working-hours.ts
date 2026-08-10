import type { AgentConfig } from '../types/index.js';

export type InjectionOrigin =
  | 'direct-human'
  | 'cron'
  | 'agent-inbox'
  | 'reminder'
  | 'startup-proactive'
  | 'worker'
  | 'system'
  | 'unknown';

const POLICY_TIMEZONE = 'Europe/London';
const POLICY_START = '07:00';
const POLICY_END = '19:00';

export function fleetWorkingHoursPolicyApplies(config: AgentConfig): boolean {
  return config.timezone === POLICY_TIMEZONE
    && config.day_mode_start === POLICY_START
    && config.day_mode_end === POLICY_END;
}

export function isLondonWeekdayWorkingTime(at: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: POLICY_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value ?? '';
  const weekday = value('weekday');
  const hour = Number(value('hour'));
  const minute = Number(value('minute'));
  const weekdayOpen = weekday !== 'Sat' && weekday !== 'Sun';
  const minuteOfDay = hour * 60 + minute;
  return weekdayOpen && minuteOfDay >= 7 * 60 && minuteOfDay < 19 * 60;
}

export function admitInjection(
  config: AgentConfig,
  origin: InjectionOrigin,
  at: Date = new Date(),
): boolean {
  if (origin === 'direct-human') return true;
  if (!fleetWorkingHoursPolicyApplies(config)) return true;
  return isLondonWeekdayWorkingTime(at);
}
