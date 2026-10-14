/**
 * The composer's control row.
 *
 * Each control is a menu anchored to a chip that names what it currently selects, so the state is
 * readable without opening anything: which model answers, how much it is asked to think, how much
 * context it is given, and whether a write waits for a click. All four are per-conversation settings
 * the assistant already stores — the chips are the same switches the settings page has, moved to where
 * the decision is actually made.
 */
import { useRef, useState } from 'react'
import {
  Brain,
  Check,
  Cpu,
  Eye,
  FilePlus2,
  FolderPlus,
  Gauge,
  Globe,
  Link2,
  MessageSquareQuote,
  Mic,
  Plus,
  Settings2,
  ShieldQuestion,
  Sparkles,
  Wand2,
} from 'lucide-react'
import type { AssistantModel, AssistantReasoning } from '@shared/assistant'
import { CONTEXT_TOKEN_STEPS } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { t, type MessageKey } from '../../lib/i18n'
import { Menu, Modal, prompt, submenuFor, type MenuItem } from '../../components/overlay'
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
  hideValueOnPhone = false,
}: {
  label: string
  value?: string
  icon: React.ReactNode
  onClick: () => void
  refObject: React.RefObject<HTMLButtonElement | null>
  active?: boolean
  /** A chip that is a switch: the accent colour says which way it is set, and colour is not readable. */
  pressed?: boolean
  /** What the control does, for the pointer that has to hover it to find out. */
  hint?: string
  /** Icon-only below the small breakpoint, for chips whose words are not needed to act. */
  hideValueOnPhone?: boolean
}) {
  return (
    <button
      ref={refObject}
      type="button"
      // An aria-label replaces the chip's text, so the current value has to be carried into the name or
      // it stops existing for anyone reading the row out loud — which is also the only way a phone, where
      // the word is hidden to make seven controls fit, keeps telling what a chip is set to.
      aria-label={value ? `${label}: ${value}` : label}
      title={hint ?? label}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      onClick={onClick}
      className={cn(
        'flex h-7 max-w-[46%] items-center gap-1 rounded-[var(--r-md)] border px-1.5 text-[length:var(--text-11-5)]',
        'transition-colors duration-[var(--dur-fast)]',
        active
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
          : 'border-transparent text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <span className="shrink-0">{icon}</span>
      {/* A phone has ~360px for seven controls, and eight full words pushed the row onto three lines and
          knocked the send button out of place. The word goes; the value stays in the accessible name. */}
      {value && <span className={cn('min-w-0 truncate sm:max-w-none', hideValueOnPhone ? 'max-w-0 overflow-hidden' : 'max-w-[58px]')}>{value}</span>}
    </button>
  )
}

function useMenuAnchor() {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return { ref, open, toggle: () => setOpen((value) => !value), close: () => setOpen(false) }
}

export function ModelMenu({
  models,
  activeId,
  onPick,
  onManage,
  onVision,
}: {
  models: AssistantModel[]
  activeId: string | null
  onPick: (id: string) => void
  onManage: () => void
  onVision: (next: boolean) => void
}) {
  const anchor = useMenuAnchor()
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
  low: 'assistant.reasoning.low',
  medium: 'assistant.reasoning.medium',
  high: 'assistant.reasoning.high',
}

export const REASONING_ORDER: AssistantReasoning[] = ['auto', 'off', 'low', 'medium', 'high']

export function ReasoningMenu({
  value,
  disabled,
  onChange,
}: {
  value: AssistantReasoning
  disabled: boolean
  onChange: (next: AssistantReasoning) => void
}) {
  const anchor = useMenuAnchor()
  const items: MenuItem[] = REASONING_ORDER.map((level) => ({
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
        hideValueOnPhone
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
    ...CONTEXT_TOKEN_STEPS.map((tokens) => ({
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
        hideValueOnPhone
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
 * vendor-side search tool that is sent as-is, and where there is none the assistant pins a search-capable
 * tool from the reader's own MCP servers instead. A switch that could do neither would be worse than no
 * switch, because it would be believed.
 */
const SEARCH_REF: React.RefObject<HTMLButtonElement | null> = { current: null }

export function WebSearchMenu({ value, onChange }: { value: boolean, onChange: (next: boolean) => void }) {
  return (
    <ControlChip
      label={t('assistant.composer.search')}
      value={value ? t('assistant.search.on') : t('assistant.search.off')}
      icon={<Globe size={12} />}
      active={value}
      pressed={value}
      hint={t('assistant.search.hint')}
      hideValueOnPhone
      onClick={() => onChange(!value)}
      refObject={SEARCH_REF}
    />
  )
}

export function ApprovalMenu({ auto, onChange }: { auto: boolean, onChange: (next: boolean) => void }) {
  const anchor = useMenuAnchor()
  const items: MenuItem[] = [
    { id: 'ask', label: t('assistant.approval.ask'), icon: !auto ? <Check size={13} /> : undefined, onSelect: () => onChange(false) },
    { id: 'auto', label: t('assistant.approval.auto'), icon: auto ? <Check size={13} /> : undefined, onSelect: () => onChange(true) },
  ]
  return (
    <>
      <ControlChip
        refObject={anchor.ref}
        label={t('assistant.composer.approval')}
        hideValueOnPhone
        value={auto ? t('assistant.approval.auto') : t('assistant.approval.ask')}
        icon={<ShieldQuestion size={12} />}
        active={anchor.open}
        onClick={anchor.toggle}
      />
      <Menu anchor={anchor.ref} open={anchor.open} onClose={anchor.close} items={items} width={190} align="end" label={t('assistant.composer.approval')} />
    </>
  )
}

export function PlusMenu({
  onFiles,
  onFolder,
  onUrl,
  onNote,
  onPrompt,
  prompts,
  onManagePrompts,
}: {
  onFiles: () => void
  onFolder: () => void
  onUrl: () => void
  onNote: () => void
  onPrompt: (text: string) => void
  /** `text` is what goes into the box; a saved prompt shows its title and inserts its content. */
  prompts: { id: string, label: string, text?: string }[]
  onManagePrompts: () => void
}) {
  const anchor = useMenuAnchor()
  // The submenu's own list and the keyboard/search list are built from one array, so the manager entry cannot
  // appear in one and be missing from the other.
  const promptRows = [...prompts, { id: '__manage', label: t('assistant.prompts.manage') }]
  const items: MenuItem[] = [
    { id: 'note', label: t('assistant.attach.reference_note'), icon: <MessageSquareQuote size={13} />, onSelect: onNote },
    { id: 'file', label: t('assistant.attach.add_file'), icon: <FilePlus2 size={13} />, onSelect: onFiles },
    { id: 'folder', label: t('assistant.attach.add_folder'), icon: <FolderPlus size={13} />, onSelect: onFolder },
    { id: 'url', label: t('assistant.attach.add_url'), icon: <Link2 size={13} />, onSelect: onUrl },
    {
      id: 'prompts',
      label: t('assistant.attach.quick_prompts'),
      icon: <Wand2 size={13} />,
      separatorBefore: true,
      subItems: promptRows.map((promptEntry) => ({ id: promptEntry.id, label: promptEntry.label })),
      // The app's own submenu renderer, because the bare one it replaces drew its rows straight onto
      // the page: with no panel background the composer's own words showed through the menu.
      submenu: submenuFor(promptRows.map((promptEntry) => ({
        id: promptEntry.id,
        label: promptEntry.label,
        onSelect: () => (promptEntry.id === '__manage' ? onManagePrompts() : onPrompt(promptEntry.text ?? promptEntry.label)),
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
}: {
  open: boolean
  onClose: () => void
  onPick: (title: string) => void
  search: (query: string) => Promise<{ id: string, title: string }[]>
}) {
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<{ id: string, title: string }[]>([])
  const [busy, setBusy] = useState(false)

  const run = async (value: string) => {
    setBusy(true)
    try {
      setRows(await search(value))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('assistant.attach.reference_note')} width={460} bodyClassName="p-3">
      <Input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          void run(event.target.value)
        }}
        placeholder={t('assistant.attach.note_prompt')}
        aria-label={t('assistant.attach.note_prompt')}
        autoFocus
      />
      <div className="mt-2 max-h-[320px] overflow-y-auto">
        {!rows.length && !busy && <p className="px-1 py-3 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.attach.note_none')}</p>}
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => {
              onPick(row.title)
              onClose()
            }}
            className="block w-full truncate rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[length:var(--text-12-5)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            {row.title}
          </button>
        ))}
      </div>
    </Modal>
  )
}

/**
 * Dictation, when the browser offers it.
 *
 * The button is drawn disabled rather than hidden on a browser without speech recognition: a control
 * that is missing is a feature the reader never learns exists, while a dead one with a reason is
 * legible.
 */
export function VoiceButton({ onText }: { onText: (chunk: string) => void }) {
  const [listening, setListening] = useState(false)
  const engineRef = useRef<{ stop: () => void } | null>(null)
  const supported = typeof window !== 'undefined'
    && Boolean((window as unknown as Record<string, unknown>).SpeechRecognition
      ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition)

  const toggle = () => {
    if (!supported) {
      void prompt({ title: t('assistant.composer.voice_unsupported') }).catch(() => undefined)
      return
    }
    if (listening) {
      engineRef.current?.stop()
      setListening(false)
      return
    }
    interface SpeechEngine {
      lang: string
      continuous: boolean
      interimResults: boolean
      onresult: ((event: { results: { length: number, [index: number]: { 0: { transcript: string } } } }) => void) | null
      onend: (() => void) | null
      onerror: (() => void) | null
      start: () => void
      stop: () => void
    }
    const Ctor = ((window as unknown as Record<string, unknown>).SpeechRecognition
      ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as new () => SpeechEngine
    const engine = new Ctor()
    engine.lang = document.documentElement.lang || 'zh-CN'
    engine.continuous = true
    engine.interimResults = false
    engine.onresult = (event) => {
      const results = event.results
      for (let index = results.length - 1; index >= 0; index--) {
        const chunk = results[index]?.[0]?.transcript
        if (chunk) onText(chunk)
      }
    }
    engine.onend = () => setListening(false)
    engine.onerror = () => setListening(false)
    engine.start()
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
