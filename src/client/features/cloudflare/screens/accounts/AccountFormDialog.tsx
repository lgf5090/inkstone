/**
 * One dialog for adding and editing an account.
 *
 * On an edit the token fields start empty and an empty field means "keep what is stored", which is
 * why the placeholders say so. The API patch only sends what the reader typed, so an untouched field
 * cannot accidentally clear a credential. Switching the auth type is the one case that needs a fresh
 * value, and the route says which one is missing.
 */
import { useEffect, useState, type FormEvent } from 'react'
import {
  CLOUDFLARE_FEATURES,
  type CloudflareAccount,
  type CloudflareAuthType,
  type CloudflareFeature,
} from '@shared/cloudflare/model'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { Button } from '../../../../components/primitives'
import { Checkbox, Field, Input, Segmented } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { accountsApi, type AccountInput, type AccountUpdateInput } from '../../api/accounts'
import { cfErrorText } from '../../api/client'
import { cfT } from '../../i18n'
import { enabledFeatures, featureLabel } from './labels'

const FORM_ID = 'cloudflare-account-form'

export function AccountFormDialog({
  open,
  account,
  onClose,
  onSaved,
}: {
  open: boolean
  account: CloudflareAccount | null
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useUi((state) => state.toast)
  const [name, setName] = useState('')
  const [authType, setAuthType] = useState<CloudflareAuthType>('token')
  const [token, setToken] = useState('')
  const [email, setEmail] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [features, setFeatures] = useState<CloudflareFeature[]>([...CLOUDFLARE_FEATURES])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(account?.name ?? '')
    setAuthType(account?.auth_type ?? 'token')
    setToken('')
    setEmail('')
    setApiKey('')
    setFeatures(account ? enabledFeatures(account.enabled_features) : [...CLOUDFLARE_FEATURES])
    setBusy(false)
    setError(null)
  }, [open, account])

  function toggleFeature(feature: CloudflareFeature, next: boolean): void {
    setFeatures((previous) => {
      if (next) return previous.includes(feature) ? previous : [...previous, feature]
      return previous.filter((item) => item !== feature)
    })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!name.trim()) {
      toast({ title: cfT('cloudflare.accounts.msg.name_required'), tone: 'warning' })
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (account) {
        const patch: AccountUpdateInput = { name: name.trim(), auth_type: authType }
        if (authType === 'token') {
          if (token.trim()) patch.api_token = token.trim()
        } else {
          if (email.trim()) patch.email = email.trim()
          if (apiKey.trim()) patch.api_key = apiKey.trim()
        }
        await accountsApi.update(account.id, patch)
        toast({ title: cfT('cloudflare.accounts.msg.update_success'), tone: 'success' })
      } else {
        const input: AccountInput = {
          name: name.trim(),
          auth_type: authType,
          enabled_features: features.join(','),
        }
        if (authType === 'token') {
          input.api_token = token.trim()
        } else {
          input.email = email.trim()
          input.api_key = apiKey.trim()
        }
        await accountsApi.create(input)
        toast({ title: cfT('cloudflare.accounts.msg.add_success'), tone: 'success' })
      }
      onSaved()
      onClose()
    } catch (caught) {
      const message = cfErrorText(caught)
      setError(message)
      toast({ title: t('common.action_failed'), description: message, tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const emailPlaceholder = account
    ? account.email
      ? cfT('cloudflare.accounts.email_edit_with_original', { email: account.email })
      : cfT('cloudflare.accounts.email_edit_placeholder')
    : cfT('cloudflare.accounts.email_placeholder')

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={account ? cfT('cloudflare.accounts.edit_modal_title') : cfT('cloudflare.accounts.add_modal_title')}
      width={520}
      dismissible={!busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button type="submit" form={FORM_ID} loading={busy}>
            {account ? t('common.save') : cfT('cloudflare.accounts.add_account')}
          </Button>
        </>
      )}
    >
      <form id={FORM_ID} onSubmit={(event) => { void handleSubmit(event) }} className="grid gap-3">
        <Field label={cfT('cloudflare.accounts.account_name')} required>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={cfT('cloudflare.accounts.account_name_placeholder')}
            autoComplete="off"
            maxLength={120}
            required
          />
        </Field>

        <Field label={cfT('cloudflare.accounts.auth_type')}>
          <Segmented
            value={authType}
            onChange={setAuthType}
            label={cfT('cloudflare.accounts.auth_type')}
            options={[
              { value: 'token', label: cfT('cloudflare.accounts.auth_type_token') },
              { value: 'global_key', label: cfT('cloudflare.accounts.auth_type_key') },
            ]}
          />
        </Field>

        {authType === 'token' ? (
          <Field label={cfT('cloudflare.accounts.api_token')}>
            <Input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={account
                ? cfT('cloudflare.accounts.api_token_edit_placeholder')
                : cfT('cloudflare.accounts.api_token_placeholder')}
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
            />
          </Field>
        ) : (
          <>
            <Field label={cfT('cloudflare.accounts.email')}>
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={emailPlaceholder}
                autoComplete="off"
                spellCheck={false}
                maxLength={254}
              />
            </Field>
            <Field label={cfT('cloudflare.accounts.api_key')}>
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={account
                  ? cfT('cloudflare.accounts.api_key_edit_placeholder')
                  : cfT('cloudflare.accounts.api_key_placeholder')}
                autoComplete="off"
                spellCheck={false}
                maxLength={4096}
              />
            </Field>
          </>
        )}

        {!account && (
          <fieldset className="space-y-1.5">
            <legend className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {cfT('cloudflare.accounts.enable_features')}
            </legend>
            <div className="flex flex-wrap gap-x-3">
              {CLOUDFLARE_FEATURES.map((feature) => (
                <Checkbox
                  key={feature}
                  checked={features.includes(feature)}
                  onChange={(next) => toggleFeature(feature, next)}
                  label={featureLabel(feature)}
                />
              ))}
            </div>
          </fieldset>
        )}

        {error && (
          <p role="alert" className="rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}
