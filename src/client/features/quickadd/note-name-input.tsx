/**
 * The field that names a note, offering the names the library already has.
 *
 * The rows say where each name already lives, because two notes called `Standup` in two folders are
 * two rows and only the folder tells the reader which one a capture is about to write into. What gets
 * saved is the bare title — the same answer a run resolves — so picking a row and typing the name
 * cannot come to different things.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Input } from '../../components/form'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { titleSuggestions } from '../../lib/quickadd/context'
import { compileQuery, queryMatches } from '../../lib/query-match'
import { usePinyinVersion } from '../../lib/pinyin'

/** Rows a reader can scan at a glance; past this the list is a search result, and it says so. */
const MAX_ROWS = 50

/** Names looked at before filtering. Titles are deduped first, so this is names, not notes. */
const MAX_SCANNED = 1000

export interface NoteNameCandidate {
  title: string
  folderPath: string | null
}

interface Row {
  title: string
  display: string
}

export function NoteNameInput({ value, onChange, notes, id, className, ...aria }: {
  value: string
  onChange: (next: string) => void
  notes: NoteNameCandidate[]
  id?: string
  className?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
}) {
  const pinyinVersion = usePinyinVersion()
  const listId = `${useId()}-list`
  const rowId = (index: number): string => `${listId}-${index}`
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  const listing = useMemo(() => {
    const made = titleSuggestions(notes, t('navigation.unfiled'), MAX_SCANNED)
    const query = compileQuery(value)
    const matched: Row[] = []
    made.options.forEach((title, index) => {
      const display = made.displayOptions[index] ?? title
      if (query.text !== '' && !queryMatches(query, title) && !queryMatches(query, display)) return
      matched.push({ title, display })
    })
    return { rows: matched.slice(0, MAX_ROWS), hidden: Math.max(0, matched.length - MAX_ROWS), error: query.error }
    // `pinyinVersion` is a dependency because a Chinese match is computed from a dictionary that
    // arrives after boot: without it the list would keep the answer it made before the dictionary landed.
  }, [notes, value, pinyinVersion])
  const { rows, hidden, error } = listing

  useEffect(() => {
    setCursor((current) => (rows.length === 0 ? 0 : Math.min(current, rows.length - 1)))
  }, [rows.length])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-row-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open])

  const commit = useCallback((row: Row) => {
    onChange(row.title)
    setOpen(false)
  }, [onChange])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      // The list swallows the Escape that closed it; the second one is for whatever contains the field.
      if (open) {
        event.stopPropagation()
        setOpen(false)
      }
      return
    }
    if (event.key === 'Enter') {
      if (open && rows.length > 0) {
        event.preventDefault()
        commit(rows[Math.min(cursor, rows.length - 1)]!)
      }
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (rows.length === 0) return
    event.preventDefault()
    setOpen(true)
    const step = event.key === 'ArrowDown' ? 1 : -1
    setCursor((current) => Math.max(0, Math.min(rows.length - 1, open ? current + step : 0)))
  }, [commit, cursor, open, rows])

  return (
    <div className="space-y-1">
      <Input
        {...aria}
        id={id}
        // The overlay layers close a dialog on Escape from a window capture listener, which runs
        // before this field ever sees the key. Marking the field while its list is open is the app's
        // own way of saying "Escape means something here" — without it, the first Escape would take
        // the whole editor with it.
        data-owns-escape={open ? '' : undefined}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && rows.length > 0 ? rowId(Math.min(cursor, rows.length - 1)) : undefined}
        autoComplete="off"
        className={className}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
          setCursor(0)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {open && error && (
        <p role="status" className="text-[10.5px] text-[var(--danger)]">
          {error === 'syntax' ? t('filter.regex_syntax') : t('filter.regex_unsafe')}
        </p>
      )}
      {open && !error && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={t('quickadd.suggest_results')}
          className="max-h-[220px] overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]"
        >
          {rows.length === 0 && (
            <p className="px-3 py-4 text-center text-[11.5px] text-[var(--text-quaternary)]">
              {notes.length === 0 ? t('quickadd.suggest_none_yet') : t('quickadd.suggest_no_match')}
            </p>
          )}
          {rows.map((row, index) => (
            <button
              key={row.title}
              type="button"
              role="option"
              id={rowId(index)}
              aria-selected={index === cursor}
              title={row.display}
              data-row-index={index}
              data-suggestion={row.display}
              // A mousedown has to stay out of the way or the input blurs before the click lands,
              // and the field would close on its own half of the gesture.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setCursor(index)}
              onClick={() => commit(row)}
              className={cn(
                // A finger needs the 44px the app gives every other touch row; a mouse does not, and the
                // settings panel is dense enough that the desktop row stays at its text height.
                'block w-full truncate px-2.5 py-1.5 text-left transition-colors min-h-[44px] md:min-h-0',
                'text-[12.5px]',
                index === cursor ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
              )}
            >
              {row.display}
            </button>
          ))}
          {hidden > 0 && (
            <p className="px-2.5 py-1.5 text-[11px] text-[var(--text-quaternary)]">
              {t('quickadd.suggest_more', { count: String(hidden) })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
