import { useEffect, useState } from 'react'
import { SHARE_PRESENCE_POLL_MS, type PublicSharePresence } from '@shared/share-presence'
import { ApiError, api } from '../../lib/api'

/**
 * The viewer's heartbeat for a show it is following (N-34 / ADR-0006).
 *
 * The poll is the transport by decision, not by default: the presenter's writes are one row and the
 * viewers' reads are conditional, so the whole channel is a row plus a `no-store` answer that can be a
 * 304 (see the ADR's comparison against a Durable Object room, which would mean putting an anonymous
 * socket on the public surface).
 *
 * What the states are for: `stale` is "I cannot hear them right now" and keeps the last page on the
 * wall, because a flicker must not look like the talk broke; `ended` stops asking, since the room being
 * empty is not a question to keep re-asking.
 */
export type AudienceFeedState = 'connecting' | 'live' | 'stale' | 'ended'

export interface AudienceFeed {
  state: AudienceFeedState
  /** The last position actually heard, or null while nothing has been heard (and after the show ended). */
  presence: PublicSharePresence | null
}

/** The backoff ceiling: a viewer left open overnight should ask about the talk, not hammer it. */
const MAX_BACKOFF_MS = SHARE_PRESENCE_POLL_MS * 16

export function useAudiencePresence(slug: string, token: string): AudienceFeed {
  const [feed, setFeed] = useState<AudienceFeed>({ state: 'connecting', presence: null })

  useEffect(() => {
    let cancelled = false
    let timer = 0
    let etag: string | null = null
    let delay = SHARE_PRESENCE_POLL_MS

    const beat = async () => {
      try {
        const presence = await api.presence.read(slug, token, etag ?? undefined, (next) => { etag = next })
        if (cancelled) return
        // A 304 answers `undefined`: nothing moved, so the page already on the wall is the right page
        // and the beat keeps its rate.
        if (presence) setFeed({ state: 'live', presence })
        delay = SHARE_PRESENCE_POLL_MS
      }
      catch (error: unknown) {
        if (cancelled) return
        if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
          // The show is over, the link was revoked, or the token was never this show's. The page itself
          // stays readable — it is the *following* that ends here, out loud.
          setFeed({ state: 'ended', presence: null })
          return
        }
        setFeed((current) => ({ state: 'stale', presence: current.presence }))
        delay = Math.min(delay * 2, MAX_BACKOFF_MS)
      }
      timer = window.setTimeout(beat, delay)
    }

    void beat()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [slug, token])

  return feed
}
