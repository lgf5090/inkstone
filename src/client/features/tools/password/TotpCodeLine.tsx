import { useEffect, useState } from 'react'
import { Copy } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { IconButton } from '../../../components/primitives'
import { copySecret } from './utils/clipboard'
import { normalizeTotpSecret, totpCode, totpSecondsRemaining } from './utils/totp'

/**
 * The live code for an account's TOTP secret, with the seconds left in the current step.
 *
 * The secret is normalised here rather than on every keystroke: a half-typed secret is not base32
 * and the field must stay editable while it is being pasted.
 */
export function TotpCodeLine({ secret }: { secret: string }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const normalized = normalizeTotpSecret(secret)
  const code = normalized ? totpCode(normalized, now) : null
  if (!code) return null

  const remaining = totpSecondsRemaining(now)

  const handleCopy = () => {
    void copySecret(code).catch(() => {
      useUi.getState().toast({ title: t('tools.password.common.copy_failed'), tone: 'danger' })
    })
  }

  return (
    <div className="mt-1.5 flex items-center gap-2" data-testid="totp-code-line">
      <span
        data-testid="totp-code"
        className="font-mono text-[length:var(--text-15)] font-semibold tracking-[0.25em] text-[var(--text-primary)]"
      >
        {code.slice(0, 3)} {code.slice(3)}
      </span>
      <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        {t('tools.password.account.totp_remaining', { seconds: String(remaining) })}
      </span>
      <IconButton
        label={t('tools.password.account.copy_totp')}
        size="sm"
        variant="ghost"
        onClick={handleCopy}
        data-testid="totp-copy-btn"
      >
        <Copy size={13} />
      </IconButton>
    </div>
  )
}
