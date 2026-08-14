import { describe, expect, it, vi } from 'vitest';
import { installDaemonConsoleTimestamps, timestampDaemonLogLines } from '../../../src/daemon/index.js';

describe('daemon log timestamps', () => {
  const instant = () => new Date('2026-08-06T10:12:34.567Z');

  it('prefixes a formatted line with ISO-8601 UTC milliseconds', () => {
    expect(timestampDaemonLogLines(['[rocky] context at %d%%', 33], instant)).toEqual([
      '2026-08-06T10:12:34.567Z [rocky] context at 33%',
    ]);
  });

  it('timestamps every physical line in multiline output', () => {
    expect(timestampDaemonLogLines(['first\nsecond'], instant)).toEqual([
      '2026-08-06T10:12:34.567Z first',
      '2026-08-06T10:12:34.567Z second',
    ]);
  });

  it('wraps console methods only once', () => {
    const originals = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    const sink = vi.fn();
    console.log = sink;
    try {
      installDaemonConsoleTimestamps(instant);
      installDaemonConsoleTimestamps(instant);
      console.log('hello');
      expect(sink).toHaveBeenCalledOnce();
      expect(sink).toHaveBeenCalledWith('2026-08-06T10:12:34.567Z hello');
    } finally {
      console.log = originals.log;
      console.info = originals.info;
      console.warn = originals.warn;
      console.error = originals.error;
      delete (console as typeof console & Record<string, unknown>).__cortextosTimestamped;
    }
  });
});
