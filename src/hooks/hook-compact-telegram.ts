/**
 * hook-compact-telegram.ts — PreCompact hook.
 * Records context compaction privately.
 *
 * This hook fires and returns immediately — it never blocks the compaction.
 * Registered in settings.json under the "PreCompact" event.
 *
 * Human-facing compaction notices were removed after a fleet restart storm
 * exposed that direct hook sends bypass conversation gates and create noise.
 * Compaction remains observable in the agent's backend log.
 */

import { loadEnv } from './index.js';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

async function main(): Promise<void> {
  const env = loadEnv();
  try {
    const logDir = join(env.ctxRoot, 'logs', env.agentName || 'agent');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      join(logDir, 'compactions.log'),
      `${new Date().toISOString()} context_compaction_started\n`,
      'utf-8',
    );
  } catch {
    // Never fail — compaction must not be blocked
  }
}

main().catch(() => process.exit(0));
