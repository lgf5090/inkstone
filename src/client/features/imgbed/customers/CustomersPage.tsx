import { useEffect, useState, type ReactElement } from 'react'
import { Eye } from 'lucide-react'
import { Button, Badge, IconButton } from '../../../components/primitives'
import { Switch } from '../../../components/form'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { Modal } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { imgbedApi, imgbedQuery } from '../api'
import type { ImgbedFile } from '@shared/imgbed/model'
import { imgbedChannelDisplayName } from '@shared/imgbed/model'

interface Customer {
  ip: string
  address: string
  count: number
  lastUploadAt: number
  blocked: boolean
}

export function CustomersPage(): ReactElement {
  const [rows, setRows] = useState<Customer[] | null>(null)
  const [error, setError] = useState('')
  const [files, setFiles] = useState<{ ip: string; files: ImgbedFile[] } | null>(null)
  const load = (): void => {
    setError('')
    imgbedApi<{ customers: Customer[] }>('/api/imgbed/manage/customers?count=200')
      .then((result) => setRows(result.customers))
      .catch((reason: Error) => setError(reason.message))
  }
  useEffect(load, [])
  const toggle = async (row: Customer, blocked: boolean): Promise<void> => {
    try {
      if (blocked) await imgbedApi('/api/imgbed/manage/customers/blocked-ips', { method: 'POST', body: { ip: row.ip } })
      else await imgbedApi(`/api/imgbed/manage/customers/blocked-ips${imgbedQuery({ ip: row.ip })}`, { method: 'DELETE' })
      load()
    } catch { load() }
  }
  const openFiles = async (ip: string): Promise<void> => {
    const result = await imgbedApi<{ files: ImgbedFile[] }>(`/api/imgbed/manage/customers/files${imgbedQuery({ ip, count: 200 })}`)
    setFiles({ ip, files: result.files })
  }
  if (error) return <Empty art="search" title={error} action={<Button onClick={load}>{t('imgbed.common.retry')}</Button>} />
  if (!rows) return <LoadingBlock label={t('imgbed.common.loading')} />
  return (
    <div className="p-3 md:p-5">
      <h2 className="mb-3 text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('imgbed.customers.title')}</h2>
      {!rows.length ? <Empty art="search" title={t('imgbed.customers.empty')} /> : (
        <div className="overflow-x-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
          <table className="w-full min-w-[520px] text-left text-[length:var(--text-11-5)]">
            <thead className="bg-[var(--bg-sunken)] text-[var(--text-quaternary)]">
              <tr><th className="p-2">{t('imgbed.customers.ip')}</th><th className="p-2">{t('imgbed.customers.address')}</th><th className="p-2">{t('imgbed.customers.count')}</th><th className="p-2">{t('imgbed.customers.last' as never)}</th><th className="p-2">{t('imgbed.customers.blocked')}</th><th className="p-2" /></tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {rows.map((row) => (
                <tr key={row.ip}>
                  <td className="p-2 font-mono text-[var(--text-primary)]">{row.ip}</td>
                  <td className="p-2 text-[var(--text-secondary)]">{row.address || '—'}</td>
                  <td className="p-2 text-[var(--text-secondary)]">{row.count}</td>
                  <td className="p-2 text-[var(--text-quaternary)]">{new Date(row.lastUploadAt).toLocaleString()}</td>
                  <td className="p-2"><Switch checked={row.blocked} onChange={(next) => void toggle(row, next)} label={row.blocked ? t('imgbed.customers.blocked') : t('imgbed.customers.allowed')} /></td>
                  <td className="p-2 text-right"><IconButton label={t('imgbed.library.files')} onClick={() => void openFiles(row.ip)}><Eye size={13} /></IconButton></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={Boolean(files)} onClose={() => setFiles(null)} title={files?.ip ?? ''} width={640}>
        {files && (
          <ul className="max-h-[60vh] divide-y divide-[var(--border-subtle)] overflow-auto">
            {files.files.map((file) => <li key={file.id} className="flex items-center gap-2 py-2"><span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{file.fileName}</span><Badge tone="neutral">{imgbedChannelDisplayName(file.channelName)}</Badge></li>)}
            {!files.files.length && <li className="py-4 text-center text-[var(--text-tertiary)]">{t('imgbed.customers.empty')}</li>}
          </ul>
        )}
      </Modal>
    </div>
  )
}
