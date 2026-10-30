import { useEffect, useState } from 'react'
import { ExternalLink, Share2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { formatBytes } from '@shared/byte-format'
import { t } from '../../../lib/i18n'
import { clouddriveApi } from '../api'
import { Button, IconButton } from '../../../components/primitives'
import { Input, Textarea } from '../../../components/form'
import { useUi } from '../../../store/ui'
import { FileIcon } from './FileIcon'
import { FolderColorMenu, TagEditorMenu } from './ColorTagMenus'
import { entryKindLabel, formatEntryDate, formatEntrySize, totalEntryBytes } from './format'

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-2 py-0.5">
      <dt className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</dt>
      <dd className="min-w-0 text-[length:var(--text-12)] text-[var(--text-primary)]">{children}</dd>
    </div>
  )
}

function AclEditor({ entry }: { entry: CloudDriveEntry }) {
  const toast = useUi((state) => state.toast)
  const [grants, setGrants] = useState<{ granteeId: string; username: string; name: string }[]>([])
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => {
    void clouddriveApi.aclGrants(entry.id).then((result) => setGrants(result.grants)).catch((error) => {
      console.warn('[inkstone] CloudDrive ACL grants could not be read', error)
    })
  }
  useEffect(() => { load() }, [entry.id])
  const add = async () => {
    if (!username.trim()) return
    setBusy(true)
    try {
      await clouddriveApi.addAclGrant(entry.id, username.trim())
      setUsername('')
      load()
      toast({ title: t('clouddrive.inspector.acl_added') })
    } catch (caught) {
      toast({
        title: t('clouddrive.toast.failed'),
        description: caught instanceof Error ? caught.message : '',
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }
  const remove = async (granteeId: string) => {
    setBusy(true)
    try {
      await clouddriveApi.removeAclGrant(entry.id, granteeId)
      load()
      toast({ title: t('clouddrive.inspector.acl_removed') })
    } catch {
      toast({ title: t('clouddrive.toast.failed'), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <section>
      <h3 className="mb-1 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">{t('clouddrive.inspector.acl')}</h3>
      <p className="mb-1 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('clouddrive.inspector.acl_hint')}</p>
      <div className="flex gap-1.5">
        <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t('clouddrive.inspector.acl')} aria-label={t('clouddrive.inspector.acl')} />
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void add()}>{t('clouddrive.inspector.acl_add')}</Button>
      </div>
      {grants.length === 0 ? <p className="mt-1 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('clouddrive.inspector.acl_empty')}</p> : (
        <ul className="mt-1 flex flex-col gap-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
          {grants.map((grant) => (
            <li key={grant.granteeId} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{grant.username}{grant.name && grant.name !== grant.username ? ` · ${grant.name}` : ''}</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(grant.granteeId)}>{t('clouddrive.inspector.acl_remove')}</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function DistributedParts({ entry }: { entry: CloudDriveEntry }) {
  const [parts, setParts] = useState<{ partNumber: number; mountId: string; size: number }[]>([])
  useEffect(() => {
    let active = true
    void clouddriveApi.entry(entry.id)
      .then((result) => { if (active) setParts(result.parts ?? []) })
      .catch((error) => {
        console.warn('[inkstone] CloudDrive parts could not be read', error)
      })
    return () => { active = false }
  }, [entry.id])
  if (parts.length === 0) return null
  const mounts = new Set(parts.map((part) => part.mountId)).size
  return (
    <section>
      <h3 className="mb-1 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">{t('clouddrive.inspector.parts')}</h3>
      <p className="text-[length:var(--text-11)] text-[var(--text-secondary)]">
        {t('clouddrive.inspector.parts_summary', { count: parts.length, mounts })}
      </p>
      <ul className="mt-1 flex max-h-36 flex-col gap-0.5 overflow-auto text-[length:var(--text-10)] text-[var(--text-tertiary)]">
        {parts.slice(0, 30).map((part) => (
          <li key={part.partNumber} className="flex items-center justify-between gap-2">
            <span>#{part.partNumber} · {part.mountId}</span>
            <span className="tabular">{formatBytes(part.size)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function FolderMetaEditor({
  entry,
  readOnly,
  busy,
  onSave,
}: {
  entry: CloudDriveEntry
  readOnly: boolean
  busy: boolean
  onSave: (note: string, patterns: string[]) => void
}) {
  const [note, setNote] = useState(entry.note ?? '')
  const [patterns, setPatterns] = useState((entry.hiddenPatterns ?? []).join(', '))
  useEffect(() => {
    setNote(entry.note ?? '')
    setPatterns((entry.hiddenPatterns ?? []).join(', '))
  }, [entry.id, entry.note, entry.hiddenPatterns])
  if (readOnly) {
    if (!entry.note && (entry.hiddenPatterns ?? []).length === 0) return null
    return (
      <section>
        <h3 className="mb-1 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">{t('clouddrive.inspector.folder_note')}</h3>
        {entry.note && <p className="whitespace-pre-wrap text-[length:var(--text-12)] text-[var(--text-secondary)]">{entry.note}</p>}
        {(entry.hiddenPatterns ?? []).length > 0 && (
          <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('clouddrive.inspector.hidden_count', { count: entry.hiddenPatterns!.length })}
          </p>
        )}
      </section>
    )
  }
  const save = () => {
    const list = [...new Set(patterns.split(',').map((pattern) => pattern.trim()).filter(Boolean))]
    onSave(note.trim(), list)
  }
  return (
    <section>
      <h3 className="mb-1 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">{t('clouddrive.inspector.folder_note')}</h3>
      <Textarea
        value={note}
        maxLength={4000}
        rows={3}
        placeholder={t('clouddrive.inspector.folder_note_hint')}
        onChange={(event) => setNote(event.target.value)}
      />
      <h3 className="mb-1 mt-2 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">{t('clouddrive.inspector.hidden_patterns')}</h3>
      <Input
        value={patterns}
        placeholder={t('clouddrive.inspector.hidden_patterns_hint')}
        onChange={(event) => setPatterns(event.target.value)}
      />
      <Button size="sm" variant="secondary" className="mt-2" loading={busy} onClick={save}>
        {t('clouddrive.inspector.save_meta')}
      </Button>
    </section>
  )
}

export function Inspector({
  open,
  entries,
  readOnly,
  busy,
  shared = false,
  onClose,
  onOpen,
  onShare,
  onColor,
  onAddTag,
  onRemoveTag,
  onSaveMeta,
}: {
  open: boolean
  entries: CloudDriveEntry[]
  readOnly: boolean
  busy: boolean
  /** Share existence is not part of the entry model; the shell may supply it later. */
  shared?: boolean
  onClose: () => void
  onOpen: (entry: CloudDriveEntry) => void
  onShare: (entries: CloudDriveEntry[]) => void
  onColor: (entry: CloudDriveEntry, color: string | null) => void
  onAddTag: (entry: CloudDriveEntry, tag: string, color: string) => void
  onRemoveTag: (entry: CloudDriveEntry, tag: string) => void
  onSaveMeta: (entry: CloudDriveEntry, note: string, hiddenPatterns: string[]) => void
}) {
  if (!open) return null
  const single = entries.length === 1 ? entries[0] : null
  const metadataWritable = single !== null && !readOnly && !single.readOnly && single.storageKind !== 'external'
  return (
    <aside className="cd-inspector flex min-h-0 flex-col" aria-label={t('clouddrive.inspector.title')}>
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3">
        <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{t('clouddrive.inspector.title')}</h2>
        <IconButton label={t('common.close')} size="sm" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {entries.length === 0 && (
          <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.inspector.none')}</p>
        )}
        {entries.length > 1 && (
          <div className="flex flex-col gap-1">
            <p className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
              {t('clouddrive.inspector.multiple', { count: entries.length })}
            </p>
            <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {t('clouddrive.inspector.total_size', { size: formatBytes(totalEntryBytes(entries)) })}
            </p>
            <Button size="sm" variant="secondary" icon={<Share2 size={13} />} onClick={() => onShare(entries)} disabled={busy} className="mt-2 self-start">
              {t('clouddrive.action.share')}
            </Button>
          </div>
        )}
        {single && (
          <div className="flex flex-col gap-3">
            <div className="flex min-w-0 items-center gap-3">
              {single.kind === 'file' && single.hasThumbnail
                ? <img src={clouddriveApi.thumbnailUrl(single.id, 320)} alt={single.name} className="size-12 shrink-0 rounded-[var(--r-sm)] object-cover" />
                : <FileIcon entry={single} size={40} />}
              <div className="min-w-0">
                <p className="break-words text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{single.name}</p>
                <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{entryKindLabel(single)}</p>
              </div>
            </div>
            <Button size="sm" variant="secondary" icon={<ExternalLink size={13} />} onClick={() => onOpen(single)}>
              {single.kind === 'folder' ? t('clouddrive.action.open') : t('clouddrive.action.preview')}
            </Button>
            <dl className="m-0">
              <DetailRow label={t('clouddrive.inspector.name')}>
                <span className="break-words">{single.name}</span>
              </DetailRow>
              <DetailRow label={t('clouddrive.inspector.kind')}>{entryKindLabel(single)}</DetailRow>
              <DetailRow label={t('clouddrive.inspector.size')}>{formatEntrySize(single)}</DetailRow>
              <DetailRow label={t('clouddrive.inspector.modified')}>{formatEntryDate(single.modifiedAt)}</DetailRow>
              <DetailRow label={t('clouddrive.inspector.uploaded')}>{formatEntryDate(single.uploadedAt)}</DetailRow>
              <DetailRow label={t('clouddrive.inspector.path')}>
                <code className="cd-path text-[length:var(--text-11)] text-[var(--text-secondary)]">{single.path}</code>
              </DetailRow>
              <DetailRow label={t('clouddrive.inspector.share')}>
                <span className="flex flex-wrap items-center gap-1.5">
                  <span>{shared ? t('clouddrive.inspector.shared') : t('clouddrive.inspector.not_shared')}</span>
                  <Button size="sm" variant="ghost" icon={<Share2 size={12} />} onClick={() => onShare([single])} disabled={busy}>
                    {t('clouddrive.action.share')}
                  </Button>
                </span>
              </DetailRow>
            </dl>
            {single.storageKind === 'distributed' && <DistributedParts entry={single} />}
            {single.storageKind !== 'external' && !readOnly && !single.readOnly && <AclEditor entry={single} />}
            {single.kind === 'folder' && (
              <section>
                <h3 className="mb-1 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">{t('clouddrive.inspector.color')}</h3>
                {metadataWritable
                  ? <FolderColorMenu value={single.color} onPick={(color) => onColor(single, color)} className="w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2" />
                  : <FileIcon entry={single} size={20} />}
              </section>
            )}
            {single.kind === 'folder' && (
              <FolderMetaEditor
                entry={single}
                readOnly={!metadataWritable}
                busy={busy}
                onSave={(note, patterns) => onSaveMeta(single, note, patterns)}
              />
            )}
            <section>
              <h3 className="mb-1 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">{t('clouddrive.inspector.tags')}</h3>
              {metadataWritable
                ? (
                  <TagEditorMenu
                    tags={single.tags}
                    busy={busy}
                    onAdd={(tag, color) => onAddTag(single, tag, color)}
                    onRemove={(tag) => onRemoveTag(single, tag)}
                  />
                )
                : (
                  <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
                    {single.tags.length === 0 ? t('clouddrive.tags.none') : single.tags.map((tag) => tag.name).join(', ')}
                  </p>
                )}
            </section>
          </div>
        )}
      </div>
    </aside>
  )
}
