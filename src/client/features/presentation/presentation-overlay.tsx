import { useCallback, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { usePresentation } from '../../store/presentation'
import { DeckHandoutSheet, DeckImageSheet, DeckPrintSheet } from './deck-print'
import { DeckExportProgress, PresentationControls, PresentationExitConfirm, SlideProgress, type PresentationControlsProps } from './presentation-controls'
import { PresentationKeyGuide } from './presentation-key-guide'
import { CoverAnnouncement, PresentationStage, ScreenCover, SlidePreparationNotice, stageProps } from './presentation-stage'
import { LaserPointer, Spotlight } from './presentation-pointer'
import { SlidePreflight } from './slide-preflight'
import { SlideOverviewGrid } from './slide-overview-grid'
import { SlideRail } from './slide-rail'
import { PresenterPanel } from './presenter-view/presenter-panel'
import { buildAudienceItems, buildPresentationOverflowItems, extractLinkHref, PresentationContextMenu, type PresentationContextMenuProps, type PresentationMenuItemsOptions } from './presentation-context-menu'
import { type PresentationSession, usePresentationSession } from './use-presentation-session'

// The show reads its own store, which the shell hosts: that is what keeps a talk
// alive across the layout switch that unmounts the workspace it started from.
export function PresentationOverlay() {
  const open = usePresentation((s) => s.open)
  const noteId = usePresentation((s) => s.noteId)
  const snapshot = usePresentation((s) => s.snapshot)
  const following = usePresentation((s) => s.following)
  const storedTitle = usePresentation((s) => s.title)
  const initialSlideIndex = usePresentation((s) => s.initialSlideIndex)
  const startedAt = usePresentation((s) => s.startedAt)
  const onClose = usePresentation((s) => s.stop)
  const panelRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const session = usePresentationSession({ open, noteId, snapshot, following, storedTitle, panelRef, stageRef, onClose, initialSlideIndex, startedAt })

  if (!open) return null

  return createPortal(<PresentationDialog panelRef={panelRef} stageRef={stageRef} session={session} />, document.body)
}

// The slide surface itself: the list, the canvas, the controls and the overview are one dialog so
// the focus trap, the idle fade and the portal all belong to a single element.
function PresentationDialog({ panelRef, stageRef, session }: {
  panelRef: RefObject<HTMLDivElement | null>
  stageRef: RefObject<HTMLDivElement | null>
  session: PresentationSession
}) {
  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    if (session.screenCover) return
    const target = event.target as Element | null
    const anchorEl = target?.closest<HTMLAnchorElement>('a[href]')
    const linkUrl = extractLinkHref(anchorEl)
    session.openContextMenu({ x: event.clientX, y: event.clientY }, linkUrl)
  }, [session])

  return (
    <>
      <div
        ref={panelRef}
        tabIndex={-1}
        role='dialog'
        data-slide-list-complete={session.listProgress.finished ? 'true' : 'false'}
        // Rasterizing a deck takes a beat per page, and the export says nothing until it lands: the
        // busy state is what tells a screen reader that the deck is being written out.
        aria-busy={session.images ? 'true' : undefined}
        aria-modal='true'
        aria-label={t('workspace.presentation_mode')}
        data-surface='presentation'
        onContextMenu={handleContextMenu}
        className={cn('anim-fade fixed inset-0 z-[var(--z-modal)] flex overflow-hidden bg-[var(--bg-base)] outline-none', session.laser && 'cursor-none')}
      >
        {session.railOpen && <SlideRail {...slideSurfaceProps(session)} title={session.noteTitle} progress={session.listProgress} chromeHidden={session.chromeHidden} occluded={session.occluded} />}
        <PresentationStage {...stageProps(stageRef, session)} />
        {session.presenterPanel && <PresenterPanel state={session.presenterPanel} chromeHidden={session.chromeHidden} occluded={session.occluded} onClose={session.closePresenterPanel} />}
        <PresentationControls {...controlProps(session, session.requestClose)} />
        <SlideProgress page={session.page} pageTotal={session.pageTotal} />
        {session.overview && <SlideOverviewGrid {...slideSurfaceProps(session)} onClose={session.clearOverview} />}
        {/* Painted over the grid rather than beside it, and put away before it by the same Esc: the
            card is the topmost layer of the projector whenever it is up. */}
        <PresentationKeyGuide open={session.keyGuide} onClose={session.clearKeyGuide} />
        {session.screenCover && <ScreenCover cover={session.screenCover} onClear={session.clearCover} />}
        <CoverAnnouncement cover={session.screenCover} />
        <SlidePreparationNotice failed={session.slideUnprepared} />
        <Spotlight active={session.spotlight} />
        {/* Inside the dialog rather than beside it: the panel owns the paint stack, and a pointer
            drawn outside it would sit under the very slide it is meant to point at. */}
        {session.imageProgress && <DeckExportProgress current={session.imageProgress.current} total={session.imageProgress.total} />}
        <LaserPointer active={session.laser} />
        <PresentationContextMenu {...contextMenuProps(panelRef, session, session.requestClose)} />
        {/* Inside the dialog for the same reason the cover and the card are: a confirm portalled to
            the body would sit under the fullscreen element it is asking about. */}
        <PresentationExitConfirm open={session.exitAsked} onConfirm={session.closeNow} onCancel={session.keepPresenting} />
      </div>
      <PresentationSheets session={session} />
    </>
  )
}

function PresentationSheets({ session }: { session: PresentationSession }) {
  return (
    <>
      {/* The whole deck is measured off-screen while the show is open, so the slide
          list lists every page from the start instead of only the slides visited. */}
      <SlidePreflight {...session.preflight} />
      {session.print && (
        <DeckPrintSheet pages={session.print.pages} metrics={session.print.metrics} font={session.proseFont} dark={session.print.dark} onDone={session.print.done} />
      )}
      {session.handout && (
        <DeckHandoutSheet pages={session.handout.pages} notes={session.handout.notes} metrics={session.handout.metrics} font={session.proseFont} dark={session.handout.dark} onDone={session.handout.done} />
      )}
      {session.images && (
        <DeckImageSheet pages={session.images.pages} metrics={session.images.metrics} font={session.proseFont} dark={session.images.dark} title={session.images.title} onProgress={session.images.onProgress} onDone={session.images.done} />
      )}
    </>
  )
}

// The page list and the overview grid draw the same thing — every page of the deck, at a scale —
// so they read the deck, the plans and the design canvas from one mapper. Both surfaces are fed by
// the session's flat props for the same reason the controls are: the dialog's markup stays about
// the slide surface rather than about plumbing.
function slideSurfaceProps(session: PresentationSession) {
  return {
    deck: session.deck,
    cacheKeys: session.cacheKeys,
    plans: session.plans,
    index: session.index,
    sub: session.sub,
    designWidth: session.metrics.designWidth,
    designHeight: session.metrics.designHeight,
    proseFont: session.proseFont,
    onSelectPage: session.jumpToPage,
  }
}

// The controls read the session's position and toggles as flat props, so mapping them in
// one place keeps the dialog's markup about the slide surface rather than about plumbing.
function controlProps(session: PresentationSession, onClose: () => void): PresentationControlsProps {
  return {
    slideIndex: session.index,
    slideCount: session.deck.length,
    subPage: session.sub,
    pageCount: session.pageCount,
    step: session.step,
    steps: session.steps,
    isFullscreen: session.isFullscreen,
    railOpen: session.railOpen,
    overview: session.overview,
    following: session.following,
    followLost: session.followLost,
    chromeHidden: session.chromeHidden,
    occluded: session.occluded,
    compact: session.compact,
    // The door reads the same rows as the right-click menu, plus the groups that answer to no key.
    overflowItems: [...buildPresentationOverflowItems(menuItemsProps(session, onClose)), ...buildAudienceItems(menuItemsProps(session, onClose))],
    exporting: Boolean(session.images),
    onPrev: session.goPrev,
    onNext: session.goNext,
    onToggleRail: session.toggleRail,
    onToggleOverview: session.toggleOverview,
    onToggleFollowing: session.toggleFollowing,
    onToggleFullscreen: session.toggleFullscreen,
    onOpenPresenter: session.openPresenter,
    audienceFollowing: session.audienceFollowing,
    onToggleAudience: session.toggleAudience,
    onExport: session.exportDeck,
    onExportHandout: session.exportHandout,
    onExportHtml: session.exportHtml,
    onExportImages: session.exportImages,
    onClose,
  }
}

/**
 * The show's rows, built once: the right-click menu and the capsule's narrow-screen door read the same
 * list, so a phone does not get a quieter second map of the same screen.
 */
function menuItemsProps(session: PresentationSession, onClose: () => void): PresentationMenuItemsOptions {
  return {
    linkUrl: null,
    slideIndex: session.index,
    slideCount: session.deck.length,
    subPage: session.sub,
    pageCount: session.pageCount,
    step: session.step,
    steps: session.steps,
    railOpen: session.railOpen,
    overview: session.overview,
    following: session.following,
    followLost: session.followLost,
    isFullscreen: session.isFullscreen,
    laser: session.laser,
    spotlight: session.spotlight,
    screenCover: session.screenCover,
    keyGuide: session.keyGuide,
    onPrev: session.goPrev,
    onNext: session.goNext,
    onToggleRail: session.toggleRail,
    onToggleOverview: session.toggleOverview,
    onToggleFollowing: session.toggleFollowing,
    onToggleFullscreen: session.toggleFullscreen,
    onOpenPresenter: session.openPresenter,
    audienceFollowing: session.audienceFollowing,
    onToggleAudience: session.toggleAudience,
    onToggleKeyGuide: session.toggleKeyGuide,
    onToggleLaser: session.toggleLaser,
    onToggleSpotlight: session.toggleSpotlight,
    onToggleBlackout: session.toggleBlackout,
    onToggleWhiteout: session.toggleWhiteout,
    onExit: onClose,
  }
}

function contextMenuProps(panelRef: RefObject<HTMLDivElement | null>, session: PresentationSession, onClose: () => void): PresentationContextMenuProps {
  return {
    ...menuItemsProps(session, onClose),
    // The menu's own wiring wins over the shared rows: the link under the pointer is what this list is
    // about, and where it opened is where the panel lands.
    linkUrl: session.contextLink,
    point: session.contextPoint,
    onClose: session.closeContextMenu,
    onReopen: (point, linkUrl) => session.openContextMenu(point, linkUrl),
    container: panelRef.current,
  }
}

