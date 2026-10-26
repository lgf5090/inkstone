import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { COLOR_HUNT_PALETTES } from '@shared/tools/color/presets/color-hunt-curated'
import { t } from '../../../../lib/i18n'
import { useColorStudioStore } from '../store'
import { ColorHuntCard } from '../components/ColorHuntCard'

export function ColorHuntPalettesView() {
  const [searchQuery, setSearchQuery] = useState('')
  const tagFilter = useColorStudioStore((s) => s.colorHuntTagFilter)
  const setTagFilter = useColorStudioStore((s) => s.setColorHuntTagFilter)

  const tags = useMemo(() => {
    const set = new Set<string>()
    COLOR_HUNT_PALETTES.forEach((p) => p.tags.forEach((t) => set.add(t)))
    return ['all', ...Array.from(set)]
  }, [])

  const filteredPalettes = useMemo(() => {
    return COLOR_HUNT_PALETTES.filter((p) => {
      const matchTag = tagFilter === 'all' || p.tags.includes(tagFilter)
      if (!matchTag) return false

      if (!searchQuery.trim()) return true
      const q = searchQuery.toLowerCase().trim()
      const titleMatch = p.title.toLowerCase().includes(q)
      const colorMatch = p.colors.some((hex) => hex.toLowerCase().includes(q))
      const tagMatch = p.tags.some((t) => t.toLowerCase().includes(q))
      return titleMatch || colorMatch || tagMatch
    })
  }, [tagFilter, searchQuery])

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6 space-y-6 bg-[var(--bg-base)]">
      {/* Header */}
      <div>
        <h2 className="text-[length:var(--text-18)] font-bold text-[var(--text-primary)]">
          {t('tools.color.hunt.title')}
        </h2>
        <p className="mt-1 text-[length:var(--text-13)] text-[var(--text-secondary)]">
          {t('tools.color.hunt.subtitle')}
        </p>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Tag chips */}
        <div className="flex flex-wrap items-center gap-1.5 overflow-x-auto pb-1">
          {tags.map((tag) => {
            const isSelected = tagFilter === tag
            return (
              <button
                key={tag}
                type="button"
                onClick={() => setTagFilter(tag)}
                className={`px-3 py-1 text-[length:var(--text-12)] font-medium capitalize rounded-full transition-colors whitespace-nowrap ${
                  isSelected
                    ? 'bg-[var(--brand-primary)] text-white shadow-xs'
                    : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:border-[var(--brand-primary)]'
                }`}
              >
                {tag === 'all' ? t('tools.color.hunt.filter_all') : tag}
              </button>
            )
          })}
        </div>

        {/* Search */}
        <div className="relative min-w-[200px] sm:w-64 shrink-0">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('tools.color.hunt.search_placeholder')}
            className="w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] pl-9 pr-3 py-1.5 text-[length:var(--text-13)] text-[var(--text-primary)] focus:border-[var(--brand-primary)] focus:outline-none"
          />
        </div>
      </div>

      {/* Palettes Grid */}
      {filteredPalettes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center text-[var(--text-tertiary)]">
          <p className="text-[length:var(--text-14)]">{t('tools.color.hunt.empty')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {filteredPalettes.map((palette) => (
            <ColorHuntCard key={palette.id} palette={palette} />
          ))}
        </div>
      )}
    </div>
  )
}
