/**
 * How much of the window this thread already takes, worn by the header as a ring.
 *
 * The reader has always been able to set the window from the composer and never able to see how full it is,
 * so nothing said when the app starts folding their older turns into a summary — a decision about their own
 * words, made silently, several turns before anything goes wrong.
 *
 * It sits in the header rather than inside the composer box. The box is where the reader writes, and a
 * measurement drawn in it is furniture in the one place that has to stay quiet; the header already carries
 * the other facts about this thread — its title, its project, the note it came from — and has room for one
 * more. What the ring asks in return is two gestures: hover or focus for the short claim, a press for the
 * long one.
 *
 * What is counted is only what the browser may legitimately know: the thread's loaded turns and the answers
 * their tools brought back. The system prompt is not reachable from a client at all — it carries the
 * reader's standing instructions, the recalled memories and the pinned note, and only the worker builds it —
 * so the ring measures the thread against the room the window can give it rather than against the whole
 * window, and says so. The words being typed are deliberately not in the number: the scope line promises
 * the thread's own text, and a figure that jumped on every keystroke could not be read off a header at all.
 */
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AssistantLimits, AssistantMessage, AssistantModel } from '@shared/assistant'
import { contextBudgetFor, estimateTokens, formatTokenStep } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { getVisibleViewport } from '../../lib/viewport'
import { placePanel } from '../../components/popover-placement'
import { Tooltip, useClickOutside, useEscape } from '../../components/overlay'
import { IconButton } from '../../components/primitives'
import { useAssistant } from './assistant-store'

/**
 * The share of the room that turns the ring into a warning.
 *
 * Below eight tenths the thread is still the size the reader chose; past it, the turns the app is about to
 * fold away are the ones being read now, so the fact is said before the limit is reached rather than at it.
 */
const WARN_AT_PERCENT = 80

/**
 * What the app adds around one stored turn when it rebuilds the prompt.
 *
 * The same figure the worker budgets a turn at: the role and the framing are a cost of their own, and a
 * thread of many short turns is not the same size as the same words in one block.
 */
const TURN_FRAMING_TOKENS = 4

/** The ring's own drawing surface: a viewBox, so every number below is a share of it rather than a pixel. */
const RING_BOX = 24
/** How far the track sits in from that surface's edge, and how thick the ring is drawn. */
const RING_RADIUS = 10
const RING_STROKE = 3
/** One full turn of the circle, which the dash pattern is cut against. */
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/**
 * What the thread's own turns cost, before anything is typed.
 *
 * A tool's answer is counted because it rides back out on every later prompt — leaving it out under-priced
 * exactly the turns that read the most, which is the mistake the worker's own budget already fixes.
 */
export function threadTokens(messages: readonly AssistantMessage[]): number {
  return messages.reduce(
    (total, message) => total
      + estimateTokens(message.content)
      + (message.tools ?? []).reduce((sum, tool) => sum + estimateTokens(tool.result ?? ''), 0)
      + TURN_FRAMING_TOKENS,
    0,
  )
}

/**
 * How much of the window the thread is actually given, or null when nothing honest can be said about it.
 *
 * The window is what the smaller of the two ceilings allows in; the answer's own allowance comes off it
 * before the history is fed in, so what is left is the most a thread can ever be given. Both numbers are
 * the model's when the model states them and the account's when it does not.
 *
 * The zero case is the whole point of the null. A model built from a provider's preset states no ceiling at
 * all, which `contextBudgetFor` reads through the account's numbers — and when the answer's allowance is
 * bigger than the window those numbers give, what is left for the thread is negative. The old guard clamped
 * that to one so the division would not throw, and the clamp was then printed as the budget: a fresh install
 * read `189 / 1`, called itself nearly full and promised to start folding turns that had never been written
 * down. A division that cannot be had is not a reading of zero or of one, it is no reading; the caller has
 * to be able to tell the two apart, which is what null says.
 */
export function contextRoom(model: AssistantModel, limits: AssistantLimits): number | null {
  const room = contextBudgetFor(model, limits) - (model.maxOutputTokens ?? limits.maxOutputTokens)
  return Number.isFinite(room) && room > 0 ? room : null
}

/** The header's context control: a ring for the eye, a progressbar for the ear, a panel for the detail. */
export function ContextUsageRing() {
  // Read narrow, and read here: the ring is the only thing in either header that cares about the thread's
  // size, so a new turn must not drag a whole view into re-rendering for it.
  const messages = useAssistant((state) => state.messages)
  const hasMore = useAssistant((state) => state.messagesHasMore)
  const settings = useAssistant((state) => state.settings)
  const model = useAssistant((state) => state.models.find((entry) => entry.id === state.settings?.activeModelId) ?? null)
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  // Only the thread is memoised: it is the half that costs a walk, and it changes once per turn.
  const counted = useMemo(() => threadTokens(messages), [messages])

  if (!model || !settings) return null
  const room = contextRoom(model, settings.limits)
  const percent = room === null ? null : Math.min(100, Math.round((counted / room) * 100))
  const warning = percent !== null && percent >= WARN_AT_PERCENT
  const used = formatTokenStep(counted)
  const limit = room === null ? null : formatTokenStep(room)
  // The short claim, said once and meant the same way everywhere it appears: in the tooltip, on the control
  // that owns the tooltip, and in the panel's own headline.
  const summary = room === null
    ? t('assistant.context.ring_unknown')
    : t('assistant.context.ring_summary', { used, limit })
      + (warning ? ` · ${t('assistant.context.ring_nearly_full')}` : '')
  const detail = room === null ? null : t('assistant.context.meter_detail', { used, limit, turns: messages.length })
  return (
    <>
      <Tooltip
        side="bottom"
        label={room === null
          ? summary
          : (
            <>
              {summary}
              <span className="text-[var(--text-tertiary)]">{t('assistant.context.meter_scope')}</span>
            </>
          )}
      >
        <IconButton
          label={summary}
          size="sm"
          ref={anchorRef}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((current) => !current)}
          className={cn(open && 'bg-[var(--bg-active)]')}
        >
          <UsageRing percent={percent} warning={warning} valueText={detail} />
        </IconButton>
      </Tooltip>
      {open && (
        <UsagePanel id={panelId} anchor={anchorRef} onClose={() => setOpen(false)}>
          <p className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{summary}</p>
          {room === null ? (
            <>
              <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-secondary)]">
                {t('assistant.context.ring_unknown_hint')}
              </p>
              {/* The window is set from the composer, so the panel that explains the gap has to say where the
                  door is rather than leave the reader hunting for a number that cannot appear. */}
              <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
                {t('assistant.context.ring_unknown_where')}
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-secondary)]">
                {t('assistant.context.meter_scope')}
                {hasMore && ` · ${t('assistant.context.meter_older')}`}
              </p>
              <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
                {detail}
              </p>
              {/* Spoken as well as drawn, and kept in the same breath as the number: a warning only a press
                  could reach would be a warning most readers never get. */}
              {warning && (
                <p role="status" className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--warning)]">
                  {t('assistant.context.meter_warning')}
                </p>
              )}
            </>
          )}
        </UsagePanel>
      )}
    </>
  )
}

/**
 * The ring itself: an arc of the circle the reading occupies, on a track that is always whole.
 *
 * The box, the track and the stroke all come from the token scale, and the only number the reading writes
 * is the dash offset — which is the measurement, not a style rule. With no reading to show the arc is simply
 * not drawn, so an unknown window looks empty rather than full, and carries no value: a `aria-valuetext`
 * beside an absent `aria-valuenow` would be read as a reading that has none.
 */
function UsageRing({ percent, warning, valueText }: { percent: number | null, warning: boolean, valueText: string | null }) {
  return (
    <span
      role="progressbar"
      aria-label={t('assistant.context.meter_label')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={valueText ?? undefined}
      className="inline-flex shrink-0"
    >
      <svg
        viewBox={`0 0 ${RING_BOX} ${RING_BOX}`}
        fill="none"
        aria-hidden="true"
        className="size-[var(--sp-4)] -rotate-90"
      >
        <circle
          cx={RING_BOX / 2}
          cy={RING_BOX / 2}
          r={RING_RADIUS}
          strokeWidth={RING_STROKE}
          className="stroke-[color:var(--border-strong)]"
        />
        {percent !== null && (
          <circle
            data-context-arc="1"
            cx={RING_BOX / 2}
            cy={RING_BOX / 2}
            r={RING_RADIUS}
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - percent / 100)}
            className={cn(
              'transition-[stroke-dashoffset] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              warning ? 'stroke-[color:var(--warning)]' : 'stroke-[color:var(--accent)]',
            )}
          />
        )}
      </svg>
    </span>
  )
}

/**
 * The long half of the answer, hung under the ring that was pressed.
 *
 * A portal, because either header can draw it and the transcript under a header clips anything that tries to
 * live inside it. Its place is measured rather than assumed — the panel's own box, the button's box, the
 * visible viewport — which is what lets one path serve a 380px dock column and a desktop window: nothing here
 * knows how tall the panel is, so nothing here has to guess. In a layout engine that reports no boxes the
 * panel stays where it is put and invisible, and its words are still in the document.
 */
function UsagePanel({ id, anchor, onClose, children }: {
  id: string
  anchor: { current: HTMLElement | null }
  onClose: () => void
  children: React.ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<{ top: number, left: number } | null>(null)
  useEscape(true, onClose)
  useClickOutside([panelRef, anchor], true, onClose)
  useLayoutEffect(() => {
    const measure = (): void => {
      const panel = panelRef.current
      const box = anchor.current?.getBoundingClientRect()
      const self = panel?.getBoundingClientRect()
      if (!panel || !box || !self || !(box.width || box.height) || !(self.width && self.height)) return
      const placed = placePanel({
        anchor: box,
        size: { width: self.width, height: self.height },
        viewport: getVisibleViewport(),
        align: 'end',
      })
      // Compared, not replaced: the resize and scroll listeners below would otherwise feed this effect an
      // endless render for a panel that never moved.
      setPlacement((current) => (current && current.top === placed.top && current.left === placed.left
        ? current
        : { top: placed.top, left: placed.left }))
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [anchor])
  // A panel with no reading from the layout engine is put aside rather than left to stack over the header.
  const style: React.CSSProperties = placement
    ? { top: placement.top, left: placement.left }
    : { top: 0, left: -9999 }
  return createPortal(
    <div
      ref={panelRef}
      id={id}
      role="note"
      aria-label={t('assistant.context.meter_label')}
      style={style}
      className={cn(
        'fixed z-[var(--z-popover)] w-64 rounded-[var(--r-lg)] border border-[var(--border-default)]',
        'bg-[var(--bg-overlay)] p-2.5 shadow-[var(--shadow-pop)]',
        placement ? 'anim-pop' : 'invisible',
      )}
    >
      {children}
    </div>,
    document.body,
  )
}
