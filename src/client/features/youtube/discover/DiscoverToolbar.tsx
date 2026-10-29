import { useEffect, useRef, useState } from 'react'
import {
  ArrowUpDown,
  CalendarDays,
  Eye,
  Gauge,
  RefreshCw,
  Search,
  Sparkles,
  ThumbsUp,
  X,
} from 'lucide-react'
import type { YouTubeAddress, SortKey } from '@shared/youtube/model'
import { SORT_KEYS } from '@shared/youtube/model'
import type { MessageKey } from '@shared/locales/en-US'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Menu, type MenuItem } from '../../../components/overlay'
import { Input } from '../../../components/form'

const SORT_LABELS: Record<SortKey, MessageKey> = {
  relevance: 'youtube.sort.relevance',
  date: 'youtube.sort.date',
  viewCount: 'youtube.sort.view_count',
  rating: 'youtube.sort.rating',
}

const SORT_ICONS: Record<SortKey, typeof Sparkles> = {
  relevance: Sparkles,
  date: CalendarDays,
  viewCount: Eye,
  rating: ThumbsUp,
}

export function DiscoverToolbar({
  address,
  busy,
  onQueryChange,
  onSortChange,
  onRefresh,
  onOpenQuota,
}: {
  address: YouTubeAddress
  busy: boolean
  onQueryChange: (query: string) => void
  onSortChange: (sort: SortKey) => void
  onRefresh: () => void
  onOpenQuota: () => void
}) {
  const isExplore = address.view.kind === 'explore'
  const isLibrary = address.view.kind === 'library' || address.view.kind === 'tag'
  const [draft, setDraft] = useState(address.q)
  const [sortOpen, setSortOpen] = useState(false)
  const sortButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setDraft(address.q)
  }, [address.q])

  useEffect(() => {
    setSortOpen(false)
  }, [address.view.kind])

  const placeholder = isExplore
    ? t('youtube.toolbar.search_placeholder')
    : isLibrary
      ? t('youtube.toolbar.filter_library')
      : t('youtube.toolbar.filter_results')

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!isExplore || busy) return
    onQueryChange(draft.trim())
  }

  const change = (value: string) => {
    setDraft(value)
    if (!isExplore) onQueryChange(value)
  }

  const clear = () => {
    setDraft('')
    onQueryChange('')
  }

  const items: MenuItem[] = SORT_KEYS.map((sort) => {
    const Icon = SORT_ICONS[sort]
    return {
      id: `sort:${sort}`,
      label: t(SORT_LABELS[sort]),
      icon: <Icon size={13} />,
      checked: address.sort === sort,
      onSelect: () => {
        onSortChange(sort)
        setSortOpen(false)
      },
    }
  })

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
      <form
        role="search"
        onSubmit={submit}
        className="flex min-w-0 flex-1 basis-[220px] items-center gap-1"
      >
        <div className="min-w-0 flex-1">
          <Input
            type="text"
            value={draft}
            onChange={(event) => change(event.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            autoComplete="off"
            spellCheck={false}
            leading={<Search size={13} aria-hidden="true" />}
            trailing={
              draft ? (
                <IconButton
                  label={t('common.clear')}
                  size="xs"
                  onClick={clear}
                >
                  <X size={12} />
                </IconButton>
              ) : undefined
            }
          />
        </div>
        {isExplore && (
          <IconButton
            label={t('youtube.toolbar.search')}
            size="sm"
            type="submit"
            variant="secondary"
            disabled={busy}
          >
            {busy ? <Spinner size={13} /> : <Search size={13} />}
          </IconButton>
        )}
      </form>

      <div className="flex shrink-0 items-center gap-1">
        {isExplore && (
          <Button
            ref={sortButtonRef}
            size="sm"
            variant="secondary"
            onClick={() => setSortOpen(true)}
            aria-haspopup="menu"
            aria-expanded={sortOpen}
            icon={<ArrowUpDown size={13} />}
          >
            <span className="hidden sm:inline">{t('youtube.toolbar.sort')}</span>
            <span className="tabular text-[var(--text-tertiary)]">{t(SORT_LABELS[address.sort])}</span>
          </Button>
        )}
        <IconButton
          label={t('youtube.toolbar.refresh')}
          size="sm"
          disabled={busy}
          aria-busy={busy}
          onClick={onRefresh}
        >
          <RefreshCw size={15} className={cn(busy && 'animate-[ink-spin_.7s_linear_infinite]')} />
        </IconButton>
        <IconButton label={t('youtube.toolbar.quota')} size="sm" onClick={onOpenQuota}>
          <Gauge size={15} />
        </IconButton>
      </div>

      <Menu
        anchor={sortButtonRef}
        open={sortOpen}
        onClose={() => setSortOpen(false)}
        items={items}
        align="end"
        label={t('youtube.toolbar.sort')}
      />
    </div>
  )
}
