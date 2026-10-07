import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ProseFont } from '@shared/types'
import { useBreakpoint } from '../../lib/hooks'
import { randomLocalId } from '../../lib/random-id'
import { t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { type DeckHandoutPayload, type DeckSheetPayload, useDeckExport } from './deck-export'
import type { DeckExportProgress } from './deck-print'
import { backwardMove, clampSlideIndex, deckProgress, exitAsk, forwardMove, railOpenFor } from './presentation-state'
import { useChromeAutoHide } from './use-chrome-auto-hide'
import { useAudienceFollow } from './use-audience-follow'
import { useDialogBehavior } from './use-dialog-behavior'
import { useIsDarkTheme } from './presentation-theme'
import { releaseSlideCache, slideSettingFlags } from './slide-html'
import { planPageSteps, type SlidePlan } from './slide-pagination'
import { useSlidePlans } from './use-slide-plans'
import { type PreflightProgress, type SlidePreflightProps } from './slide-preflight'
import { type StageMetrics, useStageMetrics } from './slide-stage'
import { useShowDeck, useSlideCacheKeys } from './use-show-deck'
import { openPresenterWindow, usePresenterBroadcaster, usePresenterSlideState, type PresenterSlideState, type PresenterStateSource } from './presenter-view/use-presenter-channel'
import { usePresentedNote } from './use-presented-note'
import { usePresentationKeys } from './use-presentation-keys'
import { useFullscreenToggle } from './use-fullscreen-toggle'
import { useSlideHtml } from './use-slide-html'

// Everything the show holds that is not markup: which note is on screen, how it splits, where the
// presenter is in it, and which mode (fullscreen, slide list, overview, laser, cover) is on. It is
// one hook because those pieces are one state machine — a page plan changes the list, the list
// drives the counter, and the counter is what the keys walk — and it is a separate module because
// the dialog reads it as a single object rather than as seventeen arguments.
/** What a show is asked to present: the note (or its frozen copy) and the two elements it drives. */
export interface PresentationSessionOptions {
  open: boolean
  noteId: string | null
  snapshot: string
  following: boolean
  storedTitle: string
  panelRef: RefObject<HTMLDivElement | null>
  stageRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  initialSlideIndex?: number
  startedAt: number
}

export interface PresentationSession {
  deck: string[]
  cacheKeys: string[]
  index: number
  sub: number
  pageCount: number
  /** Which page of the whole show this is, counted over the pages every slide measures. */
  page: number
  /** How many pages the show has — the same list the slide rail walks and the grid roams. */
  pageTotal: number
  railOpen: boolean
  following: boolean
  /** True once the note behind the show is gone: the deck holds its last snapshot and nothing follows. */
  followLost: boolean
  chromeHidden: boolean
  isFullscreen: boolean
  metrics: StageMetrics
  proseFont: ProseFont
  noteTitle: string
  /** Page layout measured per slide, the slide list's page list and the counter's totals. */
  plans: Record<number, SlidePlan>
  handlePlan: (plan: SlidePlan) => void
  goNext: () => void
  goPrev: () => void
  jumpTo: (index: number) => void
  jumpToPage: (index: number, sub: number) => void
  toggleFullscreen: () => void
  toggleRail: () => void
  toggleFollowing: () => void
  /** The page on screen could not be enhanced: readable text, placeholders where its diagrams should be. */
  slideUnprepared: boolean
  /** How far the idle pass has got in listing the pages the deck has not shown yet. */
  listProgress: PreflightProgress
  /** Builds the printable deck; the sheet appears until the print dialog is done with it. */
  exportDeck: () => void
  print: DeckSheetPayload | null
  exportHandout: () => void
  handout: DeckHandoutPayload | null
  /** Writes the deck as one HTML file that plays on its own, and saves it (N-33). */
  exportHtml: () => void
  /** Builds the same deck as images; the sheet appears until the PNGs are saved. */
  exportImages: () => void
  images: (DeckSheetPayload & { title: string; onProgress: (progress: DeckExportProgress) => void }) | null
  /** Which page of the deck the running image export has written, or null while nothing is being written. */
  imageProgress: DeckExportProgress | null
  /** Everything the idle deck-measuring pass needs, grouped so the dialog can spread it. */
  /** Everything the idle deck-measuring pass needs, grouped so the dialog can spread it. */
  preflight: SlidePreflightProps
  /**
   * Asking to leave. With an audience following this show it does not close the show — it asks first
   * (PR-L3), because a keystroke that strands a room is not a keystroke anyone meant to press.
   */
  requestClose: () => void
  /** The ask is on screen. */
  exitAsked: boolean
  /** The answer that ends it: the show goes, and the audience link with it. */
  closeNow: () => void
  /** The answer that keeps it: the question goes away and nothing else moves. */
  keepPresenting: () => void
  screenCover: 'black' | 'white' | null
  clearCover: () => void
  toggleBlackout: () => void
  toggleWhiteout: () => void
  /** Whether charts on the projector arrive already drawn, per the account's own setting. */
  instantCharts: boolean
  /** Whether the show is drawing its own pointer. */
  laser: boolean
  clearLaser: () => void
  toggleLaser: () => void
  spotlight: boolean
  clearSpotlight: () => void
  toggleSpotlight: () => void
  /** An audience is following this show, and the link is out there (N-34). */
  audienceFollowing: boolean
  /** Starts or ends that — the link is handed to the presenter's clipboard on the way in. */
  toggleAudience: () => void
  /** Whether the whole deck is laid out on top of the slide surface. */
  overview: boolean
  clearOverview: () => void
  toggleOverview: () => void
  /** How far into the page on screen the show has walked (N-31). */
  step: number
  /** How many reveals that page holds — zero when it has nothing to arrive in stages. */
  steps: number
  /** Whether the show's own key card is lying over the projector. */
  keyGuide: boolean
  clearKeyGuide: () => void
  toggleKeyGuide: () => void
  /** Whether the layers under the grid are out of reach: focus, clicks and Tab all stop at it. */
  occluded: boolean
  /** A phone window: the capsule has no room for eleven controls, so the bar offers one door instead. */
  compact: boolean
  openPresenter: () => void
  /** The console hosted inside the show, for the speaker whose browser blocked the presenter window. */
  presenterPanel: PresenterSlideState | null
  closePresenterPanel: () => void
  notes: string[]
  contextPoint: { x: number; y: number } | null
  contextLink: string | null
  openContextMenu: (point: { x: number; y: number }, linkUrl?: string | null) => void
  closeContextMenu: () => void
}

// The presenter console is a second window, and a browser that will not open one says nothing to the
// page that asked: `window.open` simply returns null. The panel this show can host itself is what the
// speaker gets instead, and the toast is what tells them the window they pressed for is not coming.
function usePresenterFallback(open: boolean) {
  const [panelOpen, setPanelOpen] = useState(false)
  const openPanel = useCallback(() => {
    setPanelOpen(true)
    useUi.getState().toast({ title: t('workspace.presentation_popup_blocked'), tone: 'warning' })
  }, [])
  const closePanel = useCallback(() => setPanelOpen(false), [])
  useEffect(() => {
    if (!open) setPanelOpen(false)
  }, [open])
  return { panelOpen, openPanel, closePanel }
}

// A show that has ended is not going to draw those pages again, and a prepared page carries its whole
// inline picture, so the markup is given back on the way out rather than held until the next talk
// evicts it — which may never happen.
function useReleasePreparedPages(open: boolean): void {
  useEffect(() => {
    if (open) return
    releaseSlideCache()
  }, [open])
}

function useSessionPresenter(options: {
  open: boolean
  noteTitle: string
  nav: ReturnType<typeof usePresentationNav>
  deck: string[]
  notes: string[]
  proseFont?: ProseFont
  startedAt: number
}) {
  const { open, noteTitle, nav, deck, notes, proseFont, startedAt } = options
  // Minted per click rather than per show: the token reaches the presenter window through its route, so
  // a document that never went through this button — a hand-typed `?presenter=1`, another tab — has no
  // channel name to speak on, and cannot ask for the speaker notes or move the projector.
  const [presenterToken, setPresenterToken] = useState<string | null>(null)
  const fallback = usePresenterFallback(open)
  const openPresenter = useCallback(() => {
    const token = randomLocalId()
    setPresenterToken(token)
    if (!openPresenterWindow(token)) fallback.openPanel()
  }, [fallback.openPanel])
  const source: PresenterStateSource = {
    noteTitle,
    slideIndex: nav.index,
    subPage: nav.sub,
    step: nav.step,
    slideCount: deck.length,
    pageCount: nav.pageCount,
    deck,
    notes,
    plans: nav.plans,
    startedAt,
    proseFont,
  }
  const presenterState = usePresenterSlideState(source)
  usePresenterBroadcaster({ ...source, open, token: presenterToken, goNext: nav.goNext, goPrev: nav.goPrev, jumpTo: nav.jumpTo })
  const presenterPanel: PresenterSlideState | null = fallback.panelOpen ? presenterState : null
  return { openPresenter, presenterPanel, closePresenterPanel: fallback.closePanel }
}

export function usePresentationSession(options: PresentationSessionOptions): PresentationSession {
  const { open, noteId, snapshot, following, storedTitle, panelRef, stageRef, onClose, initialSlideIndex = 0, startedAt } = options
  const { content: presentedContent, title: liveTitle, followLost, toggleFollowing } = usePresentedNote({ open, noteId, snapshot, following })
  const { deck, notes, hashes, fingerprint } = useShowDeck(presentedContent)
  const { dark, flags, proseFont, slideList, chartAnimation, autoHideChrome } = useShowSettings()
  const nav = usePresentationNav(deck, hashes, initialSlideIndex)
  const { isFullscreen, toggleFullscreen, metrics, chromeHidden } = useShowStage({ open, panelRef, stageRef, autoHideChrome })
  const { railOpen, toggleRail, compact } = useShowRoom(open, slideList)
  const noteTitle = liveTitle ?? storedTitle
  const cacheKeys = useSlideCacheKeys(hashes, dark, metrics)
  const exports = useDeckExport({ deck, cacheKeys, plans: nav.plans, metrics, flags, dark, title: noteTitle, notes, proseFont })
  const { listProgress, onProgress } = useListProgress()
  const presenter = useSessionPresenter({ open, noteTitle, nav, deck, notes, proseFont, startedAt })
  const audience = useSessionAudience(open, noteId, nav)
  const [exitAsked, setExitAsked] = useState(false)
  // A show with a room following it ends on a second, deliberate press: the link is out there, and
  // the presenter is the only one who knows whether leaving was the plan.
  const requestClose = useCallback(() => {
    if (exitAsk({ audienceFollowing: audience.audienceFollowing }) === 'ask') setExitAsked(true)
    else onClose()
  }, [audience.audienceFollowing, onClose])
  const keepPresenting = useCallback(() => setExitAsked(false), [])
  // The question belongs to the show it asks about: whatever closes the talk puts it away, so a reopened
  // show never opens on an answer the presenter already gave.
  useEffect(() => {
    if (!open) setExitAsked(false)
  }, [open])
  const contextMenu = usePresentationContextMenu(open)
  const mode = usePresentationKeys({ open, slideCount: deck.length, goNext: nav.goNext, goPrev: nav.goPrev, jumpTo: nav.jumpTo, toggleFullscreen, toggleRail, toggleFollowing, openPresenter: presenter.openPresenter, isMenuOpen: Boolean(contextMenu.contextPoint) })
  useDialogBehavior({ open, panelRef, isFullscreen, toggleFullscreen, onClose: requestClose, laserOn: mode.laser, clearLaser: mode.clearLaser, overviewOn: mode.overview, clearOverview: mode.clearOverview, spotlightOn: mode.spotlight, clearSpotlight: mode.clearSpotlight, keyGuideOn: mode.keyGuide, clearKeyGuide: mode.clearKeyGuide, exitConfirmOn: exitAsked, clearExitConfirm: keepPresenting })
  const slideUnprepared = useSlideHtml({ open, deck, hashes, index: nav.index, content: presentedContent, noteTitle, dark, metrics })
  useReleasePreparedPages(open)
  // The union of the pieces above, spread rather than unpacked key by key; explicit is only what this
  // file decides — `nav` is the position, `mode` what the keys own, `exports` what the controls ask for.
  return {
    deck,
    notes,
    cacheKeys,
    railOpen,
    compact,
    ...deckProgress({ deckLength: deck.length, plans: nav.plans, index: nav.index, sub: nav.sub }),
    following,
    followLost,
    chromeHidden,
    isFullscreen,
    metrics,
    proseFont,
    instantCharts: !chartAnimation,
    noteTitle,
    listProgress,
    slideUnprepared,
    toggleFullscreen,
    toggleRail,
    toggleFollowing,
    ...presenter,
    occluded: mode.overview || Boolean(mode.screenCover) || Boolean(contextMenu.contextPoint) || exitAsked,
    requestClose,
    exitAsked,
    closeNow: onClose,
    keepPresenting,
    ...nav,
    ...audience,
    ...mode,
    ...exports,
    ...contextMenu,
    preflight: { deck, hashes, cacheKeys, fingerprint, metrics, content: presentedContent, noteTitle, onPlan: nav.reportPlan, onProgress },
  }
}

/**
 * The audience follows the same position the room sees, so it is reported from the show's own nav rather
 * than from a control that would have to be told where the talk got to.
 */
function useSessionAudience(open: boolean, noteId: string | null, nav: ReturnType<typeof usePresentationNav>) {
  const audience = useAudienceFollow({ open, noteId, position: { slide: nav.index, page: nav.sub, step: nav.step } })
  return { audienceFollowing: audience.on, toggleAudience: audience.toggle }
}

/**
 * The physical stage: whether the browser is holding it fullscreen, how big its design canvas lands at,
 * and whether its own chrome is out of the way. The three are read off the same two elements and all
 * fade back in on the same activity, so they are asked for in one place.
 */
function useShowStage(options: {
  open: boolean
  panelRef: RefObject<HTMLDivElement | null>
  stageRef: RefObject<HTMLDivElement | null>
  autoHideChrome: boolean
}): { isFullscreen: boolean, toggleFullscreen: () => void, metrics: StageMetrics, chromeHidden: boolean } {
  const { open, panelRef, stageRef, autoHideChrome } = options
  const { isFullscreen, toggleFullscreen } = useFullscreenToggle(open, panelRef)
  const metrics = useStageMetrics(open, stageRef)
  return { isFullscreen, toggleFullscreen, metrics, chromeHidden: useChromeAutoHide(open && isFullscreen && autoHideChrome) }
}

function usePresentationContextMenu(open: boolean) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const [linkUrl, setLinkUrl] = useState<string | null>(null)
  const closeContextMenu = useCallback(() => {
    setPoint(null)
    setLinkUrl(null)
  }, [])
  const openContextMenu = useCallback((newPoint: { x: number; y: number }, newLinkUrl: string | null = null) => {
    setPoint(newPoint)
    setLinkUrl(newLinkUrl)
  }, [])
  useEffect(() => {
    if (!open) {
      setPoint(null)
      setLinkUrl(null)
    }
  }, [open])
  return { contextPoint: point, contextLink: linkUrl, openContextMenu, closeContextMenu }
}

// How far the idle pass has got in listing the deck. It is state rather than a guess about whether
// the list happens to be growing, because a slice that is still measuring looks identical to a
// finished pass from the outside; the dialog carries the flag as markup so it is observable.
function useListProgress(): { listProgress: PreflightProgress; onProgress: (progress: PreflightProgress) => void } {
  const [listProgress, setListProgress] = useState<PreflightProgress>({ measured: 0, slides: 0, finished: false })
  const onProgress = useCallback((progress: PreflightProgress) => setListProgress(progress), [])
  return { listProgress, onProgress }
}

// Presentation typography follows the reader's settings, so the projector looks like
// the preview the deck was written against.
function useShowSettings() {
  const dark = useIsDarkTheme()
  // One object rather than three field reads: the flags below name the settings a prepared page was
  // drawn under, and reading the fields apart would let them disagree with what the page holds.
  const preview = useSession((s) => s.settings.preview)
  const proseFont = useSession((s) => s.settings.appearance.proseFont)
  return {
    dark,
    flags: slideSettingFlags(preview),
    proseFont,
    slideList: preview.presentationSlideList,
    chartAnimation: preview.presentationChartAnimation,
    autoHideChrome: preview.presentationAutoHideChrome,
  }
}

// What the room the show sits in allows, read once: a window with room for the list opens it by
// default (an explicit toggle during the show wins until the next show opens), and a window too
// narrow for eleven controls gets the bar that fits it. Both are the same measurement, so both come
// from the same call — the overlay outlives a single show now that the shell hosts it, which is why
// the room is followed live rather than frozen at app start.
function useShowRoom(open: boolean, wanted: boolean): { railOpen: boolean; toggleRail: () => void; compact: boolean } {
  const [choice, setChoice] = useState<boolean | null>(null)
  // The account says whether a show should start with the list beside it; the room says whether
  // there is anywhere to put it. Either answer being 'no' closes it, and neither is a reason to
  // tell the presenter their setting is wrong — the toggle stays live for this show.
  const fitsViewport = useBreakpoint() !== 'mobile'
  useLayoutEffect(() => {
    if (open) setChoice(null)
  }, [open])
  const railOpen = railOpenFor(choice, fitsViewport && wanted)
  const toggleRail = useCallback(() => setChoice(!railOpen), [railOpen])
  return { railOpen, toggleRail, compact: !fitsViewport }
}

// Which slide the show is on, kept inside the deck at both ends: the opening index is clamped in case
// the note it was resumed from has since lost slides, a deck that shrinks mid-talk pulls the position
// back onto a slide that exists, and `goTo` cannot walk past either end. The page *within* a slide is
// a separate concern — see `useSubPage`.
function useDeckIndex(deckLength: number, initialSlideIndex: number = 0) {
  const [index, setIndex] = useState(() => clampSlideIndex(initialSlideIndex, deckLength))
  useEffect(() => {
    setIndex((current) => clampSlideIndex(current, deckLength))
  }, [deckLength])
  const goTo = useCallback((next: number) => setIndex(clampSlideIndex(next, deckLength)), [deckLength])
  return { index, goTo }
}

// Slide-level position plus auto-pagination sub-pages: a slide whose rendered
// blocks overflow the canvas reports its page plan, and next/prev walk through its
// sub-pages before moving to the neighboring slide. The plans also drive the slide
// list, which is why the show keeps them instead of only the current page count.
export function usePresentationNav(deck: string[], hashes: string[], initialSlideIndex: number = 0) {
  const deckLength = deck.length
  const { index, goTo } = useDeckIndex(deckLength, initialSlideIndex)
  const { plans, reportPlan } = useSlidePlans(hashes)
  const currentPlan = plans[index]
  const pageCount = currentPlan?.pages.length ?? 1
  const { sub, setSubPage, carryPage } = useSubPage(index, pageCount, Boolean(currentPlan))
  const [stepState, setStep] = useState(0)
  // How many reveals the page on screen holds, and how far it has been walked. A plan that shrank
  // mid-talk can leave the step past the last block it has, so the position reads the clamp rather
  // than the state (N-31).
  const steps = currentPlan ? planPageSteps(currentPlan, sub) : 0
  const step = Math.min(stepState, steps)
  const handlePlan = useCallback((plan: SlidePlan) => reportPlan(index, plan), [index, reportPlan])
  // Where the show stands, read when a control is used rather than written into the closure that
  // built it. The slide list holds these callbacks on every card of a long deck, and a fresh
  // identity on each turn would re-render the whole list to move one card.
  const position = useRef({ index, sub, step, steps, pageCount, deckLength, plan: currentPlan })
  position.current = { index, sub, step, steps, pageCount, deckLength, plan: currentPlan }
  const { goNext, goPrev } = usePageTurn(position, { goTo, carryPage, setSubPage, setStep })
  const jumpTo = useCallback((slide: number) => {
    carryPage(0)
    goTo(slide)
    setStep(0)
  }, [goTo, carryPage])
  // The slide list lists pages, so a click lands on the exact page it shows rather
  // than the top of the slide that contains it.
  const jumpToPage = useCallback((slide: number, page: number) => {
    const at = position.current
    const target = Math.max(page, 0)
    if (slide === at.index) {
      setSubPage(target)
      // A page the presenter clicked is the page they want to look at, whole — the same reading the
      // thumbnail and the overview card already give it (N-31).
      setStep(at.plan ? planPageSteps(at.plan, target) : 0)
    }
    else {
      carryPage(target)
      goTo(slide)
      setStep(0)
    }
  }, [goTo, carryPage, setSubPage])
  return { index, sub, step, steps, pageCount, plans, handlePlan, reportPlan, goNext, goPrev, jumpTo, jumpToPage }
}

// Page plans live in one map because the show and the slide list both read them: the
// canvas measures the slide it renders and the list turns those measurements into pages.
// The two presses that move the show forward and back. They read the position out of a ref rather
// than closing over it — the slide list holds these callbacks on every card of a long deck, and a new
// identity on each turn would re-render the whole list to move one card.
function usePageTurn(position: RefObject<{ index: number; sub: number; step: number; steps: number; pageCount: number; deckLength: number; plan: SlidePlan | undefined }>, actions: { goTo: (slide: number) => void; carryPage: (page: number) => void; setSubPage: (page: number) => void; setStep: (step: number) => void }) {
  const { goTo, carryPage, setSubPage, setStep } = actions
  const goNext = useCallback(() => {
    const at = position.current
    const move = forwardMove({ step: at.step, steps: at.steps, sub: at.sub, pageCount: at.pageCount })
    if (move === 'step') setStep(at.step + 1)
    else if (move === 'page') {
      setSubPage(at.sub + 1)
      setStep(0)
    }
    else if (at.index < at.deckLength - 1) {
      carryPage(0)
      goTo(at.index + 1)
      setStep(0)
    }
  }, [goTo, carryPage, setSubPage])
  const goPrev = useCallback(() => {
    const at = position.current
    const move = backwardMove({ step: at.step, sub: at.sub })
    if (move === 'step') setStep(Math.max(at.step - 1, 0))
    else if (move === 'page') {
      setSubPage(at.sub - 1)
      // Back onto the previous page means back to where it ended: the presenter sees what they had
      // seen, not a page with its blocks hidden again.
      setStep(at.plan ? planPageSteps(at.plan, at.sub - 1) : 0)
    }
    else if (at.index > 0) {
      carryPage(0)
      goTo(at.index - 1)
      setStep(0)
    }
  }, [goTo, carryPage, setSubPage])
  return { goNext, goPrev }
}

// The page inside the current slide: entering a slide starts at its top, while a jump
// from the slide list carries the page it named across the slide change, and a
// re-measure that shrank the slide pulls the state back onto a page that exists.
// Clamping waits for a known plan: an edit mid-talk re-splits the deck, and a clamp
// against the "one page" a missing plan implies would bounce the presenter to the top
// of the slide on every unrelated write.
function useSubPage(index: number, pageCount: number, known: boolean) {
  const [subPage, setSubPage] = useState(0)
  const pending = useRef<number | null>(null)
  useEffect(() => {
    const target = pending.current
    pending.current = null
    setSubPage(target ?? 0)
  }, [index])
  useEffect(() => {
    if (!known) return
    setSubPage((current) => Math.min(current, pageCount - 1))
  }, [known, pageCount])
  const carryPage = useCallback((page: number) => {
    pending.current = page
  }, [])
  return { sub: Math.min(Math.max(subPage, 0), pageCount - 1), setSubPage, carryPage }
}