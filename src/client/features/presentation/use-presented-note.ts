import { useCallback, useEffect, useRef } from 'react'
import { useDebounced } from '../../lib/hooks'
import { t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { usePresentation } from '../../store/presentation'
import { useUi } from '../../store/ui'
import { presentedNoteContent } from './presentation-state'

// Followed edits land on the projector, but a re-split per keystroke would remount
// the deck under the presenter: one debounce also coalesces a sync burst.
const FOLLOW_DEBOUNCE_MS = 400

type PresentedNoteSource = { open: boolean; noteId: string | null; snapshot: string; following: boolean }

// The follow half of a show, kept together: what is on screen, whether the note behind it is still
// there, and what the toggle is allowed to do about that. The show reads this as one object so the
// three judgements about the note cannot drift apart between the deck, the control and the keys.
export function usePresentedNote({ open, noteId, snapshot, following }: PresentedNoteSource): {
  content: string
  title: string | undefined
  followLost: boolean
  toggleFollowing: () => void
} {
  const presented = usePresentedContent({ open, noteId, snapshot, following })
  useFollowLossAnnouncement(presented.followLost)
  useCapturePresented(open, following, presented.content)
  const toggleFollowing = useCallback(() => {
    // The note is gone, so neither branch of the toggle can reach a screen: the control is disabled
    // and the key that drives it has to agree with it.
    if (presented.followLost) return
    usePresentation.getState().setFollowing(!following)
  }, [following, presented.followLost])
  return { ...presented, toggleFollowing }
}

// A deleted note keeps its last snapshot on the projector — that freeze is intended, and the one
// thing it must not do is go unmentioned: a bright following lamp over a note that no longer exists
// reads as "your edits will reach the screen". Told on the break rather than on every mount, because
// the overlay outlives the shell remounting under it at a breakpoint.
function useFollowLossAnnouncement(followLost: boolean): void {
  const announced = useRef(followLost)
  useEffect(() => {
    if (followLost && !announced.current) {
      useUi.getState().toast({ title: t('workspace.presentation_follow_lost'), tone: 'warning' })
    }
    announced.current = followLost
  }, [followLost])
}

// What the show puts on screen: the note body while following, the frozen copy while
// frozen. The debounce coalesces a burst of keystrokes into a single re-split of the deck,
// and the note id keys it so a show that opens presents the deck the note has now instead
// of replaying what the closed overlay was holding — which was an empty deck, so the slide
// list showed one page until the real deck arrived.
function usePresentedContent({ open, noteId, snapshot, following }: PresentedNoteSource): {
  content: string
  title: string | undefined
  followLost: boolean
} {
  const { content: live, title, exists } = useLiveNote(noteId)
  const debounced = useDebounced(live ?? '', FOLLOW_DEBOUNCE_MS, open ? noteId : null)
  const content = presentedNoteContent({ following, snapshot, live: live === undefined ? undefined : debounced, noteExists: exists })
  return { content, title, followLost: Boolean(noteId) && !exists }
}

// The show reads the note it follows straight from the store instead of taking a copy
// at start, so an edit from another tab, device or MCP write reaches the projector.
function useLiveNote(noteId: string | null) {
  const content = useNotes((s) => (noteId ? s.contents[noteId] : undefined))
  const title = useNotes((s) => (noteId ? s.notes[noteId]?.title : undefined))
  const exists = useNotes((s) => Boolean(noteId && s.notes[noteId]))
  return { content, title, exists }
}

// Following keeps the store's snapshot equal to what is on screen: freezing then
// pins exactly that, and a note that disappears mid-talk still has a last-seen deck
// to fall back to.
function useCapturePresented(open: boolean, following: boolean, presentedContent: string): void {
  useEffect(() => {
    if (open && following) usePresentation.getState().capture(presentedContent)
  }, [open, following, presentedContent])
}
