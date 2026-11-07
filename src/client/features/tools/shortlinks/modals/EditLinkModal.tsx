import { useEffect, useState } from 'react'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { Input, Select, Textarea } from '../../../../components/form'
import { DatePicker } from '../../../../components/date-picker'
import { buildRoutingRules, routingCountriesToText } from '@shared/tools/shortlinks/routing'
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
  const [tags, setTags] = useState('')
  const [password, setPassword] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [unsafe, setUnsafe] = useState(false)
  const [redirectWithQuery, setRedirectWithQuery] = useState(false)
  const [redirectStatus, setRedirectStatus] = useState('')
  const [mobileTarget, setMobileTarget] = useState('')
  const [countryTargets, setCountryTargets] = useState('')
  const [ogTitle, setOgTitle] = useState('')
  const [ogDescription, setOgDescription] = useState('')
  const [ogImage, setOgImage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (link) {
      setUrl(link.url)
      setLabel(link.label || '')
      setTags((link.tags || []).join(', '))
      setPassword('')
      setUnsafe(Boolean(link.unsafe))
      setRedirectWithQuery(Boolean(link.redirect_with_query))
      setRedirectStatus(link.routing_rules?.status ? String(link.routing_rules.status) : '')
      setMobileTarget(link.routing_rules?.devices?.mobile ?? '')
      setCountryTargets(routingCountriesToText(link.routing_rules?.countries))
      setOgTitle(link.og_preview?.title ?? '')
      setOgDescription(link.og_preview?.description ?? '')
      setOgImage(link.og_preview?.image ?? '')
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
        label: label.trim() ? label.trim() : null,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        password: password.trim() ? password.trim() : null,
        expires_at: expTs,
        unsafe,
        redirect_with_query: redirectWithQuery,
        routing_rules: buildRoutingRules({
          status: redirectStatus,
          mobile: mobileTarget,
          countries: countryTargets,
        }),
        og_preview:
          ogTitle.trim() || ogDescription.trim() || ogImage.trim()
            ? {
              title: ogTitle.trim() || undefined,
              description: ogDescription.trim() || undefined,
              image: ogImage.trim() || undefined,
            }
            : null,
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

        <div>
          <label className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1">
            {t('tools.shortlinks.modal.tags_label')}
          </label>
          <Input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t('tools.shortlinks.modal.tags_placeholder')}
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

          <label className="flex items-start gap-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={unsafe}
              onChange={(e) => setUnsafe(e.target.checked)}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <span>
              <span className="block font-medium text-[var(--text-primary)]">
                {t('tools.shortlinks.modal.unsafe_label')}
              </span>
              {t('tools.shortlinks.modal.unsafe_desc')}
            </span>
          </label>

          <label className="flex items-start gap-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={redirectWithQuery}
              onChange={(e) => setRedirectWithQuery(e.target.checked)}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <span>
              <span className="block font-medium text-[var(--text-primary)]">
                {t('tools.shortlinks.modal.redirect_query_label')}
              </span>
              {t('tools.shortlinks.modal.redirect_query_desc')}
            </span>
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="shortlinks-edit-status"
                className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1"
              >
                {t('tools.shortlinks.modal.redirect_status_label')}
              </label>
              <Select
                id="shortlinks-edit-status"
                value={redirectStatus}
                onChange={(e) => setRedirectStatus(e.target.value)}
                className="h-9"
              >
                <option value="">{t('tools.shortlinks.modal.redirect_status_default')}</option>
                <option value="302">{t('tools.shortlinks.modal.redirect_status_302')}</option>
                <option value="301">{t('tools.shortlinks.modal.redirect_status_301')}</option>
              </Select>
            </div>
            <div>
              <label className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1">
                {t('tools.shortlinks.modal.mobile_target_label')}
              </label>
              <Input
                value={mobileTarget}
                onChange={(e) => setMobileTarget(e.target.value)}
                placeholder={t('tools.shortlinks.modal.mobile_target_placeholder')}
              />
            </div>
          </div>

          <div>
            <label className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1">
              {t('tools.shortlinks.modal.country_targets_label')}
            </label>
            <Textarea
              value={countryTargets}
              onChange={(e) => setCountryTargets(e.target.value)}
              placeholder={t('tools.shortlinks.modal.country_targets_placeholder')}
              rows={3}
            />
          </div>

          <div className="space-y-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
            <div className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('tools.shortlinks.modal.og_label')}
            </div>
            <Input
              value={ogTitle}
              onChange={(e) => setOgTitle(e.target.value)}
              placeholder={t('tools.shortlinks.modal.og_title_placeholder')}
              maxLength={120}
            />
            <Textarea
              value={ogDescription}
              onChange={(e) => setOgDescription(e.target.value)}
              placeholder={t('tools.shortlinks.modal.og_description_placeholder')}
              maxLength={200}
              rows={2}
            />
            <Input
              value={ogImage}
              onChange={(e) => setOgImage(e.target.value)}
              placeholder={t('tools.shortlinks.modal.og_image_placeholder')}
            />
          </div>
        </div>
      </form>
    </Modal>
  )
}
