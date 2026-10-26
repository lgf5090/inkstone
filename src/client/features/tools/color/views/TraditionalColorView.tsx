import { useMemo, useState } from 'react'
import { FilterInput } from '../../../../components/FilterInput'
import { compileQuery } from '../../../../lib/query-match'
import {
  TRADITIONAL_CHINESE_COLORS,
  TRADITIONAL_NIPPON_COLORS,
} from '@shared/tools/color/presets'
import type { TraditionalColorItem } from '@shared/tools/color/types'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { TraditionalColorCard } from '../components/TraditionalColorCard'
import { useColorStudioStore } from '../store'

export function TraditionalColorView() {
  const traditionalTab = useColorStudioStore((s) => s.traditionalTab)
  const setTraditionalTab = useColorStudioStore((s) => s.setTraditionalTab)

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedSeries, setSelectedSeries] = useState<string>('all')

  const compiledQuery = useMemo(() => compileQuery(searchQuery), [searchQuery])

  const currentDataset: TraditionalColorItem[] = useMemo(() => {
    return traditionalTab === 'chinese'
      ? TRADITIONAL_CHINESE_COLORS
      : TRADITIONAL_NIPPON_COLORS
  }, [traditionalTab])

  // Extract distinct series
  const seriesList = useMemo(() => {
    const set = new Set<string>()
    for (const item of currentDataset) {
      if (item.series) set.add(item.series)
    }
    return Array.from(set)
  }, [currentDataset])

  const filteredColors = useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    return currentDataset.filter((item) => {
      if (selectedSeries !== 'all' && item.series !== selectedSeries) {
        return false
      }
      if (!q) return true
      return (
        item.name.toLowerCase().includes(q) ||
        item.hex.toLowerCase().includes(q) ||
        (item.pinyin && item.pinyin.toLowerCase().includes(q)) ||
        (item.romaji && item.romaji.toLowerCase().includes(q)) ||
        (item.solarTerm && item.solarTerm.toLowerCase().includes(q))
      )
    })
  }, [currentDataset, selectedSeries, searchQuery])

  return (
    <div className="flex flex-col gap-6 w-full max-w-5xl mx-auto p-4 md:p-6 overflow-y-auto">
      {/* Header */}
      <div className="flex flex-col gap-1 border-b border-[var(--border-subtle)] pb-4">
        <h2 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {t('tools.color.traditional.title')}
        </h2>
        <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {t('tools.color.traditional.subtitle')}
        </p>
      </div>

      {/* Primary Tabs: Chinese vs Nippon */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          className="flex items-center gap-1.5 p-1 rounded-[var(--r-md)] bg-[var(--bg-sunken)] border border-[var(--border-subtle)]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={traditionalTab === 'chinese'}
            onClick={() => {
              setTraditionalTab('chinese')
              setSelectedSeries('all')
            }}
            className={cn(
              'px-3.5 py-1.5 rounded-[var(--r-sm)] text-[length:var(--text-12)] font-medium transition-colors select-none',
              traditionalTab === 'chinese'
                ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-xs'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
            )}
          >
            {t('tools.color.traditional.tab_chinese')} ({TRADITIONAL_CHINESE_COLORS.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={traditionalTab === 'nippon'}
            onClick={() => {
              setTraditionalTab('nippon')
              setSelectedSeries('all')
            }}
            className={cn(
              'px-3.5 py-1.5 rounded-[var(--r-sm)] text-[length:var(--text-12)] font-medium transition-colors select-none',
              traditionalTab === 'nippon'
                ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-xs'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
            )}
          >
            {t('tools.color.traditional.tab_nippon')} ({TRADITIONAL_NIPPON_COLORS.length})
          </button>
        </div>

        {/* Search */}
        <div className="w-full sm:w-64">
          <FilterInput
            size="panel"
            className="mt-0"
            value={searchQuery}
            onChange={setSearchQuery}
            query={compiledQuery}
            label={t('tools.color.traditional.search_placeholder')}
            placeholder={t('tools.color.traditional.search_placeholder')}
          />
        </div>
      </div>

      {/* Series Filter Dots */}
      {seriesList.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)] mr-1">
            {t('tools.color.traditional.filter_series')}:
          </span>
          <button
            type="button"
            onClick={() => setSelectedSeries('all')}
            className={cn(
              'px-2.5 py-1 rounded-full text-[length:var(--text-11)] font-medium transition-colors',
              selectedSeries === 'all'
                ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)] border border-[var(--accent)]'
                : 'bg-[var(--bg-sunken)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)]',
            )}
          >
            {t('tools.color.traditional.all_series')}
          </button>
          {seriesList.map((series) => (
            <button
              key={series}
              type="button"
              onClick={() => setSelectedSeries(series)}
              className={cn(
                'px-2.5 py-1 rounded-full text-[length:var(--text-11)] font-medium transition-colors',
                selectedSeries === series
                  ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)] border border-[var(--accent)]'
                  : 'bg-[var(--bg-sunken)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)]',
              )}
            >
              {series}
            </button>
          ))}
        </div>
      )}

      {/* Color Cards Grid */}
      {filteredColors.length === 0 ? (
        <div className="p-12 text-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">
          {t('tools.color.traditional.empty')}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {filteredColors.map((color) => (
            <TraditionalColorCard
              key={`${color.name}-${color.hex}`}
              color={color}
            />
          ))}
        </div>
      )}
    </div>
  )
}
