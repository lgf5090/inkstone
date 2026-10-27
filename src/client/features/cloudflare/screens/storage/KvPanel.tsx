/**
 * KV: the namespace list on the left, the selected namespace's keys on the right.
 *
 * Keys are paged by the API's opaque cursor; the prefix filter is applied by Cloudflare rather than by
 * filtering loaded rows, because a namespace can hold far more keys than one page. The local selection
 * is only ever a set of the rows currently on screen, and it is cleared whenever that set is replaced.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import type { CloudflareAccount } from '@shared/cloudflare/model'
import { Checkbox } from '../../../../components/form'
import { Empty } from '../../../../components/feedback'
import { confirm } from '../../../../components/overlay'
import { Button, IconButton } from '../../../../components/primitives'
import { t as uiT } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { storageApi, type KvKey, type KvNamespace } from '../../api/storage'
import { SearchField } from '../../components/SearchField'
import { SortableHead, Table, TableScroll, TBody, Td, Th, THead, Tr } from '../../components/Table'
import { useCfT } from '../../i18n'
import { useSort } from '../../lib/sort'
import { formatDateTime } from '../../lib/format'
import { CreateNameDialog } from './CreateNameDialog'
import { KvValueDialog } from './KvValueDialog'
import { StorageError } from './StorageError'

export function KvPanel({ account }: { account: CloudflareAccount }) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const readOnly = account.is_demo

  const [namespaces, setNamespaces] = useState<KvNamespace[]>([])
  const [nsLoading, setNsLoading] = useState(true)
  const [nsError, setNsError] = useState<string | null>(null)
  const [selectedNs, setSelectedNs] = useState<KvNamespace | null>(null)

  const [keys, setKeys] = useState<KvKey[]>([])
  const [keysLoading, setKeysLoading] = useState(false)
  const [keysError, setKeysError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [prefix, setPrefix] = useState('')
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [createOpen, setCreateOpen] = useState(false)
  const [valueOpen, setValueOpen] = useState(false)
  const [editing, setEditing] = useState<{ key: string | null; value: string }>({ key: null, value: '' })

  const sort = useSort<KvKey>()
  const sortedKeys = useMemo(() => sort.sorted(keys), [sort, keys])
  const selectedId = selectedNs?.id ?? null

  const loadNamespaces = useCallback(async () => {
    setNsLoading(true)
    setNsError(null)
    try {
      const data = await storageApi.listKvNamespaces(account.id)
      setNamespaces(data.namespaces)
      setSelectedNs((current) => (
        current && data.namespaces.some((namespace) => namespace.id === current.id)
          ? current
          : data.namespaces[0] ?? null
      ))
    } catch (reason) {
      setNsError(cfErrorText(reason))
      setNamespaces([])
      setSelectedNs(null)
    } finally {
      setNsLoading(false)
    }
  }, [account.id])

  useEffect(() => {
    void loadNamespaces()
  }, [loadNamespaces])

  useEffect(() => {
    setKeys([])
    setCursor(null)
    setKeysError(null)
    setPrefix('')
    setSelection(new Set())
    if (!selectedId) return
    let cancelled = false
    setKeysLoading(true)
    void storageApi.listKvKeys(account.id, selectedId, { limit: 100 })
      .then((page) => {
        if (cancelled) return
        setKeys(page.keys)
        setCursor(page.cursor)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setKeysError(cfErrorText(reason))
      })
      .finally(() => {
        if (!cancelled) setKeysLoading(false)
      })
    return () => { cancelled = true }
  }, [account.id, selectedId])

  async function reloadKeys(prefixValue: string, append: boolean): Promise<void> {
    if (!selectedNs) return
    setKeysLoading(true)
    setKeysError(null)
    try {
      const page = await storageApi.listKvKeys(account.id, selectedNs.id, {
        ...(prefixValue ? { prefix: prefixValue } : {}),
        ...(append && cursor ? { cursor } : {}),
        limit: 100,
      })
      setKeys((current) => (append ? [...current, ...page.keys] : page.keys))
      setCursor(page.cursor)
      if (!append) setSelection(new Set())
    } catch (reason) {
      setKeysError(cfErrorText(reason))
    } finally {
      setKeysLoading(false)
    }
  }

  async function createNamespace(title: string): Promise<void> {
    await storageApi.createKvNamespace(account.id, title)
    toast({ title: t('cloudflare.storage.msg.namespace_created'), tone: 'success' })
    await loadNamespaces()
  }

  async function deleteNamespace(namespace: KvNamespace): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.storage.msg.delete_title'),
      description: t('cloudflare.storage.msg.delete_namespace_confirm', { name: namespace.title }),
      confirmLabel: t('cloudflare.storage.confirm_delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await storageApi.deleteKvNamespace(account.id, namespace.id)
      toast({ title: t('cloudflare.storage.msg.namespace_deleted'), tone: 'success' })
      if (selectedNs?.id === namespace.id) setSelectedNs(null)
      await loadNamespaces()
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    }
  }

  async function showValue(row: KvKey): Promise<void> {
    if (!selectedNs) return
    try {
      const data = await storageApi.getKvValue(account.id, selectedNs.id, row.name)
      setEditing({ key: row.name, value: data.value })
      setValueOpen(true)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    }
  }

  async function deleteKey(row: KvKey): Promise<void> {
    if (!selectedNs) return
    const ok = await confirm({
      title: uiT('common.delete'),
      description: row.name,
      confirmLabel: t('cloudflare.storage.confirm_delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await storageApi.deleteKvKey(account.id, selectedNs.id, row.name)
      toast({ title: t('cloudflare.storage.msg.deleted'), tone: 'success' })
      await reloadKeys(prefix, false)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    }
  }

  async function deleteSelected(): Promise<void> {
    if (!selectedNs || selection.size === 0) return
    const keysToDelete = [...selection]
    const ok = await confirm({
      title: uiT('common.delete'),
      description: keysToDelete.slice(0, 5).join(', ') + (keysToDelete.length > 5 ? '…' : ''),
      confirmLabel: t('cloudflare.storage.confirm_delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await storageApi.bulkDeleteKvKeys(account.id, selectedNs.id, keysToDelete)
      toast({ title: t('cloudflare.storage.msg.deleted'), tone: 'success' })
      setSelection(new Set())
      await reloadKeys(prefix, false)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    }
  }

  function toggleSelected(name: string): void {
    setSelection((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 p-3 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] max-lg:max-h-[40vh]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
          <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {t('cloudflare.storage.namespace')}
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
          {nsError && <div className="p-1.5"><StorageError message={nsError} onRetry={() => void loadNamespaces()} /></div>}
          {nsLoading && namespaces.length === 0 ? (
            <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-[var(--text-tertiary)]" /></div>
          ) : namespaces.length === 0 ? (
            <Empty compact title={t('cloudflare.storage.no_namespace')} />
          ) : (
            <ul className="space-y-0.5">
              {namespaces.map((namespace) => {
                const active = selectedNs?.id === namespace.id
                return (
                  <li
                    key={namespace.id}
                    className={cn(
                      'flex items-center gap-1 rounded-[var(--r-md)] px-1',
                      active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => setSelectedNs(namespace)}
                      className="min-w-0 flex-1 truncate rounded-[var(--r-xs)] px-1.5 py-1.5 text-left text-[length:var(--text-12-5)] text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                    >
                      {namespace.title}
                    </button>
                    {!readOnly && (
                      <IconButton
                        label={uiT('common.delete')}
                        size="xs"
                        onClick={() => { void deleteNamespace(namespace) }}
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
            {selectedNs ? selectedNs.title : t('cloudflare.storage.kv')}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <SearchField
              value={prefix}
              onChange={setPrefix}
              placeholder={t('cloudflare.storage.prefix_filter')}
              label={t('cloudflare.storage.prefix_filter')}
              className="w-48"
              onSubmit={() => { void reloadKeys(prefix, false) }}
            />
            {selection.size > 0 && !readOnly && (
              <Button size="sm" variant="danger" onClick={() => { void deleteSelected() }}>
                {uiT('common.delete')} ({selection.size})
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              icon={<Plus size={14} />}
              disabled={!selectedNs || readOnly}
              onClick={() => {
                setEditing({ key: null, value: '' })
                setValueOpen(true)
              }}
            >
              {t('cloudflare.storage.create')}
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {keysError && <div className="mb-2"><StorageError message={keysError} onRetry={() => { void reloadKeys(prefix, false) }} /></div>}
          <TableScroll label={t('cloudflare.storage.kv')}>
            <Table>
              <THead>
                <Tr>
                  <Th>{null}</Th>
                  <SortableHead
                    label={t('cloudflare.storage.name_label')}
                    sortKey="name"
                    sort={sort.state}
                    onToggle={sort.toggle}
                  />
                  <SortableHead
                    label={t('cloudflare.storage.ttl')}
                    sortKey="expiration"
                    sort={sort.state}
                    onToggle={sort.toggle}
                  />
                  <Th>{uiT('common.more_actions')}</Th>
                </Tr>
              </THead>
              <TBody>
                {sortedKeys.map((row) => (
                  <Tr key={row.name}>
                    <Td className="w-8">
                      <Checkbox
                        checked={selection.has(row.name)}
                        onChange={() => toggleSelected(row.name)}
                        label={<span className="sr-only">{row.name}</span>}
                      />
                    </Td>
                    <Td className="max-w-64 truncate font-mono text-[length:var(--text-12)]" title={row.name}>
                      {row.name}
                    </Td>
                    <Td className="whitespace-nowrap text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                      {row.expiration ? formatDateTime(row.expiration * 1000) : t('cloudflare.storage.never')}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1">
                        <Button size="sm" variant="ghost" onClick={() => { void showValue(row) }}>
                          {t('cloudflare.storage.view')}
                        </Button>
                        {!readOnly && (
                          <Button size="sm" variant="ghost" onClick={() => { void deleteKey(row) }}>
                            {uiT('common.delete')}
                          </Button>
                        )}
                      </div>
                    </Td>
                  </Tr>
                ))}
                {!sortedKeys.length && !keysLoading && (
                  <Tr>
                    <Td colSpan={4} className="py-6 text-center text-[var(--text-tertiary)]">
                      {t('cloudflare.compact_card.no_data')}
                    </Td>
                  </Tr>
                )}
              </TBody>
            </Table>
          </TableScroll>
          {keysLoading && sortedKeys.length > 0 && (
            <p className="mt-2 flex items-center gap-1.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
              <Loader2 size={12} className="animate-spin" />
              {uiT('common.loading')}
            </p>
          )}
          {cursor && (
            <div className="mt-3 flex justify-center">
              <Button size="sm" variant="secondary" loading={keysLoading} onClick={() => { void reloadKeys(prefix, true) }}>
                {t('cloudflare.storage.load_more')}
              </Button>
            </div>
          )}
        </div>
      </section>

      <CreateNameDialog
        open={createOpen}
        title={t('cloudflare.storage.kv_editor_title')}
        label={t('cloudflare.storage.name_label')}
        placeholder={t('cloudflare.storage.name_label')}
        submitLabel={t('cloudflare.storage.create')}
        onClose={() => setCreateOpen(false)}
        onSubmit={createNamespace}
      />

      {selectedNs && (
        <KvValueDialog
          open={valueOpen}
          accountId={account.id}
          namespaceId={selectedNs.id}
          editKey={editing.key}
          initialValue={editing.value}
          readOnly={readOnly}
          onClose={() => setValueOpen(false)}
          onSaved={() => { void reloadKeys(prefix, false) }}
        />
      )}
    </div>
  )
}
