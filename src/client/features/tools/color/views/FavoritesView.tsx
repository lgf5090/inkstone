import { useEffect, useState } from 'react'
import {
  Clock,
  Copy,
  Download,
  Heart,
  Palette,
  Pipette,
  Plus,
  Trash2,
} from 'lucide-react'
import { Button, IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import { useColorStudioStore } from '../store'

type FavoritesSubTab = 'colors' | 'palettes' | 'history'

export function FavoritesView() {
  const [activeTab, setActiveTab] = useState<FavoritesSubTab>('colors')

  const favorites = useColorStudioStore((s) => s.favorites)
  const palettes = useColorStudioStore((s) => s.palettes)
  const history = useColorStudioStore((s) => s.history)

  const fetchFavorites = useColorStudioStore((s) => s.fetchFavorites)
  const fetchPalettes = useColorStudioStore((s) => s.fetchPalettes)
  const fetchHistory = useColorStudioStore((s) => s.fetchHistory)

  const removeFavorite = useColorStudioStore((s) => s.removeFavorite)
  const removePalette = useColorStudioStore((s) => s.removePalette)
  const togglePaletteFavorite = useColorStudioStore((s) => s.togglePaletteFavorite)
  const clearHistory = useColorStudioStore((s) => s.clearHistory)

  const setCurrentHex = useColorStudioStore((s) => s.setCurrentHex)
  const copyColor = useColorStudioStore((s) => s.copyColor)
  const openCreatePaletteModal = useColorStudioStore((s) => s.openCreatePaletteModal)
  const openExportPaletteModal = useColorStudioStore((s) => s.openExportPaletteModal)

  useEffect(() => {
    fetchFavorites()
    fetchPalettes()
    fetchHistory()
  }, [fetchFavorites, fetchPalettes, fetchHistory])

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6 space-y-6 bg-[var(--bg-base)]">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-[length:var(--text-18)] font-bold text-[var(--text-primary)]">
            {t('tools.color.favorites.title')}
          </h2>
          <p className="mt-1 text-[length:var(--text-13)] text-[var(--text-secondary)]">
            {t('tools.color.favorites.subtitle')}
          </p>
        </div>

        {/* Tab switcher */}
        <div className="flex items-center gap-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-1">
          <button
            type="button"
            onClick={() => setActiveTab('colors')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] text-[length:var(--text-12)] font-semibold transition-colors ${
              activeTab === 'colors'
                ? 'bg-[var(--brand-primary)] text-white shadow-xs'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Heart size={13} />
            {t('tools.color.favorites.tab_colors')} ({favorites.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('palettes')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] text-[length:var(--text-12)] font-semibold transition-colors ${
              activeTab === 'palettes'
                ? 'bg-[var(--brand-primary)] text-white shadow-xs'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Palette size={13} />
            {t('tools.color.favorites.tab_palettes')} ({palettes.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] text-[length:var(--text-12)] font-semibold transition-colors ${
              activeTab === 'history'
                ? 'bg-[var(--brand-primary)] text-white shadow-xs'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Clock size={13} />
            {t('tools.color.favorites.tab_history')} ({history.length})
          </button>
        </div>
      </div>

      {/* Tab 1: Colors */}
      {activeTab === 'colors' && (
        <div className="space-y-4">
          {favorites.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-[var(--text-tertiary)]">
              <Heart size={32} className="mb-2 opacity-50" />
              <p className="text-[length:var(--text-14)]">{t('tools.color.favorites.empty')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {favorites.map((fav) => (
                <div
                  key={fav.id}
                  className="group flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-xs transition-all hover:border-[var(--brand-primary)]"
                >
                  <button
                    type="button"
                    aria-label={`Select ${fav.hex}`}
                    className="h-20 w-full cursor-pointer relative focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]"
                    style={{ backgroundColor: fav.hex }}
                    onClick={() => setCurrentHex(fav.hex, 'favorites')}
                  >
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/20 transition-opacity">
                      <Pipette size={16} className="text-white drop-shadow-sm" />
                    </div>
                  </button>
                  <div className="p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[length:var(--text-12)] font-bold text-[var(--text-primary)] uppercase">
                        {fav.hex}
                      </span>
                      <div className="flex items-center gap-0.5">
                        <Tooltip label={t('tools.color.studio.copy')}>
                          <IconButton
                            size="xs"
                            label={t('tools.color.studio.copy')}
                            onClick={() => copyColor(fav.hex, fav.name)}
                          >
                            <Copy size={12} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip label={t('tools.color.common.delete')}>
                          <IconButton
                            size="xs"
                            label={t('tools.color.common.delete')}
                            onClick={() => removeFavorite(fav.id)}
                          >
                            <Trash2 size={12} />
                          </IconButton>
                        </Tooltip>
                      </div>
                    </div>
                    {fav.name && (
                      <p className="truncate text-[length:var(--text-11)] text-[var(--text-secondary)] mt-0.5">
                        {fav.name}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Palettes */}
      {activeTab === 'palettes' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-[length:var(--text-13)] text-[var(--text-secondary)]">
              {t('tools.color.favorites.palettes_desc')}
            </span>
            <Button size="sm" variant="primary" onClick={openCreatePaletteModal}>
              <Plus size={14} className="mr-1.5" />
              {t('tools.color.create_palette.title')}
            </Button>
          </div>

          {palettes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-[var(--text-tertiary)]">
              <Palette size={32} className="mb-2 opacity-50" />
              <p className="text-[length:var(--text-14)]">{t('tools.color.favorites.empty')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {palettes.map((p) => {
                const hexList = p.colors.map((c) => c.hex)
                return (
                  <div
                    key={p.id}
                    className="flex flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-xs transition-all hover:border-[var(--brand-primary)]"
                  >
                    {/* Swatch Strip */}
                    <div className="flex h-16 w-full overflow-hidden">
                      {p.colors.map((c, i) => (
                        <button
                          key={i}
                          type="button"
                          aria-label={`Select color ${c.hex}`}
                          className="flex-1 h-full cursor-pointer transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand-primary)]"
                          style={{ backgroundColor: c.hex }}
                          title={c.hex}
                          onClick={() => setCurrentHex(c.hex, 'palette')}
                        />
                      ))}
                    </div>

                    {/* Palette details */}
                    <div className="p-3.5 flex flex-col space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
                          {p.title}
                        </span>
                        <button
                          type="button"
                          onClick={() => togglePaletteFavorite(p.id)}
                          className={`p-1 rounded-full transition-colors ${
                            p.isFavorite
                              ? 'text-[var(--color-danger-500)]'
                              : 'text-[var(--text-tertiary)] hover:text-[var(--color-danger-500)]'
                          }`}
                        >
                          <Heart size={14} className={p.isFavorite ? 'fill-current' : ''} />
                        </button>
                      </div>

                      {p.description && (
                        <p className="line-clamp-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
                          {p.description}
                        </p>
                      )}

                      <div className="flex items-center justify-between pt-2 border-t border-[var(--border-subtle)]">
                        <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)] uppercase font-mono">
                          {t('tools.color.favorites.palette_meta', {
                            source: p.sourceType,
                            count: p.colors.length,
                          })}
                        </span>
                        <div className="flex items-center gap-1">
                          <Tooltip label={t('tools.color.export.title')}>
                            <IconButton
                              size="xs"
                              label={t('tools.color.export.title')}
                              onClick={() =>
                                openExportPaletteModal({
                                  title: p.title,
                                  colors: hexList,
                                })
                              }
                            >
                              <Download size={12} />
                            </IconButton>
                          </Tooltip>
                          <Tooltip label={t('tools.color.favorites.delete_palette')}>
                            <IconButton
                              size="xs"
                              label={t('tools.color.favorites.delete_palette')}
                              onClick={() => removePalette(p.id)}
                            >
                              <Trash2 size={12} />
                            </IconButton>
                          </Tooltip>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab 3: History */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-[length:var(--text-13)] text-[var(--text-secondary)]">
              {t('tools.color.favorites.history_desc', { count: history.length })}
            </span>
            {history.length > 0 && (
              <Button size="sm" variant="secondary" onClick={clearHistory}>
                <Trash2 size={12} className="mr-1" />
                {t('tools.color.favorites.clear_history')}
              </Button>
            )}
          </div>

          {history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-[var(--text-tertiary)]">
              <Clock size={32} className="mb-2 opacity-50" />
              <p className="text-[length:var(--text-14)]">{t('tools.color.favorites.history_empty')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
              {history.map((item) => (
                <div
                  key={item.id}
                  className="group flex flex-col items-center overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 transition-all hover:border-[var(--brand-primary)]"
                >
                  <button
                    type="button"
                    aria-label={`Select color ${item.hex}`}
                    className="h-12 w-full rounded-[var(--radius-xs)] cursor-pointer shadow-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]"
                    style={{ backgroundColor: item.hex }}
                    onClick={() => setCurrentHex(item.hex, 'history')}
                  />
                  <div className="mt-1.5 flex items-center justify-between w-full">
                    <span className="font-mono text-[length:var(--text-11)] font-semibold text-[var(--text-primary)] uppercase">
                      {item.hex}
                    </span>
                    <Tooltip label={t('tools.color.studio.copy')}>
                      <IconButton
                        size="xs"
                        label={t('tools.color.common.copy')}
                        onClick={() => copyColor(item.hex, 'History')}
                      >
                        <Copy size={11} />
                      </IconButton>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
