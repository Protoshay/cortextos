/**
 * Architectural bypass gate — static analysis.
 *
 * Scans every .ts file under src/ for patterns that indicate a direct
 * Telegram send path that bypasses the checker pipeline.
 *
 * Checks three patterns per file:
 *   1. new TelegramAPI()         — unauthorized instantiation
 *   2. api.telegram.org          — direct HTTP to Telegram
 *   3. BOT_TOKEN                 — raw token read that enables a send
 *
 * ALLOWED_FILES lists each path that is legitimately exempt, with the
 * reason code from the table below:
 *
 *   CLASS_DEF   — defines the TelegramAPI class itself
 *   DAEMON_OWN  — daemon-owned authorized send gateway
 *   STARTUP     — reads token from disk once at agent startup, no agent-path send
 *   PROBE_ONLY  — calls validateCredentials/getMe only, never sendMessage
 *   CMD_REG     — registers bot /commands via setMyCommands, not a message send
 *   TEMPLATE    — string literal in a template/example, no actual token present
 *   HOOK_CREDS  — credential loading for hooks (index.ts), delegated to IPC on send
 *   CRASH_ALERT — legacy crash-alert hook, exempt until hook-manager migration
 *   COMMENT     — token name mentioned in comment or type definition only
 *
 * Amendment paths covered by this test:
 *   - `src/cli/bus.ts`  editMessageText → routed via IPC (edit: true flag)
 *   - `src/bus/system.ts` postActivity → routed via IPC 'send-activity-message'
 *
 * For each pattern, the test asserts that only ALLOWED_FILES match.
 * Any new non-allowlisted file that introduces a direct Telegram call
 * will cause this test to fail, preventing silent bypass regressions.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SRC_ROOT = join(process.cwd(), 'src');

/**
 * Patterns that signal a direct send bypass.
 */
const FORBIDDEN_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /new\s+TelegramAPI\s*\(/, label: 'new TelegramAPI()' },
  { re: /api\.telegram\.org/, label: 'direct api.telegram.org call' },
  { re: /BOT_TOKEN/, label: 'BOT_TOKEN read' },
];

/**
 * Files allowed to match each pattern, keyed by the label.
 * Any path relative to src/ listed here is exempt for the given pattern.
 */
const ALLOWED: Record<string, Set<string>> = {
  'new TelegramAPI()': new Set([
    'telegram/api.ts',                  // CLASS_DEF
    'daemon/telegram-send-service.ts',  // DAEMON_OWN
    'daemon/agent-manager.ts',          // STARTUP — owns activityApi for orchestrator
    'cli/setup.ts',                     // PROBE_ONLY — validateCredentials only, never sends
    'cli/enable-agent.ts',              // PROBE_ONLY — validateCredentials only, never sends
    'cli/bus.ts',                       // answer-callback (answerCallbackQuery, exempt only)
  ]),

  'direct api.telegram.org call': new Set([
    'telegram/api.ts',                  // CLASS_DEF — all HTTP calls originate here
    'cli/setup.ts',                     // PROBE_ONLY — getUpdates credential check, not a send
    'bus/metrics.ts',                   // CMD_REG — setMyCommands, not sendMessage
    'cli/add-agent.ts',                 // TEMPLATE — example URL in a string literal
    'daemon/index.ts',                  // PROBE_ONLY — startup sendMessage to validate creds
    // hook-crash-alert.ts removed: migrated to IPC, no longer calls api.telegram.org
  ]),

  'BOT_TOKEN read': new Set([
    'telegram/api.ts',                  // CLASS_DEF
    'daemon/telegram-send-service.ts',  // DAEMON_OWN
    'daemon/agent-manager.ts',          // STARTUP — reads from .env at startup
    'cli/setup.ts',                     // PROBE_ONLY
    'cli/enable-agent.ts',              // PROBE_ONLY
    'bus/metrics.ts',                   // CMD_REG — sets commands, not sends
    'cli/add-agent.ts',                 // TEMPLATE — empty token slot in generated .env
    'cli/init.ts',                      // TEMPLATE — same
    'daemon/index.ts',                  // STARTUP — reads token for initial validation
    'hooks/hook-crash-alert.ts',        // CRASH_ALERT — legacy hook
    'hooks/index.ts',                   // HOOK_CREDS — credential loading for hook harness
    'bus/approval.ts',                  // COMMENT — mentions token in log warning message
    'bus/system.ts',                    // COMMENT — mentions token in code comment
    'pty/agent-pty.ts',                 // COMMENT — mentions token in a comment
    'types/index.ts',                   // COMMENT — mentions token in a JSDoc comment
    'cli/bus.ts',                       // answer-callback (answerCallbackQuery — exempt) + event-stream watch
  ]),
};

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

function walkTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walkTs(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Telegram send coverage — no bypass paths', () => {
  const files = walkTs(SRC_ROOT);

  it('scanned at least 20 source files (sanity check)', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  for (const { re, label } of FORBIDDEN_PATTERNS) {
    it(`no unauthorized "${label}" usage outside allowlist`, () => {
      const violations: string[] = [];
      const allowed = ALLOWED[label] ?? new Set();

      for (const filepath of files) {
        const rel = filepath.slice(SRC_ROOT.length + 1).replace(/\\/g, '/');
        if (allowed.has(rel)) continue;

        const content = readFileSync(filepath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            violations.push(`  ${rel}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `Found unauthorized "${label}" in ${violations.length} location(s):\n` +
            violations.join('\n') +
            '\n\nRoute through TelegramSendService / IPC instead, or add to ALLOWED with a reason code.',
        );
      }
    });
  }

  // --- Amendment: specific file checks ---

  it('bus.ts edit-message does NOT use new TelegramAPI() — editMessageText gated via IPC', () => {
    const busTs = join(SRC_ROOT, 'cli', 'bus.ts');
    const content = readFileSync(busTs, 'utf-8');
    const editIdx = content.indexOf(".command('edit-message')");
    expect(editIdx, 'edit-message command must exist in bus.ts').toBeGreaterThan(0);
    const editSection = content.slice(editIdx, editIdx + 2500);
    expect(editSection, 'edit-message must not instantiate TelegramAPI directly').not.toMatch(
      /new TelegramAPI\s*\(/,
    );
    expect(editSection, 'edit-message must route through IPCClient').toContain('IPCClient');
    expect(editSection, 'edit-message must pass edit: true flag').toContain('edit: true');
  });

  it('system.ts postActivity does NOT use new TelegramAPI() — activity-channel gated via IPC', () => {
    const systemTs = join(SRC_ROOT, 'bus', 'system.ts');
    const content = readFileSync(systemTs, 'utf-8');
    expect(content, 'system.ts must not instantiate TelegramAPI').not.toContain('new TelegramAPI(');
    expect(content, 'system.ts must route to send-activity-message').toContain('send-activity-message');
  });

  it('approval.ts pingAgentChatId uses IPCClient (not direct TelegramAPI)', () => {
    const approvalTs = join(SRC_ROOT, 'bus', 'approval.ts');
    const content = readFileSync(approvalTs, 'utf-8');
    const pingIdx = content.indexOf('function pingAgentChatId');
    expect(pingIdx, 'pingAgentChatId must exist').toBeGreaterThan(0);
    const section = content.slice(pingIdx, pingIdx + 2500);
    expect(section, 'pingAgentChatId must not use new TelegramAPI').not.toMatch(/new TelegramAPI\s*\(/);
  });

  it('all hooks route through IPC — no direct TelegramAPI in hook-ask/permission/planmode', () => {
    const hookFiles = [
      join(SRC_ROOT, 'hooks', 'hook-ask-telegram.ts'),
      join(SRC_ROOT, 'hooks', 'hook-permission-telegram.ts'),
      join(SRC_ROOT, 'hooks', 'hook-planmode-telegram.ts'),
    ];
    for (const f of hookFiles) {
      try {
        const content = readFileSync(f, 'utf-8');
        expect(content, `${f} must not instantiate TelegramAPI directly`).not.toMatch(
          /new TelegramAPI\s*\(/,
        );
      } catch (err: any) {
        if (err.code === 'ENOENT') continue; // hook file not present in this build variant
        throw err;
      }
    }
  });

  it('codex-app-server-pty replyLocal uses IPC (not direct sendMessage)', () => {
    const ptyTs = join(SRC_ROOT, 'pty', 'codex-app-server-pty.ts');
    try {
      const content = readFileSync(ptyTs, 'utf-8');
      const replyLocalIdx = content.indexOf('replyLocal');
      if (replyLocalIdx >= 0) {
        // Extract ~1500 chars around replyLocal; sendChatAction is exempt.
        const section = content.slice(replyLocalIdx, replyLocalIdx + 1500);
        expect(section, 'replyLocal must not call .sendMessage directly').not.toContain('.sendMessage(');
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') return; // not in scope of this build
      throw err;
    }
  });

  it('sendActivityMessage routes through activitySendService.handleSendRequest', () => {
    const content = readFileSync(join(SRC_ROOT, 'daemon', 'agent-manager.ts'), 'utf-8');
    const fnIdx = content.indexOf('sendActivityMessage');
    const implIdx = content.indexOf('async sendActivityMessage(', fnIdx);
    expect(implIdx, 'async sendActivityMessage must exist').toBeGreaterThan(0);
    const section = content.slice(implIdx, implIdx + 1500);
    expect(section).not.toContain('activityApi.sendMessage');
    expect(section).toContain('activitySendService');
    expect(section).toContain('handleSendRequest');
  });

  it('sendDirect routes through handleSendRequest', () => {
    const content = readFileSync(join(SRC_ROOT, 'daemon', 'telegram-send-service.ts'), 'utf-8');
    const fnIdx = content.indexOf('async sendDirect(');
    expect(fnIdx, 'sendDirect must exist').toBeGreaterThan(0);
    const section = content.slice(fnIdx, fnIdx + 600);
    expect(section).not.toContain('this.doSend(');
    expect(section).toContain('handleSendRequest');
  });

  it('checker reasoning effort is "none" not "disabled"', () => {
    const content = readFileSync(join(SRC_ROOT, 'telegram', 'checker.ts'), 'utf-8');
    expect(content).not.toContain("effort: 'disabled'");
    expect(content).toContain("effort: 'none'");
  });

  it('independent reviewer is explicitly scoped to Otis and Skiffy', () => {
    const content = readFileSync(join(SRC_ROOT, 'daemon', 'telegram-send-service.ts'), 'utf-8');
    expect(content).toContain("MESSAGE_CHECKER_AGENTS = new Set(['otis', 'skiffy'])");
    expect(content).toContain('MESSAGE_CHECKER_AGENTS.has(this.agentName)');
    expect(content).toContain('createCodexClient(this.checkerConfig)');
  });
});
