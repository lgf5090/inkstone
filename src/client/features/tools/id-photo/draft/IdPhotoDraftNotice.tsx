import { HardDrive, RotateCcw, Trash2 } from 'lucide-react'
import { t } from '../../../../lib/i18n'
import { Button } from '../../../../components/primitives'
import { useIdPhotoStore } from '../store'

function timeLabel(savedAt: number): string {
  return new Date(savedAt).toLocaleString()
}

export function IdPhotoDraftNotice() {
  const imageSrc = useIdPhotoStore((s) => s.imageSrc)
  const draftMeta = useIdPhotoStore((s) => s.draftMeta)
  const draftStatus = useIdPhotoStore((s) => s.draftStatus)
  const restoreDraft = useIdPhotoStore((s) => s.restoreDraft)
  const clearDraft = useIdPhotoStore((s) => s.clearDraft)
  const setImageSrc = useIdPhotoStore((s) => s.setImageSrc)

  if (!imageSrc && !draftMeta) return null

  const reason =
    draftStatus === 'too_large'
      ? t('tools.id_photo.draft.too_large')
      : draftStatus === 'failed'
        ? t('tools.id_photo.draft.failed')
        : null

  return (
    <section
      aria-label={t('tools.id_photo.draft.title')}
      data-draft-notice
      data-draft-status={draftStatus}
      className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3"
    >
      <div className="flex items-start gap-2">
        <HardDrive size={15} className="mt-0.5 shrink-0 text-[var(--accent)]" aria-hidden />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
            {imageSrc
              ? draftStatus === 'pending'
                ? t('tools.id_photo.draft.pending')
                : t('tools.id_photo.draft.saved')
              : t('tools.id_photo.draft.restorable')}
          </p>
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {draftMeta
              ? t('tools.id_photo.draft.saved_at', { time: timeLabel(draftMeta.savedAt) })
              : t('tools.id_photo.draft.never')}
            {' · '}
            {t('tools.id_photo.draft.local_only')}
          </p>
          {reason && (
            <p data-draft-reason className="text-[length:var(--text-11)] text-[var(--warning)]">
              {reason}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {!imageSrc && draftMeta && (
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              if (!(await restoreDraft())) setImageSrc(null)
            }}
          >
            <RotateCcw size={12} className="mr-1" aria-hidden />
            <span>{t('tools.id_photo.draft.restore')}</span>
          </Button>
        )}
        {draftMeta && (
          <Button size="sm" variant="ghost" onClick={() => void clearDraft()}>
            <Trash2 size={12} className="mr-1" aria-hidden />
            <span>{t('tools.id_photo.draft.clear')}</span>
          </Button>
        )}
      </div>
    </section>
  )
}
