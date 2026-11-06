import { useId, useRef, useState } from 'react'
import { MAX_SLUG_LENGTH } from '@shared/tools/shortlinks/types'
import { CustomSlugRegex } from '@shared/tools/shortlinks/schemas'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { Field, Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { useUiStore } from '../../../../lib/ui-store'
import { useShortlinksStore } from '../store'
import { shortlinksApi } from '../api'

export function AddSlugModal() {
  const open = useShortlinksStore((s) => s.addSlugModalOpen)
  const linkId = useShortlinksStore((s) => s.addSlugLinkId)
  const closeAddSlugModal = useShortlinksStore((s) => s.closeAddSlugModal)
  const refreshActiveLink = useShortlinksStore((s) => s.refreshActiveLink)
  const fetchLinks = useShortlinksStore((s) => s.fetchLinks)

  const [slug, setSlug] = useState('')
  const [error, setError] = useState<'required' | 'invalid' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const fieldId = useId()

  const handleClose = () => {
    setSlug('')
    setError(null)
    closeAddSlugModal()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!linkId) return
    const trimmed = slug.trim()
    if (!trimmed) {
      setError('required')
      inputRef.current?.focus()
      return
    }
    if (trimmed.length > MAX_SLUG_LENGTH || !CustomSlugRegex.test(trimmed)) {
      setError('invalid')
      inputRef.current?.focus()
      return
    }
    setError(null)

    setSubmitting(true)
    try {
      await shortlinksApi.addSlug(linkId, { slug: trimmed })
      useUiStore.getState().toast(t('tools.shortlinks.links.status_updated'), 'success')
      handleClose()
      void refreshActiveLink()
      void fetchLinks()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      dismissible={!submitting}
      onClose={handleClose}
      title={t('tools.shortlinks.modal.add_slug_title')}
      width={440}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={handleClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4 py-2">
        <Field
          label={t('tools.shortlinks.modal.slug_input_label')}
          required
        >
          <Input
            id={`${fieldId}-input`}
            ref={inputRef}
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value)
              if (error) setError(null)
            }}
            placeholder={t('tools.shortlinks.modal.slug_placeholder_example')}
            autoFocus
            invalid={Boolean(error)}
            aria-describedby={error ? `${fieldId}-error` : undefined}
          />
        </Field>
        {error && (
          <p
            id={`${fieldId}-error`}
            role="alert"
            className="text-[length:var(--text-12)] text-[var(--danger)]"
          >
            {t(error === 'required'
              ? 'tools.shortlinks.modal.slug_required'
              : 'tools.shortlinks.modal.slug_invalid')}
          </p>
        )}
      </form>
    </Modal>
  )
}
