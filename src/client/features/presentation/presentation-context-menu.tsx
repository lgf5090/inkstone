import { createPortal } from 'react-dom'
import {
  ChevronLeft,
  Keyboard,
  ChevronRight,
  CircleDot,
  Copy,
  ExternalLink,
  LayoutGrid,
  Maximize,
  Minimize,
  Moon,
  PanelLeft,
  Pen,
  Presentation,
  Radio,
  Snowflake,
  Sun,
  SunMedium,
  Users,
  X,
} from 'lucide-react'
import { t } from '../../lib/i18n'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { Z_INDEX } from '../../lib/z-index'
import { Menu, type MenuItem } from '../../components/overlay'
import { presentationKeyCombo } from './presentation-keys'
import { hasBackwardMove, hasForwardMove, isSafeSlideLinkHref } from './presentation-state'

export interface PresentationMenuItemsOptions {
  linkUrl: string | null
  slideIndex: number
  slideCount: number
  subPage: number
  pageCount: number
  /** How far the page on screen has been revealed, and how many reveals it holds (N-31). */
  step: number
  steps: number
  railOpen: boolean
  overview: boolean
  following: boolean
  followLost: boolean
  isFullscreen: boolean
  laser: boolean
  spotlight: boolean
  screenCover: 'black' | 'white' | null
  keyGuide: boolean
  /** An audience is following this show (N-34); the row says which of the two it would do. */
  audienceFollowing: boolean
  onPrev: () => void
  onNext: () => void
  onToggleRail: () => void
  onToggleOverview: () => void
  onToggleFollowing: () => void
  onToggleFullscreen: () => void
  onToggleKeyGuide: () => void
  onToggleAudience: () => void
  onOpenPresenter: () => void
  onToggleLaser: () => void
  /** The marker over the slide (PR-M13): whether it is on, and the two ways to take marks away. */
  inkOn: boolean
  onToggleInk: () => void
  onToggleSpotlight: () => void
  onToggleBlackout: () => void
  onToggleWhiteout: () => void
  onExit: () => void
}

// The href comes out of the rendered note, so these two items exist only for a protocol the projector is
// willing to open. Left click and right click are one action on one href; they must not be two judgements.
function buildLinkItems(linkUrl: string | null): MenuItem[] {
  if (!isSafeSlideLinkHref(linkUrl)) return []
  return [
    {
      id: 'link-open',
      label: t('preview.open_in_new_tab'),
      icon: <ExternalLink size={14} />,
      onSelect: () => window.open(linkUrl, '_blank', 'noopener,noreferrer'),
    },
    {
      id: 'link-copy',
      label: t('workspace.presentation_link_copy'),
      icon: <Copy size={14} />,
      onSelect: () => {
        // Best-effort clipboard copy: environment or permission restrictions may reject writing.
        navigator.clipboard?.writeText(linkUrl).catch(() => {})
      },
    },
  ]
}

function buildNavigationItems(options: PresentationMenuItemsOptions): MenuItem[] {
  const isFirst = !hasBackwardMove({ index: options.slideIndex, sub: options.subPage, step: options.step })
  const isLast = !hasForwardMove({ index: options.slideIndex, count: options.slideCount, sub: options.subPage, pageCount: options.pageCount, step: options.step, steps: options.steps })
  return [
    {
      id: 'prev',
      label: t('workspace.presentation_prev'),
      combo: presentationKeyCombo('prev'),
      icon: <ChevronLeft size={14} />,
      disabled: isFirst,
      onSelect: options.onPrev,
      separatorBefore: isSafeSlideLinkHref(options.linkUrl),
    },
    {
      id: 'next',
      label: t('workspace.presentation_next'),
      combo: presentationKeyCombo('next'),
      icon: <ChevronRight size={14} />,
      disabled: isLast,
      onSelect: options.onNext,
    },
  ]
}

/**
 * The audience row, built apart from the session rows on purpose: the keyed rows are checked against the
 * key reference table by the door's own test, and this control answers to no keystroke — like the
 * exports, it is something a presenter presses rather than types.
 */
export function buildAudienceItems(options: PresentationMenuItemsOptions): MenuItem[] {
  // The demo edition says so rather than offering a door that cannot open: its backend is a map inside
  // this tab, so a link handed to another person opens a page that never heard of the talk (ADR-0006 —
  // a capability a surface cannot host is stated, not silently missing).
  if (IS_DEMO_MODE) {
    return [
      {
        id: 'audience',
        label: t('workspace.presentation_audience_unavailable'),
        icon: <Users size={14} />,
        disabled: true,
        separatorBefore: true,
      },
    ]
  }
  const label = options.audienceFollowing ? t('workspace.presentation_audience_stop') : t('workspace.presentation_audience_follow')
  return [
    {
      id: 'audience',
      label,
      icon: <Users size={14} />,
      checked: options.audienceFollowing,
      onSelect: options.onToggleAudience,
      separatorBefore: true,
    },
  ]
}

function buildViewItems(options: PresentationMenuItemsOptions): MenuItem[] {
  return [
    {
      id: 'overview',
      label: t('workspace.presentation_overview'),
      combo: presentationKeyCombo('overview'),
      icon: <LayoutGrid size={14} />,
      checked: options.overview,
      onSelect: options.onToggleOverview,
      separatorBefore: true,
    },
    {
      id: 'rail',
      label: t('workspace.presentation_slides'),
      combo: presentationKeyCombo('slideList'),
      icon: <PanelLeft size={14} />,
      checked: options.railOpen,
      onSelect: options.onToggleRail,
    },
    {
      id: 'presenter',
      label: t('workspace.presentation_presenter'),
      combo: presentationKeyCombo('presenter'),
      icon: <Presentation size={14} />,
      onSelect: options.onOpenPresenter,
    },
  ]
}

function buildToolItems(options: PresentationMenuItemsOptions): MenuItem[] {
  return [
    {
      id: 'laser',
      label: t('workspace.presentation_laser'),
      combo: presentationKeyCombo('laser'),
      icon: <CircleDot size={14} />,
      checked: options.laser,
      onSelect: options.onToggleLaser,
      separatorBefore: true,
    },
    {
      id: 'spotlight',
      label: t('workspace.presentation_spotlight'),
      combo: presentationKeyCombo('spotlight'),
      icon: <Sun size={14} />,
      checked: options.spotlight,
      onSelect: options.onToggleSpotlight,
    },
    {
      id: 'ink',
      label: t('workspace.presentation_ink'),
      combo: presentationKeyCombo('ink'),
      icon: <Pen size={14} />,
      checked: options.inkOn,
      onSelect: options.onToggleInk,
    },
    {
      id: 'blackout',
      label: t('workspace.presentation_blackout'),
      combo: presentationKeyCombo('blackout'),
      icon: <Moon size={14} />,
      checked: options.screenCover === 'black',
      onSelect: options.onToggleBlackout,
    },
    {
      id: 'whiteout',
      label: t('workspace.presentation_whiteout'),
      combo: presentationKeyCombo('whiteout'),
      icon: <SunMedium size={14} />,
      checked: options.screenCover === 'white',
      onSelect: options.onToggleWhiteout,
    },
  ]
}

// The rows about the show itself, shared by both doors: the follow lamp, the screen, and the card
// that says what every other row's key is.
function buildSessionItems(options: PresentationMenuItemsOptions): MenuItem[] {
  return [
    {
      id: 'follow',
      // The menu drives the same toggle as the capsule, so it carries the same news: with the note
      // gone there is nothing to follow, and the row that shows `L` would be the one place the show
      // still claims to be live.
      label: options.followLost ? t('workspace.presentation_follow_lost') : t('workspace.presentation_follow'),
      combo: options.followLost ? undefined : presentationKeyCombo('follow'),
      icon: options.followLost ? <Snowflake size={14} /> : <Radio size={14} />,
      checked: !options.followLost && options.following,
      disabled: options.followLost,
      onSelect: options.onToggleFollowing,
      separatorBefore: true,
    },
    {
      id: 'fullscreen',
      label: options.isFullscreen ? t('workspace.presentation_exit_fullscreen') : t('workspace.presentation_fullscreen'),
      combo: presentationKeyCombo('fullscreen'),
      icon: options.isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />,
      checked: options.isFullscreen,
      onSelect: options.onToggleFullscreen,
    },
    {
      id: 'key-guide',
      label: t('workspace.presentation_keys'),
      combo: presentationKeyCombo('keyGuide'),
      icon: <Keyboard size={14} />,
      checked: options.keyGuide,
      onSelect: options.onToggleKeyGuide,
    },
  ]
}

// Only the right-click menu needs a way out on the list: the capsule keeps its own button where the
// thumb already is, and at phone width that button is one of the three the bar still draws.
function buildExitItem(options: PresentationMenuItemsOptions): MenuItem {
  return {
    id: 'exit',
    label: t('workspace.presentation_exit'),
    combo: presentationKeyCombo('exit'),
    icon: <X size={14} />,
    tone: 'danger',
    onSelect: options.onExit,
    separatorBefore: true,
  }
}

export function buildPresentationMenuItems(options: PresentationMenuItemsOptions): MenuItem[] {
  return [
    ...buildLinkItems(options.linkUrl),
    ...buildNavigationItems(options),
    ...buildViewItems(options),
    ...buildToolItems(options),
    ...buildSessionItems(options),
    buildExitItem(options),
  ]
}

/**
 * The rows behind the capsule's door at phone width. The bar cannot hold eleven controls in 390px and
 * a touch screen gets no right-click, so everything that is not a turn or the way out walks through
 * here — the same builders the context menu uses, which is what keeps one list rather than two.
 */
export function buildPresentationOverflowItems(options: PresentationMenuItemsOptions): MenuItem[] {
  return [
    ...buildViewItems(options),
    ...buildToolItems(options),
    ...buildSessionItems(options),
  ]
}

export function extractLinkHref(anchor: Element | null | undefined): string | null {
  if (!anchor) return null
  const attr = anchor.getAttribute('href')
  if (attr) return attr
  const rawHref: unknown = Reflect.get(anchor, 'href')
  if (typeof rawHref === 'string') return rawHref
  if (rawHref && typeof rawHref === 'object' && 'baseVal' in rawHref) {
    const baseVal = Reflect.get(rawHref, 'baseVal')
    return typeof baseVal === 'string' && baseVal ? baseVal : null
  }
  return null
}

export function extractAnchorHrefFromPoint(x: number, y: number, fallbackTarget: Element | null, surface?: Element | null): string | null {
  if (typeof document !== 'undefined' && typeof document.elementsFromPoint === 'function') {
    // The stack comes back in paint order, and a `pointer-events: none` layer is not in it at all (measured
    // in Chrome), so the first element that is neither the menu's backdrop nor the menu is what the
    // projector is showing under the pointer. Searching deeper would offer a link hidden under an opaque
    // surface; not stopping at the panel's edge would offer one from the application behind the show.
    const top = document.elementsFromPoint(x, y)
      .find((el) => !el.hasAttribute('data-presentation-menu-backdrop') && !el.closest('[role="menu"]'))
    if (top) return surface?.contains(top) ? extractLinkHref(top.closest<HTMLAnchorElement>('a[href]')) : null
  }
  const fallbackAnchor = fallbackTarget?.closest<HTMLAnchorElement>('a[href]')
  return extractLinkHref(fallbackAnchor)
}

export interface PresentationContextMenuProps extends PresentationMenuItemsOptions {
  point: { x: number; y: number } | null
  onClose: () => void
  onReopen: (point: { x: number; y: number }, linkUrl: string | null) => void
  container?: HTMLElement | null
}

export function PresentationContextMenu(props: PresentationContextMenuProps) {
  const { point, linkUrl, onClose, onReopen, container, ...options } = props
  if (!point) return null

  const items = buildPresentationMenuItems({ ...options, linkUrl })
  const targetContainer = container ?? (typeof document !== 'undefined' ? document.body : null)
  if (!targetContainer) return null

  return (
    <>
      {createPortal(
        <div
          data-presentation-menu-backdrop
          tabIndex={-1}
          style={{ zIndex: Z_INDEX.menu }}
          className='fixed top-0 left-0 w-full h-full z-[var(--z-pop)] cursor-default select-none'
          onMouseDown={(e) => {
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            const resolvedLink = extractAnchorHrefFromPoint(e.clientX, e.clientY, e.target as Element | null, container ?? null)
            onReopen({ x: e.clientX, y: e.clientY }, resolvedLink)
          }}
        />,
        targetContainer
      )}
      <Menu
        open={Boolean(point)}
        anchor={point}
        items={items}
        onClose={onClose}
        container={targetContainer}
        zIndex={Z_INDEX.menu + 1}
        label={t('workspace.presentation_context_menu')}
      />
    </>
  )
}
