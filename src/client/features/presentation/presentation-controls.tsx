import { useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Code, Download, EllipsisVertical, FileText, Images, LayoutGrid, Maximize, Minimize, PanelLeftClose, PanelLeftOpen, Presentation, Radio, Snowflake, Users, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { t, type MessageKey } from '../../lib/i18n'
import { IconButton, Spinner } from '../../components/primitives'
import { Menu, submenuFor, Tooltip, type MenuItem } from '../../components/overlay'
import { Z_INDEX } from '../../lib/z-index'
import { presentationKeyCombo } from './presentation-keys'
import { hasBackwardMove, hasForwardMove } from './presentation-state'
import { describeDeckPosition, formatDeckPosition } from './deck-position'

/** How far an export that paints its own off-screen sheet has got. The sheet reports it; the show is
 * the only surface that can be seen reporting it, so the shape lives with the pill that says so. */
export interface DeckExportProgress {
  current: number
  total: number
}

export interface PresentationControlsProps {
  slideIndex: number
  slideCount: number
  subPage: number
  pageCount: number
  /** How far the page on screen has been revealed, and how many reveals it holds (N-31). Both are the
   * raw state, and `steps` is zero on a page that arrives all at once. */
  step: number
  steps: number
  isFullscreen: boolean
  railOpen: boolean
  overview: boolean
  following: boolean
  /** The note behind the show was deleted; the deck holds its last snapshot and cannot follow. */
  followLost: boolean
  chromeHidden: boolean
  /** The pill is under the overview grid, so it cannot be reached from behind it. */
  occluded: boolean
  /** A phone window: the bar keeps the two turns, one door, and the way out — see `ViewDoor`. */
  compact: boolean
  /** The rows behind the door. The session builds them from the same list the right-click menu reads. */
  overflowItems: MenuItem[]
  onPrev: () => void
  onNext: () => void
  onToggleRail: () => void
  onToggleOverview: () => void
  onToggleFollowing: () => void
  onToggleFullscreen: () => void
  onOpenPresenter: () => void
  /** An image export is being written right now; the control that starts it shows that on itself. */
  exporting: boolean
  onExport: () => void
  onExportImages: () => void
  onExportHandout: () => void
  /** The deck as one HTML file the recipient plays without this app (N-33). */
  onExportHtml: () => void
  /** Whether an audience is following this show, and the press that changes it (N-34). */
  audienceFollowing: boolean
  onToggleAudience: () => void
  onClose: () => void
}

// How long a gesture that only woke the bar may keep ownership of its own click. A touch reports no
// move before the tap, so the control that appears under the finger would otherwise be pressed by the
// very gesture that revealed it — and the click arrives after React has already drawn the bar back.
const GHOST_CLICK_MS = 700

export function PresentationControls({ slideIndex, slideCount, subPage, pageCount, step, steps, isFullscreen, railOpen, overview, following, followLost, audienceFollowing, chromeHidden, occluded, compact, overflowItems, exporting, onPrev, onNext, onToggleRail, onToggleOverview, onToggleFollowing, onToggleFullscreen, onOpenPresenter, onToggleAudience, onExport, onExportImages, onExportHandout, onExportHtml, onClose }: PresentationControlsProps) {
  const wokeByThisGesture = useRef(0)
  return (
    // A faded bar is `inert` *and* `invisible`, and both make the browser's hit test walk straight
    // past it to the stage behind — so the first tap where the controls are became a page turn in
    // front of the room (PR-H1, measured on a 420px touch window). This wrapper owns the bar's
    // rectangle and never fades, so the gesture that brings the controls back is only that. It takes
    // no space of its own: the bar is its only child and paints exactly over it.
    <div
      data-presentation-chrome-guard
      className='absolute bottom-[var(--sp-4)] left-1/2 -translate-x-1/2'
      onPointerDownCapture={() => {
        if (chromeHidden) wokeByThisGesture.current = Date.now()
      }}
      onClickCapture={(event) => {
        if (Date.now() - wokeByThisGesture.current > GHOST_CLICK_MS) return
        // Same gesture, revealed control: the press is spent on bringing the bar back.
        wokeByThisGesture.current = 0
        event.stopPropagation()
        event.preventDefault()
      }}
    >
      <div
        data-presentation-chrome
        inert={chromeHidden || occluded ? true : undefined}
        className={cn(
          'flex items-center gap-[var(--sp-0-5)] rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] p-[var(--sp-1)] shadow-[var(--shadow-pop)]',
          'transition-opacity duration-[var(--dur-base)] ease-[var(--ease-out)]',
          chromeHidden && 'pointer-events-none opacity-0 invisible',
        )}
      >
        <SlideStepper slideIndex={slideIndex} slideCount={slideCount} subPage={subPage} pageCount={pageCount} step={step} steps={steps} onPrev={onPrev} onNext={onNext} />
        <span className='mx-[var(--sp-1)] h-[var(--sp-4)] w-px bg-[var(--border-subtle)]' aria-hidden='true' />
        {compact
          ? <ViewDoor items={doorItems(overflowItems, exportGroupItem({ onExport, onExportImages, onExportHandout, onExportHtml, exporting }))} exporting={exporting} />
          : <>
            <ViewControls railOpen={railOpen} overview={overview} following={following} followLost={followLost} audienceFollowing={audienceFollowing} isFullscreen={isFullscreen} onToggleRail={onToggleRail} onToggleOverview={onToggleOverview} onToggleFollowing={onToggleFollowing} onToggleAudience={onToggleAudience} onToggleFullscreen={onToggleFullscreen} onOpenPresenter={onOpenPresenter} />
            <span className='mx-[var(--sp-1)] h-[var(--sp-4)] w-px bg-[var(--border-subtle)]' aria-hidden='true' />
            <ExportControls exporting={exporting} onExport={onExport} onExportImages={onExportImages} onExportHandout={onExportHandout} onExportHtml={onExportHtml} />
          </>}
        <span className='mx-[var(--sp-1)] h-[var(--sp-4)] w-px bg-[var(--border-subtle)]' aria-hidden='true' />
        <Tooltip label={t('workspace.presentation_exit')} combo={presentationKeyCombo('exit')} side='top'>
          <IconButton label={t('workspace.presentation_exit')} size='sm' onClick={onClose}>
            <X size={15} />
          </IconButton>
        </Tooltip>
      </div>
    </div>
  )
}

// The name this control owes the presenter: what the show is doing about the note, in the order the
// states matter. A deleted note keeps its last snapshot on the projector, so the freeze is the fact
// to report, and it outranks whether the show was set to follow.
function followControlLabel({ following, followLost }: { following: boolean; followLost: boolean }): string {
  if (followLost) return t('workspace.presentation_follow_lost')
  return following ? t('workspace.presentation_freeze') : t('workspace.presentation_follow')
}

function ViewControls({ railOpen, overview, following, followLost, audienceFollowing, isFullscreen, onToggleRail, onToggleOverview, onToggleFollowing, onToggleAudience, onToggleFullscreen, onOpenPresenter }: {
  railOpen: boolean
  overview: boolean
  following: boolean
  followLost: boolean
  audienceFollowing: boolean
  isFullscreen: boolean
  onToggleRail: () => void
  onToggleOverview: () => void
  onToggleFollowing: () => void
  onToggleAudience: () => void
  onToggleFullscreen: () => void
  onOpenPresenter: () => void
}) {
  const fullscreenLabel = isFullscreen ? t('workspace.presentation_exit_fullscreen') : t('workspace.presentation_fullscreen')
  const railLabel = railOpen ? t('workspace.presentation_hide_slides') : t('workspace.presentation_show_slides')
  const overviewLabel = overview ? t('workspace.presentation_hide_overview') : t('workspace.presentation_show_overview')
  const followLabel = followControlLabel({ following, followLost })
  const presenterLabel = t('workspace.presentation_presenter')
  const audienceLabel = audienceFollowing ? t('workspace.presentation_audience_stop') : t('workspace.presentation_audience_follow')
  return (
    <>
      <Tooltip label={railLabel} combo={presentationKeyCombo('slideList')} side='top'>
        <IconButton label={railLabel} size='sm' active={railOpen} onClick={onToggleRail}>
          {railOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
        </IconButton>
      </Tooltip>
      <Tooltip label={overviewLabel} combo={presentationKeyCombo('overview')} side='top'>
        <IconButton label={overviewLabel} size='sm' active={overview} onClick={onToggleOverview}>
          <LayoutGrid size={14} />
        </IconButton>
      </Tooltip>
      <Tooltip label={presenterLabel} combo={presentationKeyCombo('presenter')} side='top'>
        <IconButton label={presenterLabel} size='sm' onClick={onOpenPresenter}>
          <Presentation size={14} />
        </IconButton>
      </Tooltip>
      {/* The audience control carries no key on purpose: it is a press a presenter makes once, when
          they decide to let people in, and the door row spells out the same thing on a phone. It is not
          offered in the demo edition at all: the demo's whole backend is a map inside this tab, so a link
          handed to another person would open a page that never heard of the talk. */}
      {!IS_DEMO_MODE && (
        <Tooltip label={audienceLabel} side='top'>
          <IconButton label={audienceLabel} size='sm' data-audience-toggle='true' active={audienceFollowing} onClick={onToggleAudience}>
            <Users size={14} />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip label={followLabel} combo={followLost ? undefined : presentationKeyCombo('follow')} side='top'>
        <IconButton label={followLabel} size='sm' data-follow-toggle='true' active={!followLost && following} disabled={followLost} onClick={onToggleFollowing}>
          {!followLost && following ? <Radio size={14} /> : <Snowflake size={14} />}
        </IconButton>
      </Tooltip>
      <Tooltip label={fullscreenLabel} combo={presentationKeyCombo('fullscreen')} side='top'>
        <IconButton label={fullscreenLabel} size='sm' onClick={onToggleFullscreen}>
          {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
        </IconButton>
      </Tooltip>
    </>
  )
}

// The exports are named without a keystroke beside them because the show binds no key to any of them:
// a tooltip that showed `?` here would point at the card, not at the press.
function ExportControls({ exporting, onExport, onExportImages, onExportHandout, onExportHtml }: { exporting: boolean; onExport: () => void; onExportImages: () => void; onExportHandout: () => void; onExportHtml: () => void }) {
  return (
    <>
      <Tooltip label={t('workspace.presentation_export')} side='top'>
        <IconButton label={t('workspace.presentation_export')} size='sm' onClick={onExport}>
          <Download size={14} />
        </IconButton>
      </Tooltip>
      <Tooltip label={t('workspace.presentation_export_handout')} side='top'>
        <IconButton label={t('workspace.presentation_export_handout')} size='sm' onClick={onExportHandout}>
          <FileText size={14} />
        </IconButton>
      </Tooltip>
      <Tooltip label={t('workspace.presentation_export_html')} side='top'>
        <IconButton label={t('workspace.presentation_export_html')} size='sm' onClick={onExportHtml}>
          <Code size={14} />
        </IconButton>
      </Tooltip>
      <Tooltip label={t('workspace.presentation_export_images')} side='top'>
        <IconButton label={t('workspace.presentation_export_images')} size='sm' onClick={onExportImages}>
          {/* The control that started the write carries the sign of it, so the presenter is not left
              depending on a floating layer's place in the stack to learn the press did anything. */}
          {exporting ? <span data-export-spinner aria-hidden='true' className='inline-flex'><Spinner size={14} /></span> : <Images size={14} />}
        </IconButton>
      </Tooltip>
    </>
  )
}

// The door the narrow bar opens: every control that no longer fits in 390px, on the list the
// right-click menu already builds. It is a `Menu` from the component library — a portal with its own
// focus, Escape and dismissed-by-outside-click behaviour, which an inline panel inside the bar would
// not have (and an inline panel would grow the bar and move the button the thumb just pressed).
const DOOR_WIDTH = 244

function ViewDoor({ items, exporting }: { items: MenuItem[]; exporting: boolean }) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  // The list belongs to the projector it was opened from. A portal left on the body would sit under the
  // dialog that fills the screen — the paint-stack mistake this module has now made three times — and
  // reading it off the trigger keeps the door honest wherever the bar happens to live.
  const container = buttonRef.current?.closest<HTMLElement>('[role="dialog"]') ?? null
  const rows = items.map((item) => (item.id === 'export-images' && exporting ? { ...item, icon: <span data-export-spinner aria-hidden='true'><Spinner size={14} /></span> } : item))
  return (
    <>
      <Tooltip label={t('common.more_actions')} side='top'>
        <IconButton ref={buttonRef} label={t('common.more_actions')} size='sm' active={open} data-presentation-overflow='true' onClick={() => setOpen((on) => !on)}>
          <EllipsisVertical size={14} />
        </IconButton>
      </Tooltip>
      <Menu anchor={buttonRef} open={open} onClose={() => setOpen(false)} items={rows} align='end' width={DOOR_WIDTH} container={container} zIndex={Z_INDEX.menu + 1} label={t('common.more_actions')} />
    </>
  )
}

/**
 * The door's own shape: the four screen modes and the four exports each collapse into one row.
 *
 * Fifteen rows measured 653px of content in the 419px panel a 420×860 phone gives a door, which left
 * the last row cut in half with nothing on screen saying there was more — and everything below the
 * fold unreachable (PR-M1). Nine rows fit. The group rows carry a mark when one of their children is
 * on, because a door that cannot show that the screen is blacked out has traded one problem for a
 * worse one, and the wide bar keeps every row on top level where there is room for them.
 */
const DOOR_GROUPS: Array<{ id: string; label: MessageKey; ids: string[] }> = [
  { id: 'modes', label: 'workspace.presentation_modes', ids: ['laser', 'spotlight', 'blackout', 'whiteout'] },
]

function doorItems(overflow: MenuItem[], exportRow: MenuItem): MenuItem[] {
  const out: MenuItem[] = []
  const taken = new Set<string>()
  for (const item of overflow) {
    const group = DOOR_GROUPS.find((g) => g.ids.includes(item.id))
    if (!group) {
      out.push(item)
      continue
    }
    if (taken.has(group.id)) continue
    taken.add(group.id)
    const children = overflow.filter((row) => group.ids.includes(row.id))
    out.push({
      id: group.id,
      label: t(group.label),
      icon: children[0]?.icon,
      separatorBefore: item.separatorBefore,
      checked: children.some((row) => row.checked),
      submenu: submenuFor(children, DOOR_WIDTH),
    })
  }
  out.push(exportRow)
  return out
}

/**
 * The door's one export row.
 *
 * Four export rows at the tail of a fifteen-row list measured 653px of content in a 419px panel on a
 * 420×860 phone, which left the last row cut in half and every export below the fold with nothing on
 * screen saying there was more (PR-M1). Folded into a submenu the door is twelve rows, and the group
 * row is where the working state shows — a spinner on a row nobody can reach is not feedback.
 */
function exportGroupItem({ onExport, onExportImages, onExportHandout, onExportHtml, exporting }: { onExport: () => void; onExportImages: () => void; onExportHandout: () => void; onExportHtml: () => void; exporting: boolean }): MenuItem {
  return {
    id: 'export',
    label: t('workspace.export'),
    icon: exporting ? <span data-export-spinner aria-hidden='true'><Spinner size={14} /></span> : <Download size={14} />,
    separatorBefore: true,
    submenu: submenuFor(exportMenuItems({ onExport, onExportImages, onExportHandout, onExportHtml }), DOOR_WIDTH),
  }
}

// The exports the wide bar draws as buttons; on a phone they walk through the door with the rest, and
// the one that is working still says so on its own row.
function exportMenuItems({ onExport, onExportImages, onExportHandout, onExportHtml }: { onExport: () => void; onExportImages: () => void; onExportHandout: () => void; onExportHtml: () => void }): MenuItem[] {
  return [
    { id: 'export', label: t('workspace.presentation_export'), icon: <Download size={14} />, onSelect: onExport, separatorBefore: true },
    { id: 'export-handout', label: t('workspace.presentation_export_handout'), icon: <FileText size={14} />, onSelect: onExportHandout },
    { id: 'export-html', label: t('workspace.presentation_export_html'), icon: <Code size={14} />, onSelect: onExportHtml },
    { id: 'export-images', label: t('workspace.presentation_export_images'), icon: <Images size={14} />, onSelect: onExportImages },
  ]
}

// What the image export is doing, painted by the show itself. The sheet it counts is laid out
// off-screen, so a status layer held beside that sheet sits under the projector — the same paint-stack
// mistake the laser pointer and the screen cover were pulled back from. `--z-toast` is the token for
// "above the surface it belongs to", which is what a progress note has to be to be worth reading.
export function DeckExportProgress({ current, total }: DeckExportProgress) {
  return (
    <div
      data-export-progress
      role='status'
      aria-live='polite'
      className='pointer-events-none absolute bottom-[var(--sp-12)] left-1/2 z-[var(--z-toast)] -translate-x-1/2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-overlay)] px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-13)] text-[var(--text-primary)] shadow-[var(--shadow-soft)]'
    >
      {t('workspace.presentation_exporting_images', { value0: current, value1: total })}
    </div>
  )
}

// The deck position is one string holding everything the show is standing on: which slide, which page
// of it, and how far that page has arrived. It is printed left of the step buttons and read out by one
// announcement beside them. The digits are hidden from the accessibility tree on purpose: a screen
// reader hearing «3 / 14 · 2/4 · 1/3» as a live region learns nothing about which is which.
export function SlideStepper({ slideIndex, slideCount, subPage, pageCount, step, steps, onPrev, onNext }: {
  slideIndex: number
  slideCount: number
  subPage: number
  pageCount: number
  step: number
  steps: number
  onPrev: () => void
  onNext: () => void
}) {
  const position = { index: slideIndex, count: slideCount, subPage, pageCount, step, steps }
  // The turn is out of reach only when nothing is left to walk: a page still arriving in stages has a
  // press left in it even on the first slide of the deck (N-31).
  const atStart = !hasBackwardMove({ index: slideIndex, sub: subPage, step })
  const atEnd = !hasForwardMove({ index: slideIndex, count: slideCount, sub: subPage, pageCount, step, steps })
  return (
    <>
      <span
        data-deck-position
        aria-hidden='true'
        title={describeDeckPosition(position)}
        className='tabular min-w-[var(--sp-16)] px-[var(--sp-1)] text-center text-[length:var(--text-12)] text-[var(--text-secondary)]'
      >
        {formatDeckPosition(position)}
      </span>
      <span className='sr-only' role='status' aria-live='polite'>{describeDeckPosition(position)}</span>
      <Tooltip label={t('workspace.presentation_prev')} combo={presentationKeyCombo('prev')} side='top'>
        <IconButton label={t('workspace.presentation_prev')} size='sm' onClick={onPrev} disabled={atStart}>
          <ChevronLeft size={15} />
        </IconButton>
      </Tooltip>
      <Tooltip label={t('workspace.presentation_next')} combo={presentationKeyCombo('next')} side='top'>
        <IconButton label={t('workspace.presentation_next')} size='sm' onClick={onNext} disabled={atEnd}>
          <ChevronRight size={15} />
        </IconButton>
      </Tooltip>
    </>
  )
}

// How much of the show has been reached. It counts the pages the deck measures rather than the slides
// the author wrote, so a one-slide note that paginates into fourteen is not drawn finished before it
// has been turned. Decoration: the position itself is announced by the pill, not by this bar.
export function SlideProgress({ page, pageTotal }: { page: number; pageTotal: number }) {
  return (
    <div
      className='pointer-events-none absolute inset-x-0 bottom-0 h-[var(--sp-0-5)] bg-[var(--border-subtle)]'
      aria-hidden='true'
    >
      <div data-slide-progress className='h-full bg-[var(--accent)] transition-[width] duration-[var(--dur-base)] ease-[var(--ease-out)]' style={{ width: `${Math.round((page / pageTotal) * 100)}%` }} />
    </div>
  )
}
