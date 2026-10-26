import { useState } from 'react'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { Field, Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { createCustomSpec } from '../api'
import { useIdPhotoStore } from '../store'

export interface CustomSpecModalProps {
  open: boolean
  onClose: () => void
}

export function CustomSpecModal({ open, onClose }: CustomSpecModalProps) {
  const [name, setName] = useState('')
  const [widthMm, setWidthMm] = useState('35')
  const [heightMm, setHeightMm] = useState('45')
  const [dpi, setDpi] = useState('300')
  const [submitting, setSubmitting] = useState(false)

  const loadCustomSpecs = useIdPhotoStore((s) => s.loadCustomSpecs)
  const setSelectedSpecId = useIdPhotoStore((s) => s.setSelectedSpecId)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    setSubmitting(true)
    try {
      const created = await createCustomSpec({
        name: name.trim(),
        widthMm: parseFloat(widthMm) || 35,
        heightMm: parseFloat(heightMm) || 45,
        dpi: parseInt(dpi, 10) || 300,
        recommendedBgColors: ['#ffffff', '#438EDB'],
        category: 'custom',
      })

      await loadCustomSpecs()
      setSelectedSpecId(created.id)
      useUi.getState().toast({
        title: t('tools.id_photo.spec.add_custom'),
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
            autoFocus
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
          <Field label={t('tools.id_photo.common.height_mm')}>
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

        <Field label={t('tools.id_photo.unit.dpi')}>
          <Input
            type="number"
            min="72"
            max="1200"
            value={dpi}
            onChange={(e) => setDpi(e.target.value)}
            required
          />
        </Field>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('tools.id_photo.common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={submitting || !name.trim()}>
            {t('tools.id_photo.spec.add_custom')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
