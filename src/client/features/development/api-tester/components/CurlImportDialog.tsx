import { useEffect, useState } from 'react'
import { Code2 } from 'lucide-react'
import type { HttpRequestConfig } from '@shared/development/api-tester/types'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { Input, Textarea } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { parseCurl } from '../lib/curl-parser'

export function CurlImportDialog({
  open,
  onClose,
  onImport,
}: {
  open: boolean
  onClose: () => void
  onImport: (request: HttpRequestConfig, name: string) => void
}) {
  const [text, setText] = useState('')
  const [parsed, setParsed] = useState<HttpRequestConfig | null>(null)
  const [warnings, setWarnings] = useState<Array<{ code: string; flag?: string }>>([])
  const [name, setName] = useState('')

  useEffect(() => {
    if (!open) return
    setText('')
    setParsed(null)
    setWarnings([])
    setName('')
  }, [open])

  const parse = () => {
    const result = parseCurl(text)
    setParsed(result.request)
    setWarnings(result.warnings)
    try {
      const path = result.request.url ? new URL(result.request.url).pathname.split('/').pop() : ''
      setName(path || t('development.apitester.imported_name_placeholder'))
    } catch {
      setName(t('development.apitester.imported_name_placeholder'))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.apitester.curl_title')}
      description={t('development.apitester.curl_desc')}
      width={640}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={!parsed} onClick={() => { if (parsed) { onImport(parsed, name || t('development.apitester.imported_name_placeholder')); onClose() } }}>{t('development.apitester.import')}</Button>
        </>
      }
    >
      <div className="space-y-2">
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t('development.apitester.curl_placeholder')}
          aria-label={t('development.apitester.curl_placeholder')}
          className="min-h-[140px] resize-y font-mono text-[length:var(--text-11-5)]"
          spellCheck={false}
        />
        <Button size="sm" className="gap-1" disabled={!text.trim()} onClick={parse}>
          <Code2 size={13} /> {t('development.apitester.parse')}
        </Button>
        {warnings.length > 0 && (
          <div className="rounded-[var(--r-sm)] border border-[var(--warning)]/40 bg-[var(--warning-softer)] p-2 text-[length:var(--text-10-5)] text-[var(--warning)]">
            {warnings.map((warning, index) => <div key={index}>• {warning.flag ?? warning.code}</div>)}
          </div>
        )}
        {parsed && (
          <div className="space-y-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-2">
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono text-[length:var(--text-10)] font-semibold text-[var(--text-secondary)]">{parsed.method}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-11)] text-[var(--text-primary)]">{parsed.url}</span>
            </div>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('development.apitester.request_name')}
              aria-label={t('development.apitester.request_name')}
              className="h-7 text-[length:var(--text-11-5)]"
            />
            {parsed.headers.length > 0 && (
              <p className="text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                {t('development.apitester.imported_headers_count', { count: parsed.headers.length, type: parsed.bodyType })}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
