import { useState } from 'react'
import { Modal } from '../../../components/overlay'
import { Button } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { t } from '../../../lib/i18n'
import { api } from '../../../lib/api'
import { downloadAsBlob } from '../../../lib/transfer'
import { parseOpdsFeed, type OpdsFeed } from '../engine/opds'

export function OpdsImportModal({ onClose, onImport }: { onClose: () => void; onImport: (files: File[]) => Promise<void> }) {
  const [url, setUrl] = useState('')
  const [feed, setFeed] = useState<OpdsFeed | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = async (next: string) => {
    setBusy(true)
    setError(null)
    try {
      const answer = await api.readerLibrary.opds(next)
      setFeed(parseOpdsFeed(answer.xml, next))
      setUrl(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const download = async (entry: { title: string; url: string; type: string }) => {
    setBusy(true)
    setError(null)
    try {
      const blob = await downloadAsBlob(api.readerLibrary.opdsDownloadUrl(entry.url))
      const extension = entry.type.includes('pdf') ? 'pdf' : entry.type.includes('cbz') ? 'cbz' : 'epub'
      const name = `${entry.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)}.${extension}`
      await onImport([new File([blob], name, { type: blob.type })])
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={t('reading.import_opds')} width={620}
      footer={<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>}>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex gap-2">
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://catalog.example/opds" aria-label={t('reading.opds_url')} />
          <Button onClick={() => void load(url)} disabled={busy || !url.trim()}>{busy ? t('common.loading') : t('reading.opds_load')}</Button>
        </div>
        {error ? <p role="alert" className="text-[var(--danger)]">{error}</p> : null}
        {feed ? (
          <div className="max-h-[50vh] overflow-y-auto" aria-busy={busy}>
            <h3 className="mb-2 font-semibold">{feed.title}</h3>
            <div className="mb-2 flex flex-wrap gap-2">
              {feed.navigation.map((entry) => <Button key={entry.url} variant="ghost" size="sm" onClick={() => void load(entry.url)}>{entry.title}</Button>)}
            </div>
            {feed.entries.length ? (
              <ul className="divide-y divide-[var(--border-subtle)]">
                {feed.entries.map((entry) => <li key={entry.url} className="flex items-center gap-2 py-2"><span className="min-w-0 flex-1 truncate">{entry.title}</span><Button size="sm" onClick={() => void download(entry)} disabled={busy}>{t('reading.import_opds')}</Button></li>)}
              </ul>
            ) : <p className="text-[var(--text-secondary)]">{t('reading.opds_empty')}</p>}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
