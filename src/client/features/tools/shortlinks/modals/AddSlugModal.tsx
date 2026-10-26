import { useState } from 'react'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
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
  const [submitting, setSubmitting] = useState(false)

  const handleClose = () => {
    setSlug('')
    closeAddSlugModal()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!linkId) return
    const trimmed = slug.trim()
    if (!trimmed) return

    setSubmitting(true)
    try {
      await shortlinksApi.addSlug(linkId, { slug: trimmed })
      useUiStore.getState().toast(t('tools.shortlinks.settings.save_success'), 'success')
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
            disabled={submitting || !slug.trim()}
          >
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4 py-2">
        <div>
          <label className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1">
            {t('tools.shortlinks.modal.slug_input_label')}{' '}
            <span className="text-[var(--danger)]">*</span>
          </label>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my-alias-slug"
            required
            autoFocus
          />
          <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('tools.shortlinks.modal.custom_slug_placeholder')}
          </p>
        </div>
      </form>
    </Modal>
  )
}
