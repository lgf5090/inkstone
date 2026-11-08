import { useEffect, useMemo, useState } from 'react'
import { Copy, Download, Loader2, Pin, Star, Tag as TagIcon, Trash2 } from 'lucide-react'
import type { IconAssetDetail, IconCodegenTab, IconCollection, IconTag } from '@shared/development/icons/types'
import { buildCodegen } from '@shared/development/icons/codegen'
import { ICON_PNG_PRESETS } from '@shared/development/icons/limits'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { copyText } from '../../../../lib/clipboard'
import { Button, IconButton } from '../../../../components/primitives'
import { Input, Segmented, Slider } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { Drawer } from '../../../../components/overlay'
import { buildPreviewSvg, downloadBlob, inferPreviewMode, pngBlobFromSvg, type PreviewMode } from '../lib/preview'

const CODEGEN_TABS: { id: IconCodegenTab; label: string }[] = [
  { id: 'svg', label: 'development.icons.codegen.svg' },
  { id: 'data-url', label: 'development.icons.codegen.data_url' },
  { id: 'jsx', label: 'development.icons.codegen.jsx' },
  { id: 'react', label: 'development.icons.codegen.react' },
  { id: 'vue', label: 'development.icons.codegen.vue' },
  { id: 'svelte', label: 'development.icons.codegen.svelte' },
  { id: 'angular', label: 'development.icons.codegen.angular' },
  { id: 'component', label: 'development.icons.codegen.component' },
  { id: 'ts-import', label: 'development.icons.codegen.ts_import' },
]

export interface DetailDrawerProps {
  detail: IconAssetDetail | null
  source: { body: string; viewBox: string } | null
  collections: readonly IconCollection[]
  tags: readonly IconTag[]
  onClose: () => void
  onFavorite: (item: IconAssetDetail) => void
  onPin: (item: IconAssetDetail) => void
  onDelete: (item: IconAssetDetail) => void
  onTags: (item: IconAssetDetail, tagIds: string[]) => Promise<void>
  notify: (input: { title: string; tone?: 'default' | 'success' | 'warning' | 'danger' }) => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * The drawer is a workbench: the glyph is the subject, size/stroke/colour repaint it live, and the
 * code and download controls sit under it. Copy and download stay pinned to the bottom so a long
 * metadata list never pushes the primary verbs out of reach.
 */
export function DetailDrawer({ detail, source, collections, tags, onClose, onFavorite, onPin, onDelete, onTags, notify }: DetailDrawerProps) {
  const [size, setSize] = useState(64)
  const [stroke, setStroke] = useState(2)
  const [color, setColor] = useState('#111827')
  const [monoColor, setMonoColor] = useState(true)
  const [codegenTab, setCodegenTab] = useState<IconCodegenTab>('svg')
  const [addTagId, setAddTagId] = useState('')
  const [busy, setBusy] = useState('')

  useEffect(() => {
    setSize(64)
    setStroke(2)
    setColor('#111827')
    setMonoColor(true)
    setCodegenTab('svg')
    setAddTagId('')
  }, [detail?.id])

  const collection = collections.find((entry) => entry.id === detail?.collectionId)
  const collectionStyle = collection?.slug === 'simple-icons' || collection?.slug === 'devicon'
    ? 'brand' as const
    : collection?.slug === 'lucide' || collection?.slug === 'tabler' || collection?.slug === 'fe'
      ? 'line' as const
      : 'mixed' as const
  // Brand sets are recorded as one colour by the importer; only a body that genuinely carries several
  // painted colours keeps its palette, so a Simple Icons mark stays recolourable.
  const mode: PreviewMode = detail?.colorMode === 'multi'
    ? 'multi'
    : collectionStyle === 'brand'
      ? 'fill'
      : inferPreviewMode(source?.body ?? '', collectionStyle)
  const viewBox = source?.viewBox ?? detail?.viewBox ?? '0 0 24 24'
  const previewSvg = source ? buildPreviewSvg(source.body, viewBox, { size, stroke, color: monoColor ? 'currentColor' : color, mode }) : ''
  const codegen = useMemo(() => source && detail
    ? buildCodegen(codegenTab, {
        body: source.body,
        viewBox,
        size,
        strokeWidth: stroke,
        color: monoColor ? 'currentColor' : color,
        slug: detail.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'icon',
      })
    : '', [codegenTab, color, detail, monoColor, size, source, stroke, viewBox])

  const downloadPng = async (target: number): Promise<void> => {
    if (!source || !detail) return
    setBusy(`png-${target}`)
    try {
      const svg = buildPreviewSvg(source.body, viewBox, { size: target, stroke, color: monoColor ? 'currentColor' : color, mode })
      downloadBlob(await pngBlobFromSvg(svg, target), `${detail.name}-${target}.png`)
    } catch (error) {
      notify({ title: error instanceof Error ? error.message : t('development.icons.detail.download_failed'), tone: 'danger' })
    } finally {
      setBusy('')
    }
  }

  const copy = async (value: string): Promise<void> => {
    if (!value) return
    await copyText(value)
    notify({ title: t('development.icons.codegen.copied'), tone: 'success' })
  }

  const availableTags = tags.filter((tag) => !detail?.tags.some((entry) => entry.id === tag.id))

  return (
    <Drawer
      open={Boolean(detail)}
      onClose={onClose}
      side="right"
      width={460}
      title={t('development.icons.detail.title')}
      ariaLabel={t('development.icons.detail.title')}
      bodyClassName="overflow-hidden"
    >
      {detail && (
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <div
              className="flex items-center justify-center rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4"
              style={{ minHeight: 176, backgroundImage: 'radial-gradient(circle at 1px 1px, var(--border-subtle) 1px, transparent 0)', backgroundSize: '12px 12px' }}
            >
              {source ? (
                <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: previewSvg }} />
              ) : (
                <img src={detail.rawUrl} alt={detail.name} className="max-h-40 max-w-full object-contain" />
              )}
            </div>

            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]" title={detail.name}>{detail.name}</div>
                <div className="mt-0.5 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {collection?.name ?? t('development.icons.sidebar.uncategorized')} · {detail.license || t('development.icons.detail.no_license')}
                </div>
              </div>
              <IconButton label={detail.favorited ? t('development.icons.card.unfavorite') : t('development.icons.card.favorite')} size="sm" onClick={() => onFavorite(detail)}><Star size={14} className={detail.favorited ? 'fill-current text-[var(--warning)]' : ''} /></IconButton>
              <IconButton label={detail.pinned ? t('development.icons.card.unpin') : t('development.icons.card.pin')} size="sm" onClick={() => onPin(detail)}><Pin size={14} className={detail.pinned ? 'text-[var(--warning)]' : ''} /></IconButton>
              <IconButton label={t('development.icons.common.delete')} size="sm" onClick={() => onDelete(detail)}><Trash2 size={14} /></IconButton>
            </div>

            {source && (
              <div className="space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
                <div className="text-[length:var(--text-11)] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('development.icons.detail.preview')}</div>
                <Slider value={size} min={16} max={160} onChange={setSize} label={t('development.icons.detail.preview_size')} suffix="px" />
                {mode === 'stroke' && <Slider value={stroke} min={0.5} max={3} step={0.5} onChange={setStroke} label={t('development.icons.detail.preview_stroke')} suffix="px" />}
                {mode !== 'multi' && (
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.icons.detail.preview_color')}</span>
                    <Input
                      value={color}
                      onChange={(event) => { setColor(event.target.value); setMonoColor(false) }}
                      aria-label={t('development.icons.detail.preview_color')}
                      className="w-28 font-mono"
                    />
                    <span className="h-6 w-6 shrink-0 rounded-[var(--r-sm)] border border-[var(--border-default)]" style={{ backgroundColor: monoColor ? 'currentColor' : color }} aria-hidden="true" />
                    <Button size="sm" variant={monoColor ? 'primary' : 'secondary'} onClick={() => setMonoColor(true)}>{t('development.icons.detail.current_color')}</Button>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-1 text-[length:var(--text-11)] text-[var(--text-secondary)]">
              <span>{t('development.icons.detail.format')}: <b className="font-medium uppercase text-[var(--text-primary)]">{detail.format}</b></span>
              <span>{t('development.icons.detail.size')}: <b className="font-medium text-[var(--text-primary)]">{detail.width ?? '—'} × {detail.height ?? '—'}</b></span>
              <span>{t('development.icons.detail.bytes')}: <b className="font-medium text-[var(--text-primary)]">{formatBytes(detail.bytes)}</b></span>
              <span className="truncate" title={detail.sha256}>{t('development.icons.detail.hash')}: <b className="font-mono font-medium text-[var(--text-primary)]">{detail.sha256.slice(0, 10)}</b></span>
              <span>{t('development.icons.detail.used')}: <b className="font-medium text-[var(--text-primary)]">{detail.useCount}</b></span>
              <span>{t('development.icons.detail.colors')}: <b className="font-medium text-[var(--text-primary)]">{detail.colorMode}</b></span>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-[length:var(--text-11)] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]"><TagIcon size={11} />{t('development.icons.detail.tags')}</div>
              <div className="flex flex-wrap items-center gap-1">
                {detail.tags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => void onTags(detail, detail.tags.filter((entry) => entry.id !== tag.id).map((entry) => entry.id))}
                    className="inline-flex items-center gap-1 rounded-[var(--r-full)] border px-2 py-0.5 text-[length:var(--text-10)] hover:opacity-80"
                    style={{ borderColor: tag.color, color: tag.color }}
                    title={t('development.icons.detail.remove_tag')}
                  >
                    {tag.name}
                    <span aria-hidden="true">×</span>
                  </button>
                ))}
                {detail.tags.length === 0 && <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.icons.detail.no_tags')}</span>}
              </div>
              {availableTags.length > 0 && (
                <SelectMenu
                  label={t('development.icons.detail.add_tag')}
                  value={addTagId}
                  onChange={(value) => {
                    setAddTagId('')
                    if (value) void onTags(detail, [...detail.tags.map((entry) => entry.id), value])
                  }}
                  options={[{ value: '', label: t('development.icons.detail.add_tag') }, ...availableTags.map((tag) => ({ value: tag.id, label: tag.name }))]}
                  size="sm"
                  width={220}
                />
              )}
            </div>

            {source && (
              <div className="space-y-1.5">
                <div className="text-[length:var(--text-11)] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('development.icons.codegen.title')}</div>
                <Segmented
                  value={codegenTab}
                  onChange={setCodegenTab}
                  size="sm"
                  label={t('development.icons.codegen.title')}
                  options={CODEGEN_TABS.map((tab) => ({ value: tab.id, label: t(tab.label as never) }))}
                  className="w-full"
                />
                <pre data-testid="icons-codegen" className="max-h-44 overflow-auto rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 text-[length:var(--text-10)] text-[var(--text-secondary)]">{codegen}</pre>
                <Button size="sm" variant="secondary" onClick={() => void copy(codegen)}><Copy size={12} />{t('development.icons.codegen.copy')}</Button>
              </div>
            )}

            <div className="space-y-1.5">
              <div className="text-[length:var(--text-11)] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('development.icons.detail.downloads')}</div>
              <div className="flex flex-wrap gap-1.5">
                <a href={detail.rawUrl} download={`${detail.name}.${detail.format}`} className="inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2 text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
                  <Download size={12} />{t('development.icons.detail.original')}
                </a>
                {source && ICON_PNG_PRESETS.map((preset) => (
                  <Button key={preset} size="sm" variant="secondary" disabled={busy === `png-${preset}`} onClick={() => void downloadPng(preset)}>
                    {busy === `png-${preset}` ? <Loader2 size={12} className="animate-spin" /> : null}{'PNG'} {preset}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
            <Button block variant="secondary" onClick={() => void copy(codegen || detail.rawUrl)}><Copy size={14} />{t('development.icons.detail.copy.svg')}</Button>
            <a href={detail.rawUrl} download={`${detail.name}.${detail.format}`} className={cn('inline-flex h-8 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[var(--r-sm)] border border-[var(--border-default)] px-3 text-[length:var(--text-12)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]')}>
              <Download size={14} />{t('development.icons.detail.download.svg')}
            </a>
          </div>
        </div>
      )}
    </Drawer>
  )
}
