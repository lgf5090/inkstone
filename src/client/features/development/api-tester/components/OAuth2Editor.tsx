import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, Loader2, Trash2, XCircle } from 'lucide-react'
import type { OAuth2Config } from '@shared/development/api-tester/types'
import { Input } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'
import { exchangeOAuthToken, errorMessage } from '../api'

function codeFromCallback(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    const fromQuery = url.searchParams.get('code')
    if (fromQuery) return fromQuery
    if (url.hash) return new URLSearchParams(url.hash.replace(/^#/, '')).get('code')
    return null
  } catch {
    return /\s/.test(trimmed) ? null : trimmed
  }
}

export function OAuth2Editor({ config, onChange }: { config: OAuth2Config; onChange: (config: OAuth2Config) => void }) {
  const id = useId()
  const [showSecret, setShowSecret] = useState(false)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [exchanging, setExchanging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!config.expiresAt) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [config.expiresAt])

  const redirectUri = typeof window === 'undefined' ? '' : window.location.origin + window.location.pathname

  const authUrlWithParams = useMemo(() => {
    if (!config.authUrl) return ''
    try {
      const url = new URL(config.authUrl)
      url.searchParams.set('response_type', 'code')
      if (config.clientId) url.searchParams.set('client_id', config.clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      if (config.scope) url.searchParams.set('scope', config.scope)
      url.searchParams.set('state', `oauth2_${Date.now()}`)
      return url.toString()
    } catch {
      return ''
    }
  }, [config.authUrl, config.clientId, config.scope, redirectUri])

  const update = (patch: Partial<OAuth2Config>) => onChange({ ...config, ...patch })

  const hasToken = Boolean(config.accessToken)
  const expired = Boolean(config.expiresAt && now >= config.expiresAt)

  const tokenStatus = (() => {
    if (!hasToken) return t('development.apitester.not_obtained')
    if (expired) return t('development.apitester.expired')
    if (config.expiresAt) {
      return t('development.apitester.expires_in_sec', {
        sec: Math.max(0, Math.ceil((config.expiresAt - now) / 1_000)),
      })
    }
    return t('development.apitester.valid')
  })()

  const applyToken = (data: { accessToken: string; refreshToken?: string; tokenType?: string; expiresIn?: number }) => {
    update({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || undefined,
      tokenType: data.tokenType || 'Bearer',
      expiresAt: data.expiresIn ? Date.now() + data.expiresIn * 1_000 : undefined,
    })
  }

  const exchange = async () => {
    setError(null)
    const code = codeFromCallback(callbackUrl)
    if (!code) {
      setError(t('development.apitester.code_extract_failed'))
      return
    }
    if (!config.tokenUrl) {
      setError(t('development.apitester.token_url_required'))
      return
    }
    setExchanging(true)
    try {
      const data = await exchangeOAuthToken({
        tokenUrl: config.tokenUrl,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code,
        redirectUri,
      })
      if (data.error) {
        setError(data.errorDescription ? `${data.error}: ${data.errorDescription}` : data.error)
        return
      }
      if (!data.accessToken) {
        setError(t('development.apitester.no_access_token'))
        return
      }
      applyToken({ ...data, accessToken: data.accessToken })
      setCallbackUrl('')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setExchanging(false)
    }
  }

  const refresh = async () => {
    if (!config.refreshToken || !config.tokenUrl) return
    setError(null)
    setExchanging(true)
    try {
      const data = await exchangeOAuthToken({
        tokenUrl: config.tokenUrl,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        grantType: 'refresh_token',
        refreshToken: config.refreshToken,
      })
      if (data.error) {
        setError(data.errorDescription ? `${data.error}: ${data.errorDescription}` : data.error)
        return
      }
      if (!data.accessToken) {
        setError(t('development.apitester.no_access_token'))
        return
      }
      applyToken({ ...data, accessToken: data.accessToken })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setExchanging(false)
    }
  }

  const field = (label: string, control: ReactNode) => (
    <div className="space-y-1">
      <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</span>
      {control}
    </div>
  )

  return (
    <div className="mt-2 space-y-2 border-t border-[var(--border-subtle)] pt-2">
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--text-12)]">
        <KeyRound size={13} className="text-[var(--text-tertiary)]" aria-hidden="true" />
        <span className="text-[var(--text-tertiary)]">{t('development.apitester.token_status')}</span>
        <span
          aria-live="polite"
          className={
            hasToken && !expired
              ? 'flex items-center gap-1 text-[var(--success)]'
              : hasToken && expired
                ? 'flex items-center gap-1 text-[var(--warning)]'
                : 'text-[var(--text-tertiary)]'
          }
        >
          {hasToken && !expired && <CheckCircle2 size={12} aria-hidden="true" />}
          {hasToken && expired && <XCircle size={12} aria-hidden="true" />}
          {tokenStatus}
        </span>
        {hasToken && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto gap-1 text-[var(--danger)]"
            icon={<Trash2 size={12} />}
            onClick={() => update({ accessToken: '', refreshToken: undefined, expiresAt: undefined })}
          >
            {t('development.apitester.clear_token')}
          </Button>
        )}
        {hasToken && config.refreshToken && (
          <Button
            size="sm"
            variant="ghost"
            className="gap-1"
            disabled={exchanging}
            icon={exchanging ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
            onClick={() => void refresh()}
          >
            {t('development.apitester.refresh_token')}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={`${id}-auth-url`} className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('development.apitester.auth_url')}
          </label>
          <Input
            id={`${id}-auth-url`}
            value={config.authUrl}
            className="h-8 font-mono text-[length:var(--text-12)]"
            onChange={(event) => update({ authUrl: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-token-url`} className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('development.apitester.token_url')}
          </label>
          <Input
            id={`${id}-token-url`}
            value={config.tokenUrl}
            className="h-8 font-mono text-[length:var(--text-12)]"
            onChange={(event) => update({ tokenUrl: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-client-id`} className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('development.apitester.client_id')}
          </label>
          <Input
            id={`${id}-client-id`}
            value={config.clientId}
            className="h-8 font-mono text-[length:var(--text-12)]"
            onChange={(event) => update({ clientId: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-client-secret`} className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('development.apitester.client_secret')}
          </label>
          <Input
            id={`${id}-client-secret`}
            value={config.clientSecret}
            type={showSecret ? 'text' : 'password'}
            className="h-8 font-mono text-[length:var(--text-12)]"
            onChange={(event) => update({ clientSecret: event.target.value })}
          />
        </div>
      </div>

      {field(
        t('development.apitester.scope'),
        <Input
          aria-label={t('development.apitester.scope')}
          value={config.scope}
          className="h-8 font-mono text-[length:var(--text-12)]"
          onChange={(event) => update({ scope: event.target.value })}
        />,
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<ExternalLink size={12} />}
          disabled={!authUrlWithParams}
          onClick={() => window.open(authUrlWithParams, '_blank', 'popup=yes,width=600,height=700,noopener')}
        >
          {t('development.apitester.authorize')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={showSecret}
          icon={showSecret ? <EyeOff size={12} /> : <Eye size={12} />}
          onClick={() => setShowSecret((current) => !current)}
        >
          {showSecret ? t('development.apitester.hide_secret') : t('development.apitester.show_secret')}
        </Button>
      </div>

      <div className="space-y-1 border-t border-[var(--border-subtle)] pt-2">
        <label htmlFor={`${id}-callback`} className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('development.apitester.callback_url_hint')}
        </label>
        <div className="flex items-center gap-1.5">
          <Input
            id={`${id}-callback`}
            value={callbackUrl}
            className="h-8 min-w-0 flex-1 font-mono text-[length:var(--text-12)]"
            onChange={(event) => setCallbackUrl(event.target.value)}
          />
          <Button
            size="sm"
            className="shrink-0"
            disabled={exchanging || !callbackUrl}
            icon={exchanging ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
            onClick={() => void exchange()}
          >
            {t('development.apitester.get_token')}
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2 py-1 text-[length:var(--text-11)] text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  )
}
