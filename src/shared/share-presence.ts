/**
 * The lease on a show the audience is following (ADR-0006).
 *
 * It lives in the shared layer because it is a product rule: the worker expires the presence row with
 * it, the speaker's own copy quotes the same two hours ("this show closes in two hours at the latest"), and a viewer that
 * arrives after it has passed is told the show is over rather than handed the last known page.
 *
 * The lease is refreshed by every position write, so a talk that runs long is not cut off by it — what
 * it really measures is silence from the presenter, which is the one thing the server can tell apart
 * from a closed laptop.
 */
export const SHARE_PRESENCE_TTL_MS = 2 * 60 * 60 * 1000

/**
 * How often a following viewer asks where the show is.
 *
 * Chosen against the read budget the public route enforces (ADR-0006 section 4), not against latency: the
 * shorter this is, the more of the budget a single viewer spends, and the visible cost of a longer one
 * is a page that arrives up to `SHARE_PRESENCE_POLL_MS` late — which is what the 304 path is for.
 */
export const SHARE_PRESENCE_POLL_MS = 2000

/** Where a show is, as the channel carries it: the same three axes the presenter's own session uses. */
export interface SharePresencePosition {
  slide: number
  page: number
  step: number
}

/**
 * How far back the audience count looks (PR-M7).
 *
 * The window has to sit above the backoff ceiling a backgrounded tab falls to (16 polls, so ~32 s), or a
 * room that switched apps for a minute reads as empty; and below the length of a pause in a talk, or a
 * room that left keeps being counted after it went. It counts *browsers that asked*, which is the only
 * thing this channel can know: two people behind one address are one viewer, and nothing here is
 * identified beyond the address the request already carried.
 */
export const SHARE_PRESENCE_AUDIENCE_WINDOW_MS = 60_000

/** What a viewer gets back: the position, when the presenter wrote it, and what is being shown. */
export interface PublicSharePresence extends SharePresencePosition {
  updatedAt: number
  title: string
}

/** What starting a show hands back. The token appears in this response exactly once — after that the
 * server holds only its hash, and a speaker who loses the link has to start a new show. */
export interface SharePresenceSession extends SharePresencePosition {
  slug: string
  token: string
  expiresAt: number
}
