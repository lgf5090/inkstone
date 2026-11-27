import { AlertTriangle } from 'lucide-react'
import type { OutboxItem } from '../../lib/db'
import { t, useLocale } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'

export function ProjectConflictsDialog({ items, onDiscard, onClose }: {
  items: OutboxItem[]
  onDiscard: (item: OutboxItem) => void
  onClose: () => void
}) {
  const locale = useLocale()
  return (
    <Modal open onClose={onClose} title={t('project.offline.conflicts_title', { count: items.length })} width={620}>
      <div className="space-y-3">
        <p className="flex items-start gap-2 text-[length:var(--text-13)] text-[var(--text-secondary)]">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--danger)]" aria-hidden="true" />
          {t('project.offline.conflicts_description')}
        </p>
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={`${item.id}:${item.writeId}`} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="break-all font-mono text-[length:var(--text-12)] text-[var(--text-primary)]">{String(item.payload.path ?? item.entityId)}</p>
                  <p className="mt-1 text-[length:var(--text-12)] text-[var(--danger)]">{item.lastError ?? t('project.offline.conflict_unknown')}</p>
                  <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{new Date(item.createdAt).toLocaleString(locale)}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => onDiscard(item)}>{t('project.offline.conflict_discard')}</Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
