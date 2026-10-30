import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Copy, Check, FlaskConical, Globe, KeyRound, RotateCcw, Save, Server, Settings2, ShieldCheck, SquareTerminal } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import type { XgetSettings } from '@shared/development/xget/types'
import { XGET_CONFIG_DEFAULTS, XGET_CONFIG_LIMITS, XGET_KNOWN_METHODS } from '@shared/development/xget/constants'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { copyText } from '../../../../lib/clipboard'
import { Badge, Button } from '../../../../components/primitives'
import { Input, Field, Switch } from '../../../../components/form'
import { confirm } from '../../../../components/overlay'
import { LoadingBlock } from '../../../../components/feedback'
import { useUiStore } from '../../../../lib/ui-store'
import { xgetApi, describeXgetError } from '../api'
import { buildEcosystemCommands } from '../utils/commands'

const ECOSYSTEM_LABEL_KEYS: MessageKey[] = [
  'development.xget.settings.ecosystem.pip',
  'development.xget.settings.ecosystem.npm',
  'development.xget.settings.ecosystem.git',
  'development.xget.settings.ecosystem.hf',
  'development.xget.settings.ecosystem.conda',
  'development.xget.settings.ecosystem.go',
]

interface EngineForm {
  timeout_seconds: string
  max_retries: string
  retry_delay_ms: string
  cache_duration: string
  max_path_length: string
  allowAnonymous: boolean
  methodsText: string
  originsText: string
}

function formFrom(settings: XgetSettings): EngineForm {
  return {
    timeout_seconds: String(settings.config.timeout_seconds),
    max_retries: String(settings.config.max_retries),
    retry_delay_ms: String(settings.config.retry_delay_ms),
    cache_duration: String(settings.config.cache_duration),
    max_path_length: String(settings.config.max_path_length),
    allowAnonymous: settings.config.allow_anonymous,
    methodsText: settings.config.allowed_methods.join(', '),
    originsText: settings.config.allowed_origins.join(', '),
  }
}

function parseMethods(value: string): string[] {
  return [...new Set(value.split(',').map((entry) => entry.trim().toUpperCase()).filter(Boolean))]
}

function parseOrigins(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean)
}

type NumericField = 'timeout_seconds' | 'max_retries' | 'retry_delay_ms' | 'cache_duration' | 'max_path_length'

const NUMERIC_FIELDS: readonly { key: NumericField; range: { readonly min: number; readonly max: number } }[] = [
  { key: 'timeout_seconds', range: XGET_CONFIG_LIMITS.timeoutSeconds },
  { key: 'max_retries', range: XGET_CONFIG_LIMITS.maxRetries },
  { key: 'retry_delay_ms', range: XGET_CONFIG_LIMITS.retryDelayMs },
  { key: 'cache_duration', range: XGET_CONFIG_LIMITS.cacheDuration },
  { key: 'max_path_length', range: XGET_CONFIG_LIMITS.maxPathLength },
]

function parseInteger(value: string, range: { readonly min: number; readonly max: number }): number | null {
  const trimmed = value.trim()
  if (!/^-?\d+$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed >= range.min && parsed <= range.max ? parsed : null
}

function isValidOrigin(value: string): boolean {
  if (value === '*') return true
  try {
    const parsed = new URL(value)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash
    )
  } catch {
    return false
  }
}

function Panel({
  icon,
  title,
  description,
  action,
  children,
}: {
  icon: ReactNode
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
      <header className="flex items-start gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <span className="mt-0.5 text-[var(--accent)]">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{title}</h2>
          {description && <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{description}</p>}
        </div>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

export function SettingsPanel({
  settings,
  loading,
  error,
  onReload,
}: {
  settings: XgetSettings | null
  loading: boolean
  error: string | null
  onReload: () => Promise<void>
}) {
  const [form, setForm] = useState<EngineForm | null>(settings ? formFrom(settings) : null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [tokenSaving, setTokenSaving] = useState(false)
  const [testPath, setTestPath] = useState('/gh/microsoft/vscode')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [copiedKey, setCopiedKey] = useState('')

  useEffect(() => {
    setForm(settings ? formFrom(settings) : null)
    setErrors({})
  }, [settings])

  const ecosystem = useMemo(
    () => (settings ? buildEcosystemCommands(settings.proxy_base_url) : []),
    [settings],
  )

  async function copy(value: string, key: string): Promise<void> {
    const ok = await copyText(value)
    if (!ok) {
      useUiStore.getState().toast(t('development.xget.common.copy_failed'), 'error')
      return
    }
    setCopiedKey(key)
    useUiStore.getState().toast(t('development.xget.common.copied'), 'success')
    window.setTimeout(() => setCopiedKey(''), 1500)
  }

  function clearError(key: string): void {
    setErrors((current) => {
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  function setNumber(key: keyof EngineForm, value: string): void {
    setForm((current) => (current ? { ...current, [key]: value } : current))
    clearError(key)
  }

  async function saveConfig(config: EngineForm): Promise<void> {
    const nextErrors: Record<string, string> = {}
    const numbers = {} as Record<NumericField, number>
    for (const { key, range } of NUMERIC_FIELDS) {
      const parsed = parseInteger(config[key], range)
      if (parsed === null) {
        nextErrors[key] = t('development.xget.settings.invalid_range', {
          min: range.min,
          max: range.max,
        })
      } else {
        numbers[key] = parsed
      }
    }

    const methods = parseMethods(config.methodsText)
    if (!methods.length) {
      nextErrors.methodsText = t('development.xget.settings.invalid_methods')
    } else {
      const known = new Set<string>(XGET_KNOWN_METHODS)
      const unsupported = methods.find((method) => !known.has(method))
      if (unsupported) {
        nextErrors.methodsText = t('development.xget.settings.unsupported_method', {
          method: unsupported,
        })
      }
    }

    const origins = parseOrigins(config.originsText)
    if (!origins.includes('*')) {
      const invalid = origins.find((origin) => !isValidOrigin(origin))
      if (invalid) {
        nextErrors.originsText = t('development.xget.settings.invalid_origin', { origin: invalid })
      }
    }

    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return

    setSaving(true)
    try {
      await xgetApi.saveSettings({
        timeout_seconds: numbers.timeout_seconds,
        max_retries: numbers.max_retries,
        retry_delay_ms: numbers.retry_delay_ms,
        cache_duration: numbers.cache_duration,
        max_path_length: numbers.max_path_length,
        allow_anonymous: config.allowAnonymous,
        allowed_methods: methods,
        allowed_origins: origins,
      })
      setErrors({})
      useUiStore.getState().toast(t('development.xget.settings.saved'), 'success')
      await onReload()
    } catch (cause) {
      useUiStore.getState().toast(`${t('development.xget.settings.save_failed')}: ${describeXgetError(cause)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function resetConfig(): Promise<void> {
    if (!(await confirm({ title: t('development.xget.settings.reset'), description: t('development.xget.settings.reset_confirm'), tone: 'danger' }))) return
    const defaults: EngineForm = {
      timeout_seconds: String(XGET_CONFIG_DEFAULTS.timeout_seconds),
      max_retries: String(XGET_CONFIG_DEFAULTS.max_retries),
      retry_delay_ms: String(XGET_CONFIG_DEFAULTS.retry_delay_ms),
      cache_duration: String(XGET_CONFIG_DEFAULTS.cache_duration),
      max_path_length: String(XGET_CONFIG_DEFAULTS.max_path_length),
      allowAnonymous: XGET_CONFIG_DEFAULTS.allow_anonymous,
      methodsText: XGET_CONFIG_DEFAULTS.allowed_methods.join(', '),
      originsText: XGET_CONFIG_DEFAULTS.allowed_origins.join(', '),
    }
    setForm(defaults)
    await saveConfig(defaults)
  }

  async function saveToken(): Promise<void> {
    setTokenSaving(true)
    try {
      const result = await xgetApi.setToken(tokenInput.trim())
      setTokenInput('')
      useUiStore.getState().toast(
        result.has_proxy_token ? t('development.xget.settings.token_set') : t('development.xget.settings.token_cleared'),
        'success',
      )
      await onReload()
    } catch (cause) {
      useUiStore.getState().toast(`${t('development.xget.settings.token_save_failed')}: ${describeXgetError(cause)}`, 'error')
    } finally {
      setTokenSaving(false)
    }
  }

  async function runTest(): Promise<void> {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await xgetApi.testTarget(testPath.trim())
      const message = t('development.xget.settings.test_ok', { platform: result.platform, url: result.target_url })
      setTestResult({ ok: true, text: message })
    } catch (cause) {
      setTestResult({ ok: false, text: t('development.xget.settings.test_fail', { msg: describeXgetError(cause) }) })
    } finally {
      setTesting(false)
    }
  }

  if (loading && !settings) return <LoadingBlock />
  if (settings && !form) return <LoadingBlock />
  if (!settings || !form) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-4 py-10 text-center">
        <p className="text-[length:var(--text-13)] text-[var(--danger)]">{error ?? t('development.xget.settings.load_failed')}</p>
        <Button variant="secondary" size="sm" onClick={() => void onReload()}>
          {t('development.xget.settings.retry')}
        </Button>
      </div>
    )
  }

  const canManage = settings.can_manage
  const disabled = !canManage || saving
  const errorHint = (key: string) =>
    errors[key] ? (
      <span role="alert" className="text-[var(--danger)]">
        {errors[key]}
      </span>
    ) : undefined

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('development.xget.settings.title')}</h2>
        <p className="mt-0.5 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.xget.settings.subtitle')}</p>
      </div>
      {error && <p className="rounded-[var(--r-md)] border border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      {!canManage && <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.xget.settings.owner_only')}</p>}

      <Panel
        icon={<Server size={16} />}
        title={t('development.xget.settings.instance')}
        description={t('development.xget.settings.instance_desc')}
        action={<Badge>{t('development.xget.settings.platform_count')}: {settings.platform_count}</Badge>}
      >
        <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-3 py-2">
          <Globe size={15} className="shrink-0 text-[var(--text-tertiary)]" />
          <code className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-12)] text-[var(--text-primary)]" title={t('development.xget.settings.base_url')}>{settings.proxy_base_url}</code>
          <Button variant="ghost" size="sm" aria-label={t('development.xget.common.copy')} onClick={() => void copy(settings.proxy_base_url, 'base')} className="h-7 px-1.5">
            {copiedKey === 'base' ? <Check size={14} className="text-[var(--success)]" /> : <Copy size={14} />}
          </Button>
        </div>
      </Panel>

      <Panel icon={<Settings2 size={16} />} title={t('development.xget.settings.engine')} description={t('development.xget.settings.engine_desc')}>
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <Field label={t('development.xget.settings.timeout_seconds')} hint={errorHint('timeout_seconds') ?? t('development.xget.settings.timeout_seconds_desc')}>
            <Input type="number" min={1} max={120} value={form.timeout_seconds} disabled={disabled} invalid={Boolean(errors.timeout_seconds)} onChange={(event) => setNumber('timeout_seconds', event.target.value)} />
          </Field>
          <Field label={t('development.xget.settings.max_retries')} hint={errorHint('max_retries') ?? t('development.xget.settings.max_retries_desc')}>
            <Input type="number" min={1} max={10} value={form.max_retries} disabled={disabled} invalid={Boolean(errors.max_retries)} onChange={(event) => setNumber('max_retries', event.target.value)} />
          </Field>
          <Field label={t('development.xget.settings.retry_delay_ms')} hint={errorHint('retry_delay_ms')}>
            <Input type="number" min={0} max={30000} value={form.retry_delay_ms} disabled={disabled} invalid={Boolean(errors.retry_delay_ms)} onChange={(event) => setNumber('retry_delay_ms', event.target.value)} />
          </Field>
          <Field label={t('development.xget.settings.cache_duration')} hint={errorHint('cache_duration') ?? t('development.xget.settings.cache_duration_desc')}>
            <Input type="number" min={1} max={86400} value={form.cache_duration} disabled={disabled} invalid={Boolean(errors.cache_duration)} onChange={(event) => setNumber('cache_duration', event.target.value)} />
          </Field>
          <Field label={t('development.xget.settings.allowed_methods')} hint={errorHint('methodsText') ?? t('development.xget.settings.allowed_methods_desc')}>
            <Input
              value={form.methodsText}
              disabled={disabled}
              invalid={Boolean(errors.methodsText)}
              className="font-mono"
              onChange={(event) => {
                setForm({ ...form, methodsText: event.target.value })
                clearError('methodsText')
              }}
            />
          </Field>
          <Field label={t('development.xget.settings.allowed_origins')} hint={errorHint('originsText') ?? t('development.xget.settings.allowed_origins_desc')}>
            <Input
              value={form.originsText}
              disabled={disabled}
              invalid={Boolean(errors.originsText)}
              className="font-mono"
              onChange={(event) => {
                setForm({ ...form, originsText: event.target.value })
                clearError('originsText')
              }}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t('development.xget.settings.max_path_length')} hint={errorHint('max_path_length') ?? t('development.xget.settings.max_path_length_desc')}>
              <Input type="number" min={1} max={8192} value={form.max_path_length} disabled={disabled} invalid={Boolean(errors.max_path_length)} className="sm:max-w-56" onChange={(event) => setNumber('max_path_length', event.target.value)} />
            </Field>
          </div>
        </div>
        <div className="mt-4 flex items-start justify-between gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('development.xget.settings.allow_anonymous')}</p>
            <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.xget.settings.allow_anonymous_desc')}</p>
          </div>
          <Switch
            checked={form.allowAnonymous}
            disabled={disabled}
            onChange={(next) => setForm({ ...form, allowAnonymous: next })}
            label={t('development.xget.settings.allow_anonymous')}
          />
        </div>
        <div className="mt-5 flex items-center gap-2">
          <Button variant="primary" size="sm" icon={<Save size={14} />} loading={saving} disabled={disabled} onClick={() => void saveConfig(form)}>
            {t('development.xget.settings.save')}
          </Button>
          <Button variant="secondary" size="sm" icon={<RotateCcw size={14} />} disabled={disabled} onClick={() => void resetConfig()}>
            {t('development.xget.settings.reset')}
          </Button>
        </div>
      </Panel>

      <Panel
        icon={<ShieldCheck size={16} />}
        title={t('development.xget.settings.access')}
        description={t('development.xget.settings.access_desc')}
        action={<Badge tone={settings.has_proxy_token ? 'success' : 'neutral'}>{settings.has_proxy_token ? t('development.xget.settings.token_on') : t('development.xget.settings.token_off')}</Badge>}
      >
        {!settings.has_proxy_token && form.allowAnonymous && <p className="mb-2 text-[length:var(--text-11)] text-[var(--warning)]">{t('development.xget.settings.open_warning')}</p>}
        {!settings.has_proxy_token && !form.allowAnonymous && <p className="mb-2 text-[length:var(--text-11)] text-[var(--warning)]">{t('development.xget.settings.closed_no_token_warning')}</p>}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <Input
              type="password"
              value={tokenInput}
              disabled={!canManage || tokenSaving}
              onChange={(event) => setTokenInput(event.target.value)}
              aria-label={t('development.xget.settings.token_label')}
              placeholder={settings.has_proxy_token ? t('development.xget.settings.token_placeholder') : t('development.xget.settings.token_label')}
              leading={<KeyRound size={15} />}
              className="font-mono"
            />
          </div>
          <Button variant="secondary" size="sm" icon={<Save size={14} />} loading={tokenSaving} disabled={!canManage || tokenSaving} onClick={() => void saveToken()}>
            {t('development.xget.settings.save')}
          </Button>
        </div>
        <p className="mt-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.xget.settings.token_hint')}</p>
        <code className="mt-2 block rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-2.5 py-2 font-mono text-[length:var(--text-11)] text-[var(--text-primary)]">
          {'X-Xget-Token: <token>'}
        </code>
        <p className="mt-2 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{t('development.xget.settings.token_carrier_hint')}</p>
        <p className="mt-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{t('development.xget.settings.token_git_hint')}</p>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel icon={<FlaskConical size={16} />} title={t('development.xget.settings.test')} description={t('development.xget.settings.test_desc')}>
          <div className="flex gap-2">
            <Input
              value={testPath}
              onChange={(event) => setTestPath(event.target.value)}
              onKeyUp={(event) => {
                if (event.key === 'Enter') void runTest()
              }}
              aria-label={t('development.xget.settings.test')}
              placeholder={t('development.xget.settings.test_path_placeholder')}
              className="font-mono"
            />
            <Button variant="secondary" size="sm" icon={<RotateCcw size={14} className={cn(testing && 'animate-spin')} />} disabled={testing} onClick={() => void runTest()}>
              {testing ? t('development.xget.settings.testing') : t('development.xget.settings.test_run')}
            </Button>
          </div>
          {testResult && (
            <div
              className={cn(
                'mt-2 rounded-[var(--r-md)] border px-3 py-2 font-mono text-[length:var(--text-11)]',
                testResult.ok
                  ? 'border-[color-mix(in_oklab,var(--success)_30%,transparent)] text-[var(--success)]'
                  : 'border-[color-mix(in_oklab,var(--danger)_30%,transparent)] text-[var(--danger)]',
              )}
            >
              {testResult.text}
            </div>
          )}
        </Panel>

        <Panel icon={<SquareTerminal size={16} />} title={t('development.xget.settings.ecosystem')} description={t('development.xget.settings.ecosystem_desc')}>
          <div className="space-y-2">
            {ecosystem.map((command, index) => (
              <div key={command.command} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-3 py-2">
                <span className="w-28 shrink-0 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
                  {t(ECOSYSTEM_LABEL_KEYS[index] ?? ECOSYSTEM_LABEL_KEYS[0]!)}
                </span>
                <code className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-11)] text-[var(--text-primary)]" title={command.command}>
                  {command.command}
                </code>
                <Button variant="ghost" size="sm" aria-label={t('development.xget.settings.copy_cmd')} onClick={() => void copy(command.command, command.command)} className="h-6 px-1.5">
                  {copiedKey === command.command ? <Check size={13} className="text-[var(--success)]" /> : <Copy size={13} />}
                </Button>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  )
}
