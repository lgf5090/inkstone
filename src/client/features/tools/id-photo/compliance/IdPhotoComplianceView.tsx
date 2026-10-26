import { useMemo } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { useIdPhotoStore } from '../store'
import { checkIdPhotoCompliance } from '../engine/compliance-engine'

export function IdPhotoComplianceView() {
  const getActiveSpec = useIdPhotoStore((s) => s.getActiveSpec)
  const imageElement = useIdPhotoStore((s) => s.imageElement)
  const adjustOptions = useIdPhotoStore((s) => s.adjustOptions)

  const activeSpec = getActiveSpec()

  const report = useMemo(() => {
    return checkIdPhotoCompliance({
      spec: activeSpec,
      actualWidthPx: activeSpec.widthPx,
      actualHeightPx: activeSpec.heightPx,
      faceBox: imageElement
        ? {
            x: Math.round(activeSpec.widthPx * 0.2),
            y: Math.round(activeSpec.heightPx * 0.15),
            width: Math.round(activeSpec.widthPx * 0.6),
            height: Math.round(activeSpec.heightPx * 0.6),
          }
        : undefined,
      bgColorHex: adjustOptions.bgColor,
    })
  }, [activeSpec, imageElement, adjustOptions])

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto p-4 sm:p-6 max-w-4xl mx-auto gap-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent)]">
            <ShieldCheck size={22} />
          </div>
          <div>
            <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
              {t('tools.id_photo.compliance.title')}
            </h2>
            <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {activeSpec.flagEmoji && <span className="mr-1">{activeSpec.flagEmoji}</span>}
              {activeSpec.nameKey ? t(activeSpec.nameKey as any) : activeSpec.name} ({activeSpec.widthMm}×{activeSpec.heightMm} {t('tools.id_photo.unit.mm')})
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold text-[length:var(--text-13)]',
              report.passed
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
            )}
          >
            {report.passed ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            <span>
              {t('tools.id_photo.compliance.score_label')}: {report.score}
            </span>
          </div>
        </div>
      </div>

      {/* Checks Grid */}
      <div className="flex flex-col gap-3">
        {report.checks.map((check) => {
          const isPass = check.level === 'pass'
          const isWarn = check.level === 'warning'
          return (
            <div
              key={check.id}
              className={cn(
                'flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-[var(--r-md)] border p-3.5',
                'transition-[background-color] duration-[var(--dur-fast)]',
                isPass
                  ? 'border-emerald-500/20 bg-emerald-500/5'
                  : isWarn
                    ? 'border-amber-500/20 bg-amber-500/5'
                    : 'border-rose-500/20 bg-rose-500/5',
              )}
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5">
                  {isPass ? (
                    <CheckCircle2 size={18} className="text-emerald-500" />
                  ) : isWarn ? (
                    <AlertTriangle size={18} className="text-amber-500" />
                  ) : (
                    <XCircle size={18} className="text-rose-500" />
                  )}
                </div>
                <div className="flex flex-col gap-0.5">
                  <h4 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
                    {t(check.titleKey as any)}
                  </h4>
                  <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
                    {check.message}
                  </p>
                </div>
              </div>

              {(check.currentValue || check.expectedValue) && (
                <div className="flex sm:flex-col items-end gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {check.expectedValue && (
                    <span>{t('tools.id_photo.common.standard')}: {check.expectedValue}</span>
                  )}
                  {check.currentValue && (
                    <span className="font-mono text-[var(--text-secondary)]">
                      {t('tools.id_photo.common.current')}: {check.currentValue}
                    </span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Suggestions Card */}
      <div className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
        <h4 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('tools.id_photo.compliance.tip_title')}
        </h4>
        <ul className="list-disc list-inside space-y-1 text-[length:var(--text-12)] text-[var(--text-secondary)]">
          <li>{t('tools.id_photo.compliance.tip_1')}</li>
          <li>{t('tools.id_photo.compliance.tip_2')}</li>
          <li>{t('tools.id_photo.compliance.tip_3')}</li>
        </ul>
      </div>
    </div>
  )
}
