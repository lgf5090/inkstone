import { useEffect, useRef, useState } from 'react'
import type { ProjectGuestOpenResponse, ProjectProperty } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Input } from '../../components/form'
import { LoadingBlock } from '../../components/feedback'
import { Modal } from '../../components/overlay'
import { PropertyValueEditor } from './PropertyValueEditor'
import { openPublicGuestEdit, patchPublicGuestEdit } from './api'

export function GuestEditDialog({ slug, password, cardId, token, onClose }: {
  slug: string
  password?: string
  cardId: string
  token: string
  onClose: () => void
}) {
  const [opened, setOpened] = useState<ProjectGuestOpenResponse | null>(null)
  const [title, setTitle] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    openPublicGuestEdit(slug, cardId, token, password)
      .then((result) => {
        if (controller.signal.aborted) return
        setOpened(result)
        setTitle(result.card.title)
        setValues(result.card.values)
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => controller.abort()
  }, [slug, cardId, token, password])

  const save = async (): Promise<void> => {
    if (!opened || saving || saved) return
    if (!title.trim()) {
      setError(t('project.intake.title_required'))
      return
    }
    key.current ??= crypto.randomUUID()
    setSaving(true)
    setError(null)
    try {
      await patchPublicGuestEdit(slug, {
        cardId,
        token,
        expectedUpdateAt: opened.card.updateAt,
        title: title.trim(),
        values,
        ...(password ? { password } : {}),
      }, key.current)
      setSaved(true)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('project.guest.edit_title')} width={560}>
      {opened === null
        ? error
          ? <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>
          : <LoadingBlock />
        : saved
          ? <p role="status" className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{t('project.guest.saved')}</p>
          : (
              <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save() }}>
                <label className="block space-y-1">
                  <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('project.intake.card_title')}</span>
                  <Input className="w-full" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
                </label>
                {opened.properties.map((property) => (
                  <GuestField
                    key={property.id}
                    property={property}
                    value={values[property.id] ?? ''}
                    onChange={(value) => setValues((current) => ({ ...current, [property.id]: value }))}
                  />
                ))}
                {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={onClose}>{t('common.close')}</Button>
                  <Button type="submit" variant="primary" loading={saving} disabled={saving}>{t('common.save')}</Button>
                </div>
              </form>
            )}
    </Modal>
  )
}

function GuestField({ property, value, onChange }: { property: ProjectProperty, value: string, onChange: (value: string) => void }) {
  const textLike = property.type === 'text' || property.type === 'number' || property.type === 'url' || property.type === 'email' || property.type === 'phone'
  return (
    <div className="space-y-1">
      <span className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{property.name}</span>
      {textLike
        ? (
            <Input
              className="w-full"
              value={value}
              aria-label={property.name}
              inputMode={property.type === 'number' ? 'decimal' : property.type === 'email' ? 'email' : property.type === 'url' ? 'url' : property.type === 'phone' ? 'tel' : undefined}
              onChange={(event) => onChange(event.target.value)}
            />
          )
        : <PropertyValueEditor property={property} value={value} members={[]} people={{}} disabled={false} onChange={(next) => onChange(next ?? '')} />}
    </div>
  )
}
