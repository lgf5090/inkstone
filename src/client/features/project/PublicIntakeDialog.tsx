import { useRef, useState } from 'react'
import type { ProjectBoardBundle, ProjectProperty } from '@shared/project/model'
import { PROJECT_INTAKE_PROPERTY_TYPES } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Input } from '../../components/form'
import { Modal } from '../../components/overlay'
import { PropertyValueEditor } from './PropertyValueEditor'
import { submitPublicProjectIntake } from './api'

export function PublicIntakeDialog({ slug, password, bundle, onClose }: {
  slug: string
  password?: string
  bundle: ProjectBoardBundle
  onClose: () => void
}) {
  const config = bundle.intake
  const [title, setTitle] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [editLink, setEditLink] = useState('')
  const [copied, setCopied] = useState(false)
  const key = useRef<string | null>(null)
  if (!config?.enabled) return <></>
  const allowed = new Set(config.propertyIds)
  const fields = bundle.properties.filter((property) => allowed.has(property.id) && PROJECT_INTAKE_PROPERTY_TYPES.includes(property.type))
  const required = new Set(config.requiredPropertyIds)

  const submit = async (): Promise<void> => {
    if (submitting || createdId) return
    if (!title.trim()) {
      setError(t('project.intake.title_required'))
      return
    }
    const missing = fields.find((property) => required.has(property.id) && !(values[property.id] ?? '').trim())
    if (missing) {
      setError(t('project.intake.field_required', { field: missing.name }))
      return
    }
    key.current ??= crypto.randomUUID()
    setSubmitting(true)
    setError(null)
    try {
      const result = await submitPublicProjectIntake(slug, { title: title.trim(), values, ...(password ? { password } : {}) }, key.current)
      setCreatedId(result.cardId)
      if (result.editToken) setEditLink(`${window.location.origin}/p/${encodeURIComponent(slug)}#edit=${encodeURIComponent(result.cardId)}:${encodeURIComponent(result.editToken)}`)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={config.title || t('project.intake.title')} width={560}>
      {createdId
        ? (
            <div className="space-y-3">
              <p role="status" className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{t('project.intake.success')}</p>
              {editLink && (
                <div className="space-y-2">
                  <span className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('project.intake.edit_link')}</span>
                  <div className="flex items-center gap-2">
                    <Input className="min-w-0 flex-1" readOnly value={editLink} aria-label={t('project.intake.edit_link')} />
                    <Button
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard.writeText(editLink)
                          .then(() => setCopied(true))
                          .catch(() => setCopied(false))
                      }}
                    >
                      {copied ? t('project.intake.edit_copied') : t('project.share.copy')}
                    </Button>
                  </div>
                </div>
              )}
              <Button variant="primary" onClick={onClose}>{t('common.close')}</Button>
            </div>
          )
        : (
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submit() }}>
              <label className="block space-y-1">
                <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('project.intake.card_title')}</span>
                <Input className="w-full" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
              </label>
              {fields.map((property) => (
                <PublicIntakeField
                  key={property.id}
                  property={property}
                  required={required.has(property.id)}
                  value={values[property.id] ?? ''}
                  onChange={(value) => setValues((current) => ({ ...current, [property.id]: value }))}
                />
              ))}
              {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
              <div className="flex justify-end">
                <Button type="submit" variant="primary" loading={submitting} disabled={submitting}>{t('project.intake.submit')}</Button>
              </div>
            </form>
          )}
    </Modal>
  )
}

function PublicIntakeField({ property, required, value, onChange }: {
  property: ProjectProperty
  required: boolean
  value: string
  onChange: (value: string) => void
}) {
  const textLike = property.type === 'text' || property.type === 'number' || property.type === 'url' || property.type === 'email' || property.type === 'phone'
  return (
    <div className="space-y-1">
      <span className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
        {property.name}{required ? ' *' : ''}
      </span>
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
