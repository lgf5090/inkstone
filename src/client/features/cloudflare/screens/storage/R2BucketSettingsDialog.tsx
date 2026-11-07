/**
 * One bucket's public-access settings: CORS, lifecycle rules and custom domains.
 *
 * Each section is read from the bucket's own endpoints and written back as the whole policy, because
 * that is the only shape R2 accepts for CORS and lifecycle. Rules arrive from the API as complete
 * objects and go back untouched except for the fields edited here, so a transition this dialog does
 * not draw survives a save. A demo account sees the settings and cannot change them.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { Checkbox, Field, Input, Switch, Textarea } from '../../../../components/form'
import { Modal, confirm } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'
import { Empty } from '../../../../components/feedback'
import { t as uiT } from '../../../../lib/i18n'
import { cfErrorText } from '../../api/client'
import {
  storageApi,
  type R2BucketSettings,
  type R2CorsRule,
  type R2LifecycleRule,
} from '../../api/storage'
import { workersApi, type ZoneOption } from '../../api/workers'
import { useCfT } from '../../i18n'
import { useUi } from '../../../../store/ui'
import { Table, TableScroll, TBody, Td, Th, THead, Tr } from '../../components/Table'
import { StorageError } from './StorageError'

const CORS_METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'] as const
const MIN_TLS = ['1.0', '1.1', '1.2', '1.3'] as const
type MinTls = typeof MIN_TLS[number]
const MIN_TLS_OPTIONS = MIN_TLS.map((version) => ({ value: version, label: version }))

function originsOf(rule: R2CorsRule): string[] {
  return rule.allowed?.origins ?? []
}

function methodsOf(rule: R2CorsRule): string[] {
  return rule.allowed?.methods ?? []
}

function rulePrefix(rule: R2LifecycleRule): string {
  return rule.conditions?.prefix ?? ''
}

function daysOf(rule: R2LifecycleRule): number {
  const condition = rule.deleteObjectsTransition?.condition
  return condition?.type === 'Age' && condition.maxAge ? Math.round(condition.maxAge / 86_400) : 0
}

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

export function R2BucketSettingsDialog({
  open,
  accountId,
  bucket,
  readOnly,
  onClose,
}: {
  open: boolean
  accountId: string
  bucket: string
  readOnly: boolean
  onClose: () => void
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [settings, setSettings] = useState<R2BucketSettings | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'cors' | 'lifecycle' | 'managed' | 'domain' | null>(null)
  const [corsDraft, setCorsDraft] = useState<R2CorsRule[]>([])
  const [lifecycleDraft, setLifecycleDraft] = useState<R2LifecycleRule[]>([])
  const [zones, setZones] = useState<ZoneOption[]>([])

  const [corsOpen, setCorsOpen] = useState(false)
  const [corsOrigins, setCorsOrigins] = useState('*')
  const [corsHeaders, setCorsHeaders] = useState('')
  const [corsMethods, setCorsMethods] = useState<string[]>(['GET'])
  const [corsMaxAge, setCorsMaxAge] = useState('3600')

  const [lifecycleOpen, setLifecycleOpen] = useState(false)
  const [lifecyclePrefix, setLifecyclePrefix] = useState('')
  const [lifecycleDays, setLifecycleDays] = useState('30')

  const [domainOpen, setDomainOpen] = useState(false)
  const [domainDraft, setDomainDraft] = useState('')
  const [domainZone, setDomainZone] = useState('')
  const [domainTls, setDomainTls] = useState<MinTls>('1.2')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await storageApi.getR2BucketSettings(accountId, bucket)
      setSettings(data)
      setCorsDraft(data.cors)
      setLifecycleDraft(data.lifecycle)
    } catch (reason) {
      setError(cfErrorText(reason))
      setSettings(null)
    } finally {
      setLoading(false)
    }
  }, [accountId, bucket])

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  useEffect(() => {
    if (!open) return
    setCorsOpen(false)
    setLifecycleOpen(false)
    setDomainOpen(false)
    setDomainDraft('')
    setDomainZone('')
    setDomainTls('1.2')
  }, [open, bucket])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void workersApi.getZones(accountId)
      .then((data) => { if (!cancelled) setZones(data) })
      .catch(() => { if (!cancelled) setZones([]) })
    return () => { cancelled = true }
  }, [open, accountId])

  async function refreshDomains(): Promise<void> {
    const data = await storageApi.getR2BucketSettings(accountId, bucket)
    setSettings((current) => current
      ? {
          ...current,
          managed_domain: data.managed_domain,
          custom_domains: data.custom_domains,
        }
      : data)
  }

  async function saveCors(): Promise<void> {
    setBusy('cors')
    try {
      await storageApi.saveR2CorsRules(accountId, bucket, corsDraft)
      toast({ title: t('cloudflare.storage.r2_settings_saved'), tone: 'success' })
      await load()
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  async function saveLifecycle(): Promise<void> {
    setBusy('lifecycle')
    try {
      await storageApi.saveR2LifecycleRules(accountId, bucket, lifecycleDraft)
      toast({ title: t('cloudflare.storage.r2_settings_saved'), tone: 'success' })
      await load()
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  async function toggleManaged(next: boolean): Promise<void> {
    setBusy('managed')
    try {
      await storageApi.setR2ManagedDomain(accountId, bucket, next)
      toast({ title: t('cloudflare.storage.r2_settings_saved'), tone: 'success' })
      await refreshDomains()
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  function addCorsRule(): void {
    const origins = corsOrigins.split('\n').map((line) => line.trim()).filter(Boolean)
    const headers = corsHeaders.split('\n').map((line) => line.trim()).filter(Boolean)
    const maxAge = Number(corsMaxAge)
    const rule: R2CorsRule = {
      allowed: { origins, methods: corsMethods, ...(headers.length > 0 ? { headers } : {}) },
      ...(Number.isFinite(maxAge) && maxAge > 0 ? { maxAgeSeconds: Math.round(maxAge) } : {}),
    }
    setCorsDraft((current) => [...current, rule])
    setCorsOpen(false)
  }

  function addLifecycleRule(): void {
    const days = Number(lifecycleDays)
    if (!Number.isFinite(days) || days <= 0) return
    const prefix = lifecyclePrefix.trim()
    const rule: R2LifecycleRule = {
      id: `rule-${Date.now().toString(36)}`,
      enabled: true,
      conditions: prefix ? { prefix } : {},
      deleteObjectsTransition: { condition: { type: 'Age', maxAge: Math.round(days) * 86_400 } },
    }
    setLifecycleDraft((current) => [...current, rule])
    setLifecycleOpen(false)
  }

  async function attachDomain(): Promise<void> {
    if (!domainDraft.trim() || !domainZone) return
    setBusy('domain')
    try {
      await storageApi.attachR2CustomDomain(accountId, bucket, {
        domain: domainDraft.trim(),
        zoneId: domainZone,
        minTLS: domainTls,
      })
      toast({ title: t('cloudflare.storage.r2_settings_saved'), tone: 'success' })
      setDomainOpen(false)
      setDomainDraft('')
      await refreshDomains()
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  async function detachDomain(domain: string): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.storage.r2_domains_remove'),
      description: t('cloudflare.storage.r2_domains_confirm', { domain }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy('domain')
    try {
      await storageApi.detachR2CustomDomain(accountId, bucket, domain)
      toast({ title: t('cloudflare.storage.msg.deleted'), tone: 'success' })
      await refreshDomains()
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  const zoneOptions = zones.map((zone) => ({ value: zone.id, label: zone.name }))

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('cloudflare.storage.r2_settings_title', { bucket })}
      width={900}
      dismissible={busy === null}
      footer={<Button variant="ghost" onClick={onClose}>{uiT('common.close')}</Button>}
    >
      <div className="max-h-[72vh] space-y-3 overflow-y-auto pr-1">
        {loading && !settings ? <Loader2 size={16} className="mx-auto my-6 animate-spin text-[var(--text-tertiary)]" /> : null}
        {error && !settings ? <StorageError message={error} onRetry={() => { void load() }} /> : null}
        {settings ? (
          <>
            <Section
              title={t('cloudflare.storage.r2_settings_cors')}
              action={(
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Plus size={13} />}
                    disabled={readOnly}
                    onClick={() => setCorsOpen(true)}
                  >
                    {t('cloudflare.storage.r2_cors_add')}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy === 'cors'}
                    disabled={readOnly}
                    onClick={() => { void saveCors() }}
                  >
                    {t('cloudflare.storage.r2_cors_save')}
                  </Button>
                </div>
              )}
            >
              {corsDraft.length === 0 ? (
                <Empty compact title={t('cloudflare.storage.r2_cors_empty')} />
              ) : (
                <TableScroll label={t('cloudflare.storage.r2_settings_cors')}>
                  <Table>
                    <THead><Tr>
                      <Th>{t('cloudflare.storage.r2_cors_origins')}</Th>
                      <Th>{t('cloudflare.storage.r2_cors_methods')}</Th>
                      <Th>{t('cloudflare.storage.r2_cors_headers_col')}</Th>
                      <Th>{t('cloudflare.storage.r2_cors_max_age')}</Th>
                      <Th sticky>{uiT('common.more_actions')}</Th>
                    </Tr></THead>
                    <TBody>
                      {corsDraft.map((rule, index) => (
                        <Tr key={index}>
                          <Td className="max-w-60 font-mono text-[length:var(--text-11-5)]">
                            {originsOf(rule).join(', ') || '—'}
                          </Td>
                          <Td className="font-mono text-[length:var(--text-11-5)]">
                            {methodsOf(rule).join(', ') || '—'}
                          </Td>
                          <Td className="max-w-40 truncate font-mono text-[length:var(--text-11-5)]">
                            {(rule.allowed?.headers ?? []).join(', ') || '—'}
                          </Td>
                          <Td className="tabular-nums">{rule.maxAgeSeconds ?? '—'}</Td>
                          <Td sticky>
                            <IconButton
                              label={uiT('common.delete')}
                              size="xs"
                              disabled={readOnly}
                              onClick={() => setCorsDraft((current) => current.filter((_, position) => position !== index))}
                            >
                              <Trash2 size={13} />
                            </IconButton>
                          </Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </TableScroll>
              )}
            </Section>

            <Section title={t('cloudflare.storage.r2_settings_managed')}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                    {settings.managed_domain.domain || t('cloudflare.storage.r2_settings_managed_unavailable')}
                  </p>
                  <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                    {t('cloudflare.storage.r2_settings_managed_hint')}
                  </p>
                </div>
                <Switch
                  checked={settings.managed_domain.enabled}
                  disabled={readOnly || busy === 'managed'}
                  label={t('cloudflare.storage.r2_settings_managed')}
                  onChange={(next) => { void toggleManaged(next) }}
                />
              </div>
            </Section>

            <Section
              title={t('cloudflare.storage.r2_settings_domains')}
              action={(
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Plus size={13} />}
                  disabled={readOnly}
                  onClick={() => setDomainOpen(true)}
                >
                  {t('cloudflare.storage.r2_domains_add')}
                </Button>
              )}
            >
              {settings.custom_domains.length === 0 ? (
                <Empty compact title={t('cloudflare.storage.r2_domains_empty')} />
              ) : (
                <TableScroll label={t('cloudflare.storage.r2_settings_domains')}>
                  <Table>
                    <THead><Tr>
                      <Th>{t('cloudflare.storage.r2_domains_domain')}</Th>
                      <Th>{t('cloudflare.storage.r2_domains_status')}</Th>
                      <Th>{t('cloudflare.storage.r2_domains_zone')}</Th>
                      <Th>{t('cloudflare.storage.r2_domains_min_tls')}</Th>
                      <Th sticky>{uiT('common.more_actions')}</Th>
                    </Tr></THead>
                    <TBody>
                      {settings.custom_domains.map((domain) => (
                        <Tr key={domain.domain}>
                          <Td className="font-mono text-[length:var(--text-11-5)]">{domain.domain}</Td>
                          <Td>
                            <div className="flex flex-wrap gap-1">
                              <Badge tone={domain.status.ownership === 'active' ? 'success' : 'neutral'}>
                                {domain.status.ownership || 'unknown'}
                              </Badge>
                              <Badge tone={domain.status.ssl === 'active' ? 'success' : 'neutral'}>
                                {domain.status.ssl || 'unknown'}
                              </Badge>
                            </div>
                          </Td>
                          <Td className="text-[var(--text-tertiary)]">{domain.zoneName || domain.zoneId || '—'}</Td>
                          <Td className="tabular-nums">{domain.minTLS || '—'}</Td>
                          <Td sticky>
                            <IconButton
                              label={t('cloudflare.storage.r2_domains_remove')}
                              size="xs"
                              disabled={readOnly || busy === 'domain'}
                              onClick={() => { void detachDomain(domain.domain) }}
                            >
                              <Trash2 size={13} />
                            </IconButton>
                          </Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </TableScroll>
              )}
            </Section>

            <Section
              title={t('cloudflare.storage.r2_settings_lifecycle')}
              action={(
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Plus size={13} />}
                    disabled={readOnly}
                    onClick={() => setLifecycleOpen(true)}
                  >
                    {t('cloudflare.storage.r2_lifecycle_add')}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy === 'lifecycle'}
                    disabled={readOnly}
                    onClick={() => { void saveLifecycle() }}
                  >
                    {t('cloudflare.storage.r2_lifecycle_save')}
                  </Button>
                </div>
              )}
            >
              {lifecycleDraft.length === 0 ? (
                <Empty compact title={t('cloudflare.storage.r2_lifecycle_empty')} />
              ) : (
                <TableScroll label={t('cloudflare.storage.r2_settings_lifecycle')}>
                  <Table>
                    <THead><Tr>
                      <Th>{t('cloudflare.storage.r2_lifecycle_prefix')}</Th>
                      <Th>{t('cloudflare.storage.r2_lifecycle_delete')}</Th>
                      <Th>{t('cloudflare.storage.r2_lifecycle_enabled')}</Th>
                      <Th sticky>{uiT('common.more_actions')}</Th>
                    </Tr></THead>
                    <TBody>
                      {lifecycleDraft.map((rule, index) => (
                        <Tr key={index}>
                          <Td className="font-mono text-[length:var(--text-11-5)]">
                            {rulePrefix(rule) || t('cloudflare.storage.r2_lifecycle_all')}
                          </Td>
                          <Td className="tabular-nums">
                            {rule.deleteObjectsTransition
                              ? rule.deleteObjectsTransition.condition?.type === 'Date'
                                ? rule.deleteObjectsTransition.condition.date ?? '—'
                                : t('cloudflare.storage.r2_lifecycle_delete_after', { days: daysOf(rule) })
                              : '—'}
                          </Td>
                          <Td>
                            <Switch
                              checked={rule.enabled}
                              disabled={readOnly}
                              label={t('cloudflare.storage.r2_lifecycle_enabled')}
                              onChange={(next) => setLifecycleDraft((current) => current.map((item, position) => (
                                position === index ? { ...item, enabled: next } : item
                              )))}
                            />
                          </Td>
                          <Td sticky>
                            <IconButton
                              label={uiT('common.delete')}
                              size="xs"
                              disabled={readOnly}
                              onClick={() => setLifecycleDraft((current) => current.filter((_, position) => position !== index))}
                            >
                              <Trash2 size={13} />
                            </IconButton>
                          </Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </TableScroll>
              )}
            </Section>
          </>
        ) : null}
      </div>

      <Modal
        open={corsOpen}
        onClose={() => setCorsOpen(false)}
        title={t('cloudflare.storage.r2_cors_add')}
        width={620}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setCorsOpen(false)}>{uiT('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={corsOrigins.trim().length === 0 || corsMethods.length === 0}
              onClick={addCorsRule}
            >
              {t('cloudflare.storage.r2_cors_add')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={t('cloudflare.storage.r2_cors_origins')}>
            <Textarea
              value={corsOrigins}
              rows={3}
              className="font-mono text-[length:var(--text-11-5)]"
              onChange={(event) => setCorsOrigins(event.target.value)}
            />
          </Field>
          <div>
            <p className="mb-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('cloudflare.storage.r2_cors_methods')}
            </p>
            <div className="flex flex-wrap gap-3">
              {CORS_METHODS.map((method) => (
                <Checkbox
                  key={method}
                  checked={corsMethods.includes(method)}
                  label={method}
                  onChange={(next) => setCorsMethods((current) => (
                    next ? [...current, method] : current.filter((value) => value !== method)
                  ))}
                />
              ))}
            </div>
          </div>
          <Field label={t('cloudflare.storage.r2_cors_headers')}>
            <Textarea
              value={corsHeaders}
              rows={2}
              className="font-mono text-[length:var(--text-11-5)]"
              onChange={(event) => setCorsHeaders(event.target.value)}
            />
          </Field>
          <Field label={t('cloudflare.storage.r2_cors_max_age')}>
            <Input
              type="number"
              min={0}
              max={604800}
              value={corsMaxAge}
              onChange={(event) => setCorsMaxAge(event.target.value)}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={lifecycleOpen}
        onClose={() => setLifecycleOpen(false)}
        title={t('cloudflare.storage.r2_lifecycle_add')}
        width={520}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setLifecycleOpen(false)}>{uiT('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={!Number.isFinite(Number(lifecycleDays)) || Number(lifecycleDays) <= 0}
              onClick={addLifecycleRule}
            >
              {t('cloudflare.storage.r2_lifecycle_add')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={t('cloudflare.storage.r2_lifecycle_prefix')}>
            <Input
              value={lifecyclePrefix}
              className="font-mono text-[length:var(--text-11-5)]"
              onChange={(event) => setLifecyclePrefix(event.target.value)}
            />
          </Field>
          <Field label={t('cloudflare.storage.r2_lifecycle_days')}>
            <Input
              type="number"
              min={1}
              max={3650}
              value={lifecycleDays}
              onChange={(event) => setLifecycleDays(event.target.value)}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={domainOpen}
        onClose={() => setDomainOpen(false)}
        title={t('cloudflare.storage.r2_domains_add')}
        width={560}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setDomainOpen(false)}>{uiT('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={busy === 'domain'}
              disabled={!domainDraft.trim() || !domainZone}
              onClick={() => { void attachDomain() }}
            >
              {t('cloudflare.storage.r2_domains_add')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={t('cloudflare.storage.r2_domains_domain')}>
            <Input
              value={domainDraft}
              placeholder={t('cloudflare.storage.r2_domains_placeholder')}
              className="font-mono text-[length:var(--text-11-5)]"
              onChange={(event) => setDomainDraft(event.target.value)}
            />
          </Field>
          <div>
            <p className="mb-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('cloudflare.storage.r2_domains_zone')}
            </p>
            {zoneOptions.length === 0 ? (
              <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                {t('cloudflare.storage.r2_settings_zone_empty')}
              </p>
            ) : (
              <SelectMenu
                label={t('cloudflare.storage.r2_domains_zone')}
                value={domainZone}
                options={zoneOptions}
                placeholder={t('cloudflare.storage.r2_domains_zone')}
                onChange={setDomainZone}
              />
            )}
          </div>
          <div>
            <p className="mb-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('cloudflare.storage.r2_domains_min_tls')}
            </p>
            <SelectMenu
              label={t('cloudflare.storage.r2_domains_min_tls')}
              value={domainTls}
              options={MIN_TLS_OPTIONS}
              onChange={setDomainTls}
            />
          </div>
        </div>
      </Modal>
    </Modal>
  )
}
