import { useMemo, useState } from 'react'
import { FilterInput } from '../../../../components/FilterInput'
import { compileQuery, queryKeeps, queryKeepsRows } from '../../../../lib/query-match'
import { usePinyinVersion } from '../../../../lib/pinyin'
import {
  TRADITIONAL_CHINESE_COLORS,
  TRADITIONAL_NIPPON_COLORS,
} from '@shared/tools/color/presets'
import type { TraditionalColorItem } from '@shared/tools/color/types'
import { cn } from '../../../../lib/cn'
import { Segmented } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { TraditionalColorCard } from '../components/TraditionalColorCard'
import { useColorStudioStore } from '../store'

export function TraditionalColorView() {
  const traditionalTab = useColorStudioStore((s) => s.traditionalTab)
  const setTraditionalTab = useColorStudioStore((s) => s.setTraditionalTab)

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedSeries, setSelectedSeries] = useState<string>('all')

  const compiledQuery = useMemo(() => compileQuery(searchQuery), [searchQuery])

  // The reading table arrives after the first paint on a cold cache: a listing filtered before it lands
  // has to be filtered again once it is here, or the box keeps showing the answer typed before.
  const pinyinVersion = usePinyinVersion()

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
    const keep = (subject: string | undefined) =>
      subject !== undefined && queryKeeps(compiledQuery, subject)
    return currentDataset.filter((item) => {
      if (selectedSeries !== 'all' && item.series !== selectedSeries) {
        return false
      }
      if (queryKeepsRows(compiledQuery)) return true
      return (
        keep(item.name) ||
        keep(item.hex) ||
        keep(item.pinyin) ||
        keep(item.romaji) ||
        keep(item.solarTerm)
      )
    })
  }, [currentDataset, selectedSeries, compiledQuery, pinyinVersion])

  return (
    <div className="flex flex-col gap-6 w-full max-w-5xl mx-auto p-4 md:p-6 overflow-y-auto">
      {/* Header */}
      <div className="flex flex-col gap-1 border-b border-[var(--border-subtle)] pb-4">
        <h2 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {t('tools.color.traditional.title')}
        </h2>
        <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {t('tools.color.traditional.subtitle', { chinese: TRADITIONAL_CHINESE_COLORS.length, nippon: TRADITIONAL_NIPPON_COLORS.length })}
        </p>
      </div>

      {/* Primary Tabs: Chinese vs Nippon */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          size="sm"
          label={t('tools.color.traditional.title')}
          value={traditionalTab}
          onChange={(next) => {
            setTraditionalTab(next)
            setSelectedSeries('all')
          }}
          options={[
            { value: 'chinese' as const, label: `${t('tools.color.traditional.tab_chinese')} (${TRADITIONAL_CHINESE_COLORS.length})` },
            { value: 'nippon' as const, label: `${t('tools.color.traditional.tab_nippon')} (${TRADITIONAL_NIPPON_COLORS.length})` },
          ]}
        />

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
