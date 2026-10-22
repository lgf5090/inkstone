import { useEffect, useState } from 'react'
import {
  Calendar,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderClosed,
  Link2Off,
  Maximize2,
  Paperclip,
  Pencil,
  Plus,
  QrCode,
  Trash2,
  X,
} from 'lucide-react'
import type { AttachmentHubScope, HubAttachmentOwner, HubAttachmentWithUsage } from '@shared/attachment-hub'
import { cn } from '../../lib/cn'
import { t, localeTag } from '../../lib/i18n'
import { formatBytes } from '../../lib/time'
import { copyText } from '../../lib/clipboard'
import { useNotes } from '../../store/notes'
import { Button, IconButton } from '../../components/primitives'
import { attachmentHubApi } from './api'
import { useHubOrganizer } from './attachment-store'
import { useHubScope } from './hub-scope'
import { badgeLabelOf, fileExtensionOf, getFileCategory } from './attachment-helpers'
import { markdownOf, reportCopyFailure } from './attachment-item-common'

interface AttachmentInspectorProps {
  file: HubAttachmentWithUsage | null
  onClose: () => void
  onRename: (file: HubAttachmentWithUsage) => void
  onShowQr: (file: HubAttachmentWithUsage) => void
  onInsertHere?: (file: HubAttachmentWithUsage) => void
  onDelete: (file: HubAttachmentWithUsage) => void
  onUpdateTags: (file: HubAttachmentWithUsage, tags: string[]) => Promise<void>
  onPreview: (file: HubAttachmentWithUsage) => void
}

function useOwnerList(scope: AttachmentHubScope, file: HubAttachmentWithUsage | null) {
  const [owners, setOwners] = useState<HubAttachmentOwner[]>([])
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle')

  useEffect(() => {
    if (!file) {
      setOwners([])
      setState('idle')
      return
    }
    let isStale = false
    setState('loading')
    void attachmentHubApi.owners(scope, file.id).then(
      (result) => {
        if (isStale) return
        setOwners(result.owners)
        setState('idle')
      },
      () => {
        if (isStale) return
        setOwners([])
        setState('failed')
      },
    )
    return () => {
      isStale = true
    }
  }, [scope, file?.id])

  return { owners, isLoading: state === 'loading', failed: state === 'failed' }
}

function useCopyActions(file: HubAttachmentWithUsage | null) {
  const [isCopiedLink, setIsCopiedLink] = useState(false)
  const [isCopiedMarkdown, setIsCopiedMarkdown] = useState(false)

  const markCopied = (setter: (next: boolean) => void) => {
    setter(true)
    window.setTimeout(() => setter(false), 1600)
  }

  const copyLink = async () => {
    if (!file) return
    const url = new URL(file.url, window.location.origin).href
    if (await copyText(url)) markCopied(setIsCopiedLink)
    else reportCopyFailure()
  }

  const copyMarkdown = async () => {
    if (!file) return
    if (await copyText(markdownOf(file))) markCopied(setIsCopiedMarkdown)
    else reportCopyFailure()
  }

  return { isCopiedLink, isCopiedMarkdown, copyLink, copyMarkdown }
}

function useTagForm(file: HubAttachmentWithUsage | null, onUpdateTags: AttachmentInspectorProps['onUpdateTags']) {
  const [newTagInput, setNewTagInput] = useState('')
  const [isAddingTag, setIsAddingTag] = useState(false)

  const submitTag = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) return
    const trimmed = newTagInput.trim()
    if (!trimmed) {
      setIsAddingTag(false)
      return
    }
    const currentTags = file.tags ?? []
    if (!currentTags.includes(trimmed)) await onUpdateTags(file, [...currentTags, trimmed])
    setNewTagInput('')
    setIsAddingTag(false)
  }

  const removeTag = async (tagToRemove: string) => {
    if (!file) return
    await onUpdateTags(file, (file.tags ?? []).filter((tag) => tag !== tagToRemove))
  }

  return { newTagInput, setNewTagInput, isAddingTag, setIsAddingTag, submitTag, removeTag }
}

export function AttachmentInspector(props: AttachmentInspectorProps) {
  const { file, onClose, onRename, onShowQr, onInsertHere, onDelete, onUpdateTags, onPreview } = props
  const scope = useHubScope()
  const folders = useHubOrganizer(scope, (state) => state.folders)
  const { owners, isLoading, failed } = useOwnerList(scope, file)
  const copy = useCopyActions(file)
  const tagForm = useTagForm(file, onUpdateTags)

  if (!file) return null

  const ext = fileExtensionOf(file.filename)
  const isImage = getFileCategory(file.mime, file.filename) === 'image'
  const folder = file.folderId ? folders.find((item) => item.id === file.folderId) : null

  return (
    <aside className='flex h-full w-75 shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-sunken)]'>
      <div className='flex h-12 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-[var(--sp-3)]'>
        <span className='text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]'>
          {t('attachments.detail_info')}
        </span>
        <IconButton label={t('common.close')} size='sm' onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>

      <div className='min-h-0 flex-1 space-y-4 overflow-y-auto p-[var(--sp-3)]'>
        <PreviewBlock file={file} isImage={isImage} badge={badgeLabelOf(ext)} onPreview={onPreview} />
        <FileNameBlock file={file} onRename={onRename} />
        <ActionButtons file={file} copy={copy} onInsertHere={onInsertHere} onShowQr={onShowQr} />

        <div className='space-y-[var(--sp-2)] border-t border-[var(--border-subtle)] pt-[var(--sp-3)] text-[length:var(--text-12)]'>
          <MetaRow icon={<FolderClosed size={13} />} term={t('navigation.folder')} value={folder ? folder.name : t('folders.top_level')} />
          <MetaRow icon={<FileText size={13} />} term='MIME' value={file.mime} />
          <MetaRow icon={<Calendar size={13} />} term={t('common.created')} value={new Date(file.createdAt).toLocaleDateString(localeTag())} />
          <MetaRow icon={<Link2Off size={13} />} term={t('attachments.reference_column')} value={t('attachments.referenced_value0', { value0: file.references })} />
        </div>

        <TagsBlock file={file} form={tagForm} />
        <OwnersBlock scope={scope} owners={owners} isLoading={isLoading} failed={failed} />

        <div className='border-t border-[var(--border-subtle)] pt-[var(--sp-3)]'>
          <Button size='sm' variant='danger' block icon={<Trash2 size={13} />} onClick={() => onDelete(file)}>
            {t('attachments.delete')}
          </Button>
        </div>
      </div>
    </aside>
  )
}

function PreviewBlock({ file, isImage, badge, onPreview }: {
  file: HubAttachmentWithUsage
  isImage: boolean
  badge: string
  onPreview: (file: HubAttachmentWithUsage) => void
}) {
  const chrome = 'group relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]'
  if (isImage) {
    return (
      <button type='button' aria-label={t('attachments.preview_file')} onClick={() => onPreview(file)} className={cn(chrome, 'cursor-pointer')}>
        <img src={file.url} alt={file.filename} className='h-full w-full object-cover transition-transform duration-[var(--dur-base)] group-hover:scale-105' />
        <span className='absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100'>
          <Maximize2 size={20} className='text-white' />
        </span>
      </button>
    )
  }
  return (
    <a href={file.url} target='_blank' rel='noopener noreferrer' className={cn(chrome, 'cursor-pointer')}>
      <span className='flex flex-col items-center gap-[var(--sp-1-5)] rounded-[var(--r-xl)] bg-[var(--bg-sunken)] px-[var(--sp-4)] py-[var(--sp-3)]'>
        <span className='text-[length:var(--text-15)] font-bold tracking-wider text-[var(--text-secondary)]'>{badge}</span>
        <span className='text-[length:var(--text-11)] text-[var(--text-tertiary)]'>{file.mime}</span>
      </span>
      <span className='absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100'>
        <ExternalLink size={20} className='text-white' />
      </span>
    </a>
  )
}

function FileNameBlock({ file, onRename }: {
  file: HubAttachmentWithUsage
  onRename: (file: HubAttachmentWithUsage) => void
}) {
  return (
    <div>
      <div className='flex items-start justify-between gap-[var(--sp-2)]'>
        <h4 className='break-all text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]'>{file.filename}</h4>
        <IconButton label={t('attachments.rename')} size='sm' onClick={() => onRename(file)}>
          <Pencil size={12} />
        </IconButton>
      </div>
      <p className='mt-[var(--sp-1)] text-[length:var(--text-11-5)] text-[var(--text-tertiary)]'>
        {formatBytes(file.size)}
        {file.width && file.height ? ` · ${file.width} × ${file.height}` : ''}
      </p>
    </div>
  )
}

function ActionButtons({ file, copy, onInsertHere, onShowQr }: {
  file: HubAttachmentWithUsage
  copy: ReturnType<typeof useCopyActions>
  onInsertHere?: (file: HubAttachmentWithUsage) => void
  onShowQr: (file: HubAttachmentWithUsage) => void
}) {
  return (
    <div className='grid grid-cols-2 gap-[var(--sp-1-5)] pt-[var(--sp-1)]'>
      {onInsertHere && (
        <Button size='sm' variant='secondary' className='col-span-2' icon={<Paperclip size={13} />} onClick={() => onInsertHere(file)}>
          {t('attachments.insert_here')}
        </Button>
      )}
      <Button size='sm' variant='secondary' icon={copy.isCopiedMarkdown ? <Check size={13} className='text-[var(--success)]' /> : <Copy size={13} />} onClick={() => void copy.copyMarkdown()}>
        {copy.isCopiedMarkdown ? t('common.copied') : t('attachments.copy_markdown')}
      </Button>
      <Button size='sm' variant='secondary' icon={copy.isCopiedLink ? <Check size={13} className='text-[var(--success)]' /> : <Copy size={13} />} onClick={() => void copy.copyLink()}>
        {copy.isCopiedLink ? t('common.copied') : t('attachments.copy_link')}
      </Button>
      <Button size='sm' variant='secondary' icon={<QrCode size={13} />} onClick={() => onShowQr(file)}>
        {t('attachments.qr_code_title')}
      </Button>
      <a
        href={file.url}
        download={file.filename}
        className='inline-flex h-9 items-center justify-center gap-[var(--sp-1-5)] rounded-[var(--r-sm)] border border-[var(--border-default)] px-[var(--sp-3)] text-[length:var(--text-12)] font-medium whitespace-nowrap text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] md:h-7 md:px-2.5'
      >
        <Download size={13} />
        <span>{t('common.download')}</span>
      </a>
    </div>
  )
}

function MetaRow({ icon, term, value }: { icon: React.ReactNode; term: string; value: string }) {
  return (
    <div className='flex items-center justify-between gap-[var(--sp-3)] text-[var(--text-secondary)]'>
      <span className='flex shrink-0 items-center gap-[var(--sp-1-5)] text-[var(--text-tertiary)]'>
        {icon}
        {term}
      </span>
      <span className='min-w-0 truncate text-right font-medium text-[var(--text-primary)]'>{value}</span>
    </div>
  )
}

function TagsBlock({ file, form }: {
  file: HubAttachmentWithUsage
  form: ReturnType<typeof useTagForm>
}) {
  return (
    <div className='space-y-[var(--sp-2)] border-t border-[var(--border-subtle)] pt-[var(--sp-3)]'>
      <div className='flex items-center justify-between'>
        <span className='text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]'>{t('navigation.tag')}</span>
        <IconButton label={t('attachments.add_tag')} size='sm' onClick={() => form.setIsAddingTag(true)}>
          <Plus size={12} />
        </IconButton>
      </div>

      <div className='flex flex-wrap gap-[var(--sp-1)]'>
        {(file.tags ?? []).map((tag) => (
          <span key={tag} className='inline-flex items-center gap-[var(--sp-1)] rounded-full border border-[var(--border-subtle)] bg-[var(--bg-base)] px-[var(--sp-2)] py-[var(--sp-0-5)] text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]'>
            <span>#{tag}</span>
            <button
              type='button'
              aria-label={t('attachments.remove_tag_value0', { value0: `#${tag}` })}
              onClick={() => void form.removeTag(tag)}
              className='cursor-pointer rounded-full text-[var(--text-quaternary)] hover:text-[var(--text-primary)]'
            >
              <X size={10} />
            </button>
          </span>
        ))}

        {form.isAddingTag && (
          <form onSubmit={(e) => void form.submitTag(e)} className='inline-flex'>
            <input
              autoFocus
              type='text'
              value={form.newTagInput}
              onChange={(e) => form.setNewTagInput(e.target.value)}
              onBlur={() => {
                if (!form.newTagInput.trim()) form.setIsAddingTag(false)
              }}
              placeholder={t('attachments.add_tag')}
              aria-label={t('attachments.add_tag')}
              className='h-6 w-24 rounded-full border border-[var(--accent)] bg-[var(--bg-base)] px-[var(--sp-2)] text-[length:var(--text-11)] outline-none'
            />
          </form>
        )}
      </div>
    </div>
  )
}

function OwnersBlock({ scope, owners, isLoading, failed }: {
  scope: AttachmentHubScope
  owners: HubAttachmentOwner[]
  isLoading: boolean
  failed: boolean
}) {
  const openNote = useNotes((state) => state.openNote)
  return (
    <div className='space-y-[var(--sp-2)] border-t border-[var(--border-subtle)] pt-[var(--sp-3)]'>
      <span className='text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]'>{t('attachments.owners_title')}</span>

      {isLoading ? (
        <p className='text-[length:var(--text-11-5)] text-[var(--text-quaternary)]'>{t('common.loading')}</p>
      ) : failed ? (
        <p className='text-[length:var(--text-11-5)] text-[var(--danger)]'>{t('attachments.owners_failed')}</p>
      ) : owners.length === 0 ? (
        <p className='text-[length:var(--text-11-5)] text-[var(--text-quaternary)]'>{t('attachments.owners_empty')}</p>
      ) : (
        <div className='space-y-[var(--sp-1)]'>
          {owners.map((owner) => (
            <OwnerRow key={owner.id} owner={owner} canOpen={scope === 'notes'} onOpen={() => openNote(owner.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function OwnerRow({ owner, canOpen, onOpen }: {
  owner: HubAttachmentOwner
  canOpen: boolean
  onOpen: () => void
}) {
  const rowChrome = 'flex w-full items-center gap-[var(--sp-2)] rounded-[var(--r-md)] px-[var(--sp-2)] py-[var(--sp-1-5)] text-left text-[length:var(--text-12)] text-[var(--text-secondary)]'
  if (!canOpen) {
    return (
      <div className={rowChrome}>
        <FileText size={13} className='shrink-0 text-[var(--text-quaternary)]' />
        <span className='truncate'>{owner.title}</span>
      </div>
    )
  }
  return (
    <button type='button' onClick={onOpen} className={cn(rowChrome, 'cursor-pointer transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}>
      <FileText size={13} className='shrink-0 text-[var(--text-quaternary)]' />
      <span className='truncate'>{owner.title}</span>
    </button>
  )
}
