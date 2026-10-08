/**
 * The launcher: one searchable list of the account's QuickAdd choices.
 *
 * This is the surface the reference plugin opens with `Ctrl+Shift+A` — a modal where the reader types a
 * choice's name, or `>` in the command palette, and runs it. Two things are Inkstone's own decision
 * rather than a port: a group drills into its children instead of flattening them into the list (a
 * journal group with six daily captures is not six rows the reader has to read past), and Shift+Enter
 * runs a choice with a chosen day, which is the portable half of the reference's "pick a date"
 * commands and covers the backfill-a-past-day case without a command per choice.
 *
 * The engines are not imported here: a run pulls `runner.ts` on demand, so opening the list never
 * parses the capture or macro code.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, FolderTree, Inbox, LayoutTemplate, Search, Zap } from 'lucide-react'
import type { QuickAddChoice } from '@shared/quickadd'
import { childrenOf } from '@shared/quickadd'
import { cn } from '../../lib/cn'
import { fuzzyFilter } from '../../lib/fuzzy'
import { usePinyinVersion } from '../../lib/pinyin'
import { prettyCombo } from '../../lib/hotkeys'
import { Modal } from '../../components/overlay'
import { t } from '../../lib/i18n'
import type { MessageKey } from '@shared/locales/en-US'
import { useUi } from '../../store/ui'
import { useQuickAdd } from '../../store/quickadd'
import { askQuickAddPrompts } from './prompt-queue'
import { promptRequest } from '../../lib/quickadd/session'

const TYPE_ICON = {
  template: LayoutTemplate,
  capture: Inbox,
  macro: Zap,
  group: FolderTree,
} as const

const TYPE_LABEL_KEY = {
  template: 'quickadd.type_template',
  capture: 'quickadd.type_capture',
  macro: 'quickadd.type_macro',
  group: 'quickadd.type_group',
} as const satisfies Record<QuickAddChoice['type'], MessageKey>

interface LauncherRow {
  key: string
  choice: QuickAddChoice
  isGroup: boolean
  depth: number
  recent: boolean
}

function rowLabel(choice: QuickAddChoice): string {
  return choice.name
}

export default function QuickAddLauncher({ onClose }: { onClose: () => void }) {
  const choices = useQuickAdd((state) => state.choices)
  const settings = useQuickAdd((state) => state.settings)
  const activeNoteId = useUi((state) => state.activeNoteId)
  const [query, setQuery] = useState('')
  const [path, setPath] = useState<QuickAddChoice[]>([])
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const pinyinVersion = usePinyinVersion()

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const parent = path[path.length - 1] ?? null
  const scoped = parent ? childrenOf(choices, parent.id) : choices.filter((choice) => choice.parentId === null)

  const rows = useMemo(() => {
    const enabled = scoped.filter((choice) => choice.enabled)
    const wanted = query.trim() === ''
      ? enabled
      : fuzzyFilter(enabled, query, (choice) => rowLabel(choice)).map((match) => match.item)
    const listed: LauncherRow[] = wanted.map((choice) => ({
      key: choice.id,
      choice,
      isGroup: choice.type === 'group',
      depth: 0,
      recent: false,
    }))
    if (query.trim() !== '' || path.length > 0) return listed
    // Recents ride above the list only at the top of the tree with nothing typed: two views of the
    // same row would make the arrow keys ambiguous.
    const byId = new Map(choices.map((choice) => [choice.id, choice]))
    const recent = settings.recent
      .map((entry) => byId.get(entry.id))
      .filter((choice): choice is QuickAddChoice => Boolean(choice && choice.enabled && choice.parentId === null))
      .slice(0, 3)
      .map((choice) => ({
        key: `recent:${choice.id}`,
        choice,
        isGroup: choice.type === 'group',
        depth: 0,
        recent: true,
      }))
    const seen = new Set(recent.map((row) => row.choice.id))
    return [...recent, ...listed.filter((row) => !seen.has(row.choice.id))]
  }, [choices, path.length, pinyinVersion, query, scoped, settings.recent])

  useEffect(() => {
    setCursor((current) => (rows.length === 0 ? 0 : Math.min(current, rows.length - 1)))
  }, [rows.length])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const run = useCallback(async (choice: QuickAddChoice, pickDay: boolean) => {
    // A group is a place, not a thing that runs: the list stays open and shows what is inside it.
    if (isGroup(choice)) {
      setPath((current) => [...current, choice])
      setCursor(0)
      // The words that found the group have no business filtering what is inside it.
      setQuery('')
      return
    }
    onClose()
    let day: Date | undefined
    if (pickDay) {
      const answers = await askQuickAddPrompts({
        requests: [promptRequest({
          kind: 'date',
          key: 'day',
          label: t('quickadd.prompt_day'),
          dateFormat: settings.dateFormat,
        })],
        onePage: false,
        choiceId: choice.id,
        choiceName: choice.name,
      })
      const value = answers.get('day')
      const stamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
      if (!Number.isFinite(stamp)) return
      day = new Date(stamp)
    }
    const { runQuickAddChoice } = await import('../../lib/quickadd/runner')
    await runQuickAddChoice(choice.id, {
      sourceNoteId: activeNoteId ?? undefined,
      day,
    })
  }, [activeNoteId, onClose, settings.dateFormat])

  const activate = useCallback((row: LauncherRow, pickDay: boolean) => {
    void run(row.choice, pickDay)
  }, [run])

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setCursor((current) => (rows.length === 0 ? 0 : (current + step + rows.length) % rows.length))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setCursor(event.key === 'Home' ? 0 : Math.max(0, rows.length - 1))
      return
    }
    if (event.key === 'Enter') {
      const row = rows[cursor]
      if (!row) return
      event.preventDefault()
      activate(row, event.shiftKey)
      return
    }
    if (event.key === 'Backspace' && query === '' && path.length > 0) {
      event.preventDefault()
      setPath((current) => current.slice(0, -1))
    }
  }, [activate, cursor, path.length, query, rows])

  return (
    <Modal
      open
      onClose={onClose}
      title={path.length > 0 ? path[path.length - 1]!.name : t('quickadd.launcher_title')}
      description={t('quickadd.launcher_hint')}
      width={560}
    >
      <div className="space-y-2 p-4">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-quaternary)]"/>
          <input
            ref={inputRef}
            aria-label={t('quickadd.launcher_filter')}
            type="search"
            value={query}
            placeholder={t('quickadd.launcher_placeholder')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            className="h-9 w-full rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] pr-3 pl-8 text-[12.5px] outline-none focus:border-[var(--accent)]"
          />
        </div>
        {path.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setPath((current) => current.slice(0, -1))
              setQuery('')
            }}
            className="flex items-center gap-1 rounded-[var(--r-md)] px-1.5 py-1 text-[11.5px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <ChevronLeft size={13}/>{t('quickadd.launcher_up')}
          </button>
        )}
        <div
          ref={listRef}
          role="listbox"
          aria-label={t('quickadd.launcher_results')}
          className="max-h-[46vh] overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]"
        >
          {rows.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-[var(--text-quaternary)]">
              {choices.length === 0 ? t('quickadd.launcher_empty_library') : t('quickadd.launcher_no_match')}
            </p>
          )}
          {rows.map((row, index) => (
            <LauncherRowView
              key={row.key}
              row={row}
              index={index}
              active={index === cursor}
              onHover={() => setCursor(index)}
              onActivate={(pickDay) => activate(row, pickDay)}
            />
          ))}
        </div>
      </div>
    </Modal>
  )
}

function isGroup(choice: QuickAddChoice): boolean {
  return choice.type === 'group'
}

function LauncherRowView({ row, index, active, onHover, onActivate }: {
  row: LauncherRow
  index: number
  active: boolean
  onHover: () => void
  onActivate: (pickDay: boolean) => void
}) {
  const Icon = TYPE_ICON[row.choice.type]
  const combo = row.choice.hotkey
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-row-index={index}
      onMouseEnter={onHover}
      onClick={(event) => onActivate(event.shiftKey)}
      className={cn(
        'flex w-full items-center gap-2.5 border-b border-[var(--border-subtle)] px-2.5 py-2 text-left transition-colors last:border-b-0',
        active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
      )}
    >
      <span className={cn('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-quaternary)]')} style={{ color: row.choice.color ?? undefined }}>
        <Icon size={14}/>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-[var(--text-primary)]">{row.choice.name}</span>
        <span className="mt-0.5 block text-[11px] tabular text-[var(--text-quaternary)]">
          {row.recent ? t('quickadd.launcher_recent') : t(TYPE_LABEL_KEY[row.choice.type])}
        </span>
      </span>
      {combo && (
        <kbd className="shrink-0 rounded border border-[var(--border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
          {prettyCombo(combo).join('+')}
        </kbd>
      )}
      {row.isGroup && <ChevronRight size={14} className="shrink-0 text-[var(--text-quaternary)]"/>}
    </button>
  )
}
