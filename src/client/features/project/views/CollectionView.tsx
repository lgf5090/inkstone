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
import { Input } from '../../../components/form'
import { useUi } from '../../../store/ui'
import { ViewEmpty, ViewHead, ViewShell, ViewToolbar } from './shell'
import { listBoardFiles, projectFileUrl, uploadBoardFile } from '../api'

export function CollectionView({ boardId, canEdit, onOpenCard }: {
  boardId: string
  canEdit: boolean
  onOpenCard: (id: string) => void
}): ReactElement {
  const locale = useLocale()
  const [files, setFiles] = useState<ProjectAttachment[] | null>(null)
  const [category, setCategory] = useState<ProjectAttachmentCategory | ''>('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [broken, setBroken] = useState<Set<string>>(() => new Set())
  const input = useRef<HTMLInputElement>(null)
  const toast = useUi((state) => state.toast)

  const load = useCallback(async () => { setFiles(await listBoardFiles(boardId)) }, [boardId])
  useEffect(() => { void load().catch(() => setFiles([])) }, [load])

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
      {files !== null && shown.length === 0
        ? <ViewEmpty title={t('project.collection.empty')} hint={canEdit ? t('project.collection.empty_hint') : undefined} />
        : (
          <div className="pv-files pv-scroll" data-project-collection={boardId}>
            {shown.map((file) => {
              const kind = fileCategory(file.mime)
              const Icon = FILE_ICONS[kind] ?? FileIcon
              return (
                <article key={file.id} className="pv-file" data-collection-file={file.id}>
                  <a href={projectFileUrl(file.id)} target="_blank" rel="noreferrer" className="pv-file-thumb">
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
                  </a>
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