import { useEffect, useRef, useState } from 'react'
import { Check, Plus, X } from 'lucide-react'
import { BUILTIN_ID_PHOTO_SPECS } from '@shared/tools/id-photo/specs'
import type { IdPhotoSpec } from '@shared/tools/id-photo/types'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { Input } from '../../../../components/form'
import { Button, IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { useIdPhotoStore } from '../store'
import { specLabel } from '../spec-label'
import { filterSpecs } from '../specs/filter-specs'
import { IdPhotoEngine } from '../engine/id-photo-engine'
import { compareSize, defaultCompareIds, MAX_COMPARE, MIN_COMPARE } from './compare-model'

const PICKER_LIMIT = 12

interface CardProps {
  spec: IdPhotoSpec
  isMain: boolean
  removable: boolean
}

function CompareCard({ spec, isMain, removable }: CardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const generation = useRef(0)
  const [failed, setFailed] = useState(false)
  const imageElement = useIdPhotoStore((s) => s.imageElement)
  const adjustOptions = useIdPhotoStore((s) => s.adjustOptions)
  const setSelectedSpecId = useIdPhotoStore((s) => s.setSelectedSpecId)
  const toggleCompareSpec = useIdPhotoStore((s) => s.toggleCompareSpec)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !imageElement) return
    const run = ++generation.current
    const size = compareSize(spec)
    setFailed(false)
    new IdPhotoEngine(spec, adjustOptions)
      .renderCanvas(imageElement, size.width, size.height)
      .then((rendered) => {
        if (run !== generation.current) return
        canvas.width = rendered.width
        canvas.height = rendered.height
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(rendered, 0, 0)
      })
      .catch(() => {
        if (run !== generation.current) return
        setFailed(true)
      })
    return () => {
      generation.current += 1
    }
  }, [spec, imageElement, adjustOptions])

  const physical = `${spec.widthMm}×${spec.heightMm}${t('tools.id_photo.unit.mm')}`

  return (
    <li
      data-compare-card={spec.id}
      className={cn(
        'flex flex-col gap-2 rounded-[var(--r-md)] border p-3',
        isMain
          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
          : 'border-[var(--border-subtle)] bg-[var(--bg-sunken)]',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {spec.flagEmoji && <span className="mr-1">{spec.flagEmoji}</span>}
            {specLabel(spec)}
          </h3>
          <p className="font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {physical} · {spec.widthPx}×{spec.heightPx}{t('tools.id_photo.unit.px')}
          </p>
        </div>
        {isMain && (
          <span className="flex items-center gap-1 text-[length:var(--text-11)] font-medium text-[var(--accent-on-soft)]">
            <Check size={12} aria-hidden />
            {t('tools.id_photo.compare.main')}
          </span>
        )}
      </div>

      <div className="relative flex min-h-[120px] items-center justify-center">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={specLabel(spec)}
          className="max-h-[220px] w-auto max-w-full rounded-[var(--r-sm)] bg-[var(--bg-base)] shadow-[var(--shadow-pop)]"
        />
        {failed && (
          <p className="absolute inset-0 flex items-center justify-center text-center text-[length:var(--text-11)] text-[var(--danger)]">
            {t('tools.id_photo.preview.render_failed')}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {!isMain && (
            <Button size="sm" variant="ghost" onClick={() => setSelectedSpecId(spec.id)}>
              <span>{t('tools.id_photo.compare.use_as_main')}</span>
            </Button>
          )}
        </div>
        {removable && (
          <Tooltip label={t('tools.id_photo.compare.remove')}>
            <IconButton
              size="sm"
              label={t('tools.id_photo.compare.remove')}
              onClick={() => toggleCompareSpec(spec.id)}
            >
              <X size={14} />
            </IconButton>
          </Tooltip>
        )}
      </div>
    </li>
  )
}

export function IdPhotoCompareView() {
  const imageSrc = useIdPhotoStore((s) => s.imageSrc)
  const selectedSpecId = useIdPhotoStore((s) => s.selectedSpecId)
  const customSpecs = useIdPhotoStore((s) => s.customSpecs)
  const compareSpecIds = useIdPhotoStore((s) => s.compareSpecIds)
  const toggleCompareSpec = useIdPhotoStore((s) => s.toggleCompareSpec)
  const resetCompareSpecs = useIdPhotoStore((s) => s.resetCompareSpecs)
  const [search, setSearch] = useState('')

  const catalogue = [...customSpecs, ...BUILTIN_ID_PHOTO_SPECS]
  const ids = compareSpecIds ?? defaultCompareIds(selectedSpecId, catalogue)
  const shown = ids
    .map((id) => catalogue.find((spec) => spec.id === id))
    .filter((spec): spec is IdPhotoSpec => Boolean(spec))
  const removable = shown.length > MIN_COMPARE

  const matches = filterSpecs(catalogue, search, 'all', specLabel)
    .filter((spec) => !ids.includes(spec.id))
    .slice(0, PICKER_LIMIT)

  const full = ids.length >= MAX_COMPARE

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
          {t('tools.id_photo.compare.title')}
        </h2>
        <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('tools.id_photo.compare.desc')}
        </p>
      </header>

      {!imageSrc ? (
        <p className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('tools.id_photo.compare.need_photo')}
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {t('tools.id_photo.compare.count', { count: shown.length, max: MAX_COMPARE })}
            </span>
            {compareSpecIds && (
              <Button size="sm" variant="ghost" onClick={resetCompareSpecs}>
                <span>{t('tools.id_photo.compare.reset')}</span>
              </Button>
            )}
          </div>

          <ul className="grid list-none grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {shown.map((spec) => (
              <CompareCard
                key={spec.id}
                spec={spec}
                isMain={spec.id === selectedSpecId}
                removable={removable}
              />
            ))}
          </ul>

          <section className="flex flex-col gap-2" aria-label={t('tools.id_photo.compare.pick_title')}>
            <div className="flex items-center gap-2">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('tools.id_photo.spec.search_placeholder')}
                aria-label={t('tools.id_photo.compare.pick_title')}
                className="max-w-[280px] flex-1"
              />
              <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {full ? t('tools.id_photo.compare.max') : t('tools.id_photo.compare.min_hint')}
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              {matches.map((spec) => (
                <button
                  key={spec.id}
                  type="button"
                  disabled={full}
                  onClick={() => toggleCompareSpec(spec.id)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[length:var(--text-12)]',
                    'transition-[background-color,color] duration-[var(--dur-fast)]',
                    'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                >
                  <Plus size={12} aria-hidden />
                  <span>{specLabel(spec)}</span>
                  <span className="font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                    {spec.widthMm}×{spec.heightMm}
                  </span>
                </button>
              ))}
              {matches.length === 0 && (
                <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                  {t('tools.id_photo.spec.no_results')}
                </p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
