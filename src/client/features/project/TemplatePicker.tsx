import { useEffect, useState, type ReactElement } from 'react'
import { SquareKanban } from 'lucide-react'
import { t, useLocale } from '../../lib/i18n'
import { Modal } from '../../components/overlay'
import { Button } from '../../components/primitives'
import { LoadingBlock } from '../../components/feedback'
import { fetchProjectTemplates, type ProjectTemplateSummary } from './api'

export function TemplatePicker({ onClose, onPick }: { onClose: () => void, onPick: (templateId: string | null) => void }): ReactElement {
  const [templates, setTemplates] = useState<ProjectTemplateSummary[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const locale = useLocale()
  useEffect(() => {
    const controller = new AbortController()
    setFailed(false)
    fetchProjectTemplates(controller.signal, locale)
      .then(setTemplates)
      .catch(() => { if (!controller.signal.aborted) { setFailed(true); setTemplates([]) } })
    return () => controller.abort()
  }, [locale, attempt])
  return (
    <Modal open onClose={onClose} title={t('project.templates.title')} width={640}>
      {templates === null
        ? <LoadingBlock />
        : (
            <div className="space-y-3">
              {failed && (
                <div className="space-y-2">
                  <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{t('project.common.load_failed')}</p>
                  <Button size="sm" onClick={() => setAttempt((current) => current + 1)}>{t('project.common.retry')}</Button>
                </div>
              )}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              <button
                type="button"
                className="flex flex-col items-start gap-1 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                onClick={() => onPick(null)}
              >
                <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-[var(--r-sm)] bg-[var(--bg-sunken)]"><SquareKanban size={18} className="text-[var(--text-tertiary)]" /></span>
                <span className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{t('project.templates.blank')}</span>
                <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.templates.blank_description')}</span>
              </button>
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="flex flex-col items-start gap-1 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  onClick={() => onPick(template.id)}
                >
                  <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-[var(--r-sm)] bg-[var(--bg-sunken)] text-[length:var(--text-16)]">{template.icon}</span>
                  <span className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{template.title}</span>
                  <span className="line-clamp-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{template.description}</span>
                </button>
              ))}
              </div>
            </div>
          )}
    </Modal>
  )
}