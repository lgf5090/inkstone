/**
 * Connecting the optional Netease content account.
 *
 * The QR code is drawn in the browser from the URL the provider sends; polling only asks whether it
 * was scanned. A cookie is sent once and never echoed back. Inkstone's own login is separate and
 * unchanged — this page unlocks personalised music, not the application.
 */
import {
  useCallback,
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Cookie, LogOut, RefreshCw } from 'lucide-react'
import type { MusicAccountStatus } from '@shared/music/api'
import type { MusicAccount as MusicAccountModel } from '@shared/music/model'
import { Badge, Button } from '../../../components/primitives'
import { Field, Input } from '../../../components/form'
import { confirm } from '../../../components/overlay'
import { navigateToAddress } from '../../../lib/app-history'
import { useUi } from '../../../store/ui'
import { musicApi } from '../api'
import { useMusicQuery } from '../query'
import { MusicTabs } from '../components/Tabs'
import { musicText } from '../components/labels'
import { RemoteAvatar } from './parts/P2MediaCard'
import {
  PAGE_STACK,
  QueryError,
  describeError,
  formatDateTime,
  toastFailure,
} from './parts/P2QueryState'

type LoginTab = 'qr' | 'cookie'
type QrPhase = 'creating' | 'waiting' | 'scanned' | 'expired' | 'error'

interface QrCheckAnswer extends MusicAccountStatus {
  status?: string
  message?: string
}

const QR_POLL_MS = 2000

/** A malformed or empty referrer is not a destination; the music home is the fallback. */
function returnToSource(): void {
  const referrer = document.referrer
  if (referrer) {
    try {
      const url = new URL(referrer)
      if (
        url.origin === window.location.origin
        && url.pathname.startsWith('/music')
        && url.pathname !== '/music/login'
      ) {
        window.history.back()
        return
      }
    } catch {
      // The referrer is a diagnostic hint, never a promise; fall through to the home address.
    }
  }
  navigateToAddress('/music')
}

export function LoginPage(): ReactElement {
  const [tab, setTab] = useState<LoginTab>('qr')
  const [qr, setQr] = useState<MusicAccountStatus['qr']>(undefined)
  const [qrPhase, setQrPhase] = useState<QrPhase>('creating')
  const [qrError, setQrError] = useState<string | null>(null)
  const [qrRefresh, setQrRefresh] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [cookie, setCookie] = useState('')
  const [cookieError, setCookieError] = useState<string | null>(null)
  const [cookieSaving, setCookieSaving] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const cookieErrorId = useId()
  const accountQuery = useMusicQuery(() => musicApi.account(), [])

  const completeLogin = useCallback((account: MusicAccountModel): void => {
    useUi.getState().toast({
      title: musicText('music.login.success'),
      description: account.nickname,
      tone: 'success',
    })
    returnToSource()
  }, [])

  useEffect(() => {
    if (tab !== 'qr') return
    let cancelled = false
    setQrPhase('creating')
    setQrError(null)
    setQr(undefined)
    void musicApi.createQr()
      .then((created) => {
        if (cancelled) return
        if (!created) {
          setQrPhase('error')
          setQrError(musicText('music.login.qr_error'))
          return
        }
        setQr(created)
        setNow(Date.now())
        setQrPhase('waiting')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setQrPhase('error')
        setQrError(describeError(error))
      })
    return () => {
      cancelled = true
    }
  }, [tab, qrRefresh])

  useEffect(() => {
    if (tab !== 'qr' || !qr || (qrPhase !== 'waiting' && qrPhase !== 'scanned')) return
    let cancelled = false
    let timer = 0
    const tick = async (): Promise<void> => {
      if (cancelled) return
      if (Date.now() >= qr.expiresAt) {
        setQrPhase('expired')
        return
      }
      try {
        const answer = await musicApi.checkQr(qr.key) as QrCheckAnswer
        if (cancelled) return
        if (answer.account) {
          completeLogin(answer.account)
          return
        }
        if (answer.status === 'expired') {
          setQrPhase('expired')
          return
        }
        if (answer.status === 'scanned') setQrPhase('scanned')
        else setQrPhase('waiting')
        timer = window.setTimeout(() => {
          void tick()
        }, QR_POLL_MS)
      } catch (error) {
        if (cancelled) return
        setQrPhase('error')
        setQrError(describeError(error))
      }
    }
    timer = window.setTimeout(() => {
      void tick()
    }, QR_POLL_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [tab, qr, qrPhase, completeLogin])

  useEffect(() => {
    if (!qr || (qrPhase !== 'waiting' && qrPhase !== 'scanned')) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [qr, qrPhase])

  const secondsLeft = qr ? Math.max(0, Math.ceil((qr.expiresAt - now) / 1000)) : 0

  const submitCookie = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const value = cookie.trim()
    if (!value) {
      setCookieError(musicText('music.login.cookie_required'))
      return
    }
    setCookieSaving(true)
    setCookieError(null)
    try {
      const account = await musicApi.loginCookie(value)
      setCookie('')
      completeLogin(account)
    } catch (error) {
      setCookieError(describeError(error))
    } finally {
      setCookieSaving(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    const approved = await confirm({
      title: musicText('music.login.disconnect_confirm_title'),
      description: musicText('music.login.disconnect_confirm_body'),
      confirmLabel: musicText('music.login.disconnect'),
      tone: 'danger',
    })
    if (!approved) return
    setDisconnecting(true)
    try {
      await musicApi.logoutAccount()
      useUi.getState().toast({ title: musicText('music.login.disconnected_toast'), tone: 'success' })
      accountQuery.reload()
    } catch (error) {
      toastFailure(musicText('music.login.disconnect_failed'), error)
    } finally {
      setDisconnecting(false)
    }
  }

  const account = accountQuery.data?.account ?? null
  const expired = account?.status === 'expired'

  return (
    <section aria-label={musicText('music.page.login')} className={PAGE_STACK}>
      <header className="music-section-header">
        <div className="music-section-header__text">
          <h1 className="music-section-header__title">{musicText('music.page.login')}</h1>
          <p className="music-section-header__description">{musicText('music.login.description')}</p>
        </div>
      </header>

      {accountQuery.status === 'error' && !accountQuery.data ? (
        <QueryError
          title={musicText('music.login.account_error')}
          detail={accountQuery.error}
          onRetry={accountQuery.reload}
        />
      ) : accountQuery.status === 'loading' && !accountQuery.data ? (
        <div className="h-[74px] rounded-[var(--r-md)] bg-[var(--bg-sunken)]" role="status" aria-busy="true" aria-label={musicText('common.loading')} />
      ) : account ? (
        <div className="flex flex-wrap items-center gap-[var(--sp-3)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-4)]">
          <RemoteAvatar src={account.avatarUrl || undefined} name={account.nickname} size={48} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
              {account.nickname}
            </p>
            <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {musicText('music.login.connected_at', { date: formatDateTime(account.updatedAt) })}
            </p>
          </div>
          <Badge tone={expired ? 'warning' : 'success'}>
            {musicText(expired ? 'music.login.expired_badge' : 'music.login.connected_badge')}
          </Badge>
          <Button
            size="sm"
            variant="secondary"
            icon={<LogOut size={13} />}
            loading={disconnecting}
            onClick={() => {
              void disconnect()
            }}
          >
            {musicText('music.login.disconnect')}
          </Button>
        </div>
      ) : (
        <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {musicText('music.login.not_connected')}
        </p>
      )}

      {expired && (
        <p className="rounded-[var(--r-md)] border border-[var(--warning)] px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-12)] text-[var(--warning)]">
          {musicText('music.login.expired')}
        </p>
      )}

      <div className="flex flex-col gap-[var(--sp-3)]">
        <MusicTabs<LoginTab>
          value={tab}
          onChange={setTab}
          label={musicText('music.login.tabs_label')}
          items={[
            { value: 'qr', label: musicText('music.login.tab.qr') },
            { value: 'cookie', label: musicText('music.login.tab.cookie') },
          ]}
        />

        <div role="tabpanel" aria-label={musicText(`music.login.tab.${tab}`)}>
          {tab === 'qr' && (
            <div className="flex flex-col items-center gap-[var(--sp-3)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-5)] text-center">
              {qrPhase === 'creating' && (
                <p className="py-[var(--sp-6)] text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                  {musicText('music.login.qr_creating')}
                </p>
              )}

              {qrPhase === 'error' && (
                <div className="w-full text-start">
                  <QueryError
                    title={musicText('music.login.qr_error')}
                    detail={qrError}
                    onRetry={() => setQrRefresh((value) => value + 1)}
                  />
                </div>
              )}

              {qr && qrPhase !== 'error' && (
                <div
                  role="img"
                  aria-label={musicText('music.login.qr_alt')}
                  className="w-max rounded-[var(--r-md)] bg-[var(--bg-surface)] p-[var(--sp-3)] ring-1 ring-[var(--border-subtle)]"
                >
                  {/* A scanner reads these two colours; they are fixed rather than themed. */}
                  <QRCodeSVG value={qr.url} size={192} level="M" bgColor="#ffffff" fgColor="#000000" />
                </div>
              )}

              {qrPhase === 'waiting' && (
                <div className="flex flex-col items-center gap-[var(--sp-1)]">
                  <p className="text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]">
                    {musicText('music.login.qr_waiting')}
                  </p>
                  <p className="text-[length:var(--text-11)] tabular text-[var(--text-tertiary)]">
                    {musicText('music.login.qr_expires', { seconds: secondsLeft })}
                  </p>
                </div>
              )}

              {qrPhase === 'scanned' && (
                <div className="flex flex-col items-center gap-[var(--sp-1)]">
                  <p className="text-[length:var(--text-13)] font-medium text-[var(--accent)]">
                    {musicText('music.login.qr_scanned')}
                  </p>
                  <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                    {musicText('music.login.qr_confirm')}
                  </p>
                </div>
              )}

              {qrPhase === 'expired' && (
                <p className="text-[length:var(--text-13)] font-medium text-[var(--warning)]">
                  {musicText('music.login.qr_expired')}
                </p>
              )}

              {account && qrPhase !== 'error' && (
                <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {musicText('music.login.qr_replace_hint')}
                </p>
              )}

              <Button
                variant="secondary"
                size="sm"
                icon={<RefreshCw size={13} />}
                onClick={() => setQrRefresh((value) => value + 1)}
              >
                {musicText('music.login.qr_refresh')}
              </Button>
            </div>
          )}

          {tab === 'cookie' && (
            <form
              onSubmit={(event) => {
                void submitCookie(event)
              }}
              className="flex max-w-[640px] flex-col gap-[var(--sp-3)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-4)]"
            >
              <Field
                label={musicText('music.login.cookie_label')}
                hint={musicText('music.login.cookie_hint')}
                required
              >
                <Input
                  type="password"
                  name="netease-cookie"
                  autoComplete="off"
                  spellCheck={false}
                  value={cookie}
                  invalid={Boolean(cookieError)}
                  aria-describedby={cookieError ? cookieErrorId : undefined}
                  onChange={(event) => setCookie(event.target.value)}
                  leading={<Cookie size={14} />}
                />
              </Field>
              {cookieError && (
                <p id={cookieErrorId} role="alert" className="break-words text-[length:var(--text-11-5)] leading-relaxed text-[var(--danger)]">
                  {cookieError}
                </p>
              )}
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  loading={cookieSaving}
                  disabled={!cookie.trim()}
                >
                  {musicText('music.login.cookie_submit')}
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </section>
  )
}
