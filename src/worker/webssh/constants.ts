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

/** Session recordings are opt-in per account and expire thirty days after they start. */
export const WEBSSH_RECORDING_RETENTION_DAYS = 30
export const WEBSSH_RECORDING_RETENTION_MS = WEBSSH_RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000

/**
 * One cast event is split at this many UTF-16 code units so a single NDJSON line stays well inside a
 * replay slice; concatenating the decoded events still yields the original byte stream.
 */
export const WEBSSH_RECORDING_EVENT_CHARS = 4096

/**
 * R2 multipart parts must be at least 5 MiB except the last one. The recorder only switches from a
 * single `put` to multipart once the buffered cast crosses this bound.
 */
export const WEBSSH_RECORDING_PART_BYTES = 5 * 1024 * 1024

/** Replay slices are byte-addressed and bounded so one request never reads a whole recording. */
export const WEBSSH_RECORDING_SLICE_DEFAULT_BYTES = 64 * 1024
export const WEBSSH_RECORDING_SLICE_MAX_BYTES = 512 * 1024

/** How many expired recordings one retention fire processes. */
export const WEBSSH_RECORDING_PURGE_BATCH = 100
