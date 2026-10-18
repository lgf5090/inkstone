/**
 * The composer's control row.
 *
 * Each control is a menu anchored to a bare icon. Five of them share one row with the attachment chips
 * and the send button, and a word beside each icon pushed the row past the width of the box it sits in:
 * which model answers, how much it is asked to think, how much context it is given, and whether a write
 * waits for a click. What each one is set to therefore travels in the accessible name and in the tooltip
 * a pointer gets, never in a word drawn next to it.
 *
 * All four are per-conversation settings the assistant already stores — the chips are the same switches
 * the settings page has, moved to where the decision is actually made.
 */
import { useEffect, useId, useRef, useState } from 'react'
import {
  Brain,
  Check,
  Cpu,
  Eye,
  FilePlus2,
  FileText,
  FolderPlus,
  Gauge,
  Globe,
  Hash,
  Folder,
  Link2,
  Loader2,
  MessageSquareQuote,
  Mic,
  Plus,
  RefreshCw,
  Settings2,
  ShieldQuestion,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react'
import type { AssistantModel, AssistantReasoning, AssistantSkill, AssistantToolMode, AssistantTurnScope } from '@shared/assistant'
import { ASSISTANT_TOOL_MODES, TOKEN_STEPS } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { t, type MessageKey } from '../../lib/i18n'
import { Menu, Modal, Tooltip, prompt, submenuFor, type MenuItem } from '../../components/overlay'
import { Input } from '../../components/form'
import { IconButton } from '../../components/primitives'

export function ControlChip({
  label,
  value,
  icon,
  onClick,
  refObject,
  active,
  pressed,
  hint,
  disabled,
}: {
  label: string
  value?: string
  icon: React.ReactNode
  onClick: () => void
  refObject: React.RefObject<HTMLButtonElement | null>
  active?: boolean
  /** A control that cannot do anything right now, and says why in its hint rather than in a toast. */
  disabled?: boolean
  /** A chip that is a switch: the accent colour says which way it is set, and colour is not readable. */
  pressed?: boolean
  /** What the control does, for the pointer that has to hover it to find out. */
  hint?: string
}) {
  // There is no word on the chip any more, so the name is the only place the current value exists for
  // anyone reading the row out loud. What a pointer is told is the app's own tooltip rather than the
  // browser's `title`: the native one waits a second and paints in the operating system's chrome, which
  // on these five looked like a different application's.
  const name = value ? `${label}: ${value}` : label
  // A hint — and for a disabled control the reason it cannot be pressed — must not live only in a hover
  // tooltip: a thumb and a keyboard never fire `:hover`, and a dead control with no spoken reason reads
  // as a bug. The same words ride in the accessible description, held by a visually-hidden node the
  // control points at, so `hint` is a floor and the tooltip stays the pointer's convenience.
  const hintId = useId()
  return (
    <Tooltip label={hint ?? name}>
      <>
        <button
          ref={refObject}
          type="button"
          aria-label={name}
          {...(hint ? { 'aria-describedby': hintId } : {})}
          {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            'inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--r-md)] border border-transparent',
            'text-[var(--text-tertiary)] transition-[background-color,border-color,color,transform] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
            'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] active:scale-[0.94]',
            active
              ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
              : undefined,
            disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-[var(--text-tertiary)] active:scale-100',
          )}
        >
          {icon}
        </button>
        {hint && <span id={hintId} className="sr-only">{hint}</span>}
      </>
    </Tooltip>
  )
}

function useMenuAnchor() {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return { ref, open, toggle: () => setOpen((value) => !value), openMenu: () => setOpen(true), close: () => setOpen(false) }
}

export function ModelMenu({
  models,
  activeId,
  onPick,
  onManage,
  onVision,
  openRequest = 0,
}: {
  models: AssistantModel[]
  activeId: string | null
  onPick: (id: string) => void
  onManage: () => void
  onVision: (next: boolean) => void
  /**
   * How many times something outside this row has asked for the menu — the command palette, mostly.
   *
   * Counted rather than boolean because the second ask has to be able to raise a menu the reader closed in
   * between, and zero means nothing was asked, so a fresh mount never opens one by itself.
   */
  openRequest?: number
}) {
  const anchor = useMenuAnchor()
  useEffect(() => {
    if (openRequest) anchor.openMenu()
    // Only the ask itself moves the menu: an anchor rebuilt every render would reopen it on any keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest])
  const active = models.find((model) => model.id === activeId)
  const items: MenuItem[] = [
    ...models.map((model) => ({
      id: model.id,
      label: model.label || model.model,
      icon: model.id === activeId ? <Check size={13} /> : <Cpu size={13} />,
      onSelect: () => onPick(model.id),
    })),
    {
      id: 'vision',
      label: t('assistant.model.vision'),
      icon: <Eye size={13} />,
      checked: active?.vision === true,
      separatorBefore: true,
      onSelect: () => onVision(!(active?.vision ?? false)),
    },
    { id: 'manage', label: t('assistant.composer.manage_models'), icon: <Settings2 size={13} />, onSelect: onManage },
  ]
  return (
    <>
      <ControlChip
        refObject={anchor.ref}
        label={t('assistant.composer.model')}
        value={active ? active.label || active.model : t('assistant.composer.model_none')}
        icon={<Sparkles size={12} />}
        active={anchor.open}
        onClick={anchor.toggle}
      />
      <Menu anchor={anchor.ref} open={anchor.open} onClose={anchor.close} items={items} width={230} align="end" label={t('assistant.composer.model')} />
    </>
  )
}

export const REASONING_LABELS: Record<AssistantReasoning, MessageKey> = {
  auto: 'assistant.reasoning.auto',
  off: 'assistant.reasoning.off',
  minimal: 'assistant.reasoning.minimal',
  low: 'assistant.reasoning.low',
  medium: 'assistant.reasoning.medium',
  high: 'assistant.reasoning.high',
  xhigh: 'assistant.reasoning.xhigh',
  max: 'assistant.reasoning.max',
}

export function ReasoningMenu({
  value,
  rungs,
  disabled,
  onChange,
}: {
  value: AssistantReasoning
  /** The levels this model's own service has, in the order it publishes them. */
  rungs: AssistantReasoning[]
  disabled: boolean
  onChange: (next: AssistantReasoning) => void
}) {
  const anchor = useMenuAnchor()
  const items: MenuItem[] = rungs.map((level) => ({
    id: level,
    label: t(REASONING_LABELS[level]),
    icon: level === value ? <Check size={13} /> : undefined,
    disabled: level !== 'auto' && level !== 'off' && disabled,
    onSelect: () => onChange(level),
  }))
  return (
    <>
      <ControlChip
        refObject={anchor.ref}
        label={t('assistant.composer.thinking')}
        value={t(REASONING_LABELS[value])}
        icon={<Brain size={12} />}
        active={anchor.open}
        onClick={anchor.toggle}
      />
      <Menu anchor={anchor.ref} open={anchor.open} onClose={anchor.close} items={items} width={180} align="end" label={t('assistant.composer.thinking')} />
    </>
  )
}

/** The token count, spelled the way the reference's slider spells it: 32K, 128K, 262K. */
export function formatContext(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}K` : `${tokens}`
}

export function ContextMenu({
  value,
  onPick,
}: {
  value: number | null
  onPick: (tokens: number | null) => void
}) {
  const anchor = useMenuAnchor()
  const items: MenuItem[] = [
    {
      id: 'global',
      label: t('assistant.context.follow_global'),
      icon: value === null ? <Check size={13} /> : <Gauge size={13} />,
      onSelect: () => onPick(null),
    },
    ...TOKEN_STEPS.map((tokens) => ({
      id: String(tokens),
      label: formatContext(tokens),
      icon: value === tokens ? <Check size={13} /> : undefined,
      onSelect: () => onPick(tokens),
    })),
  ]
  return (
    <>
      <ControlChip
        refObject={anchor.ref}
        label={t('assistant.composer.context')}
        value={value === null ? t('assistant.context.follow_global') : formatContext(value)}
        icon={<Gauge size={12} />}
        active={anchor.open}
        onClick={anchor.toggle}
      />
      <Menu anchor={anchor.ref} open={anchor.open} onClose={anchor.close} items={items} width={160} align="end" label={t('assistant.composer.context')} />
    </>
  )
}

/**
 * The web-search chip.
 *
 * It asks for a live web search this turn. What that means depends on the model: two protocols have a
 * vendor-side search tool that is sent as-is; where there is none the worker queries the search engine the
 * reader configured with its own tool, and only if that is not set either does it fall back to pinning a
 * search-capable tool from the reader's MCP servers. A switch that could do none of the three would be
 * worse than no switch, because it would be believed.
 */
const SEARCH_REF: React.RefObject<HTMLButtonElement | null> = { current: null }

export function WebSearchMenu({ value, onChange, available = true, reason }: {
  value: boolean
  onChange: (next: boolean) => void
  /**
   * Whether this model can search at all.
   *
   * Three channels carry the switch, the same three the runner resolves: the vendor's own search on this
   * protocol, the built-in tool against an engine the reader configured, or a search-capable tool from the
   * reader's MCP servers. When none of them holds, the switch is drawn disabled with the reason, because a
   * switch that turns on and does nothing is worse than one that cannot be pressed.
   */
  available?: boolean
  /**
   * Which channel is missing, for the reader who has to fix it.
   *
   * Said by the caller, which is the only place that knows what was checked: a disabled control that names
   * one door is a setting to change, while one that names none is a broken app.
   */
  reason?: string
}) {
  const on = value && available
  return (
    <ControlChip
      label={t('assistant.composer.search')}
      value={on ? t('assistant.search.on') : t('assistant.search.off')}
      icon={<Globe size={12} />}
      active={on}
      pressed={on}
      disabled={!available}
      hint={available ? t('assistant.search.hint') : (reason ?? t('assistant.search.unavailable'))}
      onClick={() => onChange(!value)}
      refObject={SEARCH_REF}
    />
  )
}

export function ApprovalMenu({ mode, onChange }: { mode: AssistantToolMode, onChange: (next: AssistantToolMode) => void }) {
  const anchor = useMenuAnchor()
  const items: MenuItem[] = ASSISTANT_TOOL_MODES.map((entry) => ({
    id: entry,
    label: t(`assistant.approval.${entry}` as 'assistant.approval.ask'),
    icon: mode === entry ? <Check size={13} /> : undefined,
    onSelect: () => onChange(entry),
  }))
  return (
    <>
      <ControlChip
        refObject={anchor.ref}
        label={t('assistant.composer.approval')}
        value={t(`assistant.approval.${mode}` as 'assistant.approval.ask')}
        icon={<ShieldQuestion size={12} />}
        active={anchor.open}
        onClick={anchor.toggle}
      />
      <Menu anchor={anchor.ref} open={anchor.open} onClose={anchor.close} items={items} width={190} align="end" label={t('assistant.composer.approval')} />
    </>
  )
}

/**
 * One row of the composer's skill submenu.
 *
 * `text` is what goes into the box — a saved skill shows its title and inserts its words, while the
 * app's own openers have nothing behind them but the label. `skill` is the saved row itself, and a row
 * that has one brings its tools, its knowledge and its model along with the words.
 */
export interface QuickSkillRow {
  id: string
  label: string
  text?: string
  skill?: AssistantSkill
}

export function PlusMenu({
  onFiles,
  onFolder,
  onUrl,
  onNote,
  onPinNote,
  onSkill,
  skills,
  onManageSkills,
}: {
  onFiles: () => void
  onFolder: () => void
  onUrl: () => void
  onNote: () => void
  /** Add a note to the turn as a chip rather than citing it in the words. */
  onPinNote: () => void
  onSkill: (row: QuickSkillRow) => void
  skills: QuickSkillRow[]
  onManageSkills: () => void
}) {
  const anchor = useMenuAnchor()
  // The submenu's own list and the keyboard/search list are built from one array, so the manager entry cannot
  // appear in one and be missing from the other.
  const skillRows: QuickSkillRow[] = [...skills, { id: '__manage', label: t('assistant.skills.manage') }]
  const items: MenuItem[] = [
    { id: 'note', label: t('assistant.attach.reference_note'), icon: <MessageSquareQuote size={13} />, onSelect: onNote },
    { id: 'pin-note', label: t('assistant.attach.pin_note'), icon: <FileText size={13} />, onSelect: onPinNote },
    { id: 'file', label: t('assistant.attach.add_file'), icon: <FilePlus2 size={13} />, onSelect: onFiles },
    { id: 'folder', label: t('assistant.attach.add_folder'), icon: <FolderPlus size={13} />, onSelect: onFolder },
    { id: 'url', label: t('assistant.attach.add_url'), icon: <Link2 size={13} />, onSelect: onUrl },
    {
      id: 'skills',
      label: t('assistant.attach.quick_skills'),
      icon: <Wand2 size={13} />,
      separatorBefore: true,
      subItems: skillRows.map((skillEntry) => ({ id: skillEntry.id, label: skillEntry.label })),
      // The app's own submenu renderer, because the bare one it replaces drew its rows straight onto
      // the page: with no panel background the composer's own words showed through the menu.
      submenu: submenuFor(skillRows.map((skillEntry) => ({
        id: skillEntry.id,
        label: skillEntry.label,
        onSelect: () => (skillEntry.id === '__manage' ? onManageSkills() : onSkill(skillEntry)),
      })), 220),
    },
  ]
  return (
    <>
      <IconButton ref={anchor.ref} label={t('assistant.attach.menu')} size="sm" onClick={anchor.toggle} className="size-7 rounded-[var(--r-md)]">
        <Plus size={15} />
      </IconButton>
      <Menu anchor={anchor.ref} open={anchor.open} onClose={anchor.close} items={items} width={220} label={t('assistant.attach.menu')} />
    </>
  )
}

/** Picks a note to write about; the assistant reads it with its own note tools. */
export function NotePicker({
  open,
  onClose,
  onPick,
  search,
  title,
}: {
  open: boolean
  onClose: () => void
  onPick: (row: { id: string, title: string }) => void
  search: (query: string) => Promise<{ id: string, title: string }[]>
  /** What the picker is for: citing a note in the words, or adding one to the turn's context. */
  title?: string
}) {
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<{ id: string, title: string }[]>([])
  const [busy, setBusy] = useState(false)
  // A refused search is a different fact from "nothing matches", and hiding it behind the empty line was
  // the bug: the reader could not tell a dead request from a vault with no such note. `error` says which.
  const [error, setError] = useState<string | null>(null)
  // Which row the keyboard is on. The box keeps focus (a listbox the caret is not inside is not a
  // combobox), so the active row rides on `aria-activedescendant` rather than on its own tabindex.
  const [active, setActive] = useState(0)
  // A response that lost the race writes nothing — not its rows, not the end of a flag a newer request
  // still holds. One keystroke after another would otherwise let the slowest search land last.
  const request = useRef(0)
  const listId = useId()
  const optionId = (index: number) => `${listId}-row-${index}`

  const run = (value: string) => {
    const id = ++request.current
    setBusy(true)
    setError(null)
    setActive(0)
    search(value).then(
      (found) => {
        if (request.current === id) setRows(found)
      },
      (reason: unknown) => {
        if (request.current !== id) return
        setRows([])
        setError(reason instanceof Error ? reason.message : String(reason))
      },
    ).finally(() => {
      if (request.current === id) setBusy(false)
    })
  }

  const choose = (row: { id: string, title: string }) => {
    onPick(row)
    onClose()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Nothing to walk, the key belongs to the box: stepping against an empty list would set a NaN
      // index that `aria-activedescendant` then points at no row.
      if (!rows.length) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) => (current + step + rows.length) % rows.length)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Enter') {
      // An IME commit is not a pick: the keystroke belongs to the input method, not to the list.
      if (event.nativeEvent.isComposing) return
      event.preventDefault()
      const row = rows[active]
      if (row) choose(row)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title ?? t('assistant.attach.reference_note')} width={460} bodyClassName="p-3">
      <Input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          run(event.target.value)
        }}
        onKeyDown={onKeyDown}
        placeholder={t('assistant.attach.note_prompt')}
        aria-label={t('assistant.attach.note_prompt')}
        role="combobox"
        aria-expanded={rows.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={rows.length ? optionId(active) : undefined}
        autoFocus
      />
      <div
        id={listId}
        role="listbox"
        aria-label={t('assistant.attach.note_prompt')}
        aria-busy={busy}
        className="mt-2 max-h-[320px] overflow-y-auto"
      >
        {busy && (
          <p role="status" className="flex items-center gap-1.5 px-1 py-3 text-[length:var(--text-12)] text-[var(--text-quaternary)]">
            <Loader2 size={12} className="ink-chat-spin shrink-0" />
            {t('common.loading')}
          </p>
        )}
        {!busy && error && (
          // The one fact a failed search turns on is whether it can be asked again, so retry sits with the
          // reason rather than being left for the reader to rediscover by typing.
          <p role="alert" className="flex flex-wrap items-center gap-2 px-1 py-3 text-[length:var(--text-12)] text-[var(--danger)]">
            <span className="min-w-0 flex-1">{t('assistant.toast.failed')}</span>
            <button
              type="button"
              onClick={() => run(query)}
              className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-sm)] px-1.5 py-0.5 font-medium text-[var(--accent-on-soft)] hover:bg-[var(--accent-soft)]"
            >
              <RefreshCw size={11} />
              {t('common.retry')}
            </button>
          </p>
        )}
        {!busy && !error && !rows.length && (
          <p className="px-1 py-3 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.attach.note_none')}</p>
        )}
        {rows.map((row, index) => (
          <button
            key={row.id}
            id={optionId(index)}
            type="button"
            role="option"
            aria-selected={index === active}
            data-row={index}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(row)}
            className={cn(
              'block w-full truncate rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[length:var(--text-12-5)]',
              index === active
                ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            {row.title}
          </button>
        ))}
      </div>
    </Modal>
  )
}

/** One phrase the browser recognised. Final results are the only ones that may become text. */
interface SpeechResult {
  isFinal: boolean
  0: { transcript: string }
}

/** The event shape `SpeechRecognition.onresult` sends; `resultIndex` is where this event starts. */
interface SpeechResultEvent {
  /** The first result this event changed. Everything before it was reported by an earlier event. */
  resultIndex: number
  results: { length: number, [index: number]: SpeechResult }
}

interface SpeechEngine {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechResultEvent) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}

function speechRecognitionCtor(): (new () => SpeechEngine) | null {
  if (typeof window === 'undefined') return null
  const scope = window as unknown as Record<string, unknown>
  return (scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null) as (new () => SpeechEngine) | null
}

/**
 * Dictation, when the browser offers it.
 *
 * The button is drawn disabled rather than hidden on a browser without speech recognition: a control
 * that is missing is a feature the reader never learns exists, while a dead one with a reason is
 * legible.
 *
 * The engine is owned by this component for exactly as long as it is mounted. A microphone still open
 * after the reader closed the panel is not a dangling timer: it is an open microphone, so unmount and a
 * hidden tab both stop it rather than leaving it to the next press of a button that may never come.
 */
export function VoiceButton({ onText }: { onText: (chunk: string) => void }) {
  const [listening, setListening] = useState(false)
  const engineRef = useRef<SpeechEngine | null>(null)
  /**
   * The last result index already handed to the composer.
   *
   * `results` is the whole session's list, not this event's slice, and a browser may re-report a
   * finished phrase when a later one arrives. Walking from `resultIndex` (rather than from the end)
   * keeps the words in the order they were spoken, and this mark is what stops a final phrase being
   * appended twice.
   */
  const lastFinalRef = useRef(-1)

  const stopListening = () => {
    const engine = engineRef.current
    engineRef.current = null
    engine?.stop()
    setListening(false)
  }

  // Unmount is the panel closing, the route changing, the dock shutting: all of them end the turn's
  // dictation, and none of them has a reader left to press the button again.
  useEffect(() => () => {
    const engine = engineRef.current
    engineRef.current = null
    engine?.stop()
  }, [])

  // A tab the reader has moved away from should not keep listening; the engine would keep transcribing
  // into a box nobody is looking at, and the browser's recording indicator would stay lit.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stopListening()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  })

  const toggle = () => {
    if (listening) {
      stopListening()
      return
    }
    const Ctor = speechRecognitionCtor()
    if (!Ctor) {
      // Redundant rather than silent: `prompt()` in `components/overlay` only ever resolves — it answers
      // null with no host mounted and null on dismiss — so there is no rejection for this catch to
      // swallow. Recorded here and baselined; deleting it is a call for the gate's owner, not this slice.
      void prompt({ title: t('assistant.composer.voice_unsupported') }).catch(() => undefined)
      return
    }
    const engine = new Ctor()
    engine.lang = document.documentElement.lang || 'zh-CN'
    engine.continuous = true
    engine.interimResults = false
    lastFinalRef.current = -1
    engine.onresult = (event) => {
      const results = event.results
      // Only this event's slice, and only from the first final phrase not already handed over: the list
      // is cumulative, so a walk over all of it would repeat every earlier sentence on each result.
      for (let index = Math.max(event.resultIndex ?? 0, lastFinalRef.current + 1); index < results.length; index++) {
        const result = results[index]
        if (!result?.isFinal) continue
        lastFinalRef.current = index
        const chunk = result[0]?.transcript
        if (chunk) onText(chunk)
      }
    }
    const settle = () => {
      // An engine that ended on its own must not be mistaken for one this component still owns: the
      // cleanup of a newer engine, or an unmount, may already have replaced it.
      if (engineRef.current !== engine) return
      engineRef.current = null
      setListening(false)
    }
    engine.onend = settle
    engine.onerror = settle
    try {
      engine.start()
    } catch {
      // Starting can be refused (no microphone, permission revoked, or a start already in flight). Best
      // effort: the button returns to its off state and says why, rather than staying lit over a dead
      // engine.
      engineRef.current = null
      setListening(false)
      // The failure is already state and a prompt; the prompt only ever resolves (see the
      // no-microphone branch above), so there is no rejection left for a catch to ignore.
      void prompt({ title: t('assistant.composer.voice_failed') })
      return
    }
    engineRef.current = engine
    setListening(true)
  }

  return (
    <IconButton
      label={listening ? t('assistant.composer.voice_stop') : t('assistant.composer.voice')}
      size="sm"
      onClick={toggle}
      className={cn('size-7 rounded-[var(--r-md)]', listening && 'text-[var(--accent)]')}
    >
      <Mic size={14} />
    </IconButton>
  )
}

/** The word each scope kind is called, so a chip can name what it limits rather than only what it is. */
export const SCOPE_KIND_LABELS: Record<AssistantTurnScope['kind'], MessageKey> = {
  tag: 'assistant.scope.kind.tag',
  folder: 'assistant.scope.kind.folder',
  note: 'assistant.scope.kind.note',
}

function scopeIcon(kind: AssistantTurnScope['kind'], size: number) {
  if (kind === 'folder') return <Folder size={size} />
  if (kind === 'note') return <FileText size={size} />
  return <Hash size={size} />
}

/**
 * One scope the current turn is limited to, drawn as a control rather than a label.
 *
 * A chip that only shows a name hides two things the reader coming back to the composer needs: what the
 * pin actually does (it narrows what the assistant may read this turn), and where to change it (the `#`
 * picker). So the name of the chip says "this turn is limited to the folder …" in full, the body is a
 * button that reaches the control that changes it, and only the small X removes it. Nothing here opens a
 * settings page — it hands the reader back to the composer's own scope control.
 */
export function ScopeChip({ scope, onDrop, onOpenScopes }: {
  scope: AssistantTurnScope
  onDrop: () => void
  onOpenScopes: () => void
}) {
  const name = t('assistant.scope.chip', { kind: t(SCOPE_KIND_LABELS[scope.kind]), name: scope.name })
  return (
    <Tooltip label={t('assistant.scope.open')}>
      <span className="flex max-w-full items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-sunken)] py-[1px] pl-0.5 pr-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
        <button
          type="button"
          aria-label={name}
          onClick={onOpenScopes}
          className="inline-flex min-w-0 items-center gap-1 rounded-[var(--r-sm)] px-1 py-0.5 transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          <span aria-hidden className="shrink-0">{scopeIcon(scope.kind, 11)}</span>
          <span className="min-w-0 truncate">{scope.name}</span>
        </button>
        <button
          type="button"
          aria-label={t('assistant.trigger.drop_scope', { name: scope.name })}
          onClick={onDrop}
          className="ink-tap-pad relative flex size-4 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:text-[var(--danger)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          <X size={9} />
        </button>
      </span>
    </Tooltip>
  )
}

/**
 * What a stored answer was allowed to read, spelled out where the reader can actually find it.
 *
 * The turn's scopes are stored with the message, but stored is not the same as surfaced: a chip that only
 * carries a mouse `title` is invisible to a keyboard and to a screen reader, and to a reader coming back
 * to an old thread it is the whole point — knowing the answer only saw this folder. So the names are in
 * the accessible text, grouped under a label that says what they limit, not hidden behind a hover.
 */
export function AnswerScopeProvenance({ scopes }: { scopes: AssistantTurnScope[] }) {
  if (!scopes.length) return null
  return (
    <div
      role="group"
      aria-label={t('assistant.scope.answer_saw')}
      className="flex flex-wrap items-center gap-1 text-[length:var(--text-10)] text-[var(--text-quaternary)]"
    >
      <span className="shrink-0">{t('assistant.scope.answer_saw')}</span>
      {scopes.map((scope) => (
        <span
          key={`${scope.kind}:${scope.id}`}
          className="inline-flex max-w-[180px] items-center gap-1 truncate rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5"
        >
          <span aria-hidden className="shrink-0">{scopeIcon(scope.kind, 10)}</span>
          <span className="min-w-0 truncate">
            {t(SCOPE_KIND_LABELS[scope.kind])} · {scope.name}
          </span>
        </span>
      ))}
    </div>
  )
}
