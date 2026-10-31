import { useEffect, useMemo, useState } from 'react'
import { FilterInput } from '../../../../components/FilterInput'
import { compileQuery, queryKeeps, queryKeepsRows } from '../../../../lib/query-match'
import { usePinyinVersion } from '../../../../lib/pinyin'
import {
  ANTD_PALETTES,
  FLAT_UI_PALETTES,
  FLUENT_UI_PALETTES,
  MATERIAL_UI_PALETTES,
  OPEN_COLOR_PALETTES,
  TAILWIND_PALETTES,
  type UiPaletteGroup,
} from '@shared/tools/color/presets'
import { Segmented } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { PaletteSwatchGrid } from '../components/PaletteSwatchGrid'
import { useColorStudioStore } from '../store'

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
  const defaultUiTab = useColorStudioStore((s) => s.settings.defaultUiTab)
  const [activeTab, setActiveTab] = useState<TabKey>('tailwind')
  const [tabChosen, setTabChosen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // The setting arrives after mount, so it is adopted until the reader picks a tab of their own; after
  // that a late response must not move the ground under them.
  useEffect(() => {
    if (tabChosen) return
    if (TABS.some((tab) => tab.key === defaultUiTab)) setActiveTab(defaultUiTab as TabKey)
  }, [defaultUiTab, tabChosen])

  const compiledQuery = useMemo(() => compileQuery(searchQuery), [searchQuery])

  // The reading table arrives after the first paint on a cold cache: a listing filtered before it lands
  // has to be filtered again once it is here, or the box keeps showing the answer typed before.
  const pinyinVersion = usePinyinVersion()

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
    // The box already says when it refused a pattern; the list has to agree with it. Filtering by a plain
    // substring while handing the compiled query to FilterInput gave two answers to one search.
    if (queryKeepsRows(compiledQuery)) return currentGroups
    return currentGroups
      .map((group) => {
        if (queryKeeps(compiledQuery, group.name)) return group
        const matchingColors = group.colors.filter(
          (c) => queryKeeps(compiledQuery, c.name) || queryKeeps(compiledQuery, c.hex),
        )
        if (matchingColors.length > 0) return { ...group, colors: matchingColors }
        return null
      })
      .filter((g): g is UiPaletteGroup => g !== null)
  }, [currentGroups, compiledQuery, pinyinVersion])

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
        <Segmented
          size="sm"
          label={t('tools.color.ui.title')}
          value={activeTab}
          onChange={(next) => {
            setTabChosen(true)
            setActiveTab(next)
          }}
          options={TABS.map((tab) => ({
            value: tab.key,
            label: `${tab.label} (${tab.count})`,
            title: tab.label,
          }))}
        />

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
