/**
 * The comparisons the reader kept.
 *
 * A project is a name, the options it was compared with, and the two sides in R2. Opening one puts
 * the sides back where the comparison lives: text goes straight to the text screen, while an image,
 * a binary or a folder opens as a read-only summary — reopening those is reading what was saved,
 * not re-running a comparison whose files are no longer on this machine.
 */
import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, FolderOpen, Image as ImageIcon, Link2, Pencil, RefreshCw, Search, Share2, Trash2, Unlink } from 'lucide-react'
import type { CompareKind, CompareProject, CompareProjectListItem } from '@shared/tools/compare/types'
import { Button, IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { Modal, Tooltip, confirm, prompt } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'
import { Empty, LoadingBlock } from '../../../../components/feedback'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { compareApi, sharePageUrl } from '../api'
import { useCompareStore } from '../store'
import { formatBytes } from '../files/FileCompareView'

const KINDS: readonly CompareKind[] = ['text', 'file', 'dir', 'image', 'binary']

const KIND_LABEL_KEY: Record<CompareKind, string> = {
  text: 'tools.compare.projects.kind.text',
  file: 'tools.compare.projects.kind.file',
  dir: 'tools.compare.projects.kind.dir',
  image: 'tools.compare.projects.kind.image',
  binary: 'tools.compare.projects.kind.binary',
}

export function ProjectsView({ onOpenText }: { onOpenText: () => void }) {
  const [items, setItems] = useState<CompareProjectListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [kind, setKind] = useState<CompareKind | 'all'>('all')
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<CompareProject | null>(null)
  const [detailImages, setDetailImages] = useState<{ left: string | null, right: string | null }>({ left: null, right: null })
  const loadSides = useCompareStore((s) => s.loadSides)

  const load = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const data = await compareApi.listProjects({
        limit: 20,
        offset: 0,
        ...(kind === 'all' ? {} : { kind }),
        ...(search.trim() ? { search: search.trim() } : {}),
      })
      setItems(data.items)
      setTotal(data.total)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [kind, search])

  useEffect(() => {
    void load()
  }, [load])

  const open = async (item: CompareProjectListItem) => {
    try {
      const project = await compareApi.getProject(item.id)
      if (project.kind === 'text' && project.left_asset && project.right_asset) {
        const [leftText, rightText] = await Promise.all([
          compareApi.fetchAssetText(project.left_asset.id),
          compareApi.fetchAssetText(project.right_asset.id),
        ])
        loadSides(
          { text: leftText, name: project.left_asset.filename, bytes: project.left_asset.size, encoding: project.left_asset.encoding },
          { text: rightText, name: project.right_asset.filename, bytes: project.right_asset.size, encoding: project.right_asset.encoding },
          project.options,
          'text',
        )
        onOpenText()
        return
      }
      setDetail(project)
      if (project.kind === 'image') {
        const urls = await Promise.all([
          project.left_asset ? fetchBlobUrl(project.left_asset.id) : null,
          project.right_asset ? fetchBlobUrl(project.right_asset.id) : null,
        ])
        setDetailImages({ left: urls[0], right: urls[1] })
      }
    } catch {
      useUi.getState().toast({ title: t('tools.compare.projects.open_failed'), tone: 'danger' })
    }
  }

  const share = async (item: CompareProjectListItem) => {
    try {
      const { slug } = await compareApi.shareProject(item.id)
      await navigator.clipboard.writeText(sharePageUrl(slug)).catch(() => undefined)
      useUi.getState().toast({ title: t('tools.compare.projects.shared'), tone: 'success' })
      void load()
    } catch {
      useUi.getState().toast({ title: t('tools.compare.projects.share_failed'), tone: 'danger' })
    }
  }

  const unshare = async (item: CompareProjectListItem) => {
    try {
      await compareApi.unshareProject(item.id)
      useUi.getState().toast({ title: t('tools.compare.projects.unshared'), tone: 'success' })
      void load()
    } catch {
      useUi.getState().toast({ title: t('tools.compare.projects.share_failed'), tone: 'danger' })
    }
  }

  const rename = async (item: CompareProjectListItem) => {
    const name = await prompt({ title: t('tools.compare.projects.rename'), defaultValue: item.name, confirmLabel: t('tools.compare.projects.rename_submit') })
    if (!name?.trim()) return
    try {
      await compareApi.updateProject(item.id, { name: name.trim() })
      void load()
    } catch {
      useUi.getState().toast({ title: t('tools.compare.projects.rename_failed'), tone: 'danger' })
    }
  }

  const remove = async (item: CompareProjectListItem) => {
    const yes = await confirm({
      title: t('tools.compare.projects.delete'),
      description: t('tools.compare.projects.delete_confirm'),
      confirmLabel: t('tools.compare.projects.delete'),
      tone: 'danger',
    })
    if (!yes) return
    try {
      await compareApi.deleteProject(item.id)
      useUi.getState().toast({ title: t('tools.compare.projects.deleted'), tone: 'success' })
      void load()
    } catch {
      useUi.getState().toast({ title: t('tools.compare.projects.delete_failed'), tone: 'danger' })
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto p-3 sm:p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{t('tools.compare.projects.title')}</h2>
          <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('tools.compare.projects.desc')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1.5">
            <Search size={14} aria-hidden="true" className="text-[var(--text-tertiary)]" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('tools.compare.projects.search_placeholder')}
              aria-label={t('tools.compare.projects.search_placeholder')}
              className="w-[190px]"
            />
          </div>
          <SelectMenu
            label={t('tools.compare.projects.kind_filter')}
            value={kind}
            options={[
              { value: 'all', label: t('tools.compare.projects.all_kinds') },
              ...KINDS.map((entry) => ({ value: entry, label: t(KIND_LABEL_KEY[entry] as never) })),
            ]}
            onChange={(value) => setKind(value)}
            size="sm"
            width={190}
          />
          <Tooltip label={t('tools.compare.projects.refresh')}>
            <IconButton size="sm" label={t('tools.compare.projects.refresh')} onClick={() => void load()}>
              <RefreshCw size={14} />
            </IconButton>
          </Tooltip>
        </div>
      </header>

      {loading ? (
        <div className="flex-1 rounded-[var(--r-md)] border border-[var(--border-subtle)]">
          <LoadingBlock label={t('tools.compare.projects.loading')} />
        </div>
      ) : error ? (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-[length:var(--text-12)] text-[var(--danger)]">
          <p>{t('tools.compare.projects.load_failed')}</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => void load()}>{t('tools.compare.projects.refresh')}</Button>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
          <Empty art="select" compact title={t('tools.compare.projects.empty')} description={t('tools.compare.projects.empty_desc')} />
        </div>
      ) : (
        <>
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('tools.compare.projects.count', { count: total })}</p>
          <ul className="grid list-none grid-cols-1 gap-2 xl:grid-cols-2">
            {items.map((item) => (
              <li key={item.id} className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]" title={item.name}>{item.name}</h3>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      <span className="rounded-full border border-[var(--border-subtle)] px-1.5 py-0.5">{t(KIND_LABEL_KEY[item.kind] as never)}</span>
                      <span className="truncate">{item.left_label ?? item.left_filename ?? '—'} ↔ {item.right_label ?? item.right_filename ?? '—'}</span>
                    </p>
                  </div>
                  {item.share_slug && (
                    <span className="shrink-0 rounded-full border border-[var(--accent)]/40 px-1.5 py-0.5 text-[length:var(--text-10-5)] text-[var(--accent)]">
                      {t('tools.compare.projects.shared_badge')}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                    {summaryText(item)}
                  </span>
                  <div className="flex items-center gap-0.5">
                    <Tooltip label={t('tools.compare.projects.open')}>
                      <IconButton size="sm" label={t('tools.compare.projects.open')} onClick={() => void open(item)}>
                        {item.kind === 'image' ? <ImageIcon size={13} /> : <FolderOpen size={13} />}
                      </IconButton>
                    </Tooltip>
                    <Tooltip label={t('tools.compare.projects.rename')}>
                      <IconButton size="sm" label={t('tools.compare.projects.rename')} onClick={() => void rename(item)}>
                        <Pencil size={13} />
                      </IconButton>
                    </Tooltip>
                    {item.share_slug ? (
                      <>
                        <Tooltip label={t('tools.compare.projects.copy_link')}>
                          <IconButton size="sm" label={t('tools.compare.projects.copy_link')} onClick={() => void navigator.clipboard.writeText(sharePageUrl(item.share_slug!))}>
                            <Link2 size={13} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip label={t('tools.compare.projects.unshare')}>
                          <IconButton size="sm" label={t('tools.compare.projects.unshare')} onClick={() => void unshare(item)}>
                            <Unlink size={13} />
                          </IconButton>
                        </Tooltip>
                      </>
                    ) : (
                      <Tooltip label={t('tools.compare.projects.share')}>
                        <IconButton size="sm" label={t('tools.compare.projects.share')} onClick={() => void share(item)}>
                          <Share2 size={13} />
                        </IconButton>
                      </Tooltip>
                    )}
                    <Tooltip label={t('tools.compare.projects.delete')}>
                      <IconButton size="sm" label={t('tools.compare.projects.delete')} onClick={() => void remove(item)}>
                        <Trash2 size={13} />
                      </IconButton>
                    </Tooltip>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <Modal
        open={Boolean(detail)}
        onClose={() => { setDetail(null); setDetailImages({ left: null, right: null }) }}
        title={detail?.name}
        width={720}
        footer={detail?.share_slug ? (
          <Button variant="secondary" onClick={() => window.open(sharePageUrl(detail.share_slug!), '_blank', 'noopener')}>
            <span className="flex items-center gap-1"><ExternalLink size={13} aria-hidden="true" />{t('tools.compare.projects.view_share')}</span>
          </Button>
        ) : undefined}
      >
        {detail && (
          <div className="flex flex-col gap-3">
            <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {(detail.left_asset?.filename ?? '—')} ↔ {(detail.right_asset?.filename ?? '—')}
            </p>
            {detail.kind === 'image' ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {detailImages.left && <img src={detailImages.left} alt={detail.left_asset?.filename ?? ''} className="max-h-[42vh] w-full rounded-[var(--r-sm)] object-contain" />}
                {detailImages.right && <img src={detailImages.right} alt={detail.right_asset?.filename ?? ''} className="max-h-[42vh] w-full rounded-[var(--r-sm)] object-contain" />}
              </div>
            ) : detail.kind === 'binary' || detail.kind === 'file' ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[length:var(--text-12)]">
                <dt className="text-[var(--text-tertiary)]">{t('tools.compare.text.left')}</dt>
                <dd className="font-mono break-all">{detail.left_asset?.filename} · {formatBytes(detail.left_asset?.size ?? 0)}</dd>
                <dt className="text-[var(--text-tertiary)]">{'sha256'}</dt>
                <dd className="font-mono break-all text-[var(--text-secondary)]">{detail.left_asset?.sha256 ?? '—'}</dd>
                <dt className="text-[var(--text-tertiary)]">{t('tools.compare.text.right')}</dt>
                <dd className="font-mono break-all">{detail.right_asset?.filename} · {formatBytes(detail.right_asset?.size ?? 0)}</dd>
                <dt className="text-[var(--text-tertiary)]">{'sha256'}</dt>
                <dd className="font-mono break-all text-[var(--text-secondary)]">{detail.right_asset?.sha256 ?? '—'}</dd>
              </dl>
            ) : (
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[length:var(--text-11)]">{t('tools.compare.dir.same')} {detail.summary.dirCounts?.same ?? 0}</span>
                <span className="rounded-full border border-[var(--warning)]/40 px-2 py-0.5 text-[length:var(--text-11)] text-[var(--warning)]">{t('tools.compare.dir.different')} {detail.summary.dirCounts?.different ?? 0}</span>
                <span className="rounded-full border border-[var(--accent)]/40 px-2 py-0.5 text-[length:var(--text-11)] text-[var(--accent)]">{t('tools.compare.dir.left_only')} {detail.summary.dirCounts?.leftOnly ?? 0}</span>
                <span className="rounded-full border border-[var(--accent)]/40 px-2 py-0.5 text-[length:var(--text-11)] text-[var(--accent)]">{t('tools.compare.dir.right_only')} {detail.summary.dirCounts?.rightOnly ?? 0}</span>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

async function fetchBlobUrl(assetId: string): Promise<string | null> {
  try {
    return URL.createObjectURL(await compareApi.fetchAssetBlob(assetId))
  } catch {
    return null
  }
}

function summaryText(item: CompareProjectListItem): string {
  if (item.kind === 'text') return `${item.summary.added ?? 0}+ ${item.summary.removed ?? 0}- ${item.summary.changed ?? 0}~`
  if (item.kind === 'dir') {
    const counts = item.summary.dirCounts
    return counts ? `${counts.different}Δ ${counts.leftOnly}← ${counts.rightOnly}→` : '—'
  }
  if (item.kind === 'image') return item.summary.image ? `${item.summary.image.differing}/${item.summary.image.total}` : '—'
  return item.summary.binary?.same ? t('tools.compare.files.identical') : t('tools.compare.files.different')
}
