/**
 * The Cache & Status tab: the cache settings that sit beside the purge actions, and the zone switch.
 *
 * Purging and pausing are irreversible or reader-visible, so both ask for confirmation; the URL purge
 * stays a form until it has something to send rather than firing on a keystroke.
 */
import { useEffect, useState } from 'react'
import { Field, Textarea } from '../../../../components/form'
import { LoadingBlock } from '../../../../components/feedback'
import { confirm } from '../../../../components/overlay'
import { Badge, Button } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { t as uiT } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { dnsApi, type DnsZone, type ZoneSettings } from '../../api/dns'
import { useCfT } from '../../i18n'
import { BROWSER_TTL_CHOICES, CACHE_LEVEL_CHOICES, statusText, statusTone } from './options'
import { PanelError } from './PanelError'
import { SwitchRow } from './SwitchRow'
import { usePanelLoad } from './use-panel-load'
import { ZONE_DEFAULTS } from './ZoneSettingsPanel'

export function CachePanel({
  domain,
  zone,
  onZoneChanged,
}: {
  domain: string
  zone: DnsZone
  onZoneChanged: () => void
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const { data, loading, error, reload } = usePanelLoad(() => dnsApi.getSettings(domain), domain)
  const [settings, setSettings] = useState<Pick<ZoneSettings, 'cache_level' | 'browser_cache_ttl' | 'development_mode'>>({
    cache_level: ZONE_DEFAULTS.cache_level,
    browser_cache_ttl: ZONE_DEFAULTS.browser_cache_ttl,
    development_mode: ZONE_DEFAULTS.development_mode,
  })
  const [saving, setSaving] = useState(false)
  const [purging, setPurging] = useState(false)
  const [urlOpen, setUrlOpen] = useState(false)
  const [urls, setUrls] = useState('')

  useEffect(() => {
    if (!data) return
    setSettings({
      cache_level: data.cache_level ?? ZONE_DEFAULTS.cache_level,
      browser_cache_ttl: data.browser_cache_ttl ?? ZONE_DEFAULTS.browser_cache_ttl,
      development_mode: data.development_mode ?? ZONE_DEFAULTS.development_mode,
    })
  }, [data])

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const result = await dnsApi.updateSettings(domain, settings)
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

  async function purgeAll(): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.dns.purge_cache'),
      description: t('cloudflare.dns.purge_all_confirm'),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setPurging(true)
    try {
      await dnsApi.purgeCache(domain, { purge_everything: true })
      toast({ title: t('cloudflare.dns.msg.cache_purged'), tone: 'success' })
    } catch (reason) {
      toast({
        title: t('cloudflare.dns.msg.purge_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    } finally {
      setPurging(false)
    }
  }

  async function purgeUrls(): Promise<void> {
    const files = urls.split('\n').map((line) => line.trim()).filter(Boolean)
    if (files.length === 0) {
      toast({ title: t('cloudflare.dns.msg.url_required'), tone: 'warning' })
      return
    }
    setPurging(true)
    try {
      await dnsApi.purgeCache(domain, { files })
      toast({ title: t('cloudflare.dns.msg.url_purged', { count: files.length }), tone: 'success' })
      setUrls('')
      setUrlOpen(false)
    } catch (reason) {
      toast({
        title: t('cloudflare.dns.msg.purge_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    } finally {
      setPurging(false)
    }
  }

  async function toggleStatus(): Promise<void> {
    const paused = zone.status === 'paused'
    const ok = await confirm({
      title: paused ? t('cloudflare.dns.activate_zone') : t('cloudflare.dns.pause_zone'),
      description: paused ? t('cloudflare.dns.activate_confirm') : t('cloudflare.dns.pause_warning'),
      confirmLabel: uiT('common.continue'),
      cancelLabel: uiT('common.cancel'),
      tone: paused ? 'default' : 'danger',
    })
    if (!ok) return
    try {
      await dnsApi.updateStatus(domain, !paused)
      toast({
        title: paused ? t('cloudflare.dns.msg.zone_activated') : t('cloudflare.dns.msg.zone_paused'),
        tone: 'success',
      })
      onZoneChanged()
    } catch (reason) {
      toast({
        title: t('cloudflare.dns.msg.operation_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    }
  }

  if (loading && !data) return <LoadingBlock />
  if (error && !data) return <PanelError message={error} onRetry={reload} />

  return (
    <div className="space-y-4">
      {error && <PanelError message={error} onRetry={reload} />}

      <section className="space-y-3">
        <h3 className="text-[length:var(--text-12)] font-semibold tracking-wide text-[var(--text-secondary)] uppercase">
          {t('cloudflare.dns.cache_settings')}
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('cloudflare.dns.cache_level')}>
            <div>
              <SelectMenu
                label={t('cloudflare.dns.cache_level')}
                value={settings.cache_level ?? 'aggressive'}
                options={CACHE_LEVEL_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }))}
                onChange={(value) => setSettings((current) => ({ ...current, cache_level: value }))}
              />
            </div>
          </Field>
          <Field label={t('cloudflare.dns.browser_cache_ttl')}>
            <div>
              <SelectMenu
                label={t('cloudflare.dns.browser_cache_ttl')}
                value={String(settings.browser_cache_ttl ?? 14400)}
                options={BROWSER_TTL_CHOICES.map((choice) => ({ value: String(choice.value), label: choice.label }))}
                onChange={(value) => setSettings((current) => ({ ...current, browser_cache_ttl: Number(value) }))}
              />
            </div>
          </Field>
        </div>
        <SwitchRow
          label={t('cloudflare.dns.dev_mode')}
          hint={t('cloudflare.dns.dev_mode_hint')}
          checked={settings.development_mode === 'on'}
          onChange={(next) => setSettings((current) => ({ ...current, development_mode: next ? 'on' : 'off' }))}
        />
        <div className="flex justify-end">
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {t('cloudflare.dns.save_settings')}
          </Button>
        </div>
      </section>

      <section className="space-y-3 border-t border-[var(--border-subtle)] pt-4">
        <h3 className="text-[length:var(--text-12)] font-semibold tracking-wide text-[var(--text-secondary)] uppercase">
          {t('cloudflare.dns.purge_cache')}
        </h3>
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" loading={purging} onClick={() => void purgeAll()}>
            {t('cloudflare.dns.purge_all')}
          </Button>
          <Button variant="secondary" onClick={() => setUrlOpen((open) => !open)}>
            {urlOpen ? t('cloudflare.dns.collapse') : t('cloudflare.dns.purge_by_url')}
          </Button>
        </div>
        {urlOpen && (
          <div className="space-y-2">
            <Field label={t('cloudflare.dns.purge_by_url')}>
              <Textarea
                rows={4}
                value={urls}
                onChange={(event) => setUrls(event.target.value)}
                placeholder={t('cloudflare.dns.purge_url_placeholder')}
              />
            </Field>
            <Button variant="primary" loading={purging} onClick={() => void purgeUrls()}>
              {t('cloudflare.dns.purge_specified_url')}
            </Button>
          </div>
        )}
      </section>

      <section className="space-y-3 border-t border-[var(--border-subtle)] pt-4">
        <h3 className="text-[length:var(--text-12)] font-semibold tracking-wide text-[var(--text-secondary)] uppercase">
          {t('cloudflare.dns.zone_status')}
        </h3>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('cloudflare.dns.current_status')}
            </span>
            <Badge tone={statusTone(zone.status)}>{statusText(t, zone.status)}</Badge>
          </div>
          <Button
            variant={zone.status === 'paused' ? 'primary' : 'danger'}
            onClick={() => void toggleStatus()}
          >
            {zone.status === 'paused' ? t('cloudflare.dns.activate_zone') : t('cloudflare.dns.pause_zone')}
          </Button>
        </div>
      </section>
    </div>
  )
}
