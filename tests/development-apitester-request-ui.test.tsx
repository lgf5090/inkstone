import { act, createElement, useState, type ComponentProps } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { VARIABLE_CLOSERS, VARIABLE_TRIGGERS } from '@shared/development/api-tester/keywords'
import { defaultRequest } from '@shared/development/api-tester/state'
import type {
  CollectionNode,
  HttpRequestConfig,
  OAuth2Config,
  TagNode,
} from '@shared/development/api-tester/types'
import { RequestBuilder } from '../src/client/features/development/api-tester/components/RequestBuilder'
import { SearchField } from '../src/client/features/development/api-tester/components/SearchField'
import { initI18n, t } from '../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { formatBytes } from '../src/client/lib/time'

const apiMock = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  exchangeOAuthToken: vi.fn(),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

vi.mock('../src/client/features/development/api-tester/api', () => apiMock)

const TAGS: TagNode[] = [
  { id: 't1', name: 'Team', parentId: null, color: 'blue', sortOrder: 0, createdAt: 0 },
  { id: 't2', name: 'Backend', parentId: 't1', color: 'emerald', sortOrder: 1, createdAt: 0 },
]

const VARIABLES = [
  { key: 'token', value: 'secret' },
  { key: 'baseUrl', value: 'https://api.example.com' },
  { key: 'apiKey', value: 'k' },
]

function oauth2(overrides: Partial<OAuth2Config> = {}): OAuth2Config {
  return {
    authUrl: '',
    tokenUrl: '',
    clientId: '',
    clientSecret: '',
    scope: '',
    accessToken: '',
    ...overrides,
  }
}

function nodeWith(patch: Partial<HttpRequestConfig> = {}, overrides: Partial<CollectionNode> = {}): CollectionNode {
  return {
    id: 'node-1',
    type: 'request',
    name: 'Test request',
    parentId: null,
    order: 1,
    kind: 'rest',
    request: { ...defaultRequest(), ...patch },
    tags: [],
    updatedAt: 0,
    ...overrides,
  }
}

type BuilderProps = ComponentProps<typeof RequestBuilder>

const views: RenderedElement[] = []

function renderBuilder(initial: CollectionNode, overrides: Partial<BuilderProps> = {}) {
  const stateRef = { current: initial }
  const send = vi.fn()
  function Host() {
    const [current, setCurrent] = useState(initial)
    stateRef.current = current
    return createElement(RequestBuilder, {
      node: current,
      tags: TAGS,
      variables: VARIABLES,
      loading: false,
      onChange: (patch: Partial<CollectionNode>) => {
        setCurrent((previous) => {
          const next = { ...previous, ...patch }
          stateRef.current = next
          return next
        })
      },
      onSend: send,
      ...overrides,
    })
  }
  const view = renderElement(createElement(Host))
  views.push(view)
  return { view, state: () => stateRef.current, send }
}

function byPlaceholder<T extends HTMLInputElement | HTMLTextAreaElement>(root: HTMLElement, text: string): T {
  const found = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].find(
    (element) => element.getAttribute('placeholder') === text,
  )
  if (!found) throw new Error(`no control with placeholder "${text}"`)
  return found as T
}

function byButtonText(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => (element.textContent ?? '').trim() === text,
  )
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

function byTab(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (element) => (element.textContent ?? '').trim() === text,
  )
  if (!found) throw new Error(`no tab "${text}"`)
  return found
}

function bySelectLabel(root: HTMLElement, label: string): HTMLSelectElement {
  const found = [...(root.querySelectorAll('select') as unknown as HTMLSelectElement[])].find(
    (element) => element.getAttribute('aria-label') === label,
  )
  if (!found) throw new Error(`no select "${label}"`)
  return found
}

function byLabel(root: HTMLElement, text: string): HTMLInputElement | HTMLTextAreaElement {
  const label = [...root.querySelectorAll<HTMLLabelElement>('label')].find(
    (element) => (element.textContent ?? '').trim() === text,
  )
  if (!label?.htmlFor) throw new Error(`no label "${text}"`)
  const control = document.getElementById(label.htmlFor)
  if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLTextAreaElement)) {
    throw new Error(`label "${text}" has no text control`)
  }
  return control
}

function setText(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.setSelectionRange(value.length, value.length)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function chooseOption(element: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function press(element: Element, key: string): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function click(element: Element): void {
  act(() => {
    ;(element as HTMLElement).click()
  })
}

function outsideClick(): void {
  act(() => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
}

function paste(element: Element, text: string): void {
  act(() => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } })
    element.dispatchEvent(event)
  })
}

async function chooseFiles(input: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  apiMock.uploadFile.mockReset()
  apiMock.deleteFile.mockReset()
  apiMock.deleteFile.mockResolvedValue(undefined)
  apiMock.exchangeOAuthToken.mockReset()
})

afterEach(() => {
  for (const view of views.splice(0)) view.unmount()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('API Tester request builder', () => {
  it('edits the request name and selects it for a new request', () => {
    const onNameFocusDone = vi.fn()
    const { view, state } = renderBuilder(nodeWith(), { autoFocusName: true, onNameFocusDone })
    const name = byPlaceholder<HTMLInputElement>(view.container, t('development.apitester.request_name_placeholder'))
    expect(document.activeElement).toBe(name)
    expect(name.selectionStart).toBe(0)
    expect(name.selectionEnd).toBe(name.value.length)
    expect(onNameFocusDone).toHaveBeenCalledTimes(1)
    setText(name, 'Renamed request')
    expect(state().name).toBe('Renamed request')
  })

  it('switches the HTTP method from the menu', () => {
    const { view, state } = renderBuilder(nodeWith())
    const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
    if (!trigger) throw new Error('no method menu trigger')
    click(trigger)
    click(byButtonText(document.body, 'POST'))
    expect(state().request?.method).toBe('POST')
    expect(trigger.getAttribute('aria-label')).toBe(`${t('development.apitester.request')} POST`)
  })

  it('adds, edits, toggles and removes a key-value row', () => {
    const { view, state } = renderBuilder(nodeWith())
    click(byButtonText(view.container, t('development.apitester.add')))
    expect(state().request?.params).toHaveLength(1)
    setText(byPlaceholder<HTMLInputElement>(view.container, t('development.apitester.key_name')), 'q')
    setText(byPlaceholder<HTMLInputElement>(view.container, t('development.apitester.key_value')), 'search')
    expect(state().request?.params[0]).toMatchObject({ key: 'q', value: 'search', enabled: true })
    const enabled = [...view.container.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(
      (element) => element.getAttribute('aria-label') === t('development.apitester.enabled'),
    )
    if (!enabled) throw new Error('no enabled checkbox')
    click(enabled)
    expect(state().request?.params[0]?.enabled).toBe(false)
    click(view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('development.apitester.delete')}"]`)!)
    expect(state().request?.params).toHaveLength(0)
  })

  it('completes a variable with the keyboard and closes on escape or an outside click', () => {
    const { view, state } = renderBuilder(nodeWith())
    const url = byPlaceholder<HTMLInputElement>(view.container, t('development.apitester.url_placeholder'))
    setText(url, VARIABLE_TRIGGERS[0])
    expect(view.container.querySelector('[role="listbox"]')).not.toBeNull()
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(VARIABLES.length)
    press(url, 'ArrowDown')
    press(url, 'Enter')
    const completed = `${VARIABLE_TRIGGERS[0]}baseUrl${VARIABLE_CLOSERS[0]}`
    expect(state().request?.url).toBe(completed)
    expect(url.value).toBe(completed)
    expect(url.selectionStart).toBe(completed.length)
    expect(view.container.querySelector('[role="listbox"]')).toBeNull()
    setText(url, `${VARIABLE_TRIGGERS[0]}tok`)
    press(url, 'Escape')
    expect(view.container.querySelector('[role="listbox"]')).toBeNull()
    setText(url, VARIABLE_TRIGGERS[0])
    expect(view.container.querySelector('[role="listbox"]')).not.toBeNull()
    outsideClick()
    expect(view.container.querySelector('[role="listbox"]')).toBeNull()
  })

  it('shows the GraphQL tabs and edits the variables document', () => {
    const { view, state } = renderBuilder(nodeWith({}, { kind: 'graphql' }))
    const labels = [...view.container.querySelectorAll('[role="tab"]')].map((element) => (element.textContent ?? '').trim())
    expect(labels).toContain(t('development.apitester.query'))
    expect(labels).toContain(t('development.apitester.variables'))
    expect(labels).toContain(t('development.apitester.auth'))
    expect(labels.some((label) => label.startsWith(t('development.apitester.headers')))).toBe(true)
    expect(labels).not.toContain(t('development.apitester.params'))
    const query = byPlaceholder<HTMLTextAreaElement>(view.container, t('development.apitester.query_placeholder'))
    setText(query, '{ users { id } }')
    expect(state().request?.graphqlQuery).toBe('{ users { id } }')
    click(byTab(view.container, t('development.apitester.variables')))
    const variables = byPlaceholder<HTMLTextAreaElement>(view.container, t('development.apitester.variables_placeholder'))
    setText(variables, '{"limit":5}')
    expect(state().request?.graphqlVariables).toBe('{"limit":5}')
  })

  it('uploads, replaces and removes a binary body through the API', async () => {
    const { view, state } = renderBuilder(nodeWith())
    click(byTab(view.container, t('development.apitester.body')))
    chooseOption(bySelectLabel(view.container, t('development.apitester.body')), 'binary')
    const choose = byButtonText(view.container, t('development.apitester.choose_file'))
    click(choose)
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error('no file input')
    const first = new File(['abc'], 'photo.png', { type: 'image/png' })
    apiMock.uploadFile.mockResolvedValueOnce({
      id: 'file-1',
      kind: 'image',
      name: 'photo.png',
      contentType: 'image/png',
      size: 2048,
      createdAt: 0,
      expiresAt: 0,
      url: '',
    })
    await chooseFiles(input, [first])
    expect(apiMock.uploadFile).toHaveBeenLastCalledWith(first, 'image', 'photo.png')
    expect(state().request?.bodyFileId).toBe('file-1')
    expect(view.container.textContent).toContain('photo.png')
    expect(view.container.textContent).toContain(formatBytes(2048))

    apiMock.uploadFile.mockResolvedValueOnce({
      id: 'file-2',
      kind: 'bin',
      name: 'payload.bin',
      contentType: 'application/octet-stream',
      size: 4096,
      createdAt: 0,
      expiresAt: 0,
      url: '',
    })
    click(byButtonText(view.container, t('development.apitester.choose_file')))
    await chooseFiles(input, [new File(['def'], 'payload.bin', { type: 'application/octet-stream' })])
    expect(apiMock.deleteFile).toHaveBeenCalledWith('file-1')
    expect(state().request?.bodyFileId).toBe('file-2')
    click(byButtonText(view.container, t('development.apitester.remove_file')))
    expect(apiMock.deleteFile).toHaveBeenLastCalledWith('file-2')
    expect(state().request?.bodyFileId).toBeUndefined()
  })

  it('switches auth types and masks sensitive values', () => {
    const { view, state } = renderBuilder(nodeWith())
    click(byTab(view.container, t('development.apitester.auth')))
    chooseOption(bySelectLabel(view.container, t('development.apitester.auth')), 'bearer')
    const token = byLabel(view.container, t('development.apitester.token'))
    expect(token).toBeInstanceOf(HTMLInputElement)
    expect((token as HTMLInputElement).type).toBe('password')
    setText(token, 'secret-token')
    expect(state().request?.auth).toMatchObject({ type: 'bearer', token: 'secret-token' })
    click(byButtonText(view.container, t('development.apitester.show_sensitive')))
    expect((byLabel(view.container, t('development.apitester.token')) as HTMLInputElement).type).toBe('text')
    click(byButtonText(view.container, t('development.apitester.hide_sensitive')))
    expect((byLabel(view.container, t('development.apitester.token')) as HTMLInputElement).type).toBe('password')
    chooseOption(bySelectLabel(view.container, t('development.apitester.auth')), 'apikey-query')
    setText(byLabel(view.container, t('development.apitester.key_name_label')), 'api_key')
    setText(byLabel(view.container, t('development.apitester.key_value_label')), 'k-1')
    expect(state().request?.auth).toMatchObject({ type: 'apikey-query', keyName: 'api_key', keyValue: 'k-1' })
  })

  it('extracts the OAuth callback code and exchanges, refreshes and clears the token', async () => {
    const { view, state } = renderBuilder(nodeWith())
    click(byTab(view.container, t('development.apitester.auth')))
    chooseOption(bySelectLabel(view.container, t('development.apitester.auth')), 'oauth2')
    setText(byLabel(view.container, t('development.apitester.auth_url')), 'https://auth.example.com/authorize')
    setText(byLabel(view.container, t('development.apitester.token_url')), 'https://auth.example.com/token')
    setText(byLabel(view.container, t('development.apitester.client_id')), 'client-1')
    setText(
      byLabel(view.container, t('development.apitester.callback_url_hint')),
      'https://app.example.com/cb?code=abc123&state=s1',
    )
    apiMock.exchangeOAuthToken.mockResolvedValueOnce({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      tokenType: 'Bearer',
      expiresIn: 3600,
    })
    await act(async () => {
      byButtonText(view.container, t('development.apitester.get_token')).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(apiMock.exchangeOAuthToken).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'client-1',
        code: 'abc123',
      }),
    )
    expect(state().request?.auth.oauth2?.accessToken).toBe('at-1')
    expect(view.container.textContent).toContain(t('development.apitester.expires_in_sec', { sec: 3600 }))

    apiMock.exchangeOAuthToken.mockResolvedValueOnce({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
      tokenType: 'Bearer',
      expiresIn: 3600,
    })
    await act(async () => {
      byButtonText(view.container, t('development.apitester.refresh_token')).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(apiMock.exchangeOAuthToken).toHaveBeenLastCalledWith(
      expect.objectContaining({ grantType: 'refresh_token', refreshToken: 'rt-1' }),
    )
    expect(state().request?.auth.oauth2?.accessToken).toBe('at-2')
    click(byButtonText(view.container, t('development.apitester.clear_token')))
    expect(state().request?.auth.oauth2?.accessToken).toBe('')
  })

  it('ticks an OAuth token from valid to expired', () => {
    vi.useFakeTimers()
    const expiresAt = Date.now() + 1200
    const node = nodeWith({
      auth: {
        ...defaultRequest().auth,
        type: 'oauth2',
        oauth2: oauth2({ accessToken: 'at', refreshToken: 'rt', expiresAt }),
      },
    })
    const { view } = renderBuilder(node)
    click(byTab(view.container, t('development.apitester.auth')))
    expect(view.container.textContent).toContain(t('development.apitester.expires_in_sec', { sec: 2 }))
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(view.container.textContent).toContain(t('development.apitester.expired'))
  })

  it('selects multiple tags from the popover', () => {
    const { view, state } = renderBuilder(nodeWith())
    click(byButtonText(view.container, t('development.apitester.tags')))
    const panel = [...view.container.querySelectorAll<HTMLElement>('[role="group"]')].find(
      (element) => element.getAttribute('aria-label') === t('development.apitester.tags'),
    )
    if (!panel) throw new Error('no tag panel')
    const backend = [...panel.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(
      (element) => element.getAttribute('aria-label') === 'Team / Backend',
    )
    if (!backend) throw new Error('no backend tag')
    click(backend)
    expect(state().tags).toEqual(['t2'])
    expect(panel.isConnected).toBe(true)
    const team = [...panel.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(
      (element) => element.getAttribute('aria-label') === 'Team',
    )
    if (!team) throw new Error('no team tag')
    click(team)
    expect(state().tags).toEqual(['t2', 't1'])
    outsideClick()
    expect(panel.isConnected).toBe(false)
  })

  it('parses a pasted cURL command and shows its warning', () => {
    const { view, state } = renderBuilder(nodeWith())
    const url = byPlaceholder<HTMLInputElement>(view.container, t('development.apitester.url_placeholder'))
    paste(url, "curl 'https://api.example.com/users' -X POST -H 'X-Test: yes' -d '{\"a\":1}' --bogus")
    expect(state().request?.url).toBe('https://api.example.com/users')
    expect(state().request?.method).toBe('POST')
    expect(state().request?.headers).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'X-Test', value: 'yes', enabled: true })]),
    )
    expect(state().request?.bodyType).toBe('json')
    expect(state().request?.body).toBe('{"a":1}')
    expect(view.container.textContent).toContain('--bogus')
  })

  it('commits search text after the debounce and clears immediately', () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    const view = renderElement(
      createElement(SearchField, {
        value: '',
        onChange,
        label: t('development.apitester.search_requests'),
        placeholder: t('development.apitester.search_requests'),
        debounceMs: 50,
      }),
    )
    views.push(view)
    const input = byPlaceholder<HTMLInputElement>(view.container, t('development.apitester.search_requests'))
    setText(input, 'abc')
    expect(onChange).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(onChange).toHaveBeenLastCalledWith('abc')
    click(view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('development.apitester.clear')}"]`)!)
    expect(onChange).toHaveBeenLastCalledWith('')
    expect(input.value).toBe('')
  })
})
