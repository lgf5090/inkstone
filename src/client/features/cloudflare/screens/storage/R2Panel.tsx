/**
 * R2: buckets on the left, the selected bucket's folder on the right.
 *
 * Folders are the API's delimited prefixes, not real objects, so they are drawn as navigation and never
 * selected for deletion. A file name opens a preview only when its type can be shown inline; every file
 * still has download and delete beside it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Folder, Loader2, Plus, Trash2 } from 'lucide-react'
import type { CloudflareAccount } from '@shared/cloudflare/model'
import { Checkbox, Input } from '../../../../components/form'
import { Empty } from '../../../../components/feedback'
import { confirm } from '../../../../components/overlay'
import { Button, IconButton } from '../../../../components/primitives'
import { t as uiT } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { downloadBlob } from '../../../../lib/export-note'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { storageApi, type R2Bucket, type R2ObjectInfo } from '../../api/storage'
import { Table, TableScroll, TBody, Td, Th, THead, Tr } from '../../components/Table'
import { useCfT } from '../../i18n'
import { formatBytes, formatDateTime } from '../../lib/format'
import { CreateNameDialog } from './CreateNameDialog'
import { R2PreviewDialog } from './R2PreviewDialog'
import { R2UploadDialog } from './R2UploadDialog'
import { StorageError } from './StorageError'
import { previewKindFor } from './r2-preview'
import { isImeComposing } from '../../../../lib/ime'

interface FolderRow {
  kind: 'folder'
  key: string
  name: string
}

interface FileRow {
  kind: 'file'
  object: R2ObjectInfo
  name: string
}

type ObjectRow = FolderRow | FileRow

function displayName(key: string, prefix: string): string {
  const withoutPrefix = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key
  return withoutPrefix || key
}

export function R2Panel({ account }: { account: CloudflareAccount }) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const readOnly = account.is_demo

  const [buckets, setBuckets] = useState<R2Bucket[]>([])
  const [bucketLoading, setBucketLoading] = useState(true)
  const [bucketError, setBucketError] = useState<string | null>(null)
  const [selectedBucket, setSelectedBucket] = useState<R2Bucket | null>(null)

  const [objects, setObjects] = useState<R2ObjectInfo[]>([])
  const [prefixes, setPrefixes] = useState<string[]>([])
  const [objectLoading, setObjectLoading] = useState(false)
  const [objectError, setObjectError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [prefix, setPrefix] = useState('')
  const [prefixInput, setPrefixInput] = useState('')
  const [selection, setSelection] = useState<Set<string>>(new Set())

  const [createOpen, setCreateOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [previewObject, setPreviewObject] = useState<R2ObjectInfo | null>(null)

  const bucketName = selectedBucket?.name ?? null

  const rows = useMemo<ObjectRow[]>(() => {
    const folders: FolderRow[] = prefixes.map((key) => ({
      kind: 'folder',
      key,
      name: displayName(key, prefix).replace(/\/$/, ''),
    }))
    const files: FileRow[] = objects.map((object) => ({
      kind: 'file',
      object,
      name: displayName(object.key, prefix),
    }))
    return [...folders, ...files]
  }, [prefixes, objects, prefix])

  const loadBuckets = useCallback(async () => {
    setBucketLoading(true)
    setBucketError(null)
    try {
      const data = await storageApi.listR2Buckets(account.id)
      setBuckets(data.buckets)
      setSelectedBucket((current) => (
        current && data.buckets.some((bucket) => bucket.name === current.name)
          ? current
          : data.buckets[0] ?? null
      ))
    } catch (reason) {
      setBucketError(cfErrorText(reason))
      setBuckets([])
      setSelectedBucket(null)
    } finally {
      setBucketLoading(false)
    }
  }, [account.id])

  useEffect(() => {
    void loadBuckets()
  }, [loadBuckets])

  useEffect(() => {
    setObjects([])
    setPrefixes([])
    setCursor(null)
    setPrefix('')
    setPrefixInput('')
    setSelection(new Set())
    setObjectError(null)
    if (!bucketName) return
    let cancelled = false
    setObjectLoading(true)
    void storageApi.listR2Objects(account.id, bucketName, { delimiter: '/', limit: 100 })
      .then((page) => {
        if (cancelled) return
        setObjects(page.objects)
        setPrefixes(page.delimited_prefixes)
        setCursor(page.cursor)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setObjectError(cfErrorText(reason))
      })
      .finally(() => {
        if (!cancelled) setObjectLoading(false)
      })
    return () => { cancelled = true }
  }, [account.id, bucketName])

  async function loadObjects(prefixValue: string, cursorValue: string | null, append: boolean): Promise<void> {
    if (!selectedBucket) return
    setObjectLoading(true)
    setObjectError(null)
    try {
      const page = await storageApi.listR2Objects(account.id, selectedBucket.name, {
        ...(prefixValue ? { prefix: prefixValue } : {}),
        delimiter: '/',
        ...(cursorValue ? { cursor: cursorValue } : {}),
        limit: 100,
      })
      setObjects((current) => (append ? [...current, ...page.objects] : page.objects))
      setPrefixes((current) => (
        append ? [...new Set([...current, ...page.delimited_prefixes])] : page.delimited_prefixes
      ))
      setCursor(page.cursor)
      if (!append) setSelection(new Set())
    } catch (reason) {
      setObjectError(cfErrorText(reason))
    } finally {
      setObjectLoading(false)
    }
  }

  function navigate(nextPrefix: string): void {
    setPrefix(nextPrefix)
    setPrefixInput(nextPrefix)
    void loadObjects(nextPrefix, null, false)
  }

  async function createBucket(name: string): Promise<void> {
    const created = await storageApi.createR2Bucket(account.id, name)
    toast({ title: t('cloudflare.storage.msg.bucket_created'), tone: 'success' })
    setSelectedBucket(created)
    await loadBuckets()
  }

  async function deleteBucket(bucket: R2Bucket): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.storage.msg.delete_bucket_title'),
      description: t('cloudflare.storage.msg.delete_bucket_confirm', { name: bucket.name }),
      confirmLabel: t('cloudflare.storage.confirm_delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await storageApi.deleteR2Bucket(account.id, bucket.name)
      toast({ title: t('cloudflare.storage.msg.bucket_deleted'), tone: 'success' })
      if (bucketName === bucket.name) {
        setSelectedBucket(null)
        setObjects([])
        setPrefixes([])
      }
      await loadBuckets()
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    }
  }

  async function download(object: R2ObjectInfo): Promise<void> {
    if (!selectedBucket) return
    try {
      const file = await storageApi.downloadR2Object(account.id, selectedBucket.name, object.key)
      downloadBlob(file.filename, file.blob)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    }
  }

  async function deleteObject(object: R2ObjectInfo): Promise<void> {
    if (!selectedBucket) return
    const ok = await confirm({
      title: uiT('common.delete'),
      description: object.key,
      confirmLabel: t('cloudflare.storage.confirm_delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await storageApi.deleteR2Object(account.id, selectedBucket.name, object.key)
      toast({ title: t('cloudflare.storage.msg.deleted'), tone: 'success' })
      await loadObjects(prefix, null, false)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    }
  }

  async function deleteSelected(): Promise<void> {
    if (!selectedBucket || selection.size === 0) return
    const keys = [...selection]
    const ok = await confirm({
      title: uiT('common.delete'),
      description: keys.slice(0, 5).join(', ') + (keys.length > 5 ? '…' : ''),
      confirmLabel: t('cloudflare.storage.confirm_delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await storageApi.bulkDeleteR2Objects(account.id, selectedBucket.name, keys)
      toast({ title: t('cloudflare.storage.msg.deleted'), tone: 'success' })
      setSelection(new Set())
      await loadObjects(prefix, null, false)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    }
  }

  function toggleSelected(key: string): void {
    setSelection((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const prefixParts = prefix.split('/').filter(Boolean)

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 p-3 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] max-lg:max-h-[40vh]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
          <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {t('cloudflare.storage.bucket')}
          </h2>
          <Button
            size="sm"
            variant="primary"
            icon={<Plus size={14} />}
            disabled={readOnly}
            onClick={() => setCreateOpen(true)}
          >
            {t('cloudflare.storage.create')}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {bucketError && <div className="p-1.5"><StorageError message={bucketError} onRetry={() => { void loadBuckets() }} /></div>}
          {bucketLoading && buckets.length === 0 ? (
            <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-[var(--text-tertiary)]" /></div>
          ) : buckets.length === 0 ? (
            <Empty compact title={t('cloudflare.storage.no_bucket')} />
          ) : (
            <ul className="space-y-0.5">
              {buckets.map((bucket) => {
                const active = bucketName === bucket.name
                return (
                  <li
                    key={bucket.name}
                    className={cn(
                      'flex items-center gap-1 rounded-[var(--r-md)] px-1',
                      active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => setSelectedBucket(bucket)}
                      className="min-w-0 flex-1 truncate rounded-[var(--r-xs)] px-1.5 py-1.5 text-left text-[length:var(--text-12-5)] text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                    >
                      {bucket.name}
                    </button>
                    {!readOnly && (
                      <IconButton
                        label={uiT('common.delete')}
                        size="xs"
                        onClick={() => { void deleteBucket(bucket) }}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>

      <section className="flex min-h-0 flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
          <h2 className="min-w-0 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {bucketName ? `${t('cloudflare.storage.files')} - ${bucketName}` : t('cloudflare.storage.files')}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {selection.size > 0 && !readOnly && (
              <Button size="sm" variant="danger" onClick={() => { void deleteSelected() }}>
                {uiT('common.delete')} ({selection.size})
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={!selectedBucket || readOnly}
              onClick={() => setUploadOpen(true)}
            >
              {t('cloudflare.storage.upload')}
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1 text-[length:var(--text-12)]">
              <button
                type="button"
                onClick={() => navigate('')}
                className="rounded-[var(--r-xs)] text-[var(--accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              >
                {t('cloudflare.storage.root_dir')}
              </button>
              {prefixParts.map((part, index) => (
                <span key={`${part}-${index}`} className="flex items-center gap-1">
                  <span aria-hidden="true" className="text-[var(--text-quaternary)]">/</span>
                  <button
                    type="button"
                    onClick={() => navigate(`${prefixParts.slice(0, index + 1).join('/')}/`)}
                    className="rounded-[var(--r-xs)] text-[var(--accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  >
                    {part}
                  </button>
                </span>
              ))}
            </div>
            <Input
              value={prefixInput}
              onChange={(event) => setPrefixInput(event.target.value)}
              onKeyDown={(event) => {
                if (!isImeComposing(event) && event.key === 'Enter') {
                  event.preventDefault()
                  navigate(prefixInput.trim())
                }
              }}
              aria-label={t('cloudflare.storage.prefix_filter')}
              placeholder={t('cloudflare.storage.prefix_filter')}
              className="w-56 font-mono text-[length:var(--text-11-5)]"
            />
          </div>

          {objectError && <div className="mb-2"><StorageError message={objectError} onRetry={() => { void loadObjects(prefix, null, false) }} /></div>}

          <div className="min-h-0 flex-1 overflow-y-auto">
            <TableScroll label={t('cloudflare.storage.files')}>
              <Table>
                <THead>
                  <Tr>
                    <Th>{null}</Th>
                    <Th>{t('cloudflare.storage.name_label')}</Th>
                    <Th>{t('cloudflare.storage.column_type')}</Th>
                    <Th>{uiT('common.more_actions')}</Th>
                  </Tr>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <Tr key={row.kind === 'folder' ? `folder:${row.key}` : `file:${row.object.key}`}>
                      <Td className="w-8">
                        {row.kind === 'file' && !readOnly && (
                          <Checkbox
                            checked={selection.has(row.object.key)}
                            onChange={() => toggleSelected(row.object.key)}
                            label={<span className="sr-only">{row.object.key}</span>}
                          />
                        )}
                      </Td>
                      <Td>
                        {row.kind === 'folder' ? (
                          <button
                            type="button"
                            onClick={() => navigate(row.key)}
                            className="flex min-w-0 items-center gap-1.5 rounded-[var(--r-xs)] text-left text-[var(--accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                          >
                            <Folder size={13} className="shrink-0" />
                            <span className="truncate">{row.name}</span>
                          </button>
                        ) : (
                          <div className="min-w-0">
                            <p className="truncate text-[length:var(--text-12)] text-[var(--text-primary)]" title={row.object.key}>
                              {row.name}
                            </p>
                            <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                              {formatBytes(row.object.size)}
                              {row.object.last_modified ? ` · ${formatDateTime(Date.parse(row.object.last_modified))}` : ''}
                            </p>
                          </div>
                        )}
                      </Td>
                      <Td className="max-w-40 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]" title={row.kind === 'file' ? row.object.content_type : ''}>
                        {row.kind === 'file' ? row.object.content_type || '-' : '-'}
                      </Td>
                      <Td>
                        {row.kind === 'file' && (
                          <div className="flex flex-wrap items-center gap-1">
                            {previewKindFor(row.object.content_type, row.object.key) && (
                              <Button size="sm" variant="ghost" onClick={() => setPreviewObject(row.object)}>
                                {t('cloudflare.storage.preview')}
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => { void download(row.object) }}>
                              {t('cloudflare.storage.download')}
                            </Button>
                            {!readOnly && (
                              <Button size="sm" variant="ghost" onClick={() => { void deleteObject(row.object) }}>
                                {uiT('common.delete')}
                              </Button>
                            )}
                          </div>
                        )}
                      </Td>
                    </Tr>
                  ))}
                  {!rows.length && !objectLoading && (
                    <Tr>
                      <Td colSpan={4} className="py-6 text-center text-[var(--text-tertiary)]">
                        {t('cloudflare.compact_card.no_data')}
                      </Td>
                    </Tr>
                  )}
                </TBody>
              </Table>
            </TableScroll>
          </div>

          {cursor && (
            <div className="mt-3 flex justify-center">
              <Button size="sm" variant="secondary" loading={objectLoading} onClick={() => { void loadObjects(prefix, cursor, true) }}>
                {t('cloudflare.storage.load_more')}
              </Button>
            </div>
          )}
        </div>
      </section>

      <CreateNameDialog
        open={createOpen}
        title={t('cloudflare.storage.r2')}
        label={t('cloudflare.storage.name_label')}
        placeholder={t('cloudflare.storage.name_label')}
        submitLabel={t('cloudflare.storage.create')}
        onClose={() => setCreateOpen(false)}
        onSubmit={createBucket}
      />

      {selectedBucket && (
        <R2UploadDialog
          open={uploadOpen}
          accountId={account.id}
          bucket={selectedBucket.name}
          prefix={prefix}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            toast({ title: t('cloudflare.storage.msg.upload_success'), tone: 'success' })
            void loadObjects(prefix, null, false)
          }}
        />
      )}

      <R2PreviewDialog
        open={Boolean(previewObject)}
        accountId={account.id}
        bucket={selectedBucket?.name ?? ''}
        object={previewObject}
        onClose={() => setPreviewObject(null)}
      />
    </div>
  )
}
