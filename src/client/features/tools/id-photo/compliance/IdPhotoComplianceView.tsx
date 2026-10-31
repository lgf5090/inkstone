import { useMemo } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { useIdPhotoStore } from '../store'
import { specLabel } from '../spec-label'
import { checkIdPhotoCompliance } from '../engine/compliance-engine'

export function IdPhotoComplianceView() {
  const getActiveSpec = useIdPhotoStore((s) => s.getActiveSpec)
  const sourceSize = useIdPhotoStore((s) => s.sourceSize)
  const adjustOptions = useIdPhotoStore((s) => s.adjustOptions)
  const lastExport = useIdPhotoStore((s) => s.lastExport)
  const headBox = useIdPhotoStore((s) => s.headBox)

  const activeSpec = getActiveSpec()

  const report = useMemo(
    () =>
      checkIdPhotoCompliance({
        spec: activeSpec,
        actualWidthPx: activeSpec.widthPx,
        actualHeightPx: activeSpec.heightPx,
        sourceWidthPx: sourceSize?.width,
        sourceHeightPx: sourceSize?.height,
        fileSizeBytes: lastExport?.bytes,
        bgColorHex: adjustOptions.bgColor,
        faceBox: headBox
          ? {
              x: headBox.x * activeSpec.widthPx,
              y: headBox.y * activeSpec.heightPx,
              width: headBox.width * activeSpec.widthPx,
              height: headBox.height * activeSpec.heightPx,
            }
          : undefined,
      }),
    [activeSpec, sourceSize, adjustOptions.bgColor, lastExport, headBox],
  )

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto p-4 sm:p-6 max-w-4xl mx-auto gap-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]">
            <ShieldCheck size={22} />
          </div>
          <div>
            <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
              {t('tools.id_photo.compliance.title')}
            </h2>
            <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {activeSpec.flagEmoji && <span className="mr-1">{activeSpec.flagEmoji}</span>}
              {specLabel(activeSpec)} ({activeSpec.widthMm}×{activeSpec.heightMm} {t('tools.id_photo.unit.mm')})
            </p>
          </div>
        </div>

        <div
          className={cn(
            'flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold text-[length:var(--text-13)]',
            report.passed
              ? 'bg-[var(--success-soft)] text-[var(--success)]'
              : 'bg-[var(--warning-soft)] text-[var(--warning)]',
          )}
        >
          {report.passed ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          <span>
            {t('tools.id_photo.compliance.score_label')}: {report.score}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {report.checks.map((check) => {
          const isPass = check.level === 'pass'
          const isWarn = check.level === 'warning'
          const isUnknown = check.level === 'unknown'
          return (
            <div
              key={check.id}
              className={cn(
                'flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-[var(--r-md)] border p-3.5',
                'transition-[background-color] duration-[var(--dur-fast)]',
                isPass
                  ? 'border-[var(--border-subtle)] bg-[var(--success-soft)]'
                  : isWarn
                    ? 'border-[var(--border-subtle)] bg-[var(--warning-soft)]'
                    : isUnknown
                      ? 'border-[var(--border-subtle)] bg-[var(--bg-sunken)]'
                      : 'border-[var(--border-subtle)] bg-[var(--danger-soft)]',
              )}
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5">
                  {isPass ? (
                    <CheckCircle2 size={18} className="text-[var(--success)]" />
                  ) : isWarn ? (
                    <AlertTriangle size={18} className="text-[var(--warning)]" />
                  ) : isUnknown ? (
                    <CircleHelp size={18} className="text-[var(--text-tertiary)]" />
                  ) : (
                    <XCircle size={18} className="text-[var(--danger)]" />
                  )}
                </div>
                <div className="flex flex-col gap-0.5">
                  <h4 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
                    {t(check.titleKey)}
                  </h4>
                  <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
                    {isUnknown ? t('tools.id_photo.compliance.unknown') : check.message}
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

      {headBox && (
        <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('tools.id_photo.compliance.head_estimate')}
        </p>
      )}

      {!lastExport && (
        <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('tools.id_photo.compliance.export_hint')}
        </p>
      )}

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
