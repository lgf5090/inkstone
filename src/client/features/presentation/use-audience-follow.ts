import { useCallback, useEffect, useRef, useState } from 'react'
import type { SharePresencePosition, SharePresenceSession } from '@shared/share-presence'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'

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
  toggle: () => void
}

export function useAudienceFollow(options: {
  open: boolean
  noteId: string | null
  position: SharePresencePosition
}): AudienceFollow {
  const { open, noteId, position } = options
  const [session, setSession] = useState<SharePresenceSession | null>(null)
  // Where the last report landed. The position arrives as a fresh object on every render of the show,
  // so the comparison that decides "did the talk move" is taken over its values.
  const reported = useRef('')
  const where = `${position.slide}/${position.page}/${position.step}`

  const end = useCallback((note: string) => {
    setSession(null)
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
    void api.presence.publish(noteId, position).catch(() => {
      // A position the server will not take means the show is over there even if it is still on screen
      // here: the lease lapsed, the link was revoked, or the share itself went away. Ending it out loud
      // is the alternative to a control that keeps claiming an audience that already left.
      setSession(null)
      useUi.getState().toast({ title: t('workspace.presentation_audience_lost'), tone: 'danger' })
    })
  }, [session, noteId, where, position])

  // Leaving the show — by the exit button, by Escape, or by the tab being closed around it — ends the
  // audience with it.
  useEffect(() => {
    if (!open && session && noteId) end(noteId)
  }, [open, session, noteId, end])

  // That effect only runs on a *render* in which `open` went false, and a show that closes because the
  // overlay leaves the tree never gets that render: an unmount runs cleanups and nothing else. Without
  // this half the row lives out its whole lease and the viewer keeps reading "following this show"
  // over a talk that ended minutes ago, with the note's title and last page still served to it.
  const live = useRef<{ noteId: string, end: (note: string) => void } | null>(null)
  useEffect(() => {
    live.current = session && noteId ? { noteId, end } : null
  })
  useEffect(() => () => {
    const running = live.current
    live.current = null
    if (running) running.end(running.noteId)
  }, [])

  // A note that was deleted takes its share, and therefore this show, down with it.
  useEffect(() => {
    if (!noteId) setSession(null)
  }, [noteId])

  return { on: Boolean(session), link: session ? audienceLink(session) : null, toggle }
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
