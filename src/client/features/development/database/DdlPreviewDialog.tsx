import { Loader2 } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { useUi } from '../../../store/ui'
import { Button } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import type { DiagramDdlPlan } from './diagram-ddl'
import { DdlWarningList } from './DdlWarnings'

export interface DdlPreviewDialogProps {
  plan: DiagramDdlPlan | null
  remote: boolean
  executing: boolean
  onClose: () => void
  onExecute: () => void
}

export function DdlPreviewDialog({ plan, remote, executing, onClose, onExecute }: DdlPreviewDialogProps) {
  const open = plan !== null
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.database.diagram.save_title')}
      width={760}
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (!plan) return
              void copyText(plan.statements.join('\n')).then((ok) => useUi.getState().toast({
                title: ok ? t('development.database.common.copied') : t('development.database.common.copy_failed'),
                tone: ok ? 'success' : 'danger',
              }))
            }}
          >
            {t('development.database.common.copy')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={executing}>
            {t('development.database.common.cancel')}
          </Button>
          <Button size="sm" onClick={onExecute} disabled={executing || !plan || plan.statements.length === 0}>
            {executing ? <Loader2 size={13} className="animate-spin" /> : null}
            {t('development.database.diagram.execute')}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">
          {t('development.database.diagram.save_hint')}
        </p>
        {plan && <DdlWarningList warnings={plan.warnings} />}
        {remote && (
          <p role="status" className="rounded-[var(--r-md)] border border-[var(--warning)]/30 bg-[var(--warning-soft)] p-2 text-[length:var(--text-11)] leading-relaxed text-[var(--warning)]">
            {t('development.database.diagram.remote_warning')}
          </p>
        )}
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 font-mono text-[length:var(--text-11)] leading-relaxed">
          {plan?.statements.join('\n') || t('development.database.diagram.no_changes')}
        </pre>
      </div>
    </Modal>
  )
}