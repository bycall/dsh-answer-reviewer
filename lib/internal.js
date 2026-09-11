// Internal barrel re-export so callers can `import { ... } from './internal.js'`
// instead of knowing which file each symbol lives in. The public surface
// (index.js) uses this; test fixtures and external tooling can too.

export {
  PLUGIN_NAME,
  MAX_CHALLENGES_HARD_CAP,
  DEFAULT_THRESHOLD,
  MIN_SCORE,
  MAX_SCORE,
  Config,
  resolveConfig,
  extractAssistantText,
  extractUserPrompts,
  latestAssistantMessageId,
  buildReviewPrompt,
  parseScore,
  isScoreAcceptable,
  buildSteerMessage,
  createChallengeCounter,
} from './review.js'

export {
  createConfigStore,
  defaultConfigPath,
  DEFAULT_HTTP_PORT,
  HTTP_PORT_ENV,
  HTTP_ENABLED_ENV,
} from './config-store.js'

export {
  startServer,
  fmtLocalTime,
  REVIEWS_ROUTE_PATH,
  reviewsPayload,
  createReviewsHandler,
} from './server.js'
