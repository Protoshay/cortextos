import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROCKY = '/root/cortextos/orgs/todi-and-boys/agents/rocky';

function pythonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...pythonFiles(path));
    else if (name.endsWith('.py')) out.push(path);
  }
  return out;
}

describe('FENSA irreversible insert chokepoint', () => {
  it('has one definition and one production caller', () => {
    const hits = pythonFiles(ROCKY)
      .flatMap((path) => {
        const text = readFileSync(path, 'utf8');
        return [...text.matchAll(/submit_installation\s*\(/g)].map(() => path);
      }).sort();
    expect(hits).toEqual([
      join(ROCKY, 'local/fensa_submit_job.py'),
      join(ROCKY, 'scripts/fensa_submit_verified.py'),
    ]);
  });

  it('has no second direct portal-insert implementation', () => {
    const directInsertFiles = pythonFiles(ROCKY)
      .filter((path) => readFileSync(path, 'utf8').includes('InsertInstallation'))
      .sort();
    expect(directInsertFiles).toEqual([
      join(ROCKY, 'local/fensa_submit_job.py'),
    ]);
  });

  it('consumes exact first-party approval before the portal call', () => {
    const path = join(ROCKY, 'scripts/fensa_submit_verified.py');
    const text = readFileSync(path, 'utf8');
    expect(text.indexOf('consume_approval(a.seq, payload_hash)')).toBeGreaterThan(-1);
    expect(text.indexOf('consume_approval(a.seq, payload_hash)'))
      .toBeLessThan(text.indexOf('res = submit_installation('));
  });
});
