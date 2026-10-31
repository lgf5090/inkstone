import { useState } from 'react'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { FIELD_BASE } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { useUiStore } from '../../../../lib/ui-store'
import { useShortlinksStore } from '../store'
import { shortlinksApi } from '../api'

export function ImportModal() {
  const open = useShortlinksStore((s) => s.importModalOpen)
  const setOpen = useShortlinksStore((s) => s.setImportModalOpen)
  const fetchLinks = useShortlinksStore((s) => s.fetchLinks)
  const fetchDashboard = useShortlinksStore((s) => s.fetchDashboard)

  const [format, setFormat] = useState<'csv' | 'txt'>('csv')
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleClose = () => {
    setContent('')
    setOpen(false)
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const res = event.target?.result
      if (typeof res === 'string') {
        setContent(res)
      }
    }
    reader.readAsText(file)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = content.trim()
    if (!trimmed) return

    setSubmitting(true)
    try {
      const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean)
      const items: Array<{ url: string; slug?: string; label?: string }> = []
      for (const line of lines) {
        if (format === 'csv') {
          const parts = line.split(',').map((p) => p.trim())
          if (parts[0] && (parts[0].startsWith('http://') || parts[0].startsWith('https://'))) {
            items.push({
              url: parts[0],
              slug: parts[1] || undefined,
              label: parts[2] || undefined,
            })
          }
        } else {
          if (line.startsWith('http://') || line.startsWith('https://')) {
            items.push({ url: line })
          }
        }
      }
      if (items.length === 0) {
        throw new Error(t('tools.shortlinks.modal.import_no_urls'))
      }
      const res = await shortlinksApi.importData({ items })
      useUiStore.getState().toast(
        t('tools.shortlinks.modal.import_result', { count: res.imported }),
        'success',
      )
      handleClose()
      void fetchLinks()
      void fetchDashboard()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      dismissible={!submitting}
      onClose={handleClose}
      title={t('tools.shortlinks.modal.import_title')}
      width={520}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={handleClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={submitting || !content.trim()}
          >
            {t('tools.shortlinks.modal.import_submit')}
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4 py-2">
        <div>
          <label className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1">
            {t('tools.shortlinks.modal.import_type')}
          </label>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-[length:var(--text-13)] cursor-pointer">
              <input
                type="radio"
                name="import_format"
                value="csv"
                checked={format === 'csv'}
                onChange={() => setFormat('csv')}
                className="accent-[var(--accent)]"
              />
              <span>{t('tools.shortlinks.modal.import_csv_label')}</span>
            </label>
            <label className="flex items-center gap-1.5 text-[length:var(--text-13)] cursor-pointer">
              <input
                type="radio"
                name="import_format"
                value="txt"
                checked={format === 'txt'}
                onChange={() => setFormat('txt')}
                className="accent-[var(--accent)]"
              />
              <span>{t('tools.shortlinks.modal.import_txt_label')}</span>
            </label>
          </div>
        </div>

        <div>
          <label className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1">
            {t('tools.shortlinks.modal.import_content')}
          </label>
          <input
            type="file"
            accept={format === 'csv' ? '.csv,text/csv' : '.txt,text/plain'}
            onChange={handleFileUpload}
            className="mb-2 block w-full text-[length:var(--text-12)] text-[var(--text-secondary)] file:mr-3 file:py-1 file:px-2.5 file:rounded file:border-0 file:text-[length:var(--text-12)] file:font-medium file:bg-[var(--bg-sunken)] file:text-[var(--text-primary)] hover:file:bg-[var(--bg-hover)] cursor-pointer"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            placeholder={
              format === 'csv'
                ? 'url,custom_slug,label\nhttps://example.com/docs,docs,Documentation\nhttps://example.com/pricing,,Pricing'
                : 'https://example.com/one\nhttps://example.com/two'
            }
            className={`${FIELD_BASE} font-mono text-[length:var(--text-12)] py-2`}
          />
        </div>
      </form>
    </Modal>
  )
}
