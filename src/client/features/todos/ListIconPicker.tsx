/**
 * The list-icon picker: the to-do app's own glyph set, plus the notebook's whole emoji catalogue.
 *
 * The grid is not a menu — it lives inside the list dialog, where it has the room to be read rather
 * than scanned. Two tabs keep the two vocabularies apart: a curated lucide set grouped by what a list
 * is about, and the emoji catalogue the folder picker already loads (with the same search, the same
 * recent row and the same pinyin matching), so a reader who picked 🏠 for a folder can pick it here
 * and find it the same way.
 */
import { useEffect, useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t, useLocale } from '../../lib/i18n'
import { useFilterInput } from '../../components/FilterInput'
import { IconButton } from '../../components/primitives'
import { usePinyinVersion } from '../../lib/pinyin'
import {
  loadEmojiCatalog,
  searchEmojiIn,
  type EmojiCategory,
  type EmojiEntry,
} from '../../lib/emoji-catalog'
import { pushRecentIcon, useFolderPreferences } from '../../lib/folder-prefs'
import { LIST_ICON_GROUPS, ListIcon } from './list-icons'

const EMOJI_LIMIT = 120

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'min-h-9 rounded-[var(--r-sm)] px-2.5 text-[length:var(--text-12)] transition-colors',
        active
          ? 'bg-[var(--bg-surface)] font-medium text-[var(--text-primary)] shadow-[var(--shadow-xs)]'
          : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]',
      )}
    >
      {children}
    </button>
  )
}

function IconTile({ active, label, onClick, children }: {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex size-9 items-center justify-center rounded-[var(--r-sm)] transition-colors',
        active
          ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent-ring)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      {children}
    </button>
  )
}

export function ListIconPicker({ value, onChange }: {
  value: string | null
  onChange: (icon: string | null) => void
}) {
  const [tab, setTab] = useState<'icons' | 'emoji'>('icons')
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<readonly EmojiCategory[] | null>(null)
  const { recentIcons } = useFolderPreferences()
  const locale = useLocale()
  const pinyinVersion = usePinyinVersion()
  const trimmed = query.trim()
  // The box owns the Escape that would otherwise reach the dialog around the picker, the same
  // contract every listing and the emoji picker answer: a box holding text clears on Escape, an
  // empty one hands the key to the dialog behind it.
  const { field, clear } = useFilterInput({
    value: query,
    escapeWhenEmpty: 'release',
    onClear: () => setQuery(''),
  })

  useEffect(() => {
    if (tab !== 'emoji' || catalog !== null) return
    let alive = true
    loadEmojiCatalog().then((module) => {
      if (alive) setCatalog(module.EMOJI_ICON_CATEGORIES)
    }, () => {
      if (alive) setCatalog([])
    })
    return () => { alive = false }
  }, [tab, catalog])

  const emojiMatches = useMemo(() => {
    if (!catalog || !trimmed) return null
    const lower = trimmed.toLocaleLowerCase()
    const named = catalog.filter((category) => t(category.labelKey).toLocaleLowerCase().includes(lower))
    const found = new Map<string, EmojiEntry>()
    for (const category of named) for (const entry of category.entries) found.set(entry.char, entry)
    for (const entry of searchEmojiIn(catalog.flatMap((category) => category.entries), trimmed)) found.set(entry.char, entry)
    return [...found.values()].slice(0, EMOJI_LIMIT)
  }, [catalog, trimmed, locale, pinyinVersion])

  const pickEmoji = (char: string): void => {
    pushRecentIcon(char)
    onChange(char)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div role="tablist" aria-label={t('todo.list.icon_label')} className="flex gap-0.5 rounded-[var(--r-md)] bg-[var(--bg-inset)] p-0.5">
          <TabButton active={tab === 'icons'} onClick={() => setTab('icons')}>{t('todo.icon.tab_icons')}</TabButton>
          <TabButton active={tab === 'emoji'} onClick={() => setTab('emoji')}>{t('todo.icon.tab_emoji')}</TabButton>
        </div>
        {tab === 'emoji' && (
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">{t('todo.icon.search')}</span>
            <Search size={12} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[var(--text-quaternary)]" />
            <input
              {...field}
              data-owns-escape={query ? '1' : undefined}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('todo.icon.search')}
              autoComplete="off"
              className="h-9 w-full rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] pr-7 pl-7 text-[length:var(--text-12)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)] focus:border-[var(--accent)]"
            />
            {query && (
              <IconButton label={t('overlay.clear_search')} size="sm" onClick={clear} className="absolute top-1/2 right-1 -translate-y-1/2">
                <X size={11} />
              </IconButton>
            )}
          </label>
        )}
      </div>

      {tab === 'icons' ? (
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto pr-0.5">
          {LIST_ICON_GROUPS.map((group) => (
            <section key={group.id} aria-label={t(group.labelKey)}>
              <h4 className="px-0.5 pb-1 text-[length:var(--text-10-5)] font-medium uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
                {t(group.labelKey)}
              </h4>
              <div role="group" aria-label={t(group.labelKey)} className="grid grid-cols-6 gap-1">
                {group.icons.map((option) => {
                  const stored = `lucide:${option.name}`
                  return (
                    <IconTile key={option.name} active={value === stored} label={t(option.labelKey)} onClick={() => onChange(stored)}>
                      <ListIcon icon={stored} size={16} />
                    </IconTile>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto pr-0.5">
          {catalog === null && (
            <p className="px-1 py-6 text-center text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('todo.icon.loading')}</p>
          )}
          {catalog !== null && emojiMatches === null && recentIcons.length > 0 && (
            <section aria-label={t('todo.icon.recent')}>
              <h4 className="px-0.5 pb-1 text-[length:var(--text-10-5)] font-medium uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">{t('todo.icon.recent')}</h4>
              <div role="group" aria-label={t('todo.icon.recent')} className="grid grid-cols-8 gap-1">
                {recentIcons.map((char) => (
                  <IconTile key={char} active={value === char} label={char} onClick={() => pickEmoji(char)}>
                    <span className="text-[length:var(--text-15)] leading-none">{char}</span>
                  </IconTile>
                ))}
              </div>
            </section>
          )}
          {catalog !== null && emojiMatches === null && catalog.map((category) => (
            <section key={category.id} aria-label={t(category.labelKey)}>
              <h4 className="px-0.5 pb-1 text-[length:var(--text-10-5)] font-medium uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">{t(category.labelKey)}</h4>
              <div role="group" aria-label={t(category.labelKey)} className="grid grid-cols-8 gap-1">
                {category.entries.map((entry) => (
                  <IconTile key={entry.char} active={value === entry.char} label={entry.char} onClick={() => pickEmoji(entry.char)}>
                    <span className="text-[length:var(--text-15)] leading-none">{entry.char}</span>
                  </IconTile>
                ))}
              </div>
            </section>
          ))}
          {emojiMatches !== null && emojiMatches.length > 0 && (
            <div role="group" aria-label={t('todo.icon.matches')} className="grid grid-cols-8 gap-1">
              {emojiMatches.map((entry) => (
                <IconTile key={entry.char} active={value === entry.char} label={entry.char} onClick={() => pickEmoji(entry.char)}>
                  <span className="text-[length:var(--text-15)] leading-none">{entry.char}</span>
                </IconTile>
              ))}
            </div>
          )}
          {emojiMatches !== null && emojiMatches.length === 0 && (
            <p className="px-1 py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('todo.icon.no_match')}</p>
          )}
        </div>
      )}
    </div>
  )
}
