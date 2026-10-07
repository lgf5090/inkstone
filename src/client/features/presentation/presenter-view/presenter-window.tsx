import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, Presentation, RotateCcw } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { IconButton, Spinner } from '../../../components/primitives'
import { Tooltip } from '../../../components/overlay'
import { PresenterSlidePreview } from './presenter-slide-preview'
import { formatDeckPosition, type DeckPosition } from '../deck-position'
import { hasBackwardMove, hasForwardMove } from '../presentation-state'
import { PresenterNextSlidePane, PresenterOutlinePane, PresenterSpeakerNotesPane } from './presenter-panes'
import { usePresenterTimer, useSlideTimings, type SlideTimings } from './use-presenter-timer'
import {
  formatClock,
  formatElapsed,
  presenterTokenFromLocation,
  usePresenterReceiver,
  type PresenterInboundCommand,
  type PresenterSlideState,
} from './use-presenter-channel'

export interface PresenterWindowProps {
  initialState?: PresenterSlideState
  onCommand?: (command: PresenterInboundCommand) => void
}

export function PresenterWindow({ initialState, onCommand }: PresenterWindowProps) {
  const token = useMemo(() => presenterTokenFromLocation(window.location.search), [])
  const channel = usePresenterReceiver(token)
  const state = initialState ?? channel.state
  const connected = initialState ? true : channel.connected
  const sendCommand = onCommand ?? channel.sendCommand

  usePresenterKeyNav(sendCommand)

  if (!state) {
    return (
      <div className='flex h-screen flex-col items-center justify-center gap-[var(--sp-3)] bg-[var(--bg-base)] text-[var(--text-secondary)]'>
        <Spinner size={24} />
        <p className='text-[length:var(--text-14)]'>{t('workspace.presentation_disconnected')}</p>
      </div>
    )
  }

  return (
    <div className='flex h-screen flex-col overflow-hidden bg-[var(--bg-base)] text-[var(--text-primary)] select-none'>
      <PresenterHeader state={state} connected={connected} sendCommand={sendCommand} />
      <div className='flex min-h-0 flex-1 gap-[var(--sp-3)] p-[var(--sp-3)]'>
        {/* The page on screen and what the speaker has to say about it share a column: the notes are read
            while the slide is up, so they belong under the slide the eye is already on rather than across
            the window from it (PR-M14). The freed column holds what comes next and the whole deck by name,
            which is where "go back to the numbers slide" stops being a hunt. */}
        <div className='flex flex-[3] min-w-0 flex-col gap-[var(--sp-3)]'>
          <PresenterCurrentSlidePane state={state} />
          <PresenterSpeakerNotesPane notes={state.notes} slideIndex={state.slideIndex} onEdit={(slide, text) => sendCommand({ editNotes: { slide, text } })} />
        </div>
        <div className='flex flex-[2] min-w-0 flex-col gap-[var(--sp-3)]'>
          <PresenterNextSlidePane
            nextSource={state.nextSlideSource}
            nextLayout={state.nextLayout}
            nextPlan={state.nextPlan}
            nextSubPage={state.nextSubPage}
            nextStep={state.nextStep}
            font={state.proseFont}
          />
          <PresenterOutlinePane titles={state.slideTitles} slideIndex={state.slideIndex} onJump={(index) => sendCommand({ jump: index })} />
        </div>
      </div>
    </div>
  )
}

// The console reads the show's own position: the same derivation, so the number the speaker sees is the
// number the room sees, reveal included (N-11 unified those surfaces and this one was left out).
function presenterDeckPosition(state: PresenterSlideState): DeckPosition {
  return { index: state.slideIndex, count: state.slideCount, subPage: state.subPage, pageCount: state.pageCount, step: state.step, steps: state.steps }
}

function PresenterCurrentSlidePane({ state }: { state: PresenterSlideState }) {
  return (
    <div data-presenter-current-pane className='flex flex-[1.7] min-h-0 flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--shadow-sm)]'>
      <div className='flex items-center justify-between border-b border-[var(--border-subtle)] px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]'>
        <span>{t('workspace.presentation_current_slide')}</span>
        <span data-presenter-position className='tabular text-[var(--text-tertiary)]'>{formatDeckPosition(presenterDeckPosition(state))}</span>
      </div>
      <div className='flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--bg-editor)] p-[var(--sp-3)]'>
        <PresenterSlidePreview
          source={state.currentSlideSource}
          layout={state.currentLayout}
          plan={state.currentPlan}
          sub={state.subPage}
          step={state.step}
          font={state.proseFont}
        />
      </div>
    </div>
  )
}

function PresenterHeader({
  state,
  connected,
  sendCommand,
}: {
  state: PresenterSlideState
  connected: boolean
  sendCommand: (command: PresenterInboundCommand) => void
}) {
  const clock = usePresenterClock()
  // The show ending is heard as the channel closing, not as a final message: the last page the room
  // saw stays on screen as a record, and so does the time it took (L-6).
  const timer = usePresenterTimer(state.startedAt, !connected)
  const timings = useSlideTimings(state.slideIndex, timer.elapsedSeconds)

  return (
    <header className='flex h-[var(--sp-12)] shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-[var(--sp-4)]'>
      <div className='flex items-center gap-[var(--sp-3)] min-w-0'>
        <div className='flex items-center gap-[var(--sp-1-5)] min-w-0'>
          <Presentation size={18} className='shrink-0 text-[var(--accent)]' />
          <span className='truncate font-semibold text-[length:var(--text-14)]'>
            {state.noteTitle || t('workspace.presentation_mode')}
          </span>
        </div>
        <ConnectionBadge connected={connected} />
      </div>

      <PresenterHeaderTimer timer={timer} clock={clock} frozen={!connected} timings={timings} />
      <PresenterHeaderStepper state={state} sendCommand={sendCommand} />
    </header>
  )
}

function PresenterHeaderTimer({
  timer,
  clock,
  frozen,
  timings,
}: {
  timer: ReturnType<typeof usePresenterTimer>
  clock: string
  frozen: boolean
  timings: SlideTimings
}) {
  return (
    <div className='flex items-center gap-[var(--sp-4)]'>
      <div className='flex items-center gap-[var(--sp-2)]'>
        {/* The accent is the one colour on this bar that means "look, something is off": a running
            clock is the normal state of a talk and painting it in it reads as overtime (PR-L4).
            It goes loud only when the timer is paused, and quiet once the show is over. */}
        <span
          data-presenter-clock
          className={cn(
            'tabular font-mono text-[length:var(--text-16)] font-semibold',
            frozen ? 'text-[var(--text-tertiary)]' : timer.isPaused ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]',
          )}
        >
          {formatElapsed(timer.elapsedSeconds)}
        </span>
        {/* The number a rehearsal is actually about: not how long the talk has been running, but how
            long this page has held the room — and, once the show is over, what the whole run cost
            across how many pages (PR-M9). */}
        <span data-presenter-slide-timing className='tabular text-[length:var(--text-12)] text-[var(--text-tertiary)]'>
          {frozen
            ? t('workspace.presentation_rehearsal_summary', { value0: timings.visited, value1: formatElapsed(timer.elapsedSeconds) })
            : t('workspace.presentation_slide_elapsed', { value0: formatElapsed(timings.currentSeconds) })}
        </span>
        <Tooltip label={timer.isPaused ? t('workspace.presentation_timer_resume') : t('workspace.presentation_timer_pause')}>
          <IconButton
            size='sm'
            label={timer.isPaused ? t('workspace.presentation_timer_resume') : t('workspace.presentation_timer_pause')}
            onClick={timer.togglePause}
            // Nothing to pause or reset on a show that is over: the numbers are a record, and
            // `togglePause` would count the silence since the room left as if the talk were running.
            disabled={frozen}
          >
            {timer.isPaused ? <Play size={13} /> : <Pause size={13} />}
          </IconButton>
        </Tooltip>
        <Tooltip label={t('workspace.presentation_timer_reset')}>
          <IconButton size='sm' label={t('workspace.presentation_timer_reset')} onClick={timer.resetTimer} disabled={frozen}>
            <RotateCcw size={13} />
          </IconButton>
        </Tooltip>
      </div>
      <span className='h-[var(--sp-4)] w-px bg-[var(--border-subtle)]' aria-hidden='true' />
      <span className='tabular font-mono text-[length:var(--text-14)] text-[var(--text-secondary)]'>
        {clock}
      </span>
    </div>
  )
}

function PresenterHeaderStepper({
  state,
  sendCommand,
}: {
  state: PresenterSlideState
  sendCommand: (command: PresenterInboundCommand) => void
}) {
  return (
    <div className='flex items-center gap-[var(--sp-2)]'>
      <div data-presenter-position className='tabular text-[length:var(--text-12)] text-[var(--text-secondary)]'>{formatDeckPosition(presenterDeckPosition(state))}</div>
      <Tooltip label={t('workspace.presentation_prev')}>
        <IconButton
          size='sm'
          label={t('workspace.presentation_prev')}
          disabled={!hasBackwardMove({ index: state.slideIndex, sub: state.subPage, step: state.step })}
          onClick={() => sendCommand('prev')}
        >
          <ChevronLeft size={16} />
        </IconButton>
      </Tooltip>
      <Tooltip label={t('workspace.presentation_next')}>
        <IconButton
          size='sm'
          label={t('workspace.presentation_next')}
          disabled={!hasForwardMove({ index: state.slideIndex, count: state.slideCount, sub: state.subPage, pageCount: state.pageCount, step: state.step, steps: state.steps })}
          onClick={() => sendCommand('next')}
        >
          <ChevronRight size={16} />
        </IconButton>
      </Tooltip>
    </div>
  )
}

function ConnectionBadge({ connected }: { connected: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[var(--sp-1)] text-[length:var(--text-11)] font-medium',
        connected ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]',
      )}
    >
      <span
        className={cn(
          'h-[var(--sp-2)] w-[var(--sp-2)] rounded-full',
          connected ? 'bg-[var(--accent)]' : 'bg-[var(--border-default)]',
        )}
      />
      {connected ? t('workspace.presentation_connected') : t('workspace.presentation_disconnected')}
    </span>
  )
}

function usePresenterClock() {
  const [clock, setClock] = useState(() => formatClock(new Date()))
  useEffect(() => {
    const id = window.setInterval(() => setClock(formatClock(new Date())), 1000)
    return () => window.clearInterval(id)
  }, [])
  return clock
}

function dispatchPresenterKey(key: string, sendCommand: (cmd: PresenterInboundCommand) => void): boolean {
  switch (key) {
    case 'ArrowRight':
    case 'PageDown':
    case ' ':
    case 'ArrowDown':
      sendCommand('next')
      return true
    case 'ArrowLeft':
    case 'PageUp':
    case 'ArrowUp':
      sendCommand('prev')
      return true
    case 'Home':
      sendCommand('first')
      return true
    case 'End':
      sendCommand('last')
      return true
    case 'Escape':
      window.close()
      return true
    default:
      return false
  }
}

function usePresenterKeyNav(sendCommand: (command: PresenterInboundCommand) => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const el = event.target instanceof Element ? event.target : null
      const isInput = Boolean(el?.closest('input, textarea, select, [contenteditable="true"]'))
      if (isInput) return

      const isControl = Boolean(el?.closest('button, a'))
      if (isControl && (event.key === ' ' || event.key === 'Enter')) return

      const inSpeakerNotes = Boolean(el?.closest('[data-speaker-notes]'))
      if (inSpeakerNotes && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) {
        return
      }

      if (dispatchPresenterKey(event.key, sendCommand)) {
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sendCommand])
}
