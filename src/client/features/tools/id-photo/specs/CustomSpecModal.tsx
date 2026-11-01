import { useState } from 'react'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { Field, Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { createCustomSpec } from '../api'
import { useIdPhotoStore } from '../store'

const SPEC_MIN_MM = 10
const SPEC_MAX_MM = 400
const SPEC_MIN_DPI = 72
const SPEC_MAX_DPI = 1200
const SPEC_MAX_NAME = 50
const SPEC_MAX_KB = 20_480

export interface CustomSpecModalProps {
  open: boolean
  onClose: () => void
}

export function CustomSpecModal({ open, onClose }: CustomSpecModalProps) {
  const [name, setName] = useState('')
  const [widthMm, setWidthMm] = useState('35')
  const [heightMm, setHeightMm] = useState('45')
  const [dpi, setDpi] = useState('300')
  const [maxKb, setMaxKb] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const parseDimension = (raw: string) => {
    const value = Number(raw)
    if (!Number.isFinite(value) || value < SPEC_MIN_MM || value > SPEC_MAX_MM) return null
    return value
  }
  const parseDpi = (raw: string) => {
    const value = Number(raw)
    if (!Number.isInteger(value) || value < SPEC_MIN_DPI || value > SPEC_MAX_DPI) return null
    return value
  }
  // Empty means "no published ceiling", which is a different answer from an unreadable one.
  const parseMaxKb = (raw: string) => {
    if (!raw.trim()) return undefined
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1 || value > SPEC_MAX_KB) return null
    return value
  }
  const widthValue = parseDimension(widthMm)
  const heightValue = parseDimension(heightMm)
  const dpiValue = parseDpi(dpi)
  const maxKbValue = parseMaxKb(maxKb)
  const invalid =
    !name.trim() || widthValue === null || heightValue === null || dpiValue === null || maxKbValue === null

  const loadCustomSpecs = useIdPhotoStore((s) => s.loadCustomSpecs)
  const setSelectedSpecId = useIdPhotoStore((s) => s.setSelectedSpecId)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (invalid || widthValue === null || heightValue === null || dpiValue === null) return

    setSubmitting(true)
    try {
      const created = await createCustomSpec({
        name: name.trim().slice(0, SPEC_MAX_NAME),
        widthMm: widthValue,
        heightMm: heightValue,
        dpi: dpiValue,
        recommendedBgColors: ['#ffffff', '#438EDB'],
        category: 'custom',
        ...(maxKbValue ? { fileSizeMaxKb: maxKbValue } : {}),
      })

      await loadCustomSpecs()
      setSelectedSpecId(created.id)
      useUi.getState().toast({
        title: t('tools.id_photo.specs.created', { name: name.trim().slice(0, SPEC_MAX_NAME) }),
        tone: 'success',
      })
      onClose()
    } catch {
      useUi.getState().toast({
        title: t('tools.id_photo.export.save_error'),
        tone: 'danger',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('tools.id_photo.spec.add_custom')}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-4">
        <Field label={t('tools.id_photo.spec.add_custom')}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('tools.id_photo.common.custom_badge_placeholder')}
            required
            maxLength={SPEC_MAX_NAME}
            aria-invalid={name.trim() ? undefined : true}
            invalid={name.trim() ? undefined : true}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('tools.id_photo.common.width_mm')}>
            <Input
              type="number"
              step="0.5"
              min="10"
              max="200"
              value={widthMm}
              onChange={(e) => setWidthMm(e.target.value)}
              required
            />
          </Field>
          <Field
            label={t('tools.id_photo.common.height_mm')}
            hint={t('tools.id_photo.specs.dimension_hint', { min: SPEC_MIN_MM, max: SPEC_MAX_MM })}
          >
            <Input
              type="number"
              step="0.5"
              min="10"
              max="200"
              value={heightMm}
              onChange={(e) => setHeightMm(e.target.value)}
              required
            />
          </Field>
        </div>

        <Field
          label={t('tools.id_photo.unit.dpi')}
          hint={t('tools.id_photo.specs.dpi_hint', { min: SPEC_MIN_DPI, max: SPEC_MAX_DPI })}
        >
          <Input
            type="number"
            min="72"
            max="1200"
            value={dpi}
            onChange={(e) => setDpi(e.target.value)}
            required
          />
        </Field>

        <Field
          label={t('tools.id_photo.spec.size_limit')}
          hint={t('tools.id_photo.specs.kb_hint', { max: SPEC_MAX_KB })}
        >
          <Input
            type="number"
            min="1"
            max={String(SPEC_MAX_KB)}
            value={maxKb}
            onChange={(e) => setMaxKb(e.target.value)}
            placeholder={t('tools.id_photo.spec.size_unpublished')}
            aria-invalid={maxKbValue === null || undefined}
            invalid={maxKbValue === null || undefined}
          />
        </Field>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('tools.id_photo.common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={submitting || invalid}>
            {t('tools.id_photo.spec.add_custom')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
