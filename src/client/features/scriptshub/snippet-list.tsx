/**
 * The snippet list between the rail and the editor.
 *
 * Search is the list's own field and settles after a pause: every keystroke is a server query, and a
 * Chinese phrase typed quickly would otherwise arrive as five half-words. The quick switcher is the
 * sort menu beside it; batch actions only appear when rows are actually selected.
 */
import { useEffect, useMemo, useState, type RefObject } from 'react'
import { Pin, Plus, Search, Star, Upload, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { relativeTime } from '../../lib/time'
import { Badge, Button, IconButton } from '../../components/primitives'
import { Checkbox, Input } from '../../components/form'
import { Empty, NoteListSkeleton } from '../../components/feedback'
import { FolderPicker } from '../folders/FolderPicker'
import { SelectMenu } from '../../components/select-menu'
import { confirm } from '../../components/overlay'
import { useScriptsHub, folderPathOf } from './store'
import { LanguageIcon } from './language-icon'
import { TagPickerDialog } from './tag-picker'
import { asNotebookFolders } from './sidebar'
import type { ScriptSnippetSummary } from '@shared/scriptshub/types'

const SEARCH_DELAY_MS = 260

export function SnippetList({ searchRef, onOpenDetail }: {
  searchRef: RefObject<HTMLInputElement | null>
  onOpenDetail?: () => void
}) {
  const snippets = useScriptsHub((state) => state.snippets)
  const total = useScriptsHub((state) => state.total)
  const loading = useScriptsHub((state) => state.listLoading)
  const error = useScriptsHub((state) => state.listError)
  const query = useScriptsHub((state) => state.query)
  const overview = useScriptsHub((state) => state.overview)
  const select = useScriptsHub((state) => state.select)
  const loadList = useScriptsHub((state) => state.loadList)
  const batch = useScriptsHub((state) => state.batch)
  const createTag = useScriptsHub((state) => state.createTag)
  const [search, setSearch] = useState(query.search ?? '')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [tagOpen, setTagOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const folders = useMemo(() => asNotebookFolders(overview?.folders ?? []), [overview?.folders])
  const tags = overview?.tags ?? []
  const selectedRows = snippets.filter((snippet) => chosen.has(snippet.id))
  const allChosen = snippets.length > 0 && selectedRows.length === snippets.length

  useEffect(() => {
    const delayed = window.setTimeout(() => {
      const current = useScriptsHub.getState().query.search ?? ''
      if (search !== current) void loadList({ search, offset: 0 })
    }, SEARCH_DELAY_MS)
    return () => window.clearTimeout(delayed)
  }, [search, loadList])

  useEffect(() => {
    setChosen((current) => {
      const live = new Set(snippets.map((snippet) => snippet.id))
      const next = new Set([...current].filter((id) => live.has(id)))
      return next.size === current.size ? current : next
    })
  }, [snippets])

  const toggle = (id: string) => {
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const open = (snippet: ScriptSnippetSummary) => {
    void select(snippet.id)
    onOpenDetail?.()
  }

  const removeChosen = async () => {
    if (!selectedRows.length) return
    const agreed = await confirm({
      title: t('scriptshub.confirm.delete_snippets_title', { count: selectedRows.length }),
      description: t('scriptshub.confirm.delete_snippets_body'),
      confirmLabel: t('scriptshub.common.delete'),
      tone: 'danger',
    })
    if (!agreed) return
    setBusy(true)
    try {
      await batch({ action: 'delete', ids: selectedRows.map((snippet) => snippet.id) })
      setChosen(new Set())
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex h-full min-h-0 w-full shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-base)] md:w-[340px]">
      <div className="space-y-2 border-b border-[var(--border-subtle)] px-3 py-3">
        <div className="flex items-center gap-2">
          <Input
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            leading={<Search size={13} aria-hidden="true" />}
            trailing={search ? (
              <IconButton label={t('scriptshub.list.clear_search')} size="xs" onClick={() => setSearch('')}>
                <X size={11} aria-hidden="true" />
              </IconButton>
            ) : undefined}
            aria-label={t('scriptshub.list.search_label')}
            placeholder={t('scriptshub.list.search')}
          />
          <IconButton
            label={t('scriptshub.sidebar.new_snippet')}
            variant="primary"
            onClick={() => {
              void useScriptsHub.getState().create({
                title: t('scriptshub.defaults.new_title'),
                folderId: useScriptsHub.getState().query.folderId,
                language: 'shell',
              }).then((detail) => {
                void select(detail.id)
                onOpenDetail?.()
              })
            }}
          >
            <Plus size={14} aria-hidden="true" />
          </IconButton>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t('scriptshub.list.count', { count: total })}
          </p>
          <SelectMenu
            size="sm"
            width={168}
            label={t('scriptshub.list.sort_label')}
            value={query.sort ?? 'updated'}
            onChange={(value) => void loadList({ sort: value as typeof query.sort, offset: 0 })}
            options={[
              { value: 'updated', label: t('scriptshub.list.sort_updated') },
              { value: 'created', label: t('scriptshub.list.sort_created') },
              { value: 'title', label: t('scriptshub.list.sort_title') },
              { value: 'uses', label: t('scriptshub.list.sort_uses') },
            ]}
            className="w-[132px]"
          />
        </div>
        {selectedRows.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-[var(--r-md)] bg-[var(--bg-raised)] p-1.5">
            <span className="px-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('scriptshub.list.selected', { count: selectedRows.length })}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setTagOpen(true)} disabled={busy}>
              {t('scriptshub.list.batch_tag')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMoveOpen(true)} disabled={busy}>
              {t('scriptshub.list.batch_move')}
            </Button>
            <Button size="sm" variant="ghost" className="text-[var(--danger)]" onClick={() => void removeChosen()} disabled={busy}>
              {t('scriptshub.common.delete')}
            </Button>
            <IconButton label={t('scriptshub.list.clear_selection')} size="xs" onClick={() => setChosen(new Set())}>
              <X size={11} aria-hidden="true" />
            </IconButton>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && snippets.length === 0 && <NoteListSkeleton count={8} />}
        {!loading && error && (
          <div className="p-6 text-center text-[length:var(--text-12)] text-[var(--danger)]">
            <p>{error}</p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => void loadList()}>
              {t('scriptshub.common.retry')}
            </Button>
          </div>
        )}
        {!loading && !error && snippets.length === 0 && (
          <Empty
            art={query.search ? 'search' : 'folder'}
            title={query.search ? t('scriptshub.list.empty_search') : t('scriptshub.list.empty')}
            description={query.search ? t('scriptshub.list.empty_search_hint') : t('scriptshub.list.empty_hint')}
            compact
            action={!query.search && (
              <Button variant="primary" icon={<Plus size={13} aria-hidden="true" />} onClick={() => {
                void useScriptsHub.getState().create({
                  title: t('scriptshub.defaults.new_title'),
                  folderId: useScriptsHub.getState().query.folderId,
                  language: 'shell',
                }).then((detail) => void select(detail.id))
              }}>
                {t('scriptshub.sidebar.new_snippet')}
              </Button>
            )}
          />
        )}
        {snippets.length > 0 && (
          <>
            <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5">
              <Checkbox
                checked={allChosen}
                ariaLabel={t('scriptshub.list.select_all')}
                onChange={(next) => setChosen(next ? new Set(snippets.map((snippet) => snippet.id)) : new Set())}
              />
              <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('scriptshub.list.select_all')}</span>
            </div>
            <div role="list" aria-label={t('scriptshub.list.title')}>
              {snippets.map((snippet) => {
                const on = chosen.has(snippet.id)
                return (
                  <div key={snippet.id} role="listitem" className={cn('group flex items-start gap-2 border-b border-[var(--border-subtle)] px-3 py-2.5', on && 'bg-[var(--accent-soft)]/35')}>
                    <Checkbox
                      checked={on}
                      ariaLabel={t('scriptshub.list.select_one', { title: snippet.title })}
                      onChange={() => toggle(snippet.id)}
                      className="mt-0.5"
                    />
                    <button
                      type="button"
                      onClick={() => open(snippet)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-start gap-2">
                        <LanguageIcon id={snippet.language} size={15} className="mt-0.5 shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="min-w-0 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{snippet.title}</span>
                            {snippet.isPinned && <Pin size={10} aria-hidden="true" className="shrink-0 text-[var(--accent)]" />}
                            {snippet.isFavorite && <Star size={10} aria-hidden="true" className="shrink-0 text-[var(--warning)]" />}
                          </span>
                          {snippet.description && (
                            <span className="mt-0.5 line-clamp-2 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{snippet.description}</span>
                          )}
                          <span className="mt-1 flex flex-wrap items-center gap-1.5">
                            {snippet.publication && (
                              <Badge tone="success" className="gap-1">
                                <Upload size={9} aria-hidden="true" />
                                {t('scriptshub.list.published')}
                              </Badge>
                            )}
                            {snippet.isDeprecated && <Badge tone="warning">{t('scriptshub.list.deprecated')}</Badge>}
                            {snippet.tags.slice(0, 3).map((tag) => (
                              <span key={tag.id} className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                                #{tag.name}
                              </span>
                            ))}
                          </span>
                        </span>
                        <span className="shrink-0 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
                          {relativeTime(snippet.updatedAt)}
                        </span>
                      </div>
                    </button>
                  </div>
                )
              })}
            </div>
            {total > snippets.length && (
              <div className="p-3 text-center">
                <Button size="sm" variant="ghost" onClick={() => void loadList({ offset: snippets.length })}>
                  {t('scriptshub.list.load_more')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {query.folderId && (
        <div className="border-t border-[var(--border-subtle)] px-3 py-1.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          {folderPathOf(overview?.folders ?? [], query.folderId).map((folder) => folder.name).join(' / ')}
        </div>
      )}

      <TagPickerDialog
        open={tagOpen}
        tags={tags}
        selected={[]}
        title={t('scriptshub.list.batch_tag')}
        onClose={() => setTagOpen(false)}
        onCreate={(name) => createTag({ name })}
        onConfirm={async (ids) => {
          if (!ids.length) return
          await batch({ action: 'tag', ids: selectedRows.map((snippet) => snippet.id), tagIds: ids })
          setChosen(new Set())
        }}
      />
      <FolderPicker
        open={moveOpen}
        title={t('scriptshub.list.batch_move')}
        folders={folders}
        allowRoot
        rootLabel={t('scriptshub.sidebar.unfiled')}
        onSelect={(folderId) => {
          void batch({ action: 'move', ids: selectedRows.map((snippet) => snippet.id), folderId })
            .then(() => setChosen(new Set()))
          setMoveOpen(false)
        }}
        onClose={() => setMoveOpen(false)}
      />
    </section>
  )
}
