import { useState } from 'react'
import { ChevronDown, ChevronRight, Sparkles, Wand2 } from 'lucide-react'
import type { MockLanguage } from '@shared/development/api-tester/keywords'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { Textarea } from '../../../../components/form'
import { CopyButton } from '../../../../components/copy-button'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { exampleTemplate, generateMockJson, TYPE_DOCS } from '../lib/mock-generator'

export function MockGeneratorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [language, setLanguage] = useState<MockLanguage>('zh')
  const [template, setTemplate] = useState(() => exampleTemplate('zh'))
  const [result, setResult] = useState('')
  const [showTypes, setShowTypes] = useState(false)

  const generate = () => {
    try {
      setResult(generateMockJson(template, language))
    } catch (error) {
      setResult(t('development.apitester.generate_failed', { msg: error instanceof Error ? error.message : String(error) }))
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('development.apitester.mock_title')} description={t('development.apitester.mock_desc')} width={860}>
      <div className="flex min-h-[420px] flex-col gap-3 sm:flex-row">
        <div className="flex min-h-[240px] min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 pb-2">
            <div className="inline-flex overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-subtle)]">
              {(['zh', 'en'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setLanguage(value)}
                  className={cn(
                    'px-2 py-1 text-[length:var(--text-11)]',
                    language === value ? 'bg-[var(--accent)] text-[var(--accent-contrast)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                  )}
                >
                  {value === 'zh' ? t('development.apitester.mock_zh') : t('development.apitester.mock_en')}
                </button>
              ))}
            </div>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" className="gap-1" onClick={() => { setTemplate(exampleTemplate(language)); setResult('') }}>
              <Wand2 size={13} /> {t('development.apitester.example')}
            </Button>
            <Button size="sm" className="gap-1" onClick={generate}>
              <Sparkles size={13} /> {t('development.apitester.generate')}
            </Button>
          </div>
          <Textarea
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            aria-label={t('development.apitester.mock_title')}
            className="min-h-[200px] flex-1 resize-y font-mono text-[length:var(--text-11)]"
            spellCheck={false}
          />
          <div className="pt-1">
            <button type="button" className="flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" onClick={() => setShowTypes((value) => !value)}>
              {showTypes ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {t('development.apitester.supported_types', { count: TYPE_DOCS.length })}
            </button>
            {showTypes && (
              <div className="mt-1 max-h-32 overflow-y-auto overscroll-contain rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-1">
                {TYPE_DOCS.map((doc) => (
                  <div key={doc.type} className="flex items-baseline gap-2 px-1 py-0.5 text-[length:var(--text-10)]">
                    <code className="shrink-0 rounded bg-[var(--bg-inset)] px-1 font-mono text-[var(--accent)]">{doc.type}</code>
                    <span className="min-w-0 flex-1 truncate text-[var(--text-tertiary)]">{doc.example}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 pb-2">
            <span className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('development.apitester.generate_result')}</span>
            <div className="flex-1" />
            {result && <CopyButton text={result} label={t('development.apitester.common.copy')} toastMessage={t('development.apitester.copied_to_clipboard')} />}
          </div>
          <div className="min-h-[200px] flex-1 overflow-y-auto rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-2">
            {result ? (
              <pre className="whitespace-pre-wrap break-all font-mono text-[length:var(--text-11)]">{result}</pre>
            ) : (
              <div className="flex h-full items-center justify-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.apitester.generate_hint')}</div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
