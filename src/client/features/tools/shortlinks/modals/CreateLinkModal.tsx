import { useState } from 'react'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { Input, Select, Textarea } from '../../../../components/form'
import { DatePicker } from '../../../../components/date-picker'
import { buildRoutingRules } from '@shared/tools/shortlinks/routing'
import { t } from '../../../../lib/i18n'
import { useUiStore } from '../../../../lib/ui-store'
import { useShortlinksStore } from '../store'
import { shortlinksApi } from '../api'
import { createShortlinkSafely } from '../create-link'

export function CreateLinkModal() {
  const open = useShortlinksStore((s) => s.createModalOpen)
  const setOpen = useShortlinksStore((s) => s.setCreateModalOpen)
  const bundles = useShortlinksStore((s) => s.bundles)
  const fetchLinks = useShortlinksStore((s) => s.fetchLinks)
  const fetchDashboard = useShortlinksStore((s) => s.fetchDashboard)

  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [tags, setTags] = useState('')
  const [customSlug, setCustomSlug] = useState('')
  const [password, setPassword] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [bundleId, setBundleId] = useState<number | ''>('')
  const [unsafe, setUnsafe] = useState(false)
  const [redirectWithQuery, setRedirectWithQuery] = useState(false)
  const [redirectStatus, setRedirectStatus] = useState('')
  const [mobileTarget, setMobileTarget] = useState('')
  const [countryTargets, setCountryTargets] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleClose = () => {
    setUrl('')
    setLabel('')
    setTags('')
    setCustomSlug('')
    setPassword('')
    setExpiresAt('')
    setBundleId('')
    setUnsafe(false)
    setRedirectWithQuery(false)
    setRedirectStatus('')
    setMobileTarget('')
    setCountryTargets('')
    setOpen(false)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedUrl = url.trim()
    if (!trimmedUrl) return

    setSubmitting(true)
    try {
      const parsed = expiresAt ? Date.parse(expiresAt) : NaN
      const expTs = !Number.isNaN(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : null
      const link = await createShortlinkSafely({
        url: trimmedUrl,
        label: label.trim() || undefined,
        custom_slug: customSlug.trim() || undefined,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        password: password.trim() || undefined,
        expires_at: expTs,
        unsafe,
        redirect_with_query: redirectWithQuery,
        routing_rules: buildRoutingRules({
          status: redirectStatus,
          mobile: mobileTarget,
          countries: countryTargets,
        }),
      })
      if (!link) return

      if (bundleId && typeof bundleId === 'number') {
        try {
          await shortlinksApi.addLinksToBundle(bundleId, [link.id])
        } catch {
          // Best-effort addition of newly created shortlink into bundle
        }
      }

      useUiStore.getState().toast(t('tools.shortlinks.links.created'), 'success')
      handleClose()
      void fetchLinks()
      void fetchDashboard()
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
      title={t('tools.shortlinks.modal.create_title')}
      width={520}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={handleClose} disabled={submitting}>
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
            placeholder="https://example.com/very/long/url"
            required
            autoFocus
          />
          <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('tools.shortlinks.modal.url_help')}
          </p>
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

        <div>
          <label className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1">
            {t('tools.shortlinks.modal.custom_slug_label')}
          </label>
          <Input
            value={customSlug}
            onChange={(e) => setCustomSlug(e.target.value)}
            placeholder={t('tools.shortlinks.modal.custom_slug_placeholder')}
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
              placeholder={t('tools.shortlinks.modal.password_placeholder')}
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

        {bundles.length > 0 && (
          <div>
            <label
              htmlFor="shortlinks-create-bundle"
              className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1"
            >
              {t('tools.shortlinks.modal.bundle_label')}
            </label>
            <Select
              id="shortlinks-create-bundle"
              value={bundleId}
              onChange={(e) => setBundleId(e.target.value ? Number(e.target.value) : '')}
              className="h-9"
            >
              <option value="">{t('tools.shortlinks.modal.bundle_none')}</option>
              {bundles.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>
        )}

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
              htmlFor="shortlinks-create-status"
              className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] mb-1"
            >
              {t('tools.shortlinks.modal.redirect_status_label')}
            </label>
            <Select
              id="shortlinks-create-status"
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
      </form>
    </Modal>
  )
}
