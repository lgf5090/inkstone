import { emailAuthenticationStatus } from '@shared/email/authentication'
import { Badge } from '../../components/primitives'
import { t } from '../../lib/i18n'

const LABEL_KEYS = {
  spf: 'email.auth.spf',
  dkim: 'email.auth.dkim',
  dmarc: 'email.auth.dmarc',
} as const

export function EmailAuthenticationBadge({ headers }: { headers: readonly { key: string, value: string }[] }) {
  const status = emailAuthenticationStatus(headers)
  const entries = Object.entries(status) as Array<[keyof typeof status, string]>
  if (!entries.length) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {entries.map(([mechanism, result]) => (
        <Badge key={mechanism} tone={result === 'pass' ? 'success' : result === 'fail' ? 'danger' : 'warning'}>
          {t(LABEL_KEYS[mechanism])}: {t(result === 'pass' ? 'email.auth.pass' : result === 'fail' ? 'email.auth.fail' : 'email.auth.neutral')}
        </Badge>
      ))}
    </span>
  )
}
