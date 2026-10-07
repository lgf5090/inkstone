import { useCallback, useEffect, useRef, useState } from 'react'
import type { SharePresencePosition, SharePresenceSession } from '@shared/share-presence'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'

/** How often a running show asks its own server who is still listening. */
const AUDIENCE_STATUS_POLL_MS = 15_000

/**
 * The presenter's side of an audience following along (N-34 / ADR-0006).
 *
 * One press asks the server for a show, hands out the link it mints, and every turn of the talk reports
 * where the show is. Everything here is per-show local state: a following audience belongs to the talk
 * that is happening, not to the account, and it must not survive the show — a link still answering an
 * hour after the room emptied is a leak, and the only thing standing between the two is this hook
 * stopping it.
 */
export interface AudienceFollow {
  /** A show is running, so the control says "stop" rather than "let them follow". */
  on: boolean
  /** The link the audience opens, or null while no show is running. */
  link: string | null
  /** How many browsers have been reading the show lately (PR-M7), as last heard by this client. */
  viewers: number
  toggle: () => void
}

export function useAudienceFollow(options: {
  open: boolean
  noteId: string | null
  position: SharePresencePosition
}): AudienceFollow {
  const { open, noteId, position } = options
  const [session, setSession] = useState<SharePresenceSession | null>(null)
  const [viewers, setViewers] = useState(0)
  // Where the last report landed. The position arrives as a fresh object on every render of the show,
  // so the comparison that decides "did the talk move" is taken over its values.
  const reported = useRef('')
  const where = `${position.slide}/${position.page}/${position.step}`

  const end = useCallback((note: string) => {
    setSession(null)
    setViewers(0)
    void api.presence.stop(note).catch(() => {
      // Best-effort: this side has already ended the show and cleared its own control. The server's
      // lease is what takes the row down if the request itself never arrives.
    })
  }, [])

  const toggle = useCallback(() => {
    if (!noteId) return
    if (session) end(noteId)
    else void startAudienceShow(noteId, setSession)
  }, [noteId, session, end])

  useEffect(() => {
    if (!session || !noteId || reported.current === where) return
    reported.current = where
    // The answer to a page turn already carries the room: the presenter learns who showed up without
    // asking a second question for it.
    void api.presence.publish(noteId, position).then((answer) => {
      setViewers(answer?.viewers ?? 0)
    }).catch(() => {
      // A position the server will not take means the show is over there even if it is still on screen
      // here: the lease lapsed, the link was revoked, or the share itself went away. Ending it out loud
      // is the alternative to a control that keeps claiming an audience that already left.
      setSession(null)
      useUi.getState().toast({ title: t('workspace.presentation_audience_lost'), tone: 'danger' })
    })
  }, [session, noteId, where, position])

  // A talk has pauses, and a pause is exactly when the speaker looks up to see whether the room is still
  // there. The page turn carries the number for free; this is the beat for the minutes in between, and
  // it stops with the show because a room that is gone has nothing left to count.
  useEffect(() => {
    if (!session || !noteId) return
    const id = window.setInterval(() => {
      void api.presence.status(noteId).then((answer) => setViewers(answer.viewers)).catch(() => {
        // A number that could not be asked for is not a reason to change the one on the screen.
      })
    }, AUDIENCE_STATUS_POLL_MS)
    return () => window.clearInterval(id)
  }, [session, noteId])

  // Where the show is, kept off the render inputs: stopping the store's `stop()` clears `noteId` in the
  // same commit that closes the show, so an effect that reads `noteId` back to decide whether an
  // audience is still running would never see one. This ref is the last thing that still knows.
  const live = useRef<{ noteId: string, end: (note: string) => void } | null>(null)

  // Leaving the show — by the exit button, by Escape, or by the tab being closed around it — ends the
  // audience with it. Declared above the assignment below on purpose: an effect that runs after it would
  // already have emptied the ref of the show that just ended.
  useEffect(() => {
    if (open) return
    const running = live.current
    live.current = null
    if (running) running.end(running.noteId)
  }, [open])

  // The other half: a show that closes because the overlay leaves the tree never gets a render in which
  // `open` went false — an unmount runs cleanups and nothing else. Without this the row lives out its
  // whole lease and the viewer keeps reading "following this show" over a talk that ended minutes ago,
  // with the note's title and last page still served to it.
  useEffect(() => () => {
    const running = live.current
    live.current = null
    if (running) running.end(running.noteId)
  }, [])

  useEffect(() => {
    live.current = session && noteId ? { noteId, end } : null
  })

  // A note that was deleted takes its share, and therefore this show, down with it.
  useEffect(() => {
    if (!noteId) setSession(null)
  }, [noteId])

  return { on: Boolean(session), link: session ? audienceLink(session) : null, viewers, toggle }
}

/**
 * Ask for a show and put its link in the presenter's hands. The clipboard is the delivery, but a
 * clipboard that refuses has to hand the text over on screen rather than report a success nobody can use.
 */
async function startAudienceShow(noteId: string, onStarted: (session: SharePresenceSession) => void): Promise<void> {
  let started: SharePresenceSession
  try {
    started = await api.presence.start(noteId)
  }
  catch {
    useUi.getState().toast({ title: t('workspace.presentation_audience_failed'), tone: 'danger' })
    return
  }
  onStarted(started)
  const link = audienceLink(started)
  try {
    await navigator.clipboard.writeText(link)
    useUi.getState().toast({ title: t('workspace.presentation_audience_started'), tone: 'success' })
  }
  catch {
    useUi.getState().toast({ title: t('workspace.presentation_audience_link', { value0: link }), tone: 'warning' })
  }
}

function audienceLink(session: SharePresenceSession): string {
  return `${window.location.origin}/s/${session.slug}?present=${encodeURIComponent(session.token)}`
}
