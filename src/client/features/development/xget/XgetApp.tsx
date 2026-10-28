import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { XGET_PLATFORMS, type XgetPlatform } from '@shared/development/xget/catalog'
import { XGET_CATEGORIES, type XgetCategory, type XgetSettings } from '@shared/development/xget/types'
import { t } from '../../../lib/i18n'
import { useSession } from '../../../store/session'
import { Badge } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Empty } from '../../../components/feedback'
import { xgetApi, describeXgetError } from './api'
import { CATEGORY_ICONS, CATEGORY_LABEL_KEYS } from './lib/category'
import {
  clearXgetHistory,
  loadXgetHistory,
  prependXgetHistory,
  type XgetHistoryItem,
} from './lib/history'
import { CategoryBar, CategoryRail, type XgetView } from './components/CategoryRail'
import { ConverterBar } from './components/ConverterBar'
import { HistoryCard } from './components/HistoryCard'
import { PlatformCard } from './components/PlatformCard'
import { PlatformDetail } from './components/PlatformDetail'
import { SettingsPanel } from './components/SettingsPanel'
import { StatsView } from './components/StatsView'

const FALLBACK_BASE = `${typeof location === 'undefined' ? '' : location.origin}/api/development/xget`

export function XgetApp() {
  const userId = useSession((state) => state.user?.id ?? null)
  const [settings, setSettings] = useState<XgetSettings | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [view, setView] = useState<XgetView>('stats')
  const [activeCategory, setActiveCategory] = useState<XgetCategory>('code')
  const [search, setSearch] = useState('')
  const [input, setInput] = useState('')
  const [convertSignal, setConvertSignal] = useState(0)
  const [history, setHistory] = useState<XgetHistoryItem[]>([])
  const [selectedPlatform, setSelectedPlatform] = useState<XgetPlatform | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const loadSettings = useCallback(async (): Promise<void> => {
    setSettingsLoading(true)
    try {
      const loaded = await xgetApi.getSettings()
      setSettings(loaded)
      setSettingsError(null)
    } catch (cause) {
      setSettingsError(describeXgetError(cause))
    } finally {
      setSettingsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  useEffect(() => {
    setHistory(loadXgetHistory(userId))
  }, [userId])

  const proxyBase = settings?.proxy_base_url || FALLBACK_BASE

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return XGET_PLATFORMS
    return XGET_PLATFORMS.filter(
      (platform) =>
        platform.key.toLowerCase().includes(query) ||
        platform.name.toLowerCase().includes(query) ||
        platform.hosts.some((host) => host.toLowerCase().includes(query)),
    )
  }, [search])

  const counts = useMemo(
    () =>
      Object.fromEntries(
        XGET_CATEGORIES.map((category) => [
          category,
          filtered.filter((platform) => platform.category === category).length,
        ]),
      ) as Record<XgetCategory, number>,
    [filtered],
  )

  const currentPlatforms = filtered.filter((platform) => platform.category === activeCategory)

  function selectCategory(category: XgetCategory): void {
    setActiveCategory(category)
    setView('platforms')
  }

  function reuseHistory(item: XgetHistoryItem): void {
    setInput(item.url)
    setConvertSignal((value) => value + 1)
  }

  function addHistory(item: XgetHistoryItem): void {
    setHistory((current) => prependXgetHistory(userId, current, item))
  }

  function clearHistory(): void {
    clearXgetHistory(userId)
    setHistory([])
  }

  function openPlatform(platform: XgetPlatform): void {
    setSelectedPlatform(platform)
    setDetailOpen(true)
  }

  return (
    <div data-testid="xget-app-root" className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]">
      <div className="flex min-h-0 min-w-0 flex-1">
        <CategoryRail
          view={view}
          activeCategory={activeCategory}
          counts={counts}
          total={XGET_PLATFORMS.length}
          onSelectCategory={selectCategory}
          onShowStats={() => setView('stats')}
          onShowSettings={() => setView('settings')}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <CategoryBar
            view={view}
            activeCategory={activeCategory}
            counts={counts}
            onSelectCategory={selectCategory}
            onShowStats={() => setView('stats')}
            onShowSettings={() => setView('settings')}
          />

          {settingsError && (
            <p className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5 text-[length:var(--text-11)] text-[var(--warning)]">
              {t('development.xget.converter.default_base')} — {settingsError}
            </p>
          )}

          <ConverterBar
            proxyBase={proxyBase}
            input={input}
            onInputChange={setInput}
            convertSignal={convertSignal}
            onHistory={addHistory}
          />

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {view === 'stats' && <StatsView />}

            {view === 'platforms' && (
              <div>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  {(() => {
                    const Icon = CATEGORY_ICONS[activeCategory]
                    return <Icon size={16} className="text-[var(--accent)]" />
                  })()}
                  <h2 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
                    {t(CATEGORY_LABEL_KEYS[activeCategory])}
                  </h2>
                  <Badge>{currentPlatforms.length}</Badge>
                  <div className="ml-auto w-full sm:w-56">
                    <Input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      aria-label={t('development.xget.platforms.search')}
                      placeholder={t('development.xget.platforms.search')}
                      leading={<Search size={14} />}
                    />
                  </div>
                </div>

                {currentPlatforms.length > 0 ? (
                  <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
                    {currentPlatforms.map((platform) => (
                      <PlatformCard key={platform.key} platform={platform} proxyBase={proxyBase} onOpen={openPlatform} />
                    ))}
                  </div>
                ) : (
                  <Empty compact art="search" title={t('development.xget.platforms.empty')} />
                )}

                <HistoryCard history={history} onReuse={reuseHistory} onClear={clearHistory} />
              </div>
            )}

            {view === 'settings' && (
              <SettingsPanel settings={settings} loading={settingsLoading} error={settingsError} onReload={loadSettings} />
            )}
          </div>
        </div>
      </div>

      <PlatformDetail
        open={detailOpen}
        platform={selectedPlatform}
        proxyBase={proxyBase}
        onOpenChange={setDetailOpen}
      />
    </div>
  )
}
