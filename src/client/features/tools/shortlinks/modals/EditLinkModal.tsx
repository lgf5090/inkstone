import { useEffect, useState } from 'react'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { DatePicker } from '../../../../components/date-picker'
import { t } from '../../../../lib/i18n'
import { useUiStore } from '../../../../lib/ui-store'
import { useShortlinksStore } from '../store'
import { shortlinksApi } from '../api'

export function EditLinkModal() {
  const open = useShortlinksStore((s) => s.editModalOpen)
  const link = useShortlinksStore((s) => s.editingLink)
  const closeEditModal = useShortlinksStore((s) => s.closeEditModal)
  const fetchLinks = useShortlinksStore((s) => s.fetchLinks)
  const refreshActiveLink = useShortlinksStore((s) => s.refreshActiveLink)

  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [password, setPassword] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (link) {
      setUrl(link.url)
      setLabel(link.label || '')
      setPassword('')
      if (link.expires_at) {
        const d = new Date(link.expires_at * 1000)
        const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
        setExpiresAt(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`)
      } else {
        setExpiresAt('')
      }
    }
  }, [link])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!link) return
    const trimmedUrl = url.trim()
    if (!trimmedUrl) return

    setSubmitting(true)
    try {
      const parsed = expiresAt ? Date.parse(expiresAt) : NaN
      const expTs = !Number.isNaN(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : null
      await shortlinksApi.updateLink(link.id, {
        url: trimmedUrl,
        label: label.trim() || undefined,
        password: password.trim() ? password.trim() : undefined,
        expires_at: expTs,
      })

      useUiStore.getState().toast(t('tools.shortlinks.links.status_updated'), 'success')
      closeEditModal()
      void fetchLinks()
      void refreshActiveLink()
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
      onClose={closeEditModal}
      title={t('tools.shortlinks.modal.edit_title')}
      width={520}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={closeEditModal} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={submitting || !url.trim()}
          >
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4 py-2">
        <div>
          <label className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1">
            {t('tools.shortlinks.modal.url_label')}{' '}
            <span className="text-[var(--danger)]">*</span>
          </label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div>
          <label className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1">
            {t('tools.shortlinks.modal.label_label')}
          </label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('tools.shortlinks.modal.label_placeholder')}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1">
              {t('tools.shortlinks.modal.password_label')}
            </label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={link?.password_protected ? `•••••••• (${t('tools.shortlinks.links.password_protected')})` : t('tools.shortlinks.modal.password_placeholder')}
            />
          </div>

          <div>
            <label className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1">
              {t('tools.shortlinks.modal.expires_label')}
            </label>
            <DatePicker
              withTime
              label={t('tools.shortlinks.modal.expires_label')}
              value={expiresAt}
              onChange={setExpiresAt}
              placeholder={t('tools.shortlinks.modal.expires_placeholder')}
            />
          </div>
        </div>
      </form>
    </Modal>
  )
}
