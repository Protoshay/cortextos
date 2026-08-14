export { TelegramAPI } from './api.js';
export { TelegramPoller } from './poller.js';
export {
  logOutboundMessage,
  logInboundMessage,
  recordInboundTelegram,
  cacheLastSent,
  readLastSent,
} from './logging.js';
export { sanitizeFilename, processMediaMessage } from './media.js';
export type { ProcessedMedia } from './media.js';

// Message checker — mandatory pre-send reviewer
export {
  runDeterministicChecks,
  runSemanticCheck,
  validateDeliverableClaim,
  resolveAudience,
  assembleUserContent,
  createOpenAIClient,
  writeCheckerAudit,
  containsBehaviourPromise,
  FALSE_FIXED_REGEX,
  ACCOUNTABILITY_REGEX,
} from './checker.js';
export type {
  CheckerConfig,
  CheckerResult,
  ModelClient,
  CheckerAuditEntry,
  DeterministicResult,
  AudienceProfile,
} from './checker.js';
