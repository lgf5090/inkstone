/**
 * The snippet list between the rail and the editor.
 *
 * Every row carries what a reader decides with: the language, a line of the code itself, its tags,
 * how much there is and when it last moved. Search settles after a pause because every keystroke is
 * a server query; the density switch is the list's own, kept per device. The row menu is the same
 * `Menu` the notebook uses, so arrows, Enter, Esc and Shift+F10 behave identically.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  Copy, CopyPlus, Download, FileCode2, FilePlus2, FolderInput, Image as ImageIcon, Info, LayoutGrid, List,
  Pencil, Pin, Plus, Radio, Rows3, Rows4, Search, Star, Tag as TagIcon, Trash2, Upload, Wand2, X,
} from 'lucide-react'
import { publicationUrlPath } from '@shared/scriptshub/path'
import { serializeScriptExport } from '@shared/scriptshub/import'
import { cn } from '../../lib/cn'
import { isImeComposing } from '../../lib/ime'
import { copyText } from '../../lib/clipboard'
import { t } from '../../lib/i18n'
import { formatBytes, fullTime, relativeTime } from '../../lib/time'
import { Badge, Button, IconButton } from '../../components/primitives'
import { Checkbox, Input } from '../../components/form'
import { Empty, NoteListSkeleton } from '../../components/feedback'
import { Menu, MenuSubmenuList, Modal, Tooltip, confirm, useContextMenu, type MenuItem } from '../../components/overlay'
import { FolderPicker } from '../folders/FolderPicker'
import { SelectMenu } from '../../components/select-menu'
import { useUi } from '../../store/ui'
import { useScriptsHub, folderPathOf } from './store'
import { LanguageIcon } from './language-icon'
import { TagPickerDialog } from './tag-picker'
import { asNotebookFolders, SNIPPET_DRAG } from './sidebar'
import { scriptshubApi } from './api'
import { TagPills } from './tag-pill'
import { exportCodeCard } from './code-image'
import type { ScriptFolder, ScriptSnippetSummary, ScriptTag } from '@shared/scriptshub/types'

const SEARCH_DELAY_MS = 260

type Density = 'comfortable' | 'compact'
type Layout = 'list' | 'grid'
type PanelKind = 'history' | 'publish'

const DENSITY_KEY = 'scriptshub:row-density'
const LAYOUT_KEY = 'scriptshub:row-layout'

function readPreference<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = window.localStorage.getItem(key)
    return value && allowed.includes(value as T) ? value as T : fallback
  } catch {
    return fallback
  }
}

function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // A blocked storage area only costs the preference, not the action that set it.
  }
}

function downloadJson(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function commandFor(path: string, fileName: string, language: string): string {
  const url = `${window.location.origin}${publicationUrlPath(path)}`
  return language === 'shell' ? `curl -fsSL ${url} | bash` : `curl -fsSL ${url} -o ${fileName}`
}

export function SnippetList({ searchRef, onOpenDetail, onOpenPanel, expanded = false }: {
  searchRef: RefObject<HTMLInputElement | null>
  onOpenDetail?: () => void
  onOpenPanel?: (id: string, panel: PanelKind) => void
  expanded?: boolean
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
  const blankMenu = useContextMenu()
  const [search, setSearch] = useState(query.search ?? '')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [tagOpen, setTagOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [density, setDensity] = useState<Density>(() => readPreference(DENSITY_KEY, 'comfortable', ['comfortable', 'compact'] as const))
  const [layout, setLayout] = useState<Layout>(() => readPreference(LAYOUT_KEY, 'list', ['list', 'grid'] as const))
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

  const chooseDensity = (next: Density) => {
    setDensity(next)
    writePreference(DENSITY_KEY, next)
  }
  const chooseLayout = (next: Layout) => {
    setLayout(next)
    writePreference(LAYOUT_KEY, next)
  }

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

  const newSnippet = () => {
    void useScriptsHub.getState().create({
      title: t('scriptshub.defaults.new_title'),
      folderId: useScriptsHub.getState().query.folderId,
      language: 'shell',
    }).then((detail) => {
      void select(detail.id)
      onOpenDetail?.()
    })
  }

  return (
    <section className={cn(
      "flex h-full min-h-0 w-full shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-base)]",
      "transition-[width] duration-[var(--dur-base)] ease-[var(--ease-out)] motion-reduce:transition-none",
      expanded ? "md:w-[420px]" : "md:w-[340px]",
    )}>
      <div className="space-y-2 border-b border-[var(--border-subtle)] px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
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
          </div>
          <IconButton label={t('scriptshub.sidebar.new_snippet')} variant="primary" onClick={newSnippet}>
            <Plus size={14} aria-hidden="true" />
          </IconButton>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t('scriptshub.list.count', { count: total })}
          </p>
          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip label={layout === 'list' ? t('scriptshub.list.show_grid') : t('scriptshub.list.show_list')} side="bottom">
              <IconButton
                label={layout === 'list' ? t('scriptshub.list.show_grid') : t('scriptshub.list.show_list')}
                size="sm"
                onClick={() => chooseLayout(layout === 'list' ? 'grid' : 'list')}
              >
                {layout === 'list' ? <LayoutGrid size={13} aria-hidden="true" /> : <List size={13} aria-hidden="true" />}
              </IconButton>
            </Tooltip>
            {layout === 'list' && (
              <Tooltip label={density === 'compact' ? t('scriptshub.list.comfortable') : t('scriptshub.list.compact')} side="bottom">
                <IconButton
                  label={density === 'compact' ? t('scriptshub.list.comfortable') : t('scriptshub.list.compact')}
                  size="sm"
                  onClick={() => chooseDensity(density === 'compact' ? 'comfortable' : 'compact')}
                >
                  {density === 'compact' ? <Rows4 size={13} aria-hidden="true" /> : <Rows3 size={13} aria-hidden="true" />}
                </IconButton>
              </Tooltip>
            )}
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
              className="w-[124px]"
            />
          </div>
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

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onContextMenu={(event) => {
          event.preventDefault()
          blankMenu.onContextMenu(event)
        }}
      >
        {blankMenu.point && (
          <Menu
            anchor={blankMenu.point}
            open
            onClose={blankMenu.close}
            width={200}
            items={[
              { id: "blank-new", label: t("scriptshub.list.blank_new"), onSelect: newSnippet },
              { id: "blank-refresh", label: t("scriptshub.list.blank_refresh"), onSelect: () => void loadList() },
              { id: "blank-select", label: allChosen ? t("scriptshub.list.clear_selection") : t("scriptshub.list.select_all"), separatorBefore: true, onSelect: () => setChosen(allChosen ? new Set() : new Set(snippets.map((snippet) => snippet.id))) },
              { id: "blank-layout", label: layout === "list" ? t("scriptshub.list.show_grid") : t("scriptshub.list.show_list"), separatorBefore: true, onSelect: () => chooseLayout(layout === "list" ? "grid" : "list") },
              { id: "blank-density", label: density === "compact" ? t("scriptshub.list.comfortable") : t("scriptshub.list.compact"), disabled: layout === "grid", reason: layout === "grid" ? t("scriptshub.list.reason_grid_density") : undefined, onSelect: () => chooseDensity(density === "compact" ? "comfortable" : "compact") },
            ]}
          />
        )}
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
              <Button variant="primary" icon={<Plus size={13} aria-hidden="true" />} onClick={newSnippet}>
                {t('scriptshub.sidebar.new_snippet')}
              </Button>
            )}
          />
        )}
        {snippets.length > 0 && (
          <>
            {layout === 'list' && (
              <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5">
                <Checkbox
                  checked={allChosen}
                  ariaLabel={t('scriptshub.list.select_all')}
                  onChange={(next) => setChosen(next ? new Set(snippets.map((snippet) => snippet.id)) : new Set())}
                />
                <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('scriptshub.list.select_all')}</span>
              </div>
            )}
            <SnippetRows
              snippets={snippets}
              layout={layout}
              density={density}
              chosen={chosen}
              folders={overview?.folders ?? []}
              tags={tags}
              onOpen={open}
              onToggle={toggle}
              onOpenPanel={onOpenPanel}
              onListChanged={() => {
                void loadList()
                void useScriptsHub.getState().refreshOverview()
              }}
            />
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

function SnippetRows({ snippets, layout, density, chosen, folders, tags, onOpen, onToggle, onOpenPanel, onListChanged }: {
  snippets: ScriptSnippetSummary[]
  layout: Layout
  density: Density
  chosen: Set<string>
  folders: readonly ScriptFolder[]
  tags: ScriptTag[]
  onOpen: (snippet: ScriptSnippetSummary) => void
  onToggle: (id: string) => void
  onOpenPanel?: (id: string, panel: PanelKind) => void
  onListChanged: () => void
}) {
  return layout === 'grid' ? (
    <div role="list" aria-label={t('scriptshub.list.title')} className="grid grid-cols-2 gap-2 p-2.5">
      {snippets.map((snippet) => (
        <SnippetRow
          key={snippet.id}
          snippet={snippet}
          layout="grid"
          density="compact"
          on={chosen.has(snippet.id)}
          folders={folders}
          tags={tags}
          onOpen={onOpen}
          onToggle={onToggle}
          onOpenPanel={onOpenPanel}
          onListChanged={onListChanged}
        />
      ))}
    </div>
  ) : (
    <div role="list" aria-label={t('scriptshub.list.title')}>
      {snippets.map((snippet) => (
        <SnippetRow
          key={snippet.id}
          snippet={snippet}
          layout="list"
          density={density}
          on={chosen.has(snippet.id)}
          folders={folders}
          tags={tags}
          onOpen={onOpen}
          onToggle={onToggle}
          onOpenPanel={onOpenPanel}
          onListChanged={onListChanged}
        />
      ))}
    </div>
  )
}

function SnippetRow({ snippet, layout, density, on, folders, tags, onOpen, onToggle, onOpenPanel, onListChanged }: {
  snippet: ScriptSnippetSummary
  layout: Layout
  density: Density
  on: boolean
  folders: readonly ScriptFolder[]
  tags: ScriptTag[]
  onOpen: (snippet: ScriptSnippetSummary) => void
  onToggle: (id: string) => void
  onOpenPanel?: (id: string, panel: PanelKind) => void
  onListChanged: () => void
}) {
  const menu = useContextMenu()
  const toast = useUi((state) => state.toast)
  const patchSnippet = useScriptsHub((state) => state.patchSnippet)
  const duplicate = useScriptsHub((state) => state.duplicate)
  const [renaming, setRenaming] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const [propertiesOpen, setPropertiesOpen] = useState(false)
  const [properties, setProperties] = useState<{ lines: number; chars: number; created: number; updated: number } | null>(null)
  const longPress = useRef<{ timer: number; fired: boolean }>({ timer: 0, fired: false })
  const [renameValue, setRenameValue] = useState(snippet.title)
  const renameRef = useRef<HTMLInputElement>(null)
  const tagList = snippet.tags
  const publications = snippet.publications
  const publishedCount = publications.length
  const folderChoices = useMemo(() => asNotebookFolders(folders), [folders])
  const folderLabel = folderPathOf(folders, snippet.folderId).map((folder) => folder.name).join(' / ')

  useEffect(() => {
    if (renaming) renameRef.current?.select()
  }, [renaming])

  const startRename = () => {
    setRenameValue(snippet.title)
    setRenaming(true)
  }

  const commitRename = async () => {
    const next = renameValue.trim()
    setRenaming(false)
    if (!next || next === snippet.title) return
    try {
      // A title is part of a version, so the rename goes through the same save the editor uses:
      // otherwise restoring the latest content would quietly bring the old title back with it.
      const detail = await scriptshubApi.getSnippet(snippet.id)
      await useScriptsHub.getState().save(snippet.id, {
        title: next,
        description: detail.description,
        folderId: detail.folderId,
        language: detail.files[0]?.language ?? detail.language,
        sourceUrl: detail.sourceUrl,
        notes: detail.notes,
        tags: detail.tags.map((tag) => tag.id),
        files: detail.files.map((file) => ({ id: file.id, name: file.name, language: file.language, content: file.content })),
      })
      toast({ title: t('scriptshub.toast.renamed'), tone: 'success' })
    } catch (error) {
      toast({ title: t('scriptshub.toast.rename_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
      setRenameValue(snippet.title)
    }
  }

  const copyValue = async (value: string) => {
    const ok = await copyText(value)
    toast({ title: ok ? t('scriptshub.editor.copied') : t('scriptshub.common.copy_failed'), tone: ok ? 'success' : 'danger' })
  }

  const copyPath = async (publication: ScriptSnippetSummary['publications'][number]) => {
    await copyValue(`${window.location.origin}${publicationUrlPath(publication.path)}`)
  }

  const copyCurl = async (publication: ScriptSnippetSummary['publications'][number]) => {
    const files = (await scriptshubApi.getSnippet(snippet.id)).files
    const file = files.find((entry) => entry.id === publication.fileId)
    await copyValue(commandFor(publication.path, file?.name ?? snippet.title, file?.language ?? snippet.language))
  }

  const exportOne = async (format: 'generic' | 'masscode' | 'vscode' | 'file') => {
    try {
      const detail = await scriptshubApi.getSnippet(snippet.id)
      if (format === 'file') {
        const first = detail.files[0]
        if (!first) return
        const ok = await copyText(first.content)
        toast({ title: ok ? t('scriptshub.editor.copied') : t('scriptshub.common.copy_failed'), tone: ok ? 'success' : 'danger' })
        return
      }
      const text = serializeScriptExport([{
        title: detail.title,
        description: detail.description,
        tags: detail.tags.map((tag) => tag.name),
        files: detail.files.map((file) => ({ name: file.name, language: file.language, content: file.content })),
      }])
      downloadJson(text, `${snippet.title.replace(/[\/:*?"<>|]/g, '-')}.json`)
      toast({ title: t('scriptshub.export.done'), tone: 'success' })
    } catch (error) {
      toast({ title: t('scriptshub.export.failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  const copyAllFiles = async () => {
    const detail = await scriptshubApi.getSnippet(snippet.id)
    const text = detail.files.map((file) => `# ${file.name}\n${file.content}`).join('\n\n')
    await copyValue(text)
  }

  const exportImage = async () => {
    try {
      const detail = await scriptshubApi.getSnippet(snippet.id)
      const first = detail.files[0]
      if (!first) return
      await exportCodeCard({ title: detail.title, fileLabel: first.name, content: first.content })
      toast({ title: t('scriptshub.export.image_done'), tone: 'success' })
    } catch (error) {
      toast({ title: t('scriptshub.export.image_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  const openProperties = async () => {
    const detail = await scriptshubApi.getSnippet(snippet.id)
    const lines = detail.files.reduce((total, file) => total + (file.content ? file.content.split('\n').length : 1), 0)
    const chars = detail.files.reduce((total, file) => total + file.content.length, 0)
    setProperties({ lines, chars, created: detail.createdAt, updated: detail.updatedAt })
    setPropertiesOpen(true)
  }

  const togglePublish = async (publication: ScriptSnippetSummary['publications'][number], enabled: boolean) => {
    await useScriptsHub.getState().updatePublication(publication.id, { isEnabled: enabled })
  }

  const actions: MenuItem[] = [
    { id: 'open', label: t('scriptshub.menu.open'), icon: <FilePlus2 size={13} aria-hidden="true" />, combo: '↵', onSelect: () => onOpen(snippet) },
    { id: 'rename', label: t('scriptshub.menu.rename_snippet'), icon: <Pencil size={13} aria-hidden="true" />, combo: 'F2', onSelect: startRename },
    { id: 'duplicate', label: t('scriptshub.menu.duplicate'), icon: <CopyPlus size={13} aria-hidden="true" />, onSelect: () => {
      void duplicate(snippet.id).then(() => toast({ title: t('scriptshub.toast.duplicated'), tone: 'success' })).catch((error: unknown) => {
        toast({ title: t('scriptshub.toast.duplicate_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
      })
    } },
    { id: 'copy-title', label: t('scriptshub.menu.copy_title'), icon: <Copy size={13} aria-hidden="true" />, separatorBefore: true, onSelect: () => void copyValue(snippet.title) },
    { id: 'copy-code', label: t('scriptshub.menu.copy_code'), icon: <Copy size={13} aria-hidden="true" />, onSelect: () => {
      void scriptshubApi.getSnippet(snippet.id).then(async (detail) => {
        const ok = await copyText(detail.files[0]?.content ?? '')
        toast({ title: ok ? t('scriptshub.editor.copied') : t('scriptshub.common.copy_failed'), tone: ok ? 'success' : 'danger' })
      }).catch((error: unknown) => toast({ title: t('scriptshub.common.copy_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' }))
    } },
    { id: 'copy-all-files', label: t('scriptshub.menu.copy_all_files'), icon: <Copy size={13} aria-hidden="true" />, onSelect: () => void copyAllFiles() },
    { id: 'move', label: t('scriptshub.menu.move'), icon: <FolderInput size={13} aria-hidden="true" />, separatorBefore: true, onSelect: () => setMoveOpen(true) },
    { id: 'tags', label: t('scriptshub.menu.tags'), icon: <TagIcon size={13} aria-hidden="true" />, onSelect: () => setTagOpen(true) },
    { id: 'clear-tags', label: t('scriptshub.menu.clear_tags'), icon: <TagIcon size={13} aria-hidden="true" />, disabled: tagList.length === 0, reason: tagList.length ? undefined : t('scriptshub.menu.reason_no_tags'), onSelect: () => void patchSnippet(snippet.id, { tags: [] }) },
    { id: 'pin', label: snippet.isPinned ? t('scriptshub.menu.unpin') : t('scriptshub.menu.pin'), icon: <Pin size={13} aria-hidden="true" />, checked: snippet.isPinned, onSelect: () => void patchSnippet(snippet.id, { isPinned: !snippet.isPinned }) },
    { id: 'favorite', label: snippet.isFavorite ? t('scriptshub.menu.unfavorite') : t('scriptshub.menu.favorite'), icon: <Star size={13} aria-hidden="true" />, checked: snippet.isFavorite, onSelect: () => void patchSnippet(snippet.id, { isFavorite: !snippet.isFavorite }) },
    { id: 'deprecate', label: snippet.isDeprecated ? t('scriptshub.menu.undeprecate') : t('scriptshub.menu.deprecate'), icon: <Upload size={13} aria-hidden="true" />, checked: snippet.isDeprecated, onSelect: () => void patchSnippet(snippet.id, { isDeprecated: !snippet.isDeprecated }) },
    { id: 'copy-path', label: t('scriptshub.menu.copy_path'), icon: <Copy size={13} aria-hidden="true" />, separatorBefore: true, disabled: !publications.length, reason: publications.length ? undefined : t('scriptshub.menu.reason_no_publication'), onSelect: () => {
      if (publications[0]) void copyPath(publications[0])
    } },
    { id: 'copy-curl', label: t('scriptshub.menu.copy_curl'), icon: <FileCode2 size={13} aria-hidden="true" />, disabled: !publications.length, reason: publications.length ? undefined : t('scriptshub.menu.reason_no_publication'), onSelect: () => {
      if (publications[0]) void copyCurl(publications[0])
    } },
    { id: 'pause', label: t('scriptshub.menu.pause'), icon: <Radio size={13} aria-hidden="true" />, disabled: !publications.length, reason: publications.length ? undefined : t('scriptshub.menu.reason_no_publication'), onSelect: () => {
      const paused = publications.find((entry) => entry.isEnabled)
      if (paused) void togglePublish(paused, false)
    } },
    { id: 'resume', label: t('scriptshub.menu.resume'), icon: <Radio size={13} aria-hidden="true" />, disabled: !publications.some((entry) => !entry.isEnabled), reason: publications.some((entry) => !entry.isEnabled) ? undefined : t('scriptshub.menu.reason_none_paused'), onSelect: () => {
      const paused = publications.find((entry) => !entry.isEnabled)
      if (paused) void togglePublish(paused, true)
    } },
    { id: 'publish', label: t('scriptshub.menu.publish'), icon: <Upload size={13} aria-hidden="true" />, onSelect: () => onOpenPanel?.(snippet.id, 'publish') },
    { id: 'unpublish', label: t('scriptshub.menu.unpublish'), icon: <Trash2 size={13} aria-hidden="true" />, disabled: !publications.length, reason: publications.length ? undefined : t('scriptshub.menu.reason_no_publication'), onSelect: () => {
      const first = publications[0]
      if (!first) return
      void confirm({
        title: t('scriptshub.publish.unpublish_title'),
        description: t('scriptshub.publish.unpublish_body'),
        confirmLabel: t('scriptshub.publish.unpublish'),
        tone: 'danger',
      }).then((agreed) => {
        if (agreed) void useScriptsHub.getState().deletePublication(first.id)
      })
    } },
    { id: 'history', label: t('scriptshub.menu.revisions'), icon: <Wand2 size={13} aria-hidden="true" />, onSelect: () => onOpenPanel?.(snippet.id, 'history') },
    { id: 'export', label: t('scriptshub.menu.export'), icon: <Download size={13} aria-hidden="true" />, separatorBefore: true, submenu: ({ closeMenu }) => (
      <MenuSubmenuList
        label={t('scriptshub.menu.export')}
        items={[
          { id: 'export-generic', label: t('scriptshub.export.generic'), onSelect: () => { closeMenu(); void exportOne('generic') } },
          { id: 'export-masscode', label: t('scriptshub.export.masscode'), onSelect: () => { closeMenu(); void exportOne('masscode') } },
          { id: 'export-vscode', label: t('scriptshub.export.vscode'), onSelect: () => { closeMenu(); void exportOne('vscode') } },
          { id: 'export-file', label: t('scriptshub.menu.copy_code'), separatorBefore: true, onSelect: () => { closeMenu(); void exportOne('file') } },
          { id: 'export-image', label: t('scriptshub.export.code_image'), icon: <ImageIcon size={13} aria-hidden="true" />, separatorBefore: true, onSelect: () => { closeMenu(); void exportImage() } },
        ]}
      />
    ) },
    { id: 'properties', label: t('scriptshub.menu.properties'), icon: <Info size={13} aria-hidden="true" />, onSelect: () => void openProperties() },
    { id: 'delete', label: t('scriptshub.common.delete'), icon: <Trash2 size={13} aria-hidden="true" />, tone: 'danger', separatorBefore: true, onSelect: () => void removeSnippet() },
  ]

  async function removeSnippet() {
    const agreed = await confirm({
      title: t('scriptshub.confirm.delete_snippet_title', { title: snippet.title }),
      description: t('scriptshub.confirm.delete_snippet_body'),
      confirmLabel: t('scriptshub.common.delete'),
      tone: 'danger',
    })
    if (!agreed) return
    await useScriptsHub.getState().remove(snippet.id)
  }

  const onContext = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!on) onToggle(snippet.id)
    menu.close()
    menu.onContextMenu(event)
  }

  const clearLongPress = () => {
    if (longPress.current.timer) window.clearTimeout(longPress.current.timer)
    longPress.current.timer = 0
  }
  const openRow = () => {
    if (longPress.current.fired) {
      longPress.current.fired = false
      return
    }
    onOpen(snippet)
  }
  const beginLongPress = (event: React.TouchEvent) => {
    const touch = event.touches[0]
    if (!touch) return
    longPress.current.fired = false
    clearLongPress()
    longPress.current.timer = window.setTimeout(() => {
      longPress.current.fired = true
      menu.close()
      menu.onContextMenu({
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
        clientX: touch.clientX,
        clientY: touch.clientY,
      } as React.MouseEvent)
    }, 480)
  }

  const meta = (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
      <span>{t('scriptshub.list.files_size', { files: snippet.fileCount, size: formatBytes(snippet.charCount) })}</span>
      <span aria-hidden="true">·</span>
      <Tooltip label={fullTime(snippet.updatedAt)} side="bottom">
        <span>{t('scriptshub.list.edited', { time: relativeTime(snippet.updatedAt) })}</span>
      </Tooltip>
      <span aria-hidden="true">·</span>
      <Tooltip label={fullTime(snippet.createdAt)} side="bottom">
        <span>{t('scriptshub.list.created', { time: relativeTime(snippet.createdAt) })}</span>
      </Tooltip>
      {snippet.isDeprecated && <Badge tone="warning">{t('scriptshub.list.deprecated')}</Badge>}
    </span>
  )

  const title = renaming ? (
    <Input
      ref={renameRef}
      aria-label={t('scriptshub.menu.rename_snippet')}
      value={renameValue}
      onChange={(event) => setRenameValue(event.target.value)}
      onBlur={() => void commitRename()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault()
          void commitRename()
        }
        if (event.key === 'Escape') {
          setRenameValue(snippet.title)
          setRenaming(false)
        }
      }}
      className="min-w-0 flex-1 font-medium"
    />
  ) : (
    <span
      className={cn(
        'min-w-0 truncate font-medium text-[var(--text-primary)]',
        layout === 'grid' ? 'text-[length:var(--text-12)]' : 'text-[length:var(--text-13)] leading-snug',
      )}
    >
      {snippet.title}
    </span>
  )

  const overlays = (
    <>
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={actions} />}
      <FolderPicker
        open={moveOpen}
        title={t('scriptshub.editor.move_folder')}
        folders={folderChoices}
        currentId={snippet.folderId}
        allowRoot
        rootLabel={t('scriptshub.sidebar.unfiled')}
        onSelect={(folderId) => {
          setMoveOpen(false)
          void patchSnippet(snippet.id, { folderId })
        }}
        onClose={() => setMoveOpen(false)}
      />
      <TagPickerDialog
        open={tagOpen}
        tags={tags}
        selected={tagList.map((tag) => tag.id)}
        title={t('scriptshub.editor.tags_title')}
        onClose={() => setTagOpen(false)}
        onConfirm={(ids) => {
          setTagOpen(false)
          void patchSnippet(snippet.id, { tags: ids }).then(onListChanged)
        }}
      />
      <Modal
        open={propertiesOpen}
        onClose={() => setPropertiesOpen(false)}
        title={t('scriptshub.properties.title')}
        width={420}
        footer={<Button variant="ghost" onClick={() => setPropertiesOpen(false)}>{t('scriptshub.common.close')}</Button>}
      >
        {properties && (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-[length:var(--text-12)]">
            <dt className="text-[var(--text-tertiary)]">{t('scriptshub.properties.files')}</dt>
            <dd className="tabular text-[var(--text-secondary)]">{snippet.fileCount}</dd>
            <dt className="text-[var(--text-tertiary)]">{t('scriptshub.properties.lines')}</dt>
            <dd className="tabular text-[var(--text-secondary)]">{properties.lines}</dd>
            <dt className="text-[var(--text-tertiary)]">{t('scriptshub.properties.chars')}</dt>
            <dd className="tabular text-[var(--text-secondary)]">{properties.chars}</dd>
            <dt className="text-[var(--text-tertiary)]">{t('scriptshub.properties.created')}</dt>
            <dd className="text-[var(--text-secondary)]">{fullTime(properties.created)}</dd>
            <dt className="text-[var(--text-tertiary)]">{t('scriptshub.properties.updated')}</dt>
            <dd className="text-[var(--text-secondary)]">{fullTime(properties.updated)}</dd>
            <dt className="text-[var(--text-tertiary)]">{t('scriptshub.properties.publications')}</dt>
            <dd className="text-[var(--text-secondary)]">{t('scriptshub.publish.published_count', { published: publishedCount, total: snippet.fileCount })}</dd>
          </dl>
        )}
      </Modal>
    </>
  )

  if (layout === 'grid') {
    return (
      <>
        <div
          role="listitem"
          tabIndex={0}
          data-scriptshub-snippet-drag
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(SNIPPET_DRAG, snippet.id)
            event.dataTransfer.effectAllowed = 'move'
          }}
          onClick={openRow}
          onContextMenu={onContext}
          onTouchStart={beginLongPress}
          onTouchEnd={clearLongPress}
          onTouchMove={clearLongPress}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openRow()
            }
            if (event.key === 'F2') {
              event.preventDefault()
              startRename()
            }
          }}
          className={cn(
            'group flex min-h-[104px] cursor-default flex-col gap-1.5 rounded-[var(--r-lg)] border p-2.5 transition-colors duration-[var(--dur-fast)]',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
            on ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)]/45' : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)]',
          )}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <LanguageIcon id={snippet.language} size={14} className="shrink-0" />
            {title}
            {publishedCount > 0 && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[length:var(--text-10)] text-[var(--success)]">
                <Upload size={9} aria-hidden="true" />
                {publishedCount}/{snippet.fileCount}
              </span>
            )}
            {snippet.isPinned && <Pin size={10} aria-hidden="true" className="shrink-0 text-[var(--accent)]" />}
            {snippet.isFavorite && <Star size={10} aria-hidden="true" className="shrink-0 text-[var(--warning)]" />}
          </div>
          <p className="truncate-2 min-h-[2.6em] text-[length:var(--text-11)] leading-[1.45] text-[var(--text-tertiary)]">
            {snippet.preview || snippet.description || '—'}
          </p>
          <div className="mt-auto truncate text-[length:var(--text-10)] text-[var(--text-quaternary)]">
            {t('scriptshub.list.files_size', { files: snippet.fileCount, size: formatBytes(snippet.charCount) })} · {relativeTime(snippet.updatedAt)}
          </div>
        </div>
        {overlays}
      </>
    )
  }

  return (
    <>
      <div
        role="listitem"
        tabIndex={0}
        data-scriptshub-row
        data-scriptshub-snippet-drag
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(SNIPPET_DRAG, snippet.id)
          event.dataTransfer.effectAllowed = 'move'
        }}
        onClick={openRow}
        onContextMenu={onContext}
        onTouchStart={beginLongPress}
        onTouchEnd={clearLongPress}
        onTouchMove={clearLongPress}
        onKeyDown={(event) => {
          if (isImeComposing(event)) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openRow()
          }
          if (event.key === 'F2') {
            event.preventDefault()
            startRename()
          }
        }}
        className={cn(
          'group relative flex cursor-default items-start gap-2 border-b border-[var(--border-subtle)] px-3 transition-colors duration-[var(--dur-fast)]',
          density === 'compact' ? 'py-1.5' : 'py-2.5',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
          on ? 'bg-[var(--accent-soft)]/35' : 'hover:bg-[var(--bg-hover)]',
        )}
      >
        <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <Checkbox
            checked={on}
            ariaLabel={t('scriptshub.list.select_one', { title: snippet.title })}
            onChange={() => onToggle(snippet.id)}
            className="mt-0.5"
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <LanguageIcon id={snippet.language} size={15} className="shrink-0" />
            <span className="min-w-0 flex-1" onDoubleClick={startRename}>{title}</span>
            {publishedCount > 0 && (
              <Tooltip label={publications.map((entry) => entry.path).join(' · ')} side="bottom">
                <span className="inline-flex shrink-0 items-center gap-0.5 rounded-[var(--r-full)] border border-[var(--success)]/40 bg-[color-mix(in_oklab,var(--success)_12%,transparent)] px-1.5 text-[length:var(--text-10)] text-[var(--success)]">
                  <Upload size={9} aria-hidden="true" />
                  {publishedCount}/{snippet.fileCount}
                </span>
              </Tooltip>
            )}
            {snippet.isPinned && <Pin size={10} aria-hidden="true" className="shrink-0 text-[var(--accent)]" />}
            {snippet.isFavorite && <Star size={10} aria-hidden="true" className="shrink-0 text-[var(--warning)]" />}
            {!renaming && <span className="shrink-0 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">{relativeTime(snippet.updatedAt)}</span>}
          </div>
          {density === 'comfortable' && (
            <p className="truncate-2 mt-1 text-[length:var(--text-11-5)] leading-[1.5] text-[var(--text-tertiary)]">
              {snippet.preview || snippet.description || folderLabel || '—'}
            </p>
          )}
          {tagList.length > 0 && density === 'comfortable' && (
            <TagPills
              tags={tagList}
              max={3}
              onFilter={(tagId) => void useScriptsHub.getState().loadList({ tagId, folderId: null, quick: 'all', offset: 0 })}
            />
          )}
          {density === 'comfortable' ? meta : (
            <div className="mt-0.5 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {t('scriptshub.list.files_size', { files: snippet.fileCount, size: formatBytes(snippet.charCount) })}
              {publishedCount > 0 ? ` · ${publishedCount}/${snippet.fileCount} ${t('scriptshub.list.published')}` : ''}
            </div>
          )}
        </div>
      </div>

      {overlays}
    </>
  )
}
