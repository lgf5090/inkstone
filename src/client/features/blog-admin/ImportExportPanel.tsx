import { useRef, useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { Button } from '../../components/primitives'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { AdminCard, PageHeader } from './shared'

export function ImportExportPanel() {
  const toast = useUi((state) => state.toast)
  const inputRef = useRef<HTMLInputElement>(null)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [report, setReport] = useState('')

  const exportData = async () => {
    setExporting(true)
    try {
      const data = await api.blog.tools.exportData()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `inkstone-blog-export-${new Date().toISOString().slice(0, 10)}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      toast({ title: t('blog.admin.export_done'), tone: 'success' })
    } catch (error) {
      toast({ title: t('blog.admin.export_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setExporting(false)
    }
  }

  const importData = async (file: File) => {
    const ok = await confirm({
      title: t('blog.admin.import_title'),
      description: t('blog.admin.import_desc'),
      confirmLabel: t('blog.admin.import_action'),
      tone: 'danger',
    })
    if (!ok) return
    setImporting(true)
    setReport('')
    try {
      const text = await file.text()
      if (text.length > 4 * 1024 * 1024) throw new Error(t('blog.admin.import_too_large'))
      const parsed = JSON.parse(text) as Record<string, unknown>
      const result = await api.blog.tools.importData(parsed)
      const message = t('blog.admin.import_report', { settings: result.settings, redirects: result.redirects })
      setReport(message)
      toast({ title: t('blog.admin.import_done'), description: message, tone: 'success' })
    } catch (error) {
      toast({ title: t('blog.admin.import_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setImporting(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="mx-auto max-w-[860px]">
      <PageHeader title={t('blog.admin.import_export')} description={t('blog.admin.import_export_subtitle')} />
      <div className="grid gap-4 md:grid-cols-2">
        <AdminCard className="p-4">
          <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('blog.admin.export')}</h2>
          <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('blog.admin.export_hint')}</p>
          <Button size="sm" icon={<Download size={13} />} loading={exporting} onClick={() => void exportData()} className="mt-3">{t('blog.admin.export_json')}</Button>
        </AdminCard>
        <AdminCard className="p-4">
          <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('blog.admin.import')}</h2>
          <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('blog.admin.import_hint')}</p>
          <input ref={inputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importData(file) }} />
          <Button size="sm" icon={<Upload size={13} />} loading={importing} onClick={() => inputRef.current?.click()} className="mt-3">{t('blog.admin.import_json')}</Button>
          {report && <p role="status" className="mt-2 text-[length:var(--text-11-5)] text-[var(--success)]">{report}</p>}
        </AdminCard>
      </div>
      <AdminCard className="mt-4 p-4">
        <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('blog.admin.import_scope')}</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          <li>{t('blog.admin.import_scope_settings')}</li>
          <li>{t('blog.admin.import_scope_redirects')}</li>
          <li>{t('blog.admin.import_scope_posts')}</li>
        </ul>
      </AdminCard>
    </div>
  )
}
