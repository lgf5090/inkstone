import { useMemo, useState } from 'react'
import { FilterInput } from '../../../../components/FilterInput'
import { compileQuery } from '../../../../lib/query-match'
import {
  ANTD_PALETTES,
  FLAT_UI_PALETTES,
  FLUENT_UI_PALETTES,
  MATERIAL_UI_PALETTES,
  OPEN_COLOR_PALETTES,
  TAILWIND_PALETTES,
  type UiPaletteGroup,
} from '@shared/tools/color/presets'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { PaletteSwatchGrid } from '../components/PaletteSwatchGrid'

type TabKey = 'tailwind' | 'antd' | 'fluent' | 'flat' | 'open_color' | 'material'

const TABS: Array<{ key: TabKey; label: string; count: number }> = [
  { key: 'tailwind', label: 'Tailwind CSS', count: TAILWIND_PALETTES.length },
  { key: 'antd', label: 'Ant Design', count: ANTD_PALETTES.length },
  { key: 'fluent', label: 'Fluent UI', count: FLUENT_UI_PALETTES.length },
  { key: 'flat', label: 'Flat UI', count: FLAT_UI_PALETTES.length },
  { key: 'open_color', label: 'Open Color', count: OPEN_COLOR_PALETTES.length },
  { key: 'material', label: 'Material UI', count: MATERIAL_UI_PALETTES.length },
]

export function UiPaletteView() {
  const [activeTab, setActiveTab] = useState<TabKey>('tailwind')
  const [searchQuery, setSearchQuery] = useState('')

  const compiledQuery = useMemo(() => compileQuery(searchQuery), [searchQuery])

  const currentGroups: UiPaletteGroup[] = useMemo(() => {
    switch (activeTab) {
      case 'tailwind':
        return TAILWIND_PALETTES
      case 'antd':
        return ANTD_PALETTES
      case 'fluent':
        return FLUENT_UI_PALETTES
      case 'flat':
        return FLAT_UI_PALETTES
      case 'open_color':
        return OPEN_COLOR_PALETTES
      case 'material':
        return MATERIAL_UI_PALETTES
      default:
        return TAILWIND_PALETTES
    }
  }, [activeTab])

  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) return currentGroups
    const q = searchQuery.toLowerCase().trim()
    return currentGroups
      .map((group) => {
        const matchingColors = group.colors.filter(
          (c) => c.name.toLowerCase().includes(q) || c.hex.toLowerCase().includes(q),
        )
        const groupMatches = group.name.toLowerCase().includes(q)
        if (groupMatches) return group
        if (matchingColors.length > 0) {
          return { ...group, colors: matchingColors }
        }
        return null
      })
      .filter((g): g is UiPaletteGroup => g !== null)
  }, [currentGroups, searchQuery])

  return (
    <div className="flex flex-col gap-6 w-full max-w-5xl mx-auto p-4 md:p-6 overflow-y-auto">
      {/* Header */}
      <div className="flex flex-col gap-1 border-b border-[var(--border-subtle)] pb-4">
        <h2 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {t('tools.color.ui.title')}
        </h2>
        <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {t('tools.color.ui.subtitle')}
        </p>
      </div>

      {/* Tabs and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          className="flex flex-wrap items-center gap-1.5 p-1 rounded-[var(--r-md)] bg-[var(--bg-sunken)] border border-[var(--border-subtle)]"
        >
          {TABS.map((tab) => {
            const isActive = activeTab === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  'px-3 py-1.5 rounded-[var(--r-sm)] text-[length:var(--text-12)] font-medium transition-colors select-none',
                  isActive
                    ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-xs'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        <div className="w-full sm:w-64">
          <FilterInput
            size="panel"
            className="mt-0"
            value={searchQuery}
            onChange={setSearchQuery}
            query={compiledQuery}
            label={t('tools.color.ui.search_aria')}
            placeholder={t('tools.color.ui.search_placeholder')}
          />
        </div>
      </div>

      {/* Swatch Grids */}
      {filteredGroups.length === 0 ? (
        <div className="p-8 text-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">
          {t('tools.color.ui.empty')}
        </div>
      ) : (
        <PaletteSwatchGrid groups={filteredGroups} />
      )}
    </div>
  )
}
