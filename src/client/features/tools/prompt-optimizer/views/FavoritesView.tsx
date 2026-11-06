/**
 * The favorites library: a searchable shelf of prompts, their versions and their examples.
 */

import { useEffect, useMemo, useState } from 'react'
import { Download, FolderPlus, Pencil, Plus, RotateCcw, Search, Star, Trash2, Upload } from 'lucide-react'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { Field, Input, Textarea } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { Swatch } from '../../../../components/color-swatch'
import { Modal, confirm } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import type { FavoritePrompt, FavoriteStats, FavoriteVersion } from '@shared/tools/prompt-optimizer/types'
import { promptOptimizerApi } from '../api'
import { useUiStore } from '../../../../lib/ui-store'
import { usePromptOptimizerStore } from '../store'
import type { PromptOptimizerNavView } from '@shared/tools/prompt-optimizer/types'

export function FavoritesView() {
  const favorites = usePromptOptimizerStore((s) => s.favorites)
  const categories = usePromptOptimizerStore((s) => s.categories)
  const search = usePromptOptimizerStore((s) => s.favoriteSearch)
  const category = usePromptOptimizerStore((s) => s.favoriteCategory)
  const tag = usePromptOptimizerStore((s) => s.favoriteTag)
  const setSearch = usePromptOptimizerStore((s) => s.setFavoriteSearch)
  const setCategory = usePromptOptimizerStore((s) => s.setFavoriteCategory)
  const setTag = usePromptOptimizerStore((s) => s.setFavoriteTag)
  const refreshFavorites = usePromptOptimizerStore((s) => s.refreshFavorites)
  const refreshCategories = usePromptOptimizerStore((s) => s.refreshCategories)
  const deleteFavorite = usePromptOptimizerStore((s) => s.deleteFavorite)
  const saveFavorite = usePromptOptimizerStore((s) => s.saveFavorite)
  const setWorkspace = usePromptOptimizerStore((s) => s.setWorkspace)
  const [editing, setEditing] = useState<FavoritePrompt | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [detail, setDetail] = useState<{ favorite: FavoritePrompt; versions: FavoriteVersion[] } | null>(null)
  const [stats, setStats] = useState<FavoriteStats | null>(null)
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null)
  const tags = useMemo(() => {
    const set = new Set<string>()
    for (const favorite of favorites) for (const item of favorite.tags) set.add(item)
    return [...set].sort()
  }, [favorites])

  useEffect(() => {
    void Promise.all([
      refreshFavorites(),
      refreshCategories(),
      promptOptimizerApi.favoriteStats().then(setStats),
    ])
  }, [refreshFavorites, refreshCategories])

  // Escape leaves the shelf and returns to the workspace, matching the reference favourites page.
  // A dialog in front of the page owns Escape itself, so its handler marks the event handled first.
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape' || event.isComposing || event.repeat) return
      const state = usePromptOptimizerStore.getState()
      void state.setActiveView(state.workspace)
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [])

  const useFavorite = async (favorite: FavoritePrompt) => {
    const workspace: PromptOptimizerNavView = favorite.functionMode === 'image'
      ? 'image_text2image'
      : favorite.functionMode === 'context'
        ? 'pro_variable'
        : favorite.optimizationMode === 'system'
          ? 'basic_system'
          : 'basic_user'
    await promptOptimizerApi.useFavorite(favorite.id)
    await setWorkspace(workspace, { prompt: favorite.content, optimized: favorite.content })
    useUiStore.getState().toast(t('tools.prompt_optimizer.favorites.used'), 'success')
  }

  const openDetail = async (favorite: FavoritePrompt) => {
    try {
      const payload = await promptOptimizerApi.favorite(favorite.id)
      setDetail(payload)
    } catch {
      useUiStore.getState().toast(t('tools.prompt_optimizer.errors.save_failed').replace('{message}', favorite.title), 'error')
    }
  }

  const exportAll = async () => {
    if (!favorites.length) return
    const rows = await Promise.all(favorites.map((favorite) => promptOptimizerApi.favorite(favorite.id)))
    downloadJson('prompt-optimizer-favorites.json', {
      exportedAt: Date.now(),
      favorites: rows.map((row) => ({ ...row.favorite, versions: row.versions })),
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2">
        <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
          {t('tools.prompt_optimizer.favorites.title')}
        </h1>
        <div className="relative ml-2 min-w-[180px] flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" aria-hidden="true" />
          <Input
            aria-label={t('tools.prompt_optimizer.favorites.search')}
            value={search}
            onChange={(event) => void setSearch(event.target.value)}
            placeholder={t('tools.prompt_optimizer.favorites.search')}
            className="pl-8"
          />
        </div>
        <SelectMenu
          label={t('tools.prompt_optimizer.favorites.category')}
          value={category}
          options={[{ value: '', label: t('tools.prompt_optimizer.favorites.all_categories') }, ...categories.map((item) => ({ value: item.id, label: item.name }))]}
          onChange={(value) => void setCategory(value)}
          width={200}
          size="sm"
        />
        {tags.length > 0 && (
          <SelectMenu
            label={t('tools.prompt_optimizer.favorites.tags')}
            value={tag}
            options={[{ value: '', label: t('tools.prompt_optimizer.favorites.all_tags') }, ...tags.map((item) => ({ value: item, label: item }))]}
            onChange={(value) => void setTag(value)}
            width={180}
            size="sm"
          />
        )}
        <Button variant="ghost" size="sm" onClick={() => setCategoriesOpen(true)}>
          <FolderPlus size={13} />
          {t('tools.prompt_optimizer.favorites.manage_categories')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
          <Upload size={13} />
          {t('tools.prompt_optimizer.favorites.import')}
        </Button>
        <Button variant="ghost" size="sm" disabled={!favorites.length} onClick={() => void exportAll()}>
          <Download size={13} />
          {t('tools.prompt_optimizer.favorites.export_all')}
        </Button>
        <Button variant="primary" size="sm" onClick={() => { setEditing(null); setEditorOpen(true) }}>
          <Plus size={13} />
          {t('tools.prompt_optimizer.favorites.new')}
        </Button>
      </header>

      {stats && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('tools.prompt_optimizer.favorites.stats_total').replace('{count}', String(stats.total))}
          </span>
          {stats.tags.slice(0, 8).map((item) => (
            <Badge key={item.tag} tone="neutral">{`${item.tag} · ${item.count}`}</Badge>
          ))}
          {stats.categories.filter((item) => item.count > 0).slice(0, 4).map((item) => (
            <Badge key={item.id} tone="accent">{`${item.name} · ${item.count}`}</Badge>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {favorites.length === 0 ? (
          <p className="py-16 text-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">
            {t('tools.prompt_optimizer.favorites.empty')}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {favorites.map((favorite) => (
              <article key={favorite.id} className="flex flex-col rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
                {favorite.metadata.coverAssetId && (
                  <img
                    src={`/api/tools/prompt-optimizer/assets/${favorite.metadata.coverAssetId}`}
                    alt={favorite.title}
                    className="mb-2 h-24 w-full rounded-[var(--r-sm)] object-cover"
                  />
                )}
                <div className="mb-1 flex items-start gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-[length:var(--text-13)] font-semibold text-[var(--text-primary)] hover:underline"
                    onClick={() => void openDetail(favorite)}
                  >
                    {favorite.title}
                  </button>
                  <IconButton label={t('tools.prompt_optimizer.common.edit')} size="xs" onClick={() => { setEditing(favorite); setEditorOpen(true) }}>
                    <Pencil size={12} />
                  </IconButton>
                  <IconButton
                    label={t('tools.prompt_optimizer.common.delete')}
                    size="xs"
                    onClick={() => void confirm({
                      title: t('tools.prompt_optimizer.favorites.delete_confirm').replace('{title}', favorite.title),
                      tone: 'danger',
                    }).then((ok) => { if (ok) void deleteFavorite(favorite.id) })}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
                {favorite.description && (
                  <p className="mb-2 line-clamp-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{favorite.description}</p>
                )}
                <pre className="mb-2 line-clamp-4 whitespace-pre-wrap text-[length:var(--text-12)] text-[var(--text-secondary)]">{favorite.content}</pre>
                <div className="mt-auto flex flex-wrap items-center gap-1">
                  {favorite.tags.slice(0, 4).map((item) => <Badge key={item} tone="neutral">{item}</Badge>)}
                  {favorite.useCount > 0 && <Badge tone="accent">{favorite.useCount}</Badge>}
                  <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void useFavorite(favorite)}>
                    <Star size={13} />
                    {t('tools.prompt_optimizer.favorites.use')}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <FavoriteEditorModal open={editorOpen} editing={editing} onClose={() => setEditorOpen(false)} />
      <CategoriesModal open={categoriesOpen} onClose={() => setCategoriesOpen(false)} />
      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={t('tools.prompt_optimizer.favorites.import')}
        width={560}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>{t('tools.prompt_optimizer.common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={!importText.trim()}
              onClick={() => {
                try {
                  const parsed = JSON.parse(importText) as { favorites?: unknown[] }
                  const rows = Array.isArray(parsed.favorites) ? parsed.favorites : Array.isArray(parsed) ? parsed : []
                  void (async () => {
                    for (const row of rows) {
                      const item = row as Record<string, unknown>
                      if (typeof item.title !== 'string' || typeof item.content !== 'string') continue
                      const functionMode = item.functionMode === 'context' || item.functionMode === 'image' ? item.functionMode : 'basic'
                      const optimizationMode = item.optimizationMode === 'user' || item.optimizationMode === 'system' ? item.optimizationMode : undefined
                      const imageSubMode = item.imageSubMode === 'text2image' || item.imageSubMode === 'image2image' || item.imageSubMode === 'multiimage'
                        ? item.imageSubMode
                        : undefined
                      await promptOptimizerApi.createFavorite({
                        title: item.title,
                        content: item.content,
                        description: typeof item.description === 'string' ? item.description : '',
                        functionMode,
                        ...(optimizationMode ? { optimizationMode } : {}),
                        ...(imageSubMode ? { imageSubMode } : {}),
                        ...(typeof item.categoryId === 'string' ? { categoryId: item.categoryId } : {}),
                        tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
                        metadata: item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
                          ? { ...(item.metadata as Record<string, unknown>), origin: 'import' }
                          : { origin: 'import' },
                        ...(Array.isArray(item.examples) ? { examples: item.examples as never } : {}),
                        ...(Array.isArray(item.versions) ? { versions: item.versions as never } : {}),
                      })
                    }
                    await Promise.all([refreshFavorites(), promptOptimizerApi.favoriteStats().then(setStats)])
                    setImportOpen(false)
                    setImportText('')
                  })()
                } catch {
                  useUiStore.getState().toast(t('tools.prompt_optimizer.errors.invalid_json'), 'error')
                }
              }}
            >
              {t('tools.prompt_optimizer.common.import')}
            </Button>
          </>
        )}
      >
        <Field label={t('tools.prompt_optimizer.favorites.import_hint')}>
          <Textarea value={importText} rows={10} onChange={(event) => setImportText(event.target.value)} className="font-mono text-[length:var(--text-12)]" />
        </Field>
      </Modal>
      <Modal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.favorite.title ?? ''}
        width={680}
        footer={<Button variant="ghost" onClick={() => setDetail(null)}>{t('tools.prompt_optimizer.common.close')}</Button>}
      >
        {detail && (
          <div className="flex flex-col gap-3">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-[var(--r-sm)] bg-[var(--bg-raised)] p-3 font-mono text-[length:var(--text-12)]">
              {detail.favorite.content}
            </pre>
            <div>
              <h3 className="mb-1 text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
                {t('tools.prompt_optimizer.favorites.versions')}
              </h3>
              {detail.versions.length === 0 ? (
                <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('tools.prompt_optimizer.common.empty')}</p>
              ) : (
                <ul className="flex max-h-64 flex-col gap-1 overflow-auto">
                  {detail.versions.map((version) => (
                    <li key={version.id} className="rounded-[var(--r-sm)] bg-[var(--bg-raised)] px-2 py-1 text-[length:var(--text-11)]">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[var(--text-tertiary)]">{`v${version.version}`}</span>
                        <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{version.title}</span>
                        <span className="text-[var(--text-tertiary)]">{new Date(version.createdAt).toLocaleDateString()}</span>
                        <Button variant="ghost" size="sm" onClick={() => setExpandedVersion(expandedVersion === version.id ? null : version.id)}>
                          {t('tools.prompt_optimizer.favorites.version_preview')}
                        </Button>
                        <IconButton
                          label={t('tools.prompt_optimizer.favorites.version_restore')}
                          size="xs"
                          onClick={() => void confirm({
                            title: t('tools.prompt_optimizer.favorites.version_restore_confirm').replace('{title}', version.title),
                            tone: 'danger',
                          }).then(async (ok) => {
                            if (!ok) return
                            await saveFavorite({
                              title: version.title,
                              content: version.content,
                              description: version.description,
                              functionMode: detail.favorite.functionMode as never,
                              optimizationMode: detail.favorite.optimizationMode as never,
                              imageSubMode: detail.favorite.imageSubMode as never,
                              categoryId: detail.favorite.categoryId,
                              tags: detail.favorite.tags,
                              metadata: version.metadata,
                              examples: detail.favorite.examples,
                            }, detail.favorite.id)
                            await openDetail(detail.favorite)
                          })}
                        >
                          <RotateCcw size={12} />
                        </IconButton>
                      </div>
                      {expandedVersion === version.id && (
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-2 font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]">
                          {version.content}
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-1 text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
                {t('tools.prompt_optimizer.favorites.examples')}
              </h3>
              {detail.favorite.examples.length === 0 ? (
                <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('tools.prompt_optimizer.favorites.no_examples')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {detail.favorite.examples.map((example) => (
                    <li key={example.id} className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-2 text-[length:var(--text-12)]">
                      <div className="mb-1 flex items-center gap-2">
                        <Badge tone="neutral">{example.label}</Badge>
                        {example.evaluation?.score !== undefined && <Badge tone="success">{example.evaluation.score}</Badge>}
                      </div>
                      <p className="text-[var(--text-tertiary)]">{t('tools.prompt_optimizer.workspace.test_input')}: {example.userPrompt}</p>
                      <pre className="mt-1 whitespace-pre-wrap text-[var(--text-secondary)]">{example.output}</pre>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => downloadJson(`${detail.favorite.id}.json`, {
                ...detail.favorite,
                versions: detail.versions,
              })}
            >
              <Download size={13} />
              {t('tools.prompt_optimizer.favorites.export')}
            </Button>
          </div>
        )}
      </Modal>
    </div>
  )
}

function FavoriteEditorModal({ open, editing, onClose }: { open: boolean; editing: FavoritePrompt | null; onClose: () => void }) {
  const categories = usePromptOptimizerStore((s) => s.categories)
  const images = usePromptOptimizerStore((s) => s.images)
  const saveFavorite = usePromptOptimizerStore((s) => s.saveFavorite)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [saving, setSaving] = useState(false)
  const [coverId, setCoverId] = useState('')

  useEffect(() => {
    if (!open) return
    setCoverId(String(editing?.metadata.coverAssetId ?? ''))
    setTitle(editing?.title ?? '')
    setContent(editing?.content ?? '')
    setDescription(editing?.description ?? '')
    setTags(editing?.tags.join(', ') ?? '')
    setCategoryId(editing?.categoryId ?? '')
  }, [open, editing])

  const submit = async () => {
    if (!title.trim() || !content.trim()) return
    setSaving(true)
    try {
      const metadata = { ...(editing?.metadata ?? { origin: 'manual' }) }
      if (coverId) metadata.coverAssetId = coverId
      else delete metadata.coverAssetId
      await saveFavorite({
        title: title.trim(),
        content,
        description,
        functionMode: (editing?.functionMode as never) ?? 'basic',
        optimizationMode: editing?.optimizationMode as never,
        imageSubMode: editing?.imageSubMode as never,
        categoryId: categoryId || null,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        metadata,
        examples: editing?.examples ?? [],
      }, editing?.id)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t('tools.prompt_optimizer.templates.edit') : t('tools.prompt_optimizer.favorites.new')}
      width={680}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('tools.prompt_optimizer.common.cancel')}</Button>
          <Button variant="primary" loading={saving} disabled={!title.trim() || !content.trim()} onClick={() => void submit()}>
            {t('tools.prompt_optimizer.common.save')}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <Field label={t('tools.prompt_optimizer.favorites.title_field')} required>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label={t('tools.prompt_optimizer.favorites.content_field')} required>
          <Textarea value={content} rows={9} onChange={(event) => setContent(event.target.value)} className="font-mono text-[length:var(--text-13)]" />
        </Field>
        <Field label={t('tools.prompt_optimizer.favorites.description_field')}>
          <Textarea value={description} rows={2} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <div className="flex items-end gap-2">
          <Field label={t('tools.prompt_optimizer.favorites.cover')}>
            <SelectMenu
              label={t('tools.prompt_optimizer.favorites.cover')}
              value={coverId}
              options={[
                { value: '', label: t('tools.prompt_optimizer.common.none') },
                ...images.map((asset) => ({ value: asset.id, label: asset.prompt || asset.id })),
              ]}
              onChange={setCoverId}
              width={260}
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('tools.prompt_optimizer.favorites.category')}>
            <SelectMenu
              label={t('tools.prompt_optimizer.favorites.category')}
              value={categoryId}
              options={[{ value: '', label: t('tools.prompt_optimizer.favorites.all_categories') }, ...categories.map((category) => ({ value: category.id, label: category.name }))]}
              onChange={setCategoryId}
              width={220}
            />
          </Field>
          <Field label={t('tools.prompt_optimizer.favorites.tags')}>
            <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder={t('tools.prompt_optimizer.favorites.tags')} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

const CATEGORY_COLORS = [
  { token: 'var(--accent)', label: 'tools.prompt_optimizer.favorites.color_accent' },
  { token: 'var(--success)', label: 'tools.prompt_optimizer.favorites.color_success' },
  { token: 'var(--warning)', label: 'tools.prompt_optimizer.favorites.color_warning' },
  { token: 'var(--danger)', label: 'tools.prompt_optimizer.favorites.color_danger' },
  { token: 'var(--text-secondary)', label: 'tools.prompt_optimizer.favorites.color_neutral' },
  { token: 'var(--text-tertiary)', label: 'tools.prompt_optimizer.favorites.color_muted' },
] as const

function categoryDepth(category: { parentId: string | null }, categories: { id: string; parentId: string | null }[]): number {
  let depth = 0
  let parentId = category.parentId
  const seen = new Set<string>()
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = categories.find((item) => item.id === parentId)
    if (!parent) break
    depth += 1
    parentId = parent.parentId
  }
  return depth
}

function categoryDescendants(id: string, categories: { id: string; parentId: string | null }[]): Set<string> {
  const found = new Set<string>([id])
  let changed = true
  while (changed) {
    changed = false
    for (const category of categories) {
      if (category.parentId && found.has(category.parentId) && !found.has(category.id)) {
        found.add(category.id)
        changed = true
      }
    }
  }
  return found
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function CategoriesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const categories = usePromptOptimizerStore((s) => s.categories)
  const saveCategory = usePromptOptimizerStore((s) => s.saveCategory)
  const deleteCategory = usePromptOptimizerStore((s) => s.deleteCategory)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState('var(--accent)')
  const [parentId, setParentId] = useState('')
  const reset = () => {
    setEditingId(null)
    setName('')
    setColor('var(--accent)')
    setParentId('')
  }
  const excluded = editingId ? categoryDescendants(editingId, categories) : new Set<string>()
  const parentOptions = [
    { value: '', label: t('tools.prompt_optimizer.common.none') },
    ...categories
      .filter((category) => !excluded.has(category.id))
      .map((category) => ({
        value: category.id,
        label: `${'— '.repeat(categoryDepth(category, categories))}${category.name}`,
      })),
  ]
  const submit = () => {
    if (!name.trim()) return
    void saveCategory({
      name: name.trim(),
      description: '',
      color,
      sortOrder: categories.find((category) => category.id === editingId)?.sortOrder ?? categories.length,
      ...(parentId ? { parentId } : {}),
    }, editingId ?? undefined)
    reset()
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('tools.prompt_optimizer.favorites.manage_categories')}
      width={620}
      footer={<Button variant="ghost" onClick={onClose}>{t('tools.prompt_optimizer.common.close')}</Button>}
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('tools.prompt_optimizer.favorites.category_name')}>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label={t('tools.prompt_optimizer.favorites.category_parent')}>
            <SelectMenu
              label={t('tools.prompt_optimizer.favorites.category_parent')}
              value={parentId}
              options={parentOptions}
              onChange={setParentId}
              width={260}
            />
          </Field>
        </div>
        <Field label={t('tools.prompt_optimizer.favorites.category_color')}>
          <div role="group" aria-label={t('tools.prompt_optimizer.favorites.category_color')} className="flex items-center gap-2">
            {CATEGORY_COLORS.map((entry) => (
              <Swatch
                key={entry.token}
                color={entry.token}
                label={t(entry.label)}
                active={color === entry.token}
                onPick={() => setColor(entry.token)}
                background={entry.token}
                variant="format"
              />
            ))}
          </div>
        </Field>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={!name.trim()} onClick={submit}>
            <Plus size={13} />
            {t(editingId ? 'tools.prompt_optimizer.common.save' : 'tools.prompt_optimizer.common.add')}
          </Button>
          {editingId && (
            <Button variant="ghost" size="sm" onClick={reset}>{t('tools.prompt_optimizer.common.cancel')}</Button>
          )}
        </div>
        {categories
          .slice()
          .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
          .map((category) => (
            <div key={category.id} className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1" style={{ marginLeft: `${categoryDepth(category, categories) * 16}px` }}>
              <span className="h-3 w-3 rounded-full" style={{ background: category.color }} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{category.name}</span>
              <IconButton
                label={t('tools.prompt_optimizer.favorites.category_edit')}
                size="xs"
                onClick={() => {
                  setEditingId(category.id)
                  setName(category.name)
                  setColor(category.color)
                  setParentId(category.parentId ?? '')
                }}
              >
                <Pencil size={12} />
              </IconButton>
              <IconButton
                label={t('tools.prompt_optimizer.common.delete')}
                size="xs"
                onClick={() => void confirm({
                  title: t('tools.prompt_optimizer.favorites.category_delete_confirm').replace('{name}', category.name),
                  tone: 'danger',
                }).then((ok) => { if (ok) void deleteCategory(category.id) })}
              >
                <Trash2 size={12} />
              </IconButton>
            </div>
          ))}
      </div>
    </Modal>
  )
}
