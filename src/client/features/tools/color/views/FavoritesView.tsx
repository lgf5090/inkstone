import { useEffect, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Clock,
  Copy,
  Download,
  Heart,
  Palette,
  Pencil,
  Pipette,
  Plus,
  Trash2,
} from 'lucide-react'
import { Button, IconButton } from '../../../../components/primitives'
import { Segmented } from '../../../../components/form'
import { Tooltip, confirm } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import { useColorStudioStore } from '../store'
import { EditFavoriteModal } from '../components/modals/EditFavoriteModal'
import { EditPaletteModal } from '../components/modals/EditPaletteModal'

type FavoritesSubTab = 'colors' | 'palettes' | 'history'

/**
 * A list the server refused, shown apart from a list that came back empty.
 *
 * Both used to render "nothing saved yet", which tells a reader on a flaky connection that their colors
 * are gone — and invites them to save the same hex a second time.
 */
function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-[var(--text-tertiary)]">
      <p className="text-[length:var(--text-14)]">{t('tools.color.favorites.load_failed')}</p>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  )
}

export function FavoritesView() {
  const [activeTab, setActiveTab] = useState<FavoritesSubTab>('colors')

  const favorites = useColorStudioStore((s) => s.favorites)
  const palettes = useColorStudioStore((s) => s.palettes)
  const history = useColorStudioStore((s) => s.history)
  const isLoadingFavorites = useColorStudioStore((s) => s.isLoadingFavorites)
  const isLoadingPalettes = useColorStudioStore((s) => s.isLoadingPalettes)
  const favoritesLoadFailed = useColorStudioStore((s) => s.favoritesLoadFailed)
  const palettesLoadFailed = useColorStudioStore((s) => s.palettesLoadFailed)

  const fetchFavorites = useColorStudioStore((s) => s.fetchFavorites)
  const fetchPalettes = useColorStudioStore((s) => s.fetchPalettes)
  const fetchHistory = useColorStudioStore((s) => s.fetchHistory)

  const storeRemoveFavorite = useColorStudioStore((s) => s.removeFavorite)
  const storeRemovePalette = useColorStudioStore((s) => s.removePalette)
  const storeClearHistory = useColorStudioStore((s) => s.clearHistory)
  const togglePaletteFavorite = useColorStudioStore((s) => s.togglePaletteFavorite)

  const removeFavorite = async (id: string) => {
    // A favorite is the only copy: there is no trash and no export, so deletion asks first.
    if (!(await confirm({ title: t('tools.color.favorites.confirm_delete_favorite_title'), description: t('tools.color.favorites.confirm_delete_favorite'), tone: 'danger', confirmLabel: t('tools.color.common.delete') }))) return
    await storeRemoveFavorite(id)
  }

  const removePalette = async (id: string) => {
    if (!(await confirm({ title: t('tools.color.favorites.confirm_delete_palette_title'), description: t('tools.color.favorites.confirm_delete_palette'), tone: 'danger', confirmLabel: t('tools.color.common.delete') }))) return
    await storeRemovePalette(id)
  }

  const clearHistory = async () => {
    if (!(await confirm({ title: t('tools.color.favorites.confirm_clear_history_title'), description: t('tools.color.favorites.confirm_clear_history'), tone: 'danger', confirmLabel: t('tools.color.favorites.clear_history') }))) return
    await storeClearHistory()
  }

  const setCurrentHex = useColorStudioStore((s) => s.setCurrentHex)
  const copyColor = useColorStudioStore((s) => s.copyColor)
  const openCreatePaletteModal = useColorStudioStore((s) => s.openCreatePaletteModal)
  const openExportPaletteModal = useColorStudioStore((s) => s.openExportPaletteModal)
  const openEditFavorite = useColorStudioStore((s) => s.openEditFavorite)
  const openEditPalette = useColorStudioStore((s) => s.openEditPalette)
  const moveFavorite = useColorStudioStore((s) => s.moveFavorite)
  const movePalette = useColorStudioStore((s) => s.movePalette)

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
        <Segmented
          size="sm"
          label={t('tools.color.favorites.title')}
          value={activeTab}
          onChange={setActiveTab}
          options={[
            { value: 'colors' as const, label: `${t('tools.color.favorites.tab_colors')} (${favorites.length})` },
            { value: 'palettes' as const, label: `${t('tools.color.favorites.tab_palettes')} (${palettes.length})` },
            { value: 'history' as const, label: `${t('tools.color.favorites.tab_history')} (${history.length})` },
          ]}
        />
      </div>

      {/* The editors are reached only from these cards, so they live with the panel that opens them. */}
      <EditFavoriteModal />
      <EditPaletteModal />

      {/* Tab 1: Colors */}
      {activeTab === 'colors' && (
        <div className="space-y-4">
          {isLoadingFavorites ? (
            <p className="py-16 text-center text-[length:var(--text-14)] text-[var(--text-tertiary)]">
              {t('tools.color.favorites.loading')}
            </p>
          ) : favoritesLoadFailed ? (
            <LoadFailed onRetry={fetchFavorites} />
          ) : favorites.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-[var(--text-tertiary)]">
              <Heart size={32} className="mb-2 opacity-50" />
              <p className="text-[length:var(--text-14)]">{t('tools.color.favorites.empty')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {favorites.map((fav, index) => (
                <div
                  key={fav.id}
                  className="group flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-xs transition-all hover:border-[var(--accent)]"
                >
                  <button
                    type="button"
                    aria-label={t('tools.color.swatch.use', { hex: fav.hex })}
                    className="h-20 w-full cursor-pointer relative focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    style={{ backgroundColor: fav.hex }}
                    onClick={() => setCurrentHex(fav.hex, 'favorites')}
                  >
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/60 transition-opacity">
                      <Pipette size={16} className="text-white drop-shadow-sm" />
                    </div>
                  </button>
                  <div className="p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[length:var(--text-12)] font-bold text-[var(--text-primary)] uppercase">
                        {fav.hex}
                      </span>
                      <div className="flex flex-wrap items-center justify-end gap-0.5">
                        <Tooltip label={t('tools.color.edit.action')}>
                          <IconButton
                            size="xs"
                            label={t('tools.color.edit.action')}
                            onClick={() => openEditFavorite(fav.id)}
                          >
                            <Pencil size={12} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip label={t('tools.color.edit.move_up')}>
                          <IconButton
                            size="xs"
                            label={t('tools.color.edit.move_up')}
                            disabled={index === 0}
                            onClick={() => moveFavorite(fav.id, -1)}
                          >
                            <ArrowUp size={12} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip label={t('tools.color.edit.move_down')}>
                          <IconButton
                            size="xs"
                            label={t('tools.color.edit.move_down')}
                            disabled={index === favorites.length - 1}
                            onClick={() => moveFavorite(fav.id, 1)}
                          >
                            <ArrowDown size={12} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip label={t('tools.color.studio.copy')}>
                          <IconButton
                            size="xs"
                            label={t('tools.color.studio.copy')}
                            onClick={() => copyColor(fav.hex, fav.name || t('tools.color.favorites.title'))}
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

          {isLoadingPalettes ? (
            <p className="py-16 text-center text-[length:var(--text-14)] text-[var(--text-tertiary)]">
              {t('tools.color.favorites.loading')}
            </p>
          ) : palettesLoadFailed ? (
            <LoadFailed onRetry={fetchPalettes} />
          ) : palettes.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-[var(--text-tertiary)]">
              <Palette size={32} className="opacity-50" />
              <p className="text-[length:var(--text-14)]">{t('tools.color.favorites.empty_palettes')}</p>
              <Button size="sm" variant="secondary" onClick={openCreatePaletteModal}>
                <Plus size={14} className="mr-1.5" />
                {t('tools.color.create_palette.title')}
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {palettes.map((p, index) => {
                const hexList = p.colors.map((c) => c.hex)
                return (
                  <div
                    key={p.id}
                    className="flex flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-xs transition-all hover:border-[var(--accent)]"
                  >
                    {/* Swatch Strip */}
                    <div className="flex h-16 w-full overflow-hidden">
                      {p.colors.map((c, i) => (
                        <button
                          key={i}
                          type="button"
                          aria-label={t('tools.color.swatch.use', { hex: c.hex })}
                          className="h-full min-w-4 cursor-pointer transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
                          style={{ backgroundColor: c.hex, flexGrow: c.ratio && c.ratio > 0 ? c.ratio : 1 }}
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
                          aria-label={p.isFavorite ? t('tools.color.toast.palette_favorite_removed') : t('tools.color.toast.palette_favorite_added')}
                          onClick={() => togglePaletteFavorite(p.id)}
                          className={`p-1 rounded-full transition-colors ${
                            p.isFavorite
                              ? 'text-[var(--danger)]'
                              : 'text-[var(--text-tertiary)] hover:text-[var(--danger)]'
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
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <Tooltip label={t('tools.color.edit.action')}>
                            <IconButton
                              size="xs"
                              label={t('tools.color.edit.action')}
                              onClick={() => openEditPalette(p.id)}
                            >
                              <Pencil size={12} />
                            </IconButton>
                          </Tooltip>
                          <Tooltip label={t('tools.color.edit.move_up')}>
                            <IconButton
                              size="xs"
                              label={t('tools.color.edit.move_up')}
                              disabled={index === 0}
                              onClick={() => movePalette(p.id, -1)}
                            >
                              <ArrowUp size={12} />
                            </IconButton>
                          </Tooltip>
                          <Tooltip label={t('tools.color.edit.move_down')}>
                            <IconButton
                              size="xs"
                              label={t('tools.color.edit.move_down')}
                              disabled={index === palettes.length - 1}
                              onClick={() => movePalette(p.id, 1)}
                            >
                              <ArrowDown size={12} />
                            </IconButton>
                          </Tooltip>
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
                  className="group flex flex-col items-center overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 transition-all hover:border-[var(--accent)]"
                >
                  <button
                    type="button"
                    aria-label={t('tools.color.swatch.use', { hex: item.hex })}
                    className="h-12 w-full rounded-[var(--radius-xs)] cursor-pointer shadow-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
