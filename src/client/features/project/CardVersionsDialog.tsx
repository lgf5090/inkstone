import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { ProjectCard, ProjectCardVersion, ProjectCardVersionDetail } from '@shared/project/model'
import { t, useLocale } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { LoadingBlock } from '../../components/feedback'
import { confirm, Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { fetchProjectCardVersion, fetchProjectCardVersions, restoreProjectCardVersion } from './api'

function formatSize(size: number): string {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`
}

export function CardVersionsDialog({ cardId, cardTitle, expectedUpdateAt, canEdit, onClose, onRestored }: {
  cardId: string
  cardTitle: string
  expectedUpdateAt: number
  canEdit: boolean
  onClose: () => void
  onRestored: (card: ProjectCard) => void
}) {
  const locale = useLocale()
  const toast = useUi((state) => state.toast)
  const [versions, setVersions] = useState<ProjectCardVersion[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ProjectCardVersionDetail | null>(null)
  const [error, setError] = useState(false)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setVersions(null)
    setError(false)
    fetchProjectCardVersions(cardId, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return
        setVersions(items)
        setSelectedId(items[0]?.id ?? null)
      })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [cardId])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    const controller = new AbortController()
    setDetail(null)
    setError(false)
    fetchProjectCardVersion(cardId, selectedId, controller.signal)
      .then(setDetail)
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [cardId, selectedId])

  const restore = async (): Promise<void> => {
    if (!selectedId || restoring) return
    const ok = await confirm({
      title: t('project.card.version_restore'),
      description: t('project.card.version_restore_confirm'),
      confirmLabel: t('common.restore'),
    })
    if (!ok) return
    setRestoring(true)
    try {
      const card = await restoreProjectCardVersion(cardId, selectedId, expectedUpdateAt)
      onRestored(card)
      setVersions(await fetchProjectCardVersions(cardId))
      toast({ title: t('project.card.version_restored'), tone: 'success' })
    } catch (cause: unknown) {
      toast({ title: t('common.restore_failed'), description: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('common.version_history')} description={cardTitle} width={760}>
      <div className="grid gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
        <div className="space-y-2">
          {versions === null
            ? <LoadingBlock />
            : versions.length === 0
              ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.card.versions_empty')}</p>
              : (
                  <ul className="max-h-[420px] space-y-1 overflow-y-auto">
                    {versions.map((version) => (
                      <li key={version.id}>
                        <button
                          type="button"
                          className={`w-full rounded-[var(--r-sm)] px-3 py-2 text-left ${selectedId === version.id ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-sunken)]'}`}
                          aria-pressed={selectedId === version.id}
                          onClick={() => setSelectedId(version.id)}
                        >
                          <span className="block truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{version.title || t('project.board.untitled_card')}</span>
                          <span className="block text-[length:var(--text-11)] text-[var(--text-tertiary)]">{new Date(version.createdAt).toLocaleString(locale)} · {formatSize(version.size)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
        </div>
        <div className="min-w-0 rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-3">
          {error
            ? <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{t('project.common.load_failed')}</p>
            : detail === null
              ? <LoadingBlock />
              : (
                  <div className="space-y-3">
                    <div>
                      <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{new Date(detail.createdAt).toLocaleString(locale)}</p>
                      <h3 className="truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{detail.snapshot.card.title || t('project.board.untitled_card')}</h3>
                      <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                        {t('project.card.version_values', { count: Object.keys(detail.snapshot.card.values).length })} · {t('project.card.version_contents', { count: detail.snapshot.contents.length })}
                      </p>
                    </div>
                    {detail.snapshot.contents.length > 0 && (
                      <ul className="max-h-[280px] space-y-1 overflow-y-auto">
                        {detail.snapshot.contents.map((content) => (
                          <li key={content.id} className="rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)]">
                            {content.title || t('project.card.content')}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
        {canEdit && (
          <Button variant="primary" icon={<RotateCcw size={13} />} disabled={!selectedId || detail === null || error || restoring} loading={restoring} onClick={() => void restore()}>
            {t('project.card.version_restore')}
          </Button>
        )}
      </div>
    </Modal>
  )
}
