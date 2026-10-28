import { useMemo, useState } from 'react'
import { Select } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'
import type { HttpRequestConfig, RequestKind } from '@shared/development/api-tester/types'
import {
  CODEGEN_LANGUAGES,
  generateCode,
  type CodegenRequest,
} from '../lib/codegen'
import { CodeBlock } from './CodeBlock'

const LANG_GROUPS = (() => {
  const groups = new Map<string, typeof CODEGEN_LANGUAGES>()
  for (const language of CODEGEN_LANGUAGES) {
    const list = groups.get(language.category) ?? []
    list.push(language)
    groups.set(language.category, list)
  }
  return Array.from(groups.entries())
})()

/** Request configuration → the generator's flat input shape. */
function toCodegenRequest(request: HttpRequestConfig, kind: RequestKind): CodegenRequest {
  const headers = request.headers
    .filter((header) => header.enabled && header.key)
    .map((header) => ({ key: header.key, value: header.value, enabled: true }))
  const queryParams = request.params
    .filter((param) => param.enabled && param.key)
    .map((param) => ({ key: param.key, value: param.value, enabled: true }))

  let body = ''
  let bodyType: CodegenRequest['bodyType'] = 'none'

  if (kind === 'graphql') {
    let variables: unknown = null
    try {
      variables = request.graphqlVariables ? JSON.parse(request.graphqlVariables) : null
    } catch (error) {
      // Invalid variables are a user mistake, not a generator failure: send the raw text as null.
      console.warn('[inkstone] API Tester GraphQL variables are not valid JSON', error)
      variables = null
    }
    body = JSON.stringify({ query: request.graphqlQuery, variables }, null, 2)
    bodyType = 'json'
  } else {
    switch (request.bodyType) {
      case 'json':
        body = request.body
        bodyType = 'json'
        break
      case 'raw':
        body = request.body
        bodyType = 'raw'
        break
      case 'binary':
        body = request.body
        bodyType = 'binary'
        break
      case 'form-urlencoded':
        body = request.formFields
          .filter((field) => field.enabled && field.key)
          .map((field) => `${encodeURIComponent(field.key)}=${encodeURIComponent(field.value)}`)
          .join('&')
        bodyType = 'x-www-form-urlencoded'
        break
      case 'form-data':
        body = request.formFields
          .filter((field) => field.enabled && field.key)
          .map((field) => `${field.key}=${field.value}`)
          .join('\n')
        bodyType = 'form-data'
        break
      default:
        bodyType = 'none'
    }
  }

  const auth: CodegenRequest['auth'] =
    request.auth.type === 'none'
      ? undefined
      : request.auth.type === 'bearer'
        ? { type: 'bearer', token: request.auth.token }
        : request.auth.type === 'basic'
          ? { type: 'basic', username: request.auth.username, password: request.auth.password }
          : request.auth.type === 'oauth2' && request.auth.oauth2?.accessToken
            ? { type: 'bearer', token: request.auth.oauth2.accessToken }
            : request.auth.type === 'apikey-header'
              ? { type: 'apikey_header', keyName: request.auth.keyName, keyValue: request.auth.keyValue }
              : { type: 'apikey_query', keyName: request.auth.keyName, keyValue: request.auth.keyValue }

  return {
    method: kind === 'graphql' ? 'POST' : request.method,
    url: request.url,
    headers,
    queryParams,
    body,
    bodyType,
    auth,
  }
}

export function CodegenPanel({
  request,
  kind,
}: {
  request: HttpRequestConfig | null
  kind: RequestKind
}) {
  const [langId, setLangId] = useState('curl')
  const selected = CODEGEN_LANGUAGES.find((language) => language.id === langId)

  const code = useMemo(() => {
    if (!request) return ''
    try {
      return generateCode(langId, toCodegenRequest(request, kind))
    } catch (error) {
      console.warn('[inkstone] API Tester code generation failed', error)
      return t('development.apitester.codegen_failed')
    }
  }, [kind, langId, request])

  return (
    <div className="h-full overflow-y-auto overscroll-contain p-2" data-slot="api-tester-codegen">
      <div className="space-y-2">
        <Select
          value={langId}
          onChange={(event) => setLangId(event.target.value)}
          aria-label={t('development.apitester.codegen_select_lang')}
          className="w-60"
        >
          {LANG_GROUPS.map(([category, languages]) => (
            <optgroup key={category} label={category}>
              {languages.map((language) => (
                <option key={language.id} value={language.id}>
                  {language.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <CodeBlock code={code} lang={langId} label={selected?.label} />
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('development.apitester.codegen_select_lang')}>
          {CODEGEN_LANGUAGES.slice(0, 10).map((language) => (
            <Button
              key={language.id}
              size="sm"
              variant={language.id === langId ? 'secondary' : 'ghost'}
              aria-pressed={language.id === langId}
              className="h-6 px-2 text-[length:var(--text-10-5)]"
              onClick={() => setLangId(language.id)}
            >
              {language.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
