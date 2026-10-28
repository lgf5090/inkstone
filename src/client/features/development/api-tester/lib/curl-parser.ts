import { defaultRequest, emptyAuth, kv } from '@shared/development/api-tester/state'
import type { HttpMethod, HttpRequestConfig } from '@shared/development/api-tester/types'

/**
 * Warnings are returned as stable codes instead of localized text: the UI owns the translation.
 *
 * - `missing_flag_arg`: a flag that needs a value sits at the end of the command.
 * - `unknown_flag`: a dash-prefixed token is not one of the flags handled below.
 */
export interface CurlWarning {
  code: 'missing_flag_arg' | 'unknown_flag'
  flag?: string
}

export interface CurlParseResult {
  request: HttpRequestConfig
  warnings: CurlWarning[]
}

/**
 * Small shell tokenizer: single quotes, double quotes, backslash escapes and `\` line
 * continuations. It is not a complete POSIX shell parser, but it covers the commands produced by
 * browser developer tools and the common `curl` flags.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let index = 0
  const length = input.length
  let current = ''
  let quote: '"' | "'" | null = null
  while (index < length) {
    const character = input[index]
    if (quote) {
      if (character === '\\') {
        // Inside double quotes only $ ` " \ and newline are escapable; single quotes keep the backslash.
        if (quote === '"') {
          const next = input[index + 1]
          if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
            current += next
            index += 2
            continue
          }
          current += character
          index++
          continue
        }
        current += character
        index++
        continue
      }
      if (character === quote) {
        quote = null
        index++
        continue
      }
      current += character
      index++
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      index++
      continue
    }
    if (character === '\\') {
      const next = input[index + 1]
      if (next === '\n') {
        index += 2
        continue
      }
      current += next ?? ''
      index += 2
      continue
    }
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      index++
      continue
    }
    current += character
    index++
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

export function parseCurl(raw: string): CurlParseResult {
  const warnings: CurlWarning[] = []
  const text = raw.trim().replace(/^curl\s+/i, '')
  const tokens = tokenize(text)
  const request: HttpRequestConfig = {
    ...defaultRequest(),
    headers: [],
    params: [],
    formFields: [],
    auth: emptyAuth(),
    body: '',
    bodyType: 'none',
  }

  let methodSet = false
  let index = 0
  const takeNext = (flag: string): string | null => {
    index++
    if (index >= tokens.length) {
      warnings.push({ code: 'missing_flag_arg', flag })
      return null
    }
    return tokens[index]
  }

  while (index < tokens.length) {
    const token = tokens[index]

    // URL: the first bare http(s) token. Other bare tokens are accepted below as a fallback.
    if (!token.startsWith('-') && /^https?:\/\//i.test(token)) {
      request.url = token
      index++
      continue
    }

    switch (token) {
      case '-X':
      case '--request': {
        const method = takeNext(token)
        if (method) {
          request.method = method.toUpperCase() as HttpMethod
          methodSet = true
        }
        break
      }
      case '-H':
      case '--header': {
        const header = takeNext(token)
        if (header) {
          const separator = header.indexOf(':')
          if (separator > -1) {
            const key = header.slice(0, separator).trim()
            const value = header.slice(separator + 1).trim()
            const lowerKey = key.toLowerCase()
            if (lowerKey === 'content-length') break
            if (lowerKey === 'authorization' && /^bearer\s+/i.test(value)) {
              request.auth = { ...request.auth, type: 'bearer', token: value.replace(/^bearer\s+/i, '') }
              break
            }
            if (lowerKey === 'authorization' && /^basic\s+/i.test(value)) {
              try {
                const decoded = atob(value.replace(/^basic\s+/i, ''))
                const [username, ...rest] = decoded.split(':')
                request.auth = { ...request.auth, type: 'basic', username: username ?? '', password: rest.join(':') }
              } catch {
                // Invalid base64: leave the auth configuration untouched.
              }
              break
            }
            // A repeated header replaces the earlier one, case-insensitively.
            request.headers = request.headers.filter((item) => item.key.toLowerCase() !== lowerKey)
            request.headers.push(kv(key, value, true))
          }
        }
        break
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary': {
        const body = takeNext(token)
        if (body !== null) {
          // Port note: the reference only defaulted to POST when the current method was neither
          // GET nor HEAD. Its default request is GET, so that branch could never run and was
          // removed as behavior-identical dead code.
          request.body = (request.body ? request.body + '&' : '') + body
          request.bodyType = 'raw'
          if (/^\s*[{[]/.test(body)) request.bodyType = 'json'
          if (/^[^=]+=[^&]*(&[^=]+=[^&]*)*$/.test(body) && !body.startsWith('{')) {
            request.bodyType = 'form-urlencoded'
          }
        }
        break
      }
      case '-F':
      case '--form': {
        const field = takeNext(token)
        if (field) {
          const separator = field.indexOf('=')
          if (separator > -1) {
            request.formFields = request.formFields.filter((item) => item.key !== field.slice(0, separator))
            request.formFields.push(kv(field.slice(0, separator), field.slice(separator + 1), true))
            request.bodyType = 'form-data'
            if (!methodSet) {
              request.method = 'POST'
              methodSet = true
            }
          }
        }
        break
      }
      case '-u':
      case '--user': {
        const user = takeNext(token)
        if (user) {
          const [username, ...rest] = user.split(':')
          request.auth = {
            ...request.auth,
            type: 'basic',
            username: username ?? '',
            password: rest.join(':'),
          }
        }
        break
      }
      case '-L':
      case '--location':
      case '-k':
      case '--insecure':
      case '--compressed':
      case '-s':
      case '--silent':
      case '-S':
      case '--show-error':
      case '-i':
      case '--include':
      case '-v':
      case '--verbose':
        // These flags do not change the request structure.
        break
      case '-o':
      case '--output':
      case '-O':
      case '--remote-name':
      case '-w':
      case '--write-out':
      case '--connect-timeout':
      case '-m':
      case '--max-time':
      case '-A':
      case '--user-agent':
      case '-e':
      case '--referer':
        // These flags do not affect the request, but their argument must be consumed.
        index++
        break
      default:
        if (!token.startsWith('-') && !request.url) {
          request.url = token
        } else if (token.startsWith('-')) {
          warnings.push({ code: 'unknown_flag', flag: token })
        }
        break
    }
    index++
  }

  // Form fields always imply form-data, even if a flag combination skipped the branch above.
  if (request.formFields.length > 0 && request.bodyType === 'none') {
    request.bodyType = 'form-data'
  }
  // An empty raw body is not a body.
  if (request.bodyType === 'raw' && !request.body) {
    request.bodyType = 'none'
  }

  return { request, warnings }
}
