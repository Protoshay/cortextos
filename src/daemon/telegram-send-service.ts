/**
 * TelegramSendService — daemon-owned gatekeeper for all human-facing Telegram sends.
 *
 * One instance is created per agent by AgentManager. It holds the TelegramAPI
 * instance (and therefore the bot token), so the token never needs to live in
 * agent child-process environments.
 *
 * All send paths converge here:
 *   CLI agents  → IPCClient → IPC 'send-human-message' → handleSendRequest()
 *   Daemon code → sendDirect() (bypasses checker — used for system alerts)
 *
 * The checker pipeline (handleSendRequest) runs in order:
 *   1. verifyAgentIdentity
 *   2. validateDeliverableClaim (checks inbound log for triggering msg ID)
 *   3. checkHumanConversationGate
 *   4. checkHumanMessageCadenceGate
 *   5. checkHumanQuestionGate
 *   6. checkFensaWindowGate (predicate-scoped, not agent-scoped)
 *   7. runDeterministicChecks
 *   8. runSemanticCheck (skipped for source:'hook')
 *   9. writeCheckerAudit
 *  10. TelegramAPI.send*
 *  11. logOutboundMessage, markHumanQuestionOpen, cacheLastSent, logEvent
 *
 * Fail-closed: a checker error of any kind cannot silently become a send.
 *
 * Security posture — what IS enforced (supported path):
 *   Agents cannot skip any gate via the supported CLI path.
 *
 * Security posture — what is NOT enforced (uid-0 limitation):
 *   A compromised uid-0 agent process could bypass via /proc, direct curl,
 *   or reading config files. OS isolation (privilege separation) is a
 *   separate future milestone — see RESULT.md.
 */

import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { TelegramAPI, requireSentMessageId } from '../telegram/api.js';
import {
  checkHumanConversationGate,
  checkHumanMessageCadenceGate,
  checkHumanQuestionGate,
  checkFensaWindowGate,
  logOutboundMessage,
  markHumanQuestionOpen,
  cacheLastSent,
  buildRecentHistory,
} from '../telegram/logging.js';
import {
  validateDeliverableClaim,
  runDeterministicChecks,
  runSemanticCheck,
  writeCheckerAudit,
  resolveAudience,
  assembleCheckerContext,
  createOpenAIClient,
  createCodexClient,
  recordGeraldToldGateShadow,
  type CheckerConfig,
  type ModelClient,
  type CheckerAuditEntry,
} from '../telegram/checker.js';

/** Plain-language semantic review is required for the two agents with evidence. */
export const MESSAGE_CHECKER_AGENTS = new Set(['otis', 'skiffy']);

/**
 * Age bound on the conversation snippet handed to the semantic gate.
 *
 * The outbound log only advances when a send SUCCEEDS — a rejection returns
 * before `doSend`. So without a time bound the window is a fixed point: every
 * rejected draft is judged against exactly the history that rejected the last
 * one. Scoped to this call site on purpose; the context-injection caller in
 * agent-manager keeps the unbounded window, since it gates nothing.
 */
export const CHECKER_HISTORY_MAX_AGE_HOURS = 24;

import { logEvent } from '../bus/event.js';
import { resolvePaths } from '../utils/paths.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HumanSendRequest {
  agentName: string;
  chatId: string;
  text: string;
  /** Triggering inbound message ID for deliverable validation. */
  deliverableForMsgId?: number;
  /**
   * Gerald told-gate declaration (Monday item IDs, comma-separated) — STEP 2
   * of the staged told-gate rollout: record-only, not yet enforced. See
   * orgs/todi-and-boys/agents/rimu/scripts/plan_told_gate_shared_state.md §4.
   */
  geraldItems?: string;
  correctionOf?: number;
  image?: string;
  file?: string;
  plainText?: boolean;
  /** Inline keyboard markup for hook UI messages (permission prompts, AskUserQuestion). */
  replyMarkup?: object;
  /** 'cli' = full checker; 'hook' = daemon token only, skip semantic; 'daemon' = sendDirect path */
  source: 'cli' | 'hook' | 'daemon';
  /**
   * Amendment: gate human-facing edits via the same checker pipeline.
   * When true, the underlying send becomes editMessageText on editMessageId
   * rather than a new sendMessage. The checker still runs on the replacement text.
   */
  edit?: boolean;
  editMessageId?: number;
}

export interface HumanSendResult {
  ok: boolean;
  sentMessageId?: number;
  rejection?: { reason: string; rewrite?: string };
  error?: string;
}

// ---------------------------------------------------------------------------
// TelegramSendService
// ---------------------------------------------------------------------------

export class TelegramSendService {
  private readonly api: TelegramAPI;
  private readonly ctxRoot: string;
  private readonly agentName: string;
  private readonly checkerConfig: CheckerConfig;
  private readonly openaiKey: string;
  private readonly paths: BusPaths;
  private readonly org: string;
  private readonly instanceId: string;
  /** Lazy-initialised model client — created once on first use. */
  private modelClient: ModelClient | null = null;

  constructor(opts: {
    api: TelegramAPI;
    ctxRoot: string;
    agentName: string;
    instanceId: string;
    org: string;
    checkerConfig: CheckerConfig;
    openaiKey: string;
    modelClient?: ModelClient;
  }) {
    this.api = opts.api;
    this.ctxRoot = opts.ctxRoot;
    this.agentName = opts.agentName;
    this.instanceId = opts.instanceId;
    this.org = opts.org;
    this.checkerConfig = opts.checkerConfig;
    this.openaiKey = opts.openaiKey;
    this.modelClient = opts.modelClient ?? null;
    this.paths = resolvePaths(opts.agentName, opts.instanceId, opts.org);
  }

  // ---------------------------------------------------------------------------
  // Primary send path — called by the IPC handler
  // ---------------------------------------------------------------------------

  /**
   * Run ALL gates and the checker, then send (or reject).
   * Called by the IPC server 'send-human-message' handler.
   *
   * Bounded by: checkerConfig.timeoutMs (8 s) + Telegram API timeout (15 s).
   * The IPC client should use a 35 s timeout for this command type.
   */
  async handleSendRequest(req: HumanSendRequest): Promise<HumanSendResult> {
    const startMs = Date.now();
    const checkerEnabled = MESSAGE_CHECKER_AGENTS.has(this.agentName);

    // Gate 1: caller must identify as this agent (simple name match —
    // the IPC socket is 0600 so the actual identity assurance is the socket).
    if (req.agentName !== this.agentName) {
      return {
        ok: false,
        rejection: {
          reason: `Agent identity mismatch: request for '${req.agentName}' routed to service for '${this.agentName}'.`,
        },
      };
    }

    // Gerald told-gate shadow record (STEP 2 — record-only, non-enforcing).
    // Fires first, unconditionally, so it captures every attempt (rejected
    // or accepted) rather than only sends that clear later gates. True no-op
    // for every chat other than Gerald's. Never blocks or alters this send.
    recordGeraldToldGateShadow(
      this.ctxRoot,
      this.agentName,
      req.chatId,
      req.text,
      req.geraldItems,
    );

    // Gate 3: Validate deliverable claim (reads inbound log).
    const { deliverable, triggeringText } = validateDeliverableClaim(
      this.ctxRoot,
      this.agentName,
      req.chatId,
      req.deliverableForMsgId,
    );

    // Gate 4: Conversation style gate.
    const styleError = checkHumanConversationGate(req.chatId, req.text, deliverable);
    if (styleError) {
      return { ok: false, rejection: { reason: styleError } };
    }

    // Gate 5: Cadence gate.
    const cadenceError = checkHumanMessageCadenceGate(
      this.ctxRoot,
      this.agentName,
      req.chatId,
      deliverable,
      req.correctionOf,
    );
    if (cadenceError) {
      return { ok: false, rejection: { reason: cadenceError } };
    }

    // Gate 6: Open-question gate.
    const questionError = checkHumanQuestionGate(
      this.ctxRoot,
      this.agentName,
      req.chatId,
      req.text,
      deliverable,
    );
    if (questionError) {
      return { ok: false, rejection: { reason: questionError } };
    }

    // Gate 7: FENSA counts and lists must state their time range.
    // Predicate-scoped, not agent-scoped, deliberately: gating on agentName
    // would silently stop protecting whoever inherits the FENSA lane next.
    // Inert for any message that is not a FENSA count.
    const fensaWindowError = checkFensaWindowGate(req.text);
    if (fensaWindowError) {
      return { ok: false, rejection: { reason: fensaWindowError } };
    }

    // Independent deterministic and semantic review applies only to agents
    // with observed failures until evidence justifies widening the scope.
    if (checkerEnabled) {
      const det = runDeterministicChecks(req.chatId, req.text, deliverable);
      if (det.reject) {
        writeCheckerAudit(this.ctxRoot, this.agentName, {
          timestamp: new Date().toISOString(),
          agent: this.agentName,
          chat_id: req.chatId,
          source: req.source,
          stage: 'deterministic',
          result: 'reject',
          reason: det.reject,
          full_draft: req.text,
          draft_preview: req.text.slice(0, 100),
        });
        return { ok: false, rejection: { reason: det.reject } };
      }

      const profile = resolveAudience(req.chatId);
      const recentHistory = buildRecentHistory(
        this.ctxRoot,
        this.agentName,
        req.chatId,
        2,
        CHECKER_HISTORY_MAX_AGE_HOURS,
      );
      const userContent = assembleCheckerContext({
        analyticsDir: this.paths.analyticsDir,
        agentName: this.agentName,
        contextFlags: det.contextFlags,
        triggeringText,
        recentHistory,
        draftText: req.text,
      });

      const client = this.getModelClient();
      const semanticStartMs = Date.now();

      let semanticResult: Awaited<ReturnType<typeof runSemanticCheck>>;
      try {
        semanticResult = await runSemanticCheck(profile, userContent, client);
      } catch (err) {
        const reason = `Checker error: ${sanitiseCheckerError(err)}`;
        const latencyMs = Date.now() - semanticStartMs;
        const auditEntry: CheckerAuditEntry = {
          timestamp: new Date().toISOString(),
          agent: this.agentName,
          chat_id: req.chatId,
          source: req.source,
          stage: 'error',
          result: 'error',
          reason,
          full_draft: req.text,
          latency_ms: latencyMs,
          draft_preview: req.text.slice(0, 100),
        };
        writeCheckerAudit(this.ctxRoot, this.agentName, auditEntry);
        return { ok: false, rejection: { reason } };
      }

      const latencyMs = Date.now() - semanticStartMs;
      const auditEntry: CheckerAuditEntry = {
        timestamp: new Date().toISOString(),
        agent: this.agentName,
        chat_id: req.chatId,
        source: req.source,
        stage: 'semantic',
        result: semanticResult.pass ? 'pass' : 'reject',
        reason: semanticResult.pass ? undefined : semanticResult.reason,
        rewrite: semanticResult.pass ? undefined : semanticResult.rewrite,
        full_draft: semanticResult.pass ? undefined : req.text,
        latency_ms: latencyMs,
        draft_preview: req.text.slice(0, 100),
      };
      writeCheckerAudit(this.ctxRoot, this.agentName, auditEntry);

      if (!semanticResult.pass) {
        return {
          ok: false,
          rejection: {
            reason: semanticResult.reason,
            rewrite: semanticResult.rewrite,
          },
        };
      }
    }

    // --- SEND ---
    return this.doSend(req);
  }

  /**
   * Daemon-internal send path. Routes through the full checker pipeline.
   */
  async sendDirect(
    chatId: string,
    text: string,
    opts?: {
      replyMarkup?: object;
      plainText?: boolean;
      source?: string;
    },
  ): Promise<HumanSendResult> {
    return this.handleSendRequest({
      agentName: this.agentName,
      chatId,
      text,
      plainText: opts?.plainText,
      replyMarkup: opts?.replyMarkup,
      source: 'daemon',
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async doSend(req: HumanSendRequest): Promise<HumanSendResult> {
    try {
      let sentMessageId = 0;

      if (req.edit && req.editMessageId) {
        // Amendment: human-facing edits are gated via the same checker pipeline.
        // editMessageText does not return a message_id (Telegram returns `true`),
        // so we keep the original message ID as the reference.
        await this.api.editMessageText(req.chatId, req.editMessageId, req.text, req.replyMarkup);
        sentMessageId = req.editMessageId;
      } else if (req.image) {
        const result = await this.api.sendPhoto(req.chatId, req.image, req.text, req.replyMarkup);
        sentMessageId = requireSentMessageId(result);
      } else if (req.file) {
        const result = await this.api.sendDocument(req.chatId, req.file, req.text);
        sentMessageId = requireSentMessageId(result);
      } else {
        const result = await this.api.sendMessage(req.chatId, req.text, req.replyMarkup, {
          parseMode: req.plainText ? null : 'HTML',
        });
        sentMessageId = requireSentMessageId(result);
      }

      // Post-send bookkeeping (unchanged from existing send path)
      logOutboundMessage(
        this.ctxRoot,
        this.agentName,
        req.chatId,
        req.text,
        sentMessageId,
        {
          parseMode: req.plainText ? 'none' : 'html',
          correctionOf: req.correctionOf,
        },
      );
      markHumanQuestionOpen(
        this.ctxRoot,
        this.agentName,
        req.chatId,
        req.text,
        sentMessageId,
      );
      cacheLastSent(this.ctxRoot, this.agentName, req.chatId, req.text);

      try {
        const preview =
          req.text.length > 120 ? req.text.slice(0, 120) + '\u2026' : req.text;
        logEvent(
          this.paths,
          this.agentName,
          this.org,
          'message',
          'telegram_sent',
          'info',
          JSON.stringify({ chat_id: req.chatId, message_id: sentMessageId, preview }),
        );
      } catch {
        // Non-fatal
      }

      return { ok: true, sentMessageId };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Telegram send failed: ${msg}` };
    }
  }

  private getModelClient(): ModelClient {
    if (!this.modelClient) {
      this.modelClient = MESSAGE_CHECKER_AGENTS.has(this.agentName)
        ? createCodexClient(this.checkerConfig)
        : createOpenAIClient(this.openaiKey, this.checkerConfig);
    }
    return this.modelClient;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip API keys and sensitive details from checker error messages.
 * The sanitised string goes into the audit log and the rejection message
 * shown to the agent — both of which must never carry credentials.
 */
function sanitiseCheckerError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Remove anything that looks like an API key (Bearer sk-..., etc.)
  return raw.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_-]{10,}/g, '[REDACTED]').slice(0, 200);
}

/**
 * Read daemon config from {ctxRoot}/config/daemon.json.
 * Returns default CheckerConfig if the key is absent or the file is missing.
 */
export function readCheckerConfig(ctxRoot: string): CheckerConfig {
  const configPath = join(ctxRoot, 'config', 'daemon.json');
  const defaults: CheckerConfig = {
    model: 'gpt-5.6-luna',
    timeoutMs: 8000,
    tokenCap: 200,
  };

  try {
    const { existsSync, readFileSync } = require('fs') as typeof import('fs');
    if (!existsSync(configPath)) return defaults;
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      message_checker?: {
        model?: string;
        timeout_ms?: number;
        token_cap?: number;
      };
    };
    const mc = raw.message_checker;
    if (!mc) return defaults;
    return {
      model: typeof mc.model === 'string' && mc.model ? mc.model : defaults.model,
      timeoutMs: typeof mc.timeout_ms === 'number' ? mc.timeout_ms : defaults.timeoutMs,
      tokenCap: typeof mc.token_cap === 'number' ? mc.token_cap : defaults.tokenCap,
    };
  } catch {
    return defaults;
  }
}
