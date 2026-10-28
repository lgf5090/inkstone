/** The project → notebook → note library. One panel, shared by the desktop column and mobile drawer. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckSquare, ChevronRight, FilePlus2, FolderInput, FolderPlus, MoreHorizontal, NotebookPen, Pin, Search, Trash2, X } from 'lucide-react'
import type { InknoteNoteMeta, InknoteSearchResult } from '@shared/inknote/types'
import { TAG_COLORS } from '@shared/inknote/constants'
import { paperSurfaceFor } from '@shared/inknote/color'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Select } from '../../../components/form'
import { useFilterInput } from '../../../components/FilterInput'
import { confirm, Menu, MenuSubmenuList, Modal, prompt, type MenuItem } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { inknoteApi } from '../api'
import { useInknoteStore } from '../store'

interface Props {
  selectedNotebookId: string | null
  onSelectNotebook: (id: string) => void
  onAfterOpen?: () => void
}

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

const coverCache = new Map<string, string>()

function NoteCover({ note }: { note: InknoteNoteMeta }) {
  const surface = paperSurfaceFor(note.paper.color)
  const [src, setSrc] = useState<string | null>(note.coverUrl ?? coverCache.get(note.id) ?? null)
  useEffect(() => {
    if (src) return
    let cancelled = false
    void inknoteApi.note(note.id, 'all').then((detail) => {
      if (cancelled || !detail.pages[0]) return
      return import('../engine/renderer').then(({ renderPageToCanvas }) => import('../../../lib/inknote/text-layout').then(({ fontStackFor }) => {
        const canvas = renderPageToCanvas(detail.pages[0]!.content, note.paper, { width: note.pageWidth, height: note.pageHeight, contentWidth: note.contentWidth, contentHeight: note.contentHeight }, 90, fontStackFor('system'))
        const data = canvas?.toDataURL('image/jpeg', 0.72) ?? null
        if (data && !cancelled) { coverCache.set(note.id, data); setSrc(data) }
      }))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [note.id, note.paper, note.pageWidth, note.pageHeight, note.contentWidth, note.contentHeight, src])
  return (
    <span className="relative flex h-12 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[3px] border border-[var(--border-subtle)] text-[length:var(--text-12)] font-semibold" style={{ background: surface.bg, color: surface.dark ? '#f8fafc' : '#475569' }}>
      {src ? <img src={src} alt="" className="size-full object-cover" loading="lazy" /> : note.title.slice(0, 1)}
    </span>
  )
}

export function LibraryPanel({ selectedNotebookId, onSelectNotebook, onAfterOpen }: Props) {
  const library = useInknoteStore((state) => state.library)
  const openNote = useInknoteStore((state) => state.openNote)
  const createNote = useInknoteStore((state) => state.createNote)
  const createSubject = useInknoteStore((state) => state.createSubject)
  const createNotebook = useInknoteStore((state) => state.createNotebook)
  const updateSubject = useInknoteStore((state) => state.updateSubject)
  const deleteSubject = useInknoteStore((state) => state.deleteSubject)
  const updateNotebook = useInknoteStore((state) => state.updateNotebook)
  const deleteNotebook = useInknoteStore((state) => state.deleteNotebook)
  const deleteNote = useInknoteStore((state) => state.deleteNote)
  const duplicateNote = useInknoteStore((state) => state.duplicateNote)
  const updateNoteMeta = useInknoteStore((state) => state.updateNoteMeta)
  const patchNotesMeta = useInknoteStore((state) => state.patchNotesMeta)
  const restoreNote = useInknoteStore((state) => state.restoreNote)
  const purgeNote = useInknoteStore((state) => state.purgeNote)
  const activeNoteId = useInknoteStore((state) => state.note?.id ?? null)
  const toast = useUi((state) => state.toast)
  const [recent, setRecent] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<InknoteSearchResult[] | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const settings = useInknoteStore((state) => state.library?.settings)
  const updateSettings = useInknoteStore((state) => state.updateSettings)
  const [trashOpen, setTrashOpen] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveTarget, setMoveTarget] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const searchTimer = useRef<number | undefined>(undefined)

  const subjects = library?.subjects ?? []
  const notebooks = library?.notebooks ?? []
  const notes = library?.notes ?? []
  const notebook = notebooks.find((entry) => entry.id === selectedNotebookId) ?? notebooks[0] ?? null
  const subject = subjects.find((entry) => entry.id === notebook?.subjectId) ?? subjects[0] ?? null

  useEffect(() => {
    if (!selectedNotebookId && notebooks[0]) onSelectNotebook(notebooks[0].id)
  }, [notebooks, onSelectNotebook, selectedNotebookId])

  useEffect(() => () => { if (searchTimer.current) window.clearTimeout(searchTimer.current) }, [])

  const visibleNotes = useMemo(() => {
    const sort = settings?.noteSort ?? 'updated'
    const base = recent ? [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 15) : notes.filter((note) => note.notebookId === notebook?.id)
    const filtered = tagFilter ? base.filter((note) => note.colorTag === tagFilter) : base
    return [...filtered].sort((a, b) => {
      if (Number(a.pinned) !== Number(b.pinned)) return Number(b.pinned) - Number(a.pinned)
      if (sort === 'created') return b.createdAt - a.createdAt
      if (sort === 'title') return a.title.localeCompare(b.title)
      return b.updatedAt - a.updatedAt
    })
  }, [notes, notebook?.id, recent, settings?.noteSort, tagFilter])

  const runSearch = (value: string) => {
    setQuery(value)
    if (searchTimer.current) window.clearTimeout(searchTimer.current)
    if (!value.trim()) { setResults(null); return }
    searchTimer.current = window.setTimeout(() => {
      inknoteApi.search(value, { notebookId: undefined, limit: 50 })
        .then((response) => setResults(response.results))
        .catch(() => setResults([]))
    }, 180)
  }

  const { field, clear } = useFilterInput({ value: query, onClear: () => runSearch('') })

  const noteMenuItems = (note: InknoteNoteMeta): MenuItem[] => [
    { id: 'open', label: t('inknote.open'), onSelect: () => void openFromList(note) },
    { id: 'rename', label: t('inknote.rename'), onSelect: () => void renameNote(note) },
    { id: 'pin', label: note.pinned ? t('inknote.unpin') : t('inknote.pin'), onSelect: () => void updateNoteMeta({ title: note.title, pinned: !note.pinned }) },
    { id: 'duplicate', label: t('inknote.duplicate'), onSelect: () => void duplicateNote(note.id) },
    { id: 'tag', label: t('inknote.tag_color'), submenu: () => <MenuSubmenuList label={t('inknote.tag_color')} items={TAG_COLORS.map((color) => ({ id: color, label: color, onSelect: () => void updateNoteMeta({ colorTag: color }) }))} /> },
    { id: 'delete', label: t('inknote.delete'), tone: 'danger', separatorBefore: true, onSelect: () => void removeNote(note) },
  ]

  async function openFromList(note: InknoteNoteMeta) {
    await openNote(note.id)
    onAfterOpen?.()
  }

  async function renameNote(note: InknoteNoteMeta) {
    const name = await prompt({ title: t('inknote.rename'), defaultValue: note.title, placeholder: t('inknote.untitled') })
    if (!name?.trim()) return
    await updateNoteMeta({ title: name.trim() })
  }

  async function removeNote(note: InknoteNoteMeta) {
    if (!await confirm({ title: t('inknote.delete'), description: t('inknote.confirm_delete_note'), confirmLabel: t('inknote.delete') })) return
    await deleteNote(note.id).catch((error) => toast({ title: String(error), tone: 'danger' }))
  }

  async function newSubject() {
    const name = await prompt({ title: t('inknote.new_project'), placeholder: t('inknote.new_project') })
    if (name?.trim()) await createSubject(name.trim()).catch((error) => toast({ title: String(error), tone: 'danger' }))
  }

  async function newNotebook() {
    if (!subject) return newSubject()
    const name = await prompt({ title: t('inknote.new_notebook'), placeholder: t('inknote.new_notebook') })
    if (name?.trim()) await createNotebook(subject.id, name.trim()).catch((error) => toast({ title: String(error), tone: 'danger' }))
  }

  function openMenu(x: number, y: number, items: MenuItem[]) {
    setMenu({ x, y, items })
  }

  async function notebookMenu(target: { id: string; name: string }, x: number, y: number) {
    openMenu(x, y, [
      { id: 'rename', label: t('inknote.rename'), onSelect: () => { setMenu(null); void (async () => {
        const name = await prompt({ title: t('inknote.rename'), defaultValue: target.name })
        if (name?.trim()) await updateNotebook(target.id, { name: name.trim() })
      })() } },
      { id: 'delete', label: t('inknote.delete'), tone: 'danger', onSelect: () => { setMenu(null); void (async () => {
        if (!await confirm({ title: t('inknote.delete'), description: t('inknote.confirm_delete_notebook'), confirmLabel: t('inknote.delete') })) return
        await deleteNotebook(target.id)
        if (selectedNotebookId === target.id) {
          const next = notebooks.find((entry) => entry.id !== target.id)
          if (next) onSelectNotebook(next.id)
        }
      })() } },
    ])
  }


  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <div className="flex items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-2">
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] font-semibold">{t('inknote.library')}</span>
        <IconButton label={t('inknote.recent')} size="sm" active={recent} onClick={() => setRecent((value) => !value)}><NotebookPen size={14}/></IconButton>
        <IconButton label={t('inknote.trash')} size="sm" onClick={() => setTrashOpen(true)}><Trash2 size={14}/></IconButton>
      </div>
      <div className="px-2 py-2">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" />
          <input {...field} value={query} onChange={(event) => runSearch(event.target.value)} placeholder={t('inknote.search_placeholder')} aria-label={t('inknote.search_placeholder')} className="h-8 w-full rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-inset)] pl-7 pr-7 text-[length:var(--text-12)] outline-none focus:border-[var(--accent)]" />
          {query && <IconButton label={t('notes.clear_filters')} size="xs" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={clear}><X size={11}/></IconButton>}
        </div>
      </div>
      <div className="flex items-center gap-1 px-2 pb-2">
        <Select aria-label={t('inknote.sort.label')} value={settings?.noteSort ?? 'updated'} onChange={(event) => void updateSettings({ noteSort: event.target.value as 'updated' | 'created' | 'title' })} className="h-7 flex-1 text-[length:var(--text-11)]">
          <option value="updated">{t('inknote.sort.updated')}</option>
          <option value="created">{t('inknote.sort.created')}</option>
          <option value="title">{t('inknote.sort.title')}</option>
        </Select>
        <div className="flex items-center gap-1" role="group" aria-label={t('inknote.tag_color')}>
          <button type="button" aria-label={t('inknote.filter_all')} aria-pressed={tagFilter === null} onClick={() => setTagFilter(null)} className={cn('size-4 rounded-full border border-[var(--border-default)] text-[length:var(--text-9)]', tagFilter === null && 'ring-2 ring-[var(--accent)]')}>×</button>
          {TAG_COLORS.map((color) => (
            <button key={color} type="button" aria-label={color} aria-pressed={tagFilter === color} onClick={() => setTagFilter(tagFilter === color ? null : color)} className={cn('size-4 rounded-full', tagFilter === color && 'ring-2 ring-[var(--accent)]')} style={{ background: color }}/>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {results !== null ? (
          <div className="space-y-0.5">
            <p className="px-1 py-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('inknote.search_results')}</p>
            {results.length === 0 && <p className="px-2 py-3 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.no_results')}</p>}
            {results.map((result) => (
              <button key={result.noteId} type="button" onClick={() => void openNote(result.noteId, result.pageIndex).then(() => onAfterOpen?.())} className="block w-full rounded-[var(--r-sm)] px-2 py-1.5 text-left hover:bg-[var(--bg-hover)]">
                <span className="block truncate text-[length:var(--text-12)] font-medium">{result.title}</span>
                <span className="block truncate text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{result.subjectName} / {result.notebookName} · {result.pageIndex + 1}</span>
                {result.snippet && <span className="mt-0.5 block truncate text-[length:var(--text-11)] text-[var(--text-secondary)]">{result.snippet}</span>}
              </button>
            ))}
          </div>
        ) : (
          <>
            {subjects.length === 0 && <p className="px-2 py-3 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.no_projects')}</p>}
            {subjects.map((entry) => {
              const isOpen = !collapsed.has(entry.id)
              const children = notebooks.filter((item) => item.subjectId === entry.id)
              return (
                <div key={entry.id} className="mb-1">
                  <div className="group flex items-center gap-0.5 rounded-[var(--r-sm)] hover:bg-[var(--bg-hover)]">
                    <button type="button" aria-label={entry.name} className="flex min-w-0 flex-1 items-center gap-1 px-1 py-1 text-left text-[length:var(--text-12)] font-semibold" onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next })}>
                      <ChevronRight size={11} className={cn('shrink-0 transition-transform', isOpen && 'rotate-90')} />
                      <span className="truncate">{entry.name}</span>
                      <span className="ml-auto text-[length:var(--text-10)] text-[var(--text-quaternary)]">{children.reduce((sum, child) => sum + notes.filter((note) => note.notebookId === child.id).length, 0)}</span>
                    </button>
                    <IconButton label={t('inknote.rename')} size="xs" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); void subjectMenu(entry.id, entry.name, rect.right, rect.bottom) }}><MoreHorizontal size={12}/></IconButton>
                  </div>
                  {isOpen && children.map((item) => (
                    <div key={item.id} className={cn('group flex items-center gap-0.5 rounded-[var(--r-sm)] pl-4', item.id === notebook?.id ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'hover:bg-[var(--bg-hover)]')}>
                      <button type="button" onClick={() => { setRecent(false); onSelectNotebook(item.id) }} className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left text-[length:var(--text-12)]">
                        <span className="size-2 shrink-0 rounded-full" style={{ background: item.coverColor || 'var(--accent)' }} />
                        <span className="truncate">{item.emoji ? `${item.emoji} ` : ''}{item.name}</span>
                      </button>
                      <IconButton label={t('inknote.rename')} size="xs" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); void notebookMenu({ id: item.id, name: item.name }, rect.right, rect.bottom) }}><MoreHorizontal size={12}/></IconButton>
                    </div>
                  ))}
                  {isOpen && children.length === 0 && <p className="pl-6 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('inknote.no_notebooks')}</p>}
                </div>
              )
            })}
            <div className="mt-2 flex flex-wrap gap-1 px-1">
              <Button size="sm" variant="ghost" icon={<FolderPlus size={13}/>} onClick={() => void newSubject()}>{t('inknote.new_project')}</Button>
              <Button size="sm" variant="ghost" icon={<FilePlus2 size={13}/>} onClick={() => void newNotebook()}>{t('inknote.new_notebook')}</Button>
            </div>
            <div className="mt-2 flex items-center justify-between px-1">
              <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{recent ? t('inknote.recent') : notebook?.name}</span>
              <div className="flex items-center gap-1">
                <IconButton label={t('inknote.select')} size="sm" active={selectMode} onClick={() => { setSelectMode((value) => !value); setSelected(new Set()) }}><CheckSquare size={13}/></IconButton>
                <Button size="sm" variant="primary" icon={<FilePlus2 size={13}/>} onClick={() => void createNote(notebook?.id).then(() => onAfterOpen?.())}>{t('inknote.new_note')}</Button>
              </div>
            </div>
            {selectMode && (
              <div className="mt-1 flex flex-wrap items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-1 py-1">
                <button type="button" className="text-[length:var(--text-11)] underline" onClick={() => setSelected(new Set(visibleNotes.map((entry) => entry.id)))}>{t('inknote.select_all')}</button>
                <button type="button" className="text-[length:var(--text-11)] underline" onClick={() => setSelected(new Set())}>{t('inknote.clear_selection')}</button>
                <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('inknote.selected_count', { count: String(selected.size) })}</span>
                <span className="flex-1"/>
                <IconButton label={t('inknote.batch_move')} size="xs" disabled={selected.size === 0} onClick={() => { setMoveTarget(''); setMoveOpen(true) }}><FolderInput size={12}/></IconButton>
                <IconButton label={t('inknote.batch_pin')} size="xs" disabled={selected.size === 0} onClick={() => void batchPatch({ pinned: true })}><Pin size={12}/></IconButton>
                <IconButton label={t('inknote.tag_color')} size="xs" disabled={selected.size === 0} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openMenu(rect.left, rect.bottom, TAG_COLORS.map((color) => ({ id: color, label: color, onSelect: () => { setMenu(null); void batchPatch({ colorTag: color }) } }))) }}><span className="size-3 rounded-full" style={{ background: TAG_COLORS[0] }}/></IconButton>
                <IconButton label={t('inknote.batch_delete')} size="xs" disabled={selected.size === 0} onClick={() => void batchDelete()}><Trash2 size={12}/></IconButton>
                <IconButton label={t('inknote.clear_selection')} size="xs" onClick={() => { setSelectMode(false); setSelected(new Set()) }}><X size={12}/></IconButton>
              </div>
            )}
            <div className="mt-1 space-y-0.5">
              {visibleNotes.length === 0 && <p className="px-2 py-4 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.no_notes')}</p>}
              {visibleNotes.map((note) => (
                <button key={note.id} type="button" data-inknote-note-id={note.id} aria-pressed={selectMode ? selected.has(note.id) : undefined} onClick={() => {
                  if (selectMode) { setSelected((current) => { const next = new Set(current); if (next.has(note.id)) next.delete(note.id); else next.add(note.id); return next }); return }
                  void openFromList(note)
                }} onContextMenu={(event) => { event.preventDefault(); if (!selectMode) openMenu(event.clientX, event.clientY, noteMenuItems(note)) }} className={cn('flex w-full items-center gap-2 rounded-[var(--r-sm)] px-1.5 py-1.5 text-left', note.id === activeNoteId ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]', selectMode && selected.has(note.id) && 'ring-1 ring-[var(--accent)]')}>
                  {selectMode && <span aria-hidden="true" className={cn('flex size-4 shrink-0 items-center justify-center rounded-[3px] border border-[var(--border-strong)]', selected.has(note.id) && 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]')}>{selected.has(note.id) ? '✓' : ''}</span>}
                  <NoteCover note={note} />
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-[length:var(--text-12)]', note.pinned && 'font-semibold')}>{note.title || t('inknote.untitled')}</span>
                    <span className="block truncate text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{t('inknote.pages_count', { count: note.pageCount })}</span>
                  </span>
                  {note.colorTag && <span className="size-2 shrink-0 rounded-full" style={{ background: note.colorTag }} />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {menu && (
        <Menu anchor={{ x: menu.x, y: menu.y }} open onClose={() => setMenu(null)} items={menu.items} />
      )}
      <TrashDialog open={trashOpen} onClose={() => setTrashOpen(false)} onRestore={restoreNote} onPurge={purgeNote} />
      <Modal open={moveOpen} onClose={() => setMoveOpen(false)} title={t('inknote.batch_move')} width={380}>
        <div className="space-y-2">
          <Select aria-label={t('inknote.move_target')} value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)} className="w-full">
            <option value="">{t('inknote.move_target')}</option>
            {subjects.map((entry) => (
              <optgroup key={entry.id} label={entry.name}>
                {notebooks.filter((item) => item.subjectId === entry.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </optgroup>
            ))}
          </Select>
          <div className="flex justify-end">
            <Button size="sm" variant="primary" disabled={!moveTarget || selected.size === 0} onClick={() => { setMoveOpen(false); void batchPatch({ notebookId: moveTarget }) }}>{t('inknote.batch_move')}</Button>
          </div>
        </div>
      </Modal>
    </aside>
  )

  async function batchPatch(patch: Partial<Pick<InknoteNoteMeta, 'notebookId' | 'colorTag' | 'pinned'>>) {
    const ids = [...selected]
    if (ids.length === 0) return
    const result = await patchNotesMeta(ids, patch)
    setSelectMode(false)
    setSelected(new Set())
    toast({ title: result.failed > 0 ? t('inknote.batch_partial', { changed: String(result.changed), failed: String(result.failed) }) : t('inknote.batch_done', { count: String(result.changed) }), ...(result.failed > 0 ? { tone: 'danger' as const } : {}) })
  }

  async function batchDelete() {
    const ok = await confirm({ title: t('inknote.batch_delete'), description: t('inknote.batch_delete_confirm'), confirmLabel: t('inknote.delete') })
    if (!ok) return
    let failed = 0
    for (const id of [...selected]) {
      try { await deleteNote(id) } catch { failed += 1 }
    }
    setSelectMode(false)
    setSelected(new Set())
    toast({ title: failed > 0 ? t('inknote.batch_partial', { changed: String(selected.size - failed), failed: String(failed) }) : t('inknote.batch_done', { count: String(selected.size) }), ...(failed > 0 ? { tone: 'danger' as const } : {}) })
  }

  function subjectMenu(id: string, name: string, x: number, y: number) {
    openMenu(x, y, [
      { id: 'rename', label: t('inknote.rename'), onSelect: () => { setMenu(null); void (async () => {
        const next = await prompt({ title: t('inknote.rename'), defaultValue: name })
        if (next?.trim()) await updateSubject(id, { name: next.trim() })
      })() } },
      { id: 'delete', label: t('inknote.delete'), tone: 'danger', onSelect: () => { setMenu(null); void (async () => {
        if (await confirm({ title: t('inknote.delete'), description: t('inknote.confirm_delete_notebook'), confirmLabel: t('inknote.delete') })) await deleteSubject(id)
      })() } },
    ])
  }
}

function TrashDialog({ open, onClose, onRestore, onPurge }: { open: boolean; onClose: () => void; onRestore: (id: string) => Promise<void>; onPurge: (id: string) => Promise<void> }) {
  const [notes, setNotes] = useState<InknoteNoteMeta[]>([])
  useEffect(() => {
    if (!open) return
    inknoteApi.trash().then((response) => setNotes(response.notes)).catch(() => setNotes([]))
  }, [open])
  return (
    <Modal open={open} onClose={onClose} title={t('inknote.trash')} width={520}>
      <div className="space-y-1">
        {notes.length === 0 && <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.no_notes')}</p>}
        {notes.map((note) => (
          <div key={note.id} className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)]">{note.title}</span>
            <Button size="sm" variant="ghost" onClick={() => void onRestore(note.id).then(() => setNotes((list) => list.filter((entry) => entry.id !== note.id)))}>{t('inknote.restore')}</Button>
            <Button size="sm" variant="ghost" onClick={() => void confirm({ title: t('inknote.purge'), description: t('inknote.confirm_purge'), confirmLabel: t('inknote.purge') }).then((ok) => ok ? onPurge(note.id).then(() => setNotes((list) => list.filter((entry) => entry.id !== note.id))) : undefined)}>{t('inknote.purge')}</Button>
          </div>
        ))}
      </div>
    </Modal>
  )
}
