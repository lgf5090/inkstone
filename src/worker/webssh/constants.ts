export const WEBSSH_API_PREFIX = '/api/webssh'
export const WEBSSH_PAGE_PATH = '/webssh'
export const WEBSSH_REPLAY_PAGE_PREFIX = '/w/'

export const WEBSSH_TICKET_TTL_MS = 60_000

export const WEBSSH_MAX_ACTIVE_SESSIONS_PER_USER = 3

export const WEBSSH_MAX_ACTIVE_SESSIONS_PER_HOST = 1

export const WEBSSH_MAX_FRAME_BYTES = 64 * 1024
export const WEBSSH_MAX_QUEUED_INPUT_BYTES = 1024 * 1024

/** An idle terminal is closed after twenty minutes (plan D-01/R-02). */
export const WEBSSH_IDLE_TIMEOUT_MS = 20 * 60 * 1000

/** `last_activity_at` is persisted at this cadence instead of on every output chunk. */
export const WEBSSH_ACTIVITY_PERSIST_MS = 30_000

/** Output that arrives before `ready` is held briefly rather than dropped (bounded). */
export const WEBSSH_PRE_READY_OUTPUT_LIMIT = 256 * 1024

/** The host form's initial command limit; it is written once after the shell is ready. */
export const WEBSSH_MAX_INITIAL_COMMAND_LENGTH = 4096
