import { useId, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import type { AuthConfig, AuthType, OAuth2Config } from '@shared/development/api-tester/types'
import { Select } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'
import { VariableAutocomplete, type AutocompleteVariable } from './VariableAutocomplete'
import { OAuth2Editor } from './OAuth2Editor'

function emptyOAuth2(): OAuth2Config {
  return {
    authUrl: '',
    tokenUrl: '',
    clientId: '',
    clientSecret: '',
    scope: '',
    accessToken: '',
  }
}

export function AuthEditor({
  auth,
  onChange,
  variables = [],
}: {
  auth: AuthConfig
  onChange: (auth: AuthConfig) => void
  variables?: readonly AutocompleteVariable[]
}) {
  const id = useId()
  const [showSensitive, setShowSensitive] = useState(false)

  const options: Array<{ value: AuthType; label: string }> = [
    { value: 'none', label: t('development.apitester.no_auth') },
    { value: 'bearer', label: t('development.apitester.bearer_token') },
    { value: 'basic', label: t('development.apitester.basic_auth') },
    { value: 'apikey-header', label: t('development.apitester.api_key_header') },
    { value: 'apikey-query', label: t('development.apitester.api_key_query') },
    { value: 'oauth2', label: t('development.apitester.oauth2') },
  ]

  const showToggle =
    auth.type === 'bearer' || auth.type === 'basic' || auth.type === 'apikey-header' || auth.type === 'apikey-query'
  const secretType = showSensitive ? 'text' : 'password'

  return (
    <div className="space-y-2">
      <Select
        aria-label={t('development.apitester.auth')}
        value={auth.type}
        className="h-8 w-56 text-[length:var(--text-12)]"
        onChange={(event) => onChange({ ...auth, type: event.target.value as AuthType })}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>

      {auth.type === 'bearer' && (
        <div className="space-y-1">
          <label htmlFor={`${id}-token`} className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('development.apitester.token')}
          </label>
          <VariableAutocomplete
            id={`${id}-token`}
            value={auth.token}
            variables={variables}
            type={secretType}
            className="h-8 font-mono text-[length:var(--text-12)]"
            onValueChange={(token) => onChange({ ...auth, token })}
          />
        </div>
      )}

      {auth.type === 'basic' && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={`${id}-username`} className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('development.apitester.username')}
            </label>
            <VariableAutocomplete
              id={`${id}-username`}
              value={auth.username}
              variables={variables}
              className="h-8 font-mono text-[length:var(--text-12)]"
              onValueChange={(username) => onChange({ ...auth, username })}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-password`} className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('development.apitester.password')}
            </label>
            <VariableAutocomplete
              id={`${id}-password`}
              value={auth.password}
              variables={variables}
              type={secretType}
              className="h-8 font-mono text-[length:var(--text-12)]"
              onValueChange={(password) => onChange({ ...auth, password })}
            />
          </div>
        </div>
      )}

      {(auth.type === 'apikey-header' || auth.type === 'apikey-query') && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={`${id}-key-name`} className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('development.apitester.key_name_label')}
            </label>
            <VariableAutocomplete
              id={`${id}-key-name`}
              value={auth.keyName}
              variables={variables}
              className="h-8 font-mono text-[length:var(--text-12)]"
              onValueChange={(keyName) => onChange({ ...auth, keyName })}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-key-value`} className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('development.apitester.key_value_label')}
            </label>
            <VariableAutocomplete
              id={`${id}-key-value`}
              value={auth.keyValue}
              variables={variables}
              type={secretType}
              className="h-8 font-mono text-[length:var(--text-12)]"
              onValueChange={(keyValue) => onChange({ ...auth, keyValue })}
            />
          </div>
        </div>
      )}

      {showToggle && (
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={showSensitive}
          icon={showSensitive ? <EyeOff size={13} /> : <Eye size={13} />}
          onClick={() => setShowSensitive((current) => !current)}
        >
          {showSensitive ? t('development.apitester.hide_sensitive') : t('development.apitester.show_sensitive')}
        </Button>
      )}

      {auth.type === 'oauth2' && (
        <OAuth2Editor config={auth.oauth2 ?? emptyOAuth2()} onChange={(oauth2) => onChange({ ...auth, oauth2 })} />
      )}
    </div>
  )
}
