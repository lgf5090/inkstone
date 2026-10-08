import { useCallback, useEffect } from 'react'
import { decodeDataValue } from '../../lib/markdown/data-attr'
import { parseWikiTarget } from '../../lib/markdown/renderer'
import { findNoteByTitle, noteById, useNotes } from '../../store/notes'
import { linkCardTitle, linkPreviewFromElement, type OwnNote } from './link-preview'
import { findTagPage } from '../tags/tagMutations'
import { useSession } from '../../store/session'
import { usePinnedWindows } from '../../store/pinned-windows'
import { withPinnedWindowSize } from '../../lib/pinned-window-size'
import { useLinkHover } from './link-hover'
import { useLinkEditor } from '../links/store'
import type { WikiLinkHoverCardState } from '../../types/hover-card'

/** The note a copied direct link of this deployment points at, when it points at one the reader can open. */
function ownNoteOf(href: string): OwnNote | null {
  if (!/^https?:\/\//i.test(href)) return null;
  try {
    const parsed = new URL(href);
    if (parsed.origin !== window.location.origin) return null;
    const match = /^\/n\/([A-Za-z0-9_-]{1,64})(?:[/?#]|$)/.exec(parsed.pathname);
    if (!match) return null;
    const note = noteById(match[1]!);
    return note && !note.deletedAt ? { title: note.title, id: note.id } : null;
  }
  catch {
    return null;
  }
}

export function resolveHoverCandidate(
  link: HTMLElement,
  sourceNoteId: string | null,
  linksEnabled = true,
): WikiLinkHoverCardState | null {
  if (linksEnabled) {
    const preview = linkPreviewFromElement(link, ownNoteOf);
    if (preview) {
      return {
        anchor: link,
        title: linkCardTitle(preview),
        noteId: null,
        missing: false,
        link: preview,
      };
    }
  }
  // A hashtag only previews anything when the user gave that tag a page; the alternative is a
  // card that duplicates the note the reader is already looking at.
  if (link.dataset.tag !== undefined && link.dataset.wikilink === undefined) {
    const page = findTagPage(decodeDataValue(link.dataset.tag))
    if (!page) return null
    return { anchor: link, title: page.title, noteId: page.id, missing: false, headline: page.title }
  }
  // The branch below is for `[[#heading]]`, which carries its target in the same datum: an element
  // without one is not a wiki link at all, and the card it would produce is a copy of the note the
  // reader is already looking at.
  if (link.dataset.wikilink === undefined) return null
  const parsed = parseWikiTarget(decodeDataValue(link.dataset.wikilink))
  const notes = useNotes.getState().notes
  if (parsed.noteTitle) {
    const note = findNoteByTitle(parsed.noteTitle)
    if (note)
      return { anchor: link, title: parsed.alias ?? note.title, noteId: note.id, missing: false, headline: parsed.heading ?? note.title }
    return { anchor: link, title: parsed.alias ?? parsed.noteTitle, noteId: null, missing: true, headline: parsed.heading ?? parsed.noteTitle }
  }
  const summary = sourceNoteId ? notes[sourceNoteId] : undefined
  if (!summary) return null
  return { anchor: link, title: parsed.alias ?? summary.title, noteId: sourceNoteId, missing: false, headline: parsed.heading ?? summary.title }
}

export function useLinkHoverHost(sourceNoteId: string | null) {
  const preview = useSession((s) => s.settings.preview)
  // The link editor and a preview card are two panels over the same span, and the card wins the race
  // by 320ms; while the reader is editing a link there is nothing left to preview about it.
  const editing = useLinkEditor((s) => s.request !== null)
  const resolve = useCallback(
    (link: HTMLElement) => resolveHoverCandidate(link, sourceNoteId, preview.linkHoverLinks),
    [sourceNoteId, preview.linkHoverLinks],
  )
  const hover = useLinkHover({
    resolve,
    delay: preview.linkHoverDelayMs,
    enabled: preview.linkHover && !editing,
    armOnNonLink: true,
  })
  const handlePin = useCallback((card: WikiLinkHoverCardState, rect: DOMRect) => {
    usePinnedWindows.getState().pin(card, withPinnedWindowSize(rect))
    hover.hideNow()
  }, [hover.hideNow])

  useEffect(() => {
    const onScroll = (event: Event) => {
      const target = event.target as Element | null
      if (target && typeof target.closest === 'function' && target.closest('[role="tooltip"]')) return
      hover.hideNow()
    }
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [hover.hideNow])

  const onMouseLeave = useCallback(() => hover.handleMouseLeave(), [hover.handleMouseLeave])

  const onFocus = useCallback((event: React.FocusEvent) => {
    // Rendered links are real anchors, so the keyboard reaches them the same way it reaches a
    // wiki link or a hashtag, and tabbing to one should preview it just as hovering does.
    const link = (event.target as HTMLElement).closest<HTMLElement>('[data-wikilink], [data-tag], a[href]')
    if (!link) return
    hover.propose(link, { immediate: true })
  }, [hover.propose])

  const onBlur = useCallback((event: React.FocusEvent) => {
    const related = event.relatedTarget as Element | null
    if (related && typeof related.closest === 'function' && related.closest('[role="tooltip"]')) {
      hover.clearPendingHide()
      return
    }
    hover.armHide(0)
  }, [hover.clearPendingHide, hover.armHide])

  return { hover, handlePin, onMouseLeave, onFocus, onBlur }
}
