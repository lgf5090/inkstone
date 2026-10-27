/**
 * The accounts an AI tab may send a request through.
 *
 * The request still names an account, but "auto" is the default the route understands, so a failed
 * account list leaves the tab usable and says so once rather than emptying every selector.
 */
import { useEffect, useState } from 'react'
import { useUi } from '../../../../store/ui'
import { accountsApi } from '../../api/accounts'
import { cfErrorText } from '../../api/client'
import { useCfT } from '../../i18n'
import { accountHasAiFeature } from './options'

export interface AiAccountOption {
  label: string
  value: string
}

export function useAiAccounts(): {
  accounts: AiAccountOption[]
  error: string | null
} {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [accounts, setAccounts] = useState<AiAccountOption[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    accountsApi.list({ pageSize: 100, filter: 'active' })
      .then((page) => {
        if (cancelled) return
        setAccounts(page.accounts
          .filter((account) => account.is_active === 1 && accountHasAiFeature(account.enabled_features))
          .map((account) => ({ label: account.name, value: account.id })))
        setError(null)
      })
      .catch((failure: unknown) => {
        if (cancelled) return
        const message = cfErrorText(failure)
        setError(message)
        toast({ title: t('common.action_failed'), description: message, tone: 'danger' })
      })
    return () => { cancelled = true }
  }, [t, toast])

  return { accounts, error }
}
