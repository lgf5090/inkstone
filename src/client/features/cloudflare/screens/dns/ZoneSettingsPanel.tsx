/**
 * The Zone settings tab: SSL/TLS, security and the performance switches.
 *
 * The form starts from what Cloudflare returned and falls back to the reference module's defaults
 * only for keys the API did not list, so saving never invents a value for a setting that exists.
 */
import { useEffect, useState } from 'react'
import { Checkbox, Field } from '../../../../components/form'
import { LoadingBlock } from '../../../../components/feedback'
import { Button } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { dnsApi, type ZoneSettings } from '../../api/dns'
import { useCfT } from '../../i18n'
import { SECURITY_CHOICES, SSL_CHOICES } from './options'
import { PanelError } from './PanelError'
import { SwitchRow } from './SwitchRow'
import { usePanelLoad } from './use-panel-load'

export const ZONE_DEFAULTS: ZoneSettings = {
  ssl: 'full',
  always_use_https: 'on',
  automatic_https_rewrites: 'on',
  security_level: 'medium',
  cache_level: 'aggressive',
  browser_cache_ttl: 14400,
  development_mode: 'off',
  minify: { js: true, css: true, html: false },
  brotli: 'on',
  zero_rtt: 'on',
}

export function ZoneSettingsPanel({ domain }: { domain: string }) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const { data, loading, error, reload } = usePanelLoad(() => dnsApi.getSettings(domain), domain)
  const [form, setForm] = useState<ZoneSettings>(ZONE_DEFAULTS)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!data) return
    setForm({
      ssl: data.ssl ?? ZONE_DEFAULTS.ssl,
      always_use_https: data.always_use_https ?? ZONE_DEFAULTS.always_use_https,
      automatic_https_rewrites: data.automatic_https_rewrites ?? ZONE_DEFAULTS.automatic_https_rewrites,
      security_level: data.security_level ?? ZONE_DEFAULTS.security_level,
      cache_level: data.cache_level ?? ZONE_DEFAULTS.cache_level,
      browser_cache_ttl: data.browser_cache_ttl ?? ZONE_DEFAULTS.browser_cache_ttl,
      development_mode: data.development_mode ?? ZONE_DEFAULTS.development_mode,
      minify: { ...ZONE_DEFAULTS.minify, ...(data.minify ?? {}) },
      brotli: data.brotli ?? ZONE_DEFAULTS.brotli,
      zero_rtt: data.zero_rtt ?? ZONE_DEFAULTS.zero_rtt,
    })
  }, [data])

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const result = await dnsApi.updateSettings(domain, form)
      if (result.failed.length > 0) {
        toast({
          title: t('cloudflare.dns.msg.settings_partial_fail', { failed: result.failed.join(', ') }),
          tone: 'warning',
        })
      } else {
        toast({ title: t('cloudflare.dns.msg.settings_updated'), tone: 'success' })
      }
      reload()
    } catch (reason) {
      toast({
        title: t('cloudflare.dns.msg.save_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data) return <LoadingBlock />
  if (error && !data) return <PanelError message={error} onRetry={reload} />

  return (
    <div className="space-y-4">
      {error && <PanelError message={error} onRetry={reload} />}
      <section className="space-y-3">
        <h3 className="text-[length:var(--text-12)] font-semibold tracking-wide text-[var(--text-secondary)] uppercase">
          {t('cloudflare.dns.ssl_tls')}
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('cloudflare.dns.ssl_mode')}>
            <div>
              <SelectMenu
                label={t('cloudflare.dns.ssl_mode')}
                value={form.ssl ?? 'full'}
                options={SSL_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }))}
                onChange={(value) => setForm((current) => ({ ...current, ssl: value }))}
              />
            </div>
          </Field>
          <Field label={t('cloudflare.dns.security_level')}>
            <div>
              <SelectMenu
                label={t('cloudflare.dns.security_level')}
                value={form.security_level ?? 'medium'}
                options={SECURITY_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }))}
                onChange={(value) => setForm((current) => ({ ...current, security_level: value }))}
              />
            </div>
          </Field>
        </div>
        <SwitchRow
          label={t('cloudflare.dns.always_https')}
          checked={form.always_use_https === 'on'}
          onChange={(next) => setForm((current) => ({ ...current, always_use_https: next ? 'on' : 'off' }))}
        />
        <SwitchRow
          label={t('cloudflare.dns.auto_https_rewrite')}
          checked={form.automatic_https_rewrites === 'on'}
          onChange={(next) => setForm((current) => ({ ...current, automatic_https_rewrites: next ? 'on' : 'off' }))}
        />
      </section>

      <section className="space-y-3 border-t border-[var(--border-subtle)] pt-4">
        <h3 className="text-[length:var(--text-12)] font-semibold tracking-wide text-[var(--text-secondary)] uppercase">
          {t('cloudflare.dns.performance')}
        </h3>
        <Field label={t('cloudflare.dns.auto_minify')}>
          <div className="flex flex-wrap gap-4">
            <Checkbox
              checked={form.minify?.js === true}
              onChange={(next) => setForm((current) => ({ ...current, minify: { ...current.minify, js: next } }))}
              label={t('cloudflare.dns.minify_js')}
            />
            <Checkbox
              checked={form.minify?.css === true}
              onChange={(next) => setForm((current) => ({ ...current, minify: { ...current.minify, css: next } }))}
              label={t('cloudflare.dns.minify_css')}
            />
            <Checkbox
              checked={form.minify?.html === true}
              onChange={(next) => setForm((current) => ({ ...current, minify: { ...current.minify, html: next } }))}
              label={t('cloudflare.dns.minify_html')}
            />
          </div>
        </Field>
        <SwitchRow
          label={t('cloudflare.dns.brotli')}
          checked={form.brotli === 'on'}
          onChange={(next) => setForm((current) => ({ ...current, brotli: next ? 'on' : 'off' }))}
        />
        <SwitchRow
          label={t('cloudflare.dns.zero_rtt')}
          checked={form.zero_rtt === 'on'}
          onChange={(next) => setForm((current) => ({ ...current, zero_rtt: next ? 'on' : 'off' }))}
        />
      </section>

      <div className="flex justify-end border-t border-[var(--border-subtle)] pt-3">
        <Button variant="primary" loading={saving} onClick={() => void save()}>
          {t('cloudflare.dns.save_settings')}
        </Button>
      </div>
    </div>
  )
}
