import { useEffect, useRef, useState } from 'react'
import { Calendar, Check, Copy, Download, Edit3, ExternalLink, FileCode, FileText, Globe, Lock, Plus, Save, Trash2, X } from 'lucide-react'
import type { GistFile, GistItem } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { copyText } from '../../../../lib/clipboard'
import { Button, IconButton } from '../../../../components/primitives'
import { Input, Textarea } from '../../../../components/form'
import { Empty } from '../../../../components/feedback'
import { Menu, type MenuItem } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { githubApi } from '../api'
import { formatDate, formatNumber, inferLanguage } from '../lib/format'

export function GistDetail({
  gist,
  notes,
  readOnly,
  saving,
  exportsEnabled,
  exportable = true,
  onUpdateNotes,
  onUpdateGist,
  onDeleteGist,
}: {
  gist: GistItem | null
  notes: string
  readOnly: boolean
  saving: boolean
  exportsEnabled: boolean
  exportable?: boolean
  onUpdateNotes?: (notes: string) => void
  onUpdateGist?: (gist: GistItem) => void | Promise<void>
  onDeleteGist?: (id: string) => void
}) {
  const toast = useUi((state) => state.toast)
  const [editing, setEditing] = useState(false)
  const [editFiles, setEditFiles] = useState<GistFile[]>([])
  const [editDescription, setEditDescription] = useState('')
  const [selectedFile, setSelectedFile] = useState(0)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesDraft, setNotesDraft] = useState(notes)
  const [copied, setCopied] = useState(false)
  const exportAnchor = useRef<HTMLButtonElement>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    setEditing(false)
    setSelectedFile(0)
    setEditingNotes(false)
  }, [gist?.id])
  useEffect(() => setNotesDraft(notes), [notes])
  useEffect(() => {
    if (!gist) return
    if (selectedFile >= gist.files.length) setSelectedFile(Math.max(0, gist.files.length - 1))
  }, [gist, selectedFile])

  if (!gist) return <Empty art="select" title={t('development.github.gists.select_hint')} />

  const files = editing ? editFiles : gist.files
  const current = files[selectedFile]
  const startEdit = () => {
    setEditFiles(gist.files.map((file) => ({ ...file })))
    setEditDescription(gist.description)
    setEditing(true)
  }
  const updateFile = (index: number, patch: Partial<GistFile>) => {
    setEditFiles((previous) => previous.map((file, fileIndex) => {
      if (fileIndex !== index) return file
      const next = { ...file, ...patch }
      if (patch.filename !== undefined) next.language = inferLanguage(patch.filename)
      if (patch.content !== undefined) next.size = patch.content.length
      return next
    }))
  }
  const addFile = () => {
    setEditFiles((previous) => [...previous, { filename: `file${previous.length + 1}.txt`, language: 'Text', content: '', size: 0 }])
    setSelectedFile(editFiles.length)
  }
  const removeFile = (index: number) => {
    setEditFiles((previous) => {
      if (previous.length <= 1) return previous
      const next = previous.filter((_, fileIndex) => fileIndex !== index)
      setSelectedFile(Math.min(selectedFile, next.length - 1))
      return next
    })
  }
  const save = async () => {
    if (!onUpdateGist) return
    const valid = editFiles.filter((file) => file.filename.trim())
    if (valid.length === 0) {
      toast({ title: t('development.github.gists.filename_required'), tone: 'danger' })
      return
    }
    if (new Set(valid.map((file) => file.filename.trim())).size !== valid.length) {
      toast({ title: t('development.github.gists.filename_duplicate'), tone: 'danger' })
      return
    }
    await onUpdateGist({ ...gist, description: editDescription.trim(), files: valid, fileCount: valid.length, updatedAt: new Date().toISOString() })
    setEditing(false)
    if (selectedFile >= valid.length) setSelectedFile(0)
  }
  const copyContent = async () => {
    if (!current?.content) return
    const ok = await copyText(current.content)
    setCopied(ok)
    if (ok) window.setTimeout(() => setCopied(false), 1500)
    else toast({ title: t('development.github.common.copy_failed'), tone: 'danger' })
  }

  const exportGist = async (format: 'json' | 'md' | 'txt') => {
    if (!gist) return
    setExporting(true)
    try {
      const file = await githubApi.createExport(gist.id, format)
      const anchor = document.createElement('a')
      anchor.href = githubApi.exportUrl(file.id)
      anchor.download = file.filename
      anchor.rel = 'noopener noreferrer'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      toast({ title: t('development.github.gists.export_done'), tone: 'success' })
    } catch (cause) {
      toast({ title: t('development.github.gists.export_failed'), description: cause instanceof Error ? cause.message : undefined, tone: 'danger' })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="h-full min-w-0 overflow-y-auto overscroll-contain" data-slot="gist-detail">
      <div className="border-b border-[var(--border-subtle)] p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {editing ? <Input value={editDescription} onChange={(event) => setEditDescription(event.target.value)} placeholder={t('development.github.gists.description_placeholder')} className="h-8" /> : <div className="flex flex-wrap items-center gap-2"><span className={cn('inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[length:var(--text-10)] font-medium', gist.isPublic ? 'bg-[color-mix(in_oklab,var(--success)_14%,transparent)] text-[var(--success)]' : 'bg-[color-mix(in_oklab,var(--warning)_14%,transparent)] text-[var(--warning)]')}>{gist.isPublic ? <><Globe size={10} />{t('development.github.gists.public')}</> : <><Lock size={10} />{t('development.github.gists.secret')}</>}</span><h2 className="min-w-0 truncate text-[length:var(--text-15)] font-semibold" title={gist.description || gist.id}>{gist.description || gist.id}</h2></div>}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
              {gist.owner && <span>{gist.owner.login}</span>}
              {gist.url && <a href={gist.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"><ExternalLink size={10} />{t('development.github.gists.view_on_github')}</a>}
              <span className="inline-flex items-center gap-1"><Calendar size={10} />{t('development.github.gists.updated_at', { date: formatDate(gist.updatedAt) })}</span>
              <span className="inline-flex items-center gap-1"><FileCode size={10} />{t('development.github.gists.file_count', { count: gist.fileCount })}</span>
            </div>
          </div>
          <div className="flex shrink-0 gap-1">
            {!readOnly && onUpdateGist && (editing ? <>
              <Button variant="secondary" size="sm" onClick={() => setEditing(false)} disabled={saving}><X size={12} />{t('common.cancel')}</Button>
              <Button size="sm" onClick={() => void save()} disabled={saving} loading={saving}><Save size={12} />{t('common.save')}</Button>
            </> : <Button variant="secondary" size="sm" onClick={startEdit}><Edit3 size={12} />{t('common.edit')}</Button>)}
            {!readOnly && exportable && exportsEnabled && !editing && <><Button ref={exportAnchor} variant="secondary" size="sm" onClick={() => setExportOpen(true)} loading={exporting}><Download size={12} />{t('development.github.gists.export')}</Button><Menu anchor={exportAnchor} open={exportOpen} onClose={() => setExportOpen(false)} items={[{ id: 'json', label: t('development.github.gists.export_json'), onSelect: () => void exportGist('json') }, { id: 'md', label: t('development.github.gists.export_md'), onSelect: () => void exportGist('md') }, { id: 'txt', label: t('development.github.gists.export_txt'), onSelect: () => void exportGist('txt') }] satisfies MenuItem[]} align="end" width={180} label={t('development.github.gists.export')} /></>}
            {!readOnly && onDeleteGist && !editing && <IconButton label={t('common.delete')} size="sm" onClick={() => onDeleteGist(gist.id)}><Trash2 size={13} /></IconButton>}
          </div>
        </div>
      </div>

      {readOnly && <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] px-4 py-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.github.gists.read_only')}</div>}
      <div className="border-b border-[var(--border-subtle)] p-3">
        <div className="mb-2 flex items-center gap-2"><FileCode size={14} className="text-[var(--text-tertiary)]" /><span className="text-[length:var(--text-13)] font-semibold">{t('development.github.gists.files')}</span><span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">({files.length})</span>{editing && <Button variant="secondary" size="sm" className="ml-auto" onClick={addFile}><Plus size={11} />{t('development.github.gists.add_file')}</Button>}</div>
        <div className="flex flex-wrap gap-1.5">
          {files.map((file, index) => (
            <div key={`${file.filename}-${index}`} className={cn('inline-flex items-center rounded-[var(--r-md)] border', index === selectedFile ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border-subtle)]')}>
              <button type="button" onClick={() => setSelectedFile(index)} className={cn('inline-flex max-w-40 items-center gap-1 px-2 py-1 text-[length:var(--text-11)]', index === selectedFile ? 'text-[var(--accent-on-soft)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]')}><FileCode size={10} /><span className="truncate">{file.filename || t('development.github.gists.unnamed')}</span></button>
              {editing && files.length > 1 && <IconButton label={t('common.delete')} size="sm" onClick={() => removeFile(index)}><Trash2 size={10} /></IconButton>}
            </div>
          ))}
        </div>
      </div>

      <div className="p-4">
        {current ? <div className="space-y-2">
          <div className="flex items-center gap-2">
            {editing ? <><Input value={current.filename} onChange={(event) => updateFile(selectedFile, { filename: event.target.value })} placeholder={t('development.github.gists.filename_placeholder')} className="h-8 flex-1 text-[length:var(--text-11)]" /><span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{current.language}</span></> : <><span className="min-w-0 truncate text-[length:var(--text-13)] font-medium">{current.filename}</span><span className="shrink-0 rounded bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{current.language ?? 'Text'}</span><span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{formatNumber(current.size)} {t('development.github.gists.chars')}</span><Button variant="ghost" size="sm" className="ml-auto" onClick={() => void copyContent()} disabled={!current.content}>{copied ? <><Check size={11} className="text-[var(--success)]" />{t('development.github.gists.copied')}</> : <><Copy size={11} />{t('development.github.gists.copy_content')}</>}</Button></>}
          </div>
          {editing ? <Textarea value={current.content} onChange={(event) => updateFile(selectedFile, { content: event.target.value })} placeholder={t('development.github.gists.content_placeholder')} className="min-h-[280px] font-mono text-[length:var(--text-11)]" /> : <pre className="max-h-[55vh] overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 text-[length:var(--text-11)] leading-relaxed"><code className="font-mono">{current.content || t('development.github.gists.empty_file')}</code></pre>}
        </div> : <p className="rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] p-4 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.github.gists.no_files')}</p>}
      </div>

      {!readOnly && onUpdateNotes && <div className="border-t border-[var(--border-subtle)] p-4">
        <div className="mb-2 flex items-center gap-2"><FileText size={14} className="text-[var(--text-tertiary)]" /><span className="text-[length:var(--text-13)] font-semibold">{t('development.github.gists.notes')}</span>{!editingNotes && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => { setNotesDraft(notes); setEditingNotes(true) }}><Edit3 size={11} />{t('common.edit')}</Button>}</div>
        {editingNotes ? <div className="space-y-2"><Textarea value={notesDraft} onChange={(event) => setNotesDraft(event.target.value)} placeholder={t('development.github.gists.notes_placeholder')} className="min-h-20 text-[length:var(--text-11)]" autoFocus /><div className="flex justify-end gap-1"><Button variant="secondary" size="sm" onClick={() => setEditingNotes(false)}>{t('common.cancel')}</Button><Button size="sm" onClick={() => { onUpdateNotes(notesDraft); setEditingNotes(false) }}><Save size={11} />{t('common.save')}</Button></div></div> : notes ? <p className="whitespace-pre-wrap text-[length:var(--text-11)] text-[var(--text-secondary)]">{notes}</p> : <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.github.gists.no_notes')}</p>}
      </div>}
    </div>
  )
}
