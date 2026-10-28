import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Search, X } from 'lucide-react'
import type { MusicSearchSuggestion, MusicSuggestionKind } from '@shared/music/api'
import { IconButton } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { isImeComposing } from '../../../lib/ime'
import { musicApi } from '../api'
import { useMusicUi } from '../store/ui'
import { musicText } from './labels'

/** A suggestion row is either a typed entity or a term saved on this device. */
type Candidate = MusicSearchSuggestion | string

const SUGGESTION_TYPE_KEYS: Record<MusicSuggestionKind, string> = {
  song: 'music.search.type.song',
  artist: 'music.search.type.artist',
  album: 'music.search.type.album',
  playlist: 'music.search.type.playlist',
}

function candidateName(candidate: Candidate): string {
  return typeof candidate === 'string' ? candidate : candidate.name
}

/**
 * The search field with its two suggestion sources: this device's history when the box is empty,
 * and the provider's typed suggestions while typing. The listbox is optional for the mouse, but
 * arrow keys and Enter are the same path a reader can use without one.
 */
export function MusicSearchBox({
  value,
  onChange,
  onCommit,
  onPickSuggestion,
}: {
  value: string
  onChange: (value: string) => void
  onCommit: (value: string) => void
  /** Opens a suggested entity directly; without it a pick falls back to searching its name. */
  onPickSuggestion?: (suggestion: MusicSearchSuggestion) => void
}): ReactElement {
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const blurTimer = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<MusicSearchSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(-1)
  const history = useMusicUi((state) => state.searchHistory)
  const term = value.trim()
  const items: Candidate[] = term ? suggestions : history
  const listOpen = open && (loading || items.length > 0)

  useEffect(() => {
    if (!open || !term) {
      setSuggestions([])
      setLoading(false)
      setActive(-1)
      return
    }
    let current = true
    setLoading(true)
    const timer = window.setTimeout(() => {
      musicApi.suggest(term)
        .then((answer) => {
          if (!current) return
          setSuggestions(answer.items.slice(0, 8))
          setActive(-1)
        })
        .catch(() => {
          // A failed suggestion is a quiet miss: the reader can still press Enter to search.
          if (current) setSuggestions([])
        })
        .finally(() => {
          if (current) setLoading(false)
        })
    }, 180)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [open, term])

  useEffect(() => () => {
    if (blurTimer.current !== null) window.clearTimeout(blurTimer.current)
  }, [])

  const closeLater = (): void => {
    if (blurTimer.current !== null) window.clearTimeout(blurTimer.current)
    blurTimer.current = window.setTimeout(() => {
      setOpen(false)
      setActive(-1)
    }, 120)
  }

  const choose = (candidate: Candidate): void => {
    if (typeof candidate === 'string') onCommit(candidate)
    else if (onPickSuggestion) onPickSuggestion(candidate)
    else onCommit(candidate.name)
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Enter chooses a candidate and the arrows page the list while a Chinese or Japanese input method
    // owns the keystroke; the box must not commit half a word from underneath it.
    if (isImeComposing(event)) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open || items.length === 0) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((index) => (index + step + items.length) % items.length)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (!open || items.length === 0) return
      event.preventDefault()
      setActive(event.key === 'Home' ? 0 : items.length - 1)
      return
    }
    if (event.key === 'Escape') {
      setOpen(false)
      setActive(-1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const candidate = open && active >= 0 ? items[active] : undefined
      if (candidate) {
        choose(candidate)
        return
      }
      setOpen(false)
      setActive(-1)
      onCommit(value)
    }
  }

  return (
    <div className="relative w-full">
      <Input
        ref={inputRef}
        type="search"
        value={value}
        leading={<Search size={14} aria-hidden="true" />}
        trailing={value ? (
          <IconButton
            label={musicText('music.search.clear')}
            size="xs"
            onClick={() => {
              onChange('')
              setSuggestions([])
              setActive(-1)
              setOpen(true)
              inputRef.current?.focus()
            }}
          >
            <X size={12} />
          </IconButton>
        ) : undefined}
        placeholder={musicText('music.search.placeholder')}
        aria-label={musicText('music.search.placeholder')}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={listOpen}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        onFocus={() => {
          if (blurTimer.current !== null) {
            window.clearTimeout(blurTimer.current)
            blurTimer.current = null
          }
          setOpen(true)
        }}
        onBlur={closeLater}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
      />
      {listOpen && (
        <div className="absolute inset-x-0 top-full z-[var(--z-popover)] mt-1 overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-overlay)] shadow-[var(--shadow-pop)]">
          <p className="px-3 pb-1 pt-2 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-section)] text-[var(--text-quaternary)]">
            {musicText(term ? 'music.search.suggest.title' : 'music.search.history.title')}
          </p>
          <ul id={listId} role="listbox" aria-label={musicText(term ? 'music.search.suggest.title' : 'music.search.history.title')} className="m-0 flex list-none flex-col p-1">
            {loading ? (
              <li role="status" className="px-2 py-1.5 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                {musicText('music.search.suggest.loading')}
              </li>
            ) : items.map((item, index) => {
              const suggestion = typeof item === 'string' ? null : item
              return (
                <li key={suggestion ? `${suggestion.kind}:${suggestion.id}` : `${item}-${index}`} role="presentation">
                  <button
                    id={`${listId}-${index}`}
                    type="button"
                    role="option"
                    aria-label={suggestion ? `${musicText(SUGGESTION_TYPE_KEYS[suggestion.kind])} ${suggestion.name}` : String(item)}
                    aria-selected={active === index}
                    className={active === index
                      ? 'flex w-full items-center rounded-[var(--r-sm)] bg-[var(--bg-hover)] px-2 py-1.5 text-left text-[length:var(--text-12-5)] text-[var(--text-primary)]'
                      : 'flex w-full items-center rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[length:var(--text-12-5)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(item)}
                  >
                    <Search size={12} aria-hidden="true" className="me-2 shrink-0 text-[var(--text-quaternary)]" />
                    {suggestion ? (
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="shrink-0 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-section)] text-[var(--text-quaternary)]">
                          {musicText(SUGGESTION_TYPE_KEYS[suggestion.kind])}
                        </span>
                        <span className="truncate">{suggestion.name}</span>
                        {suggestion.detail && (
                          <span className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                            {suggestion.detail}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="truncate">{candidateName(item)}</span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
