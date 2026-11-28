/**
 * The collection: every file the board carries, as a shelf rather than a list of filenames.
 *
 * An image shows itself; everything else shows its kind. Search and the category chips narrow the
 * shelf, and a file that belongs to a card opens that card, because "where did this come from" is the
 * question a board's attachments actually raise.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, File as FileIcon, FolderOpen, Upload } from 'lucide-react'
import type { ProjectAttachment, ProjectAttachmentCategory } from '@shared/project/model'
import { PROJECT_ATTACHMENT_CATEGORIES } from '@shared/project/model'
import { t, useLocale } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { LoadingBlock } from '../../../components/feedback'
import { Input } from '../../../components/form'
import { confirm, useDialogFocus, useEscape } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { request } from '../../../lib/api'
import { ViewEmpty, ViewHead, ViewShell, ViewToolbar } from './shell'
import { deleteProjectFile, listBoardFiles, projectFileUrl, uploadBoardFile } from '../api'

export function CollectionView({ boardId, canEdit, onOpenCard, publicView = false }: {
  boardId: string
  canEdit: boolean
  onOpenCard: (id: string) => void
  publicView?: boolean
}): ReactElement {
  const locale = useLocale()
  const [files, setFiles] = useState<ProjectAttachment[] | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [category, setCategory] = useState<ProjectAttachmentCategory | ''>('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [broken, setBroken] = useState<Set<string>>(() => new Set())
  const [preview, setPreview] = useState<ProjectAttachment | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [textStatus, setTextStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const previewRef = useRef<HTMLElement>(null)
  useDialogFocus(preview !== null, previewRef)
  useEscape(preview !== null, () => setPreview(null))
  const toast = useUi((state) => state.toast)

  const load = useCallback(async () => {
    const list = await listBoardFiles(boardId)
    setFiles(list)
    setError(false)
    return list
  }, [boardId])
  useEffect(() => {
    if (publicView) { setFiles([]); setError(false); return }
    let alive = true
    setFiles(null)
    setError(false)
    void listBoardFiles(boardId)
      .then((list) => { if (alive) setFiles(list) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [load, publicView, attempt])

  const shown = useMemo(() => (files ?? [])
    .filter((file) => !category || fileCategory(file.mime) === category)
    .filter((file) => !query.trim() || file.filename.toLowerCase().includes(query.trim().toLowerCase())), [files, category, query])

  const upload = async (file: File): Promise<void> => {
    setBusy(true)
    try {
      await uploadBoardFile(boardId, file)
      await load()
    } catch (reason) {
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!preview) return
    const target = preview
    const ok = await confirm({ title: t('project.collection.delete_file'), description: target.filename, tone: 'danger', confirmLabel: t('common.delete') })
    if (!ok) return
    try {
      await deleteProjectFile(target.id)
      setPreview(null)
      await load()
    } catch (reason) {
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    }
  }

  // The reference previews the picked file beside the tree; a cloud attachment gets the same panel.
  useEffect(() => {
    if (!preview || !preview.mime.startsWith('text/')) { setText(null); setTextStatus('idle'); return }
    const controller = new AbortController()
    setTextStatus('loading')
    request<string>(projectFileUrl(preview.id), { signal: controller.signal })
      .then((body) => { if (!controller.signal.aborted) { setText(body.slice(0, 20_000)); setTextStatus('ready') } })
      .catch(() => { if (!controller.signal.aborted) { setText(null); setTextStatus('error') } })
    return () => controller.abort()
  }, [preview, previewAttempt])

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const file of files ?? []) {
      const key = fileCategory(file.mime)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return map
  }, [files])

  return (
    <ViewShell data-view="collection">
      <ViewHead icon={<FolderOpen size={15} aria-hidden="true" />} title={t('project.view.collection')} count={files?.length ?? 0}>
        {canEdit && (
          <>
            <input ref={input} type="file" className="hidden" onChange={(event) => { const picked = event.target.files?.[0]; if (picked) void upload(picked); event.target.value = '' }} />
            <Button size="sm" variant="primary" icon={<Upload size={14} />} disabled={busy} onClick={() => input.current?.click()}>
              {t('project.collection.upload')}
            </Button>
          </>
        )}
      </ViewHead>
      <ViewToolbar>
        <Input
          className="w-48"
          value={query}
          aria-label={t('project.view.search')}
          placeholder={t('project.view.search')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="pv-bar-sep" aria-hidden="true" />
        <Button size="sm" variant={category === '' ? 'primary' : 'ghost'} onClick={() => setCategory('')}>{t('project.collection.all')}</Button>
        {PROJECT_ATTACHMENT_CATEGORIES.filter((entry) => (counts.get(entry) ?? 0) > 0).map((entry) => (
          <Button key={entry} size="sm" variant={category === entry ? 'primary' : 'ghost'} onClick={() => setCategory(entry)}>
            {t(`project.collection.cat_${entry}` as Parameters<typeof t>[0])}
            <span className="ml-1 opacity-70">{counts.get(entry)}</span>
          </Button>
        ))}
      </ViewToolbar>
      {error
        ? (
            <div role="alert" className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
              <p className="text-[length:var(--text-13)] text-[var(--danger)]">{t('project.common.load_failed')}</p>
              <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.common.load_failed_hint')}</p>
              <Button size="sm" onClick={() => setAttempt((current) => current + 1)}>{t('project.common.retry')}</Button>
            </div>
          )
        : files === null
          ? <LoadingBlock />
          : shown.length === 0
            ? <ViewEmpty title={t('project.collection.empty')} hint={canEdit ? t('project.collection.empty_hint') : undefined} />
            : (
          <div className="pv-files pv-scroll" data-project-collection={boardId}>
            {shown.map((file) => {
              const kind = fileCategory(file.mime)
              const Icon = FILE_ICONS[kind] ?? FileIcon
              return (
                <article key={file.id} className="pv-file" data-collection-file={file.id} data-selected={preview?.id === file.id}>
                  <button type="button" className="pv-file-thumb" aria-label={t('project.collection.preview', { name: file.filename })} onClick={() => setPreview(file)}>
                    {kind === 'images' && !broken.has(file.id)
                      ? (
                        <img
                          src={projectFileUrl(file.id)}
                          alt={file.filename}
                          className="size-full object-cover"
                          loading="lazy"
                          onError={() => setBroken((current) => new Set(current).add(file.id))}
                        />
                      )
                      : <Icon size={30} aria-hidden="true" className="text-[var(--text-quaternary)]" />}
                  </button>
                  <div className="pv-file-body">
                    <a className="truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)] hover:text-[var(--accent)]" href={projectFileUrl(file.id)} target="_blank" rel="noreferrer" title={file.filename}>
                      {file.filename}
                    </a>
                    <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      {formatBytes(file.size)} · {new Date(file.createdAt).toLocaleDateString(locale)}
                    </span>
                    {file.cardId && (
                      <Button size="sm" variant="ghost" onClick={() => onOpenCard(file.cardId!)}>{t('project.card.open')}</Button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      {preview && (
        <aside ref={previewRef} className="pv-preview" aria-label={preview.filename} data-file-preview={preview.id}>
          <div className="pv-cal-panel-head">
            <span className="pv-cal-panel-date truncate">{preview.filename}</span>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>{t('common.close')}</Button>
          </div>
          <div className="pv-preview-body pv-scroll">
            {fileCategory(preview.mime) === 'images' && !broken.has(preview.id)
              ? <img src={projectFileUrl(preview.id)} alt={preview.filename} className="max-h-full max-w-full object-contain" onError={() => setBroken((current) => new Set(current).add(preview.id))} />
              : textStatus === 'loading'
                ? <LoadingBlock />
                : textStatus === 'error'
                  ? (
                      <div role="alert" className="flex flex-col items-center gap-3 p-4 text-center">
                        <p className="text-[length:var(--text-12)] text-[var(--danger)]">{t('project.common.load_failed')}</p>
                        <Button size="sm" variant="ghost" onClick={() => setPreviewAttempt((current) => current + 1)}>{t('project.common.retry')}</Button>
                      </div>
                    )
                  : text !== null
                    ? <pre className="pv-preview-text">{text}</pre>
                    : (() => { const Fallback = FILE_ICONS[fileCategory(preview.mime)] ?? FileIcon; return <Fallback size={40} aria-hidden="true" className="text-[var(--text-quaternary)]" /> })()}
          </div>
          <div className="pv-preview-foot">
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{formatBytes(preview.size)} · {new Date(preview.createdAt).toLocaleDateString(locale)}</span>
            <a className="text-[length:var(--text-12)] text-[var(--accent)]" href={projectFileUrl(preview.id)} target="_blank" rel="noreferrer">{t('project.collection.open_raw')}</a>
            {canEdit && !preview.cardId && <Button size="sm" variant="ghost" onClick={() => void remove()}>{t('project.collection.delete_file')}</Button>}
            {preview.cardId && <Button size="sm" variant="ghost" onClick={() => onOpenCard(preview.cardId!)}>{t('project.card.open')}</Button>}
          </div>
        </aside>
      )}
    </ViewShell>
  )
}

const FILE_ICONS: Partial<Record<ProjectAttachmentCategory, typeof FileIcon>> = {
  images: FileImage,
  pdf: FileText,
  txt: FileText,
  docx: FileText,
  sheets: FileSpreadsheet,
  slides: FileSpreadsheet,
  audio: FileAudio,
  video: FileVideo,
  archives: FileArchive,
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/** The same buckets the server files uploads under, read from the mime the row carries. */
function fileCategory(mime: string): ProjectAttachmentCategory {
  if (mime.startsWith('image/')) return 'images'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/')) return 'txt'
  if (mime.includes('word') || mime.includes('document')) return 'docx'
  if (mime.includes('sheet') || mime.includes('excel')) return 'sheets'
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'slides'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('compressed')) return 'archives'
  return 'other'
}