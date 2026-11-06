/**
 * URL normalization is two enums, not a table of settings: the normalization type and whether it
 * applies only to incoming requests or to both directions. Saving reloads the form from Cloudflare's
 * answer, so the switch always reflects what the zone actually holds.
 */
import { useEffect, useState } from 'react'
import { Field } from '../../../../components/form'
import { LoadingBlock } from '../../../../components/feedback'
import { Button } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { dnsSecurityApi, type UrlNormalization } from '../../api/dns-security'
import { useCfT } from '../../i18n'
import { PanelError } from './PanelError'
import { usePanelLoad } from './use-panel-load'

const DEFAULTS: UrlNormalization = { type: 'cloudflare', scope: 'incoming' }

export function UrlNormalizationPanel({ domain }: { domain: string }) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const { data, loading, error, reload } = usePanelLoad(
    () => dnsSecurityApi.getUrlNormalization(domain),
    domain,
  )
  const [form, setForm] = useState<UrlNormalization>(DEFAULTS)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (data) setForm(data)
  }, [data])

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const saved = await dnsSecurityApi.updateUrlNormalization(domain, form)
      setForm(saved)
      toast({ title: t('cloudflare.dns.msg.settings_updated'), tone: 'success' })
    } catch (reason) {
      toast({ title: t('cloudflare.dns.msg.save_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data) return <LoadingBlock />
  if (error && !data) return <PanelError message={error} onRetry={reload} />

  return (
    <div className="space-y-4">
      {error && <PanelError message={error} onRetry={reload} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('cloudflare.dns.url_normalization_type')}>
          <div>
            <SelectMenu
              label={t('cloudflare.dns.url_normalization_type')}
              value={form.type}
              options={[
                { value: 'cloudflare', label: t('cloudflare.dns.url_normalization_cloudflare') },
                { value: 'rfc3986', label: t('cloudflare.dns.url_normalization_rfc3986') },
              ]}
              onChange={(value) => setForm((current) => ({ ...current, type: value as UrlNormalization['type'] }))}
            />
          </div>
        </Field>
        <Field label={t('cloudflare.dns.url_normalization_scope')}>
          <div>
            <SelectMenu
              label={t('cloudflare.dns.url_normalization_scope')}
              value={form.scope}
              options={[
                { value: 'incoming', label: t('cloudflare.dns.url_normalization_incoming') },
                { value: 'both', label: t('cloudflare.dns.url_normalization_both') },
              ]}
              onChange={(value) => setForm((current) => ({ ...current, scope: value as UrlNormalization['scope'] }))}
            />
          </div>
        </Field>
      </div>
      <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
        {t('cloudflare.dns.url_normalization_hint')}
      </p>
      <div className="flex justify-end">
        <Button variant="primary" loading={saving} onClick={() => void save()}>
          {t('cloudflare.dns.save_settings')}
        </Button>
      </div>
    </div>
  )
}
