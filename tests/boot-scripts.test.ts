import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const bootScript = readFileSync('public/boot.js', 'utf8')
const authorizeScript = readFileSync('public/authorize-login.js', 'utf8')

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-accent')
  document.documentElement.removeAttribute('data-background')
  document.documentElement.lang = 'en-US'
  document.body.replaceChildren()
  localStorage.clear()
  sessionStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type BootRecovery = { fail: () => void; ready: () => void; booted: () => boolean }

const startBootScript = (): BootRecovery => {
  new Function(bootScript)()
  return (window as unknown as { __inkstoneBoot: BootRecovery }).__inkstoneBoot
}

const failScriptLoad = (): void => {
  const script = document.createElement('script')
  script.type = 'module'
  document.head.appendChild(script)
  script.dispatchEvent(new Event('error'))
}

it('applies stored theme, accent, background, locale, and font scale', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  localStorage.setItem('inkstone.ui', JSON.stringify({
    theme: 'dark',
    accent: 'indigo',
    background: 'white',
    fontScale: 19,
  }))
  localStorage.setItem('inkstone-locale', 'zh-CN')
  new Function(bootScript)()
  const root = document.documentElement
  expect(root.dataset.theme).toBe('dark')
  expect(root.dataset.accent).toBe('indigo')
  expect(root.dataset.background).toBe('white')
  expect(root.lang).toBe('zh-CN')
  expect(root.style.getPropertyValue('--prose-size')).toBe('19px')
})

it('falls back safely when storage holds invalid data', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  localStorage.setItem('inkstone.ui', '{not json')
  expect(() => new Function(bootScript)()).not.toThrow()
})

it('posts credentials with the client header and reloads on success', async () => {
  document.body.innerHTML = [
    '<form id="login" class="login-form" data-sign-in-failed="sign-in failed fallback">',
    '<input name="username" value="owner"><input name="password" type="password" value="pw">',
    '<p id="error" class="error"></p><button class="primary" type="submit">go</button></form>',
  ].join('')
  const reload = vi.fn()
  // Declared with the two arguments `fetch` is called with, so reading the call's `init` is checked.
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('location', { reload })
  new Function(authorizeScript)()
  const form = document.getElementById('login') as HTMLFormElement
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }))
  expect(fetchMock.mock.calls[0]![1]).toMatchObject({
    headers: { 'Content-Type': 'application/json', 'X-Inkstone-Client': '1' },
  })
  expect(reload).toHaveBeenCalled()
})

it('surfaces server message and local fallback on failure', async () => {
  document.body.innerHTML = [
    '<form id="login" data-sign-in-failed="sign-in failed fallback">',
    '<input name="username" value="owner"><input name="password" value="pw">',
    '<p id="error" class="error"></p><button type="submit">go</button></form>',
  ].join('')
  const fetchMock = vi.fn(async () => new Response(
    JSON.stringify({ error: { message: 'Incorrect username or password' } }),
    { status: 401 },
  ))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('location', { reload: vi.fn() })
  new Function(authorizeScript)()
  const form = document.getElementById('login') as HTMLFormElement
  const button = form.querySelector('button') as HTMLButtonElement
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(document.getElementById('error')!.textContent).toBe('Incorrect username or password')
  expect(button.disabled).toBe(false)
})

it('uses the localized fallback when the error body is unreadable', async () => {
  document.body.innerHTML = [
    '<form id="login" data-sign-in-failed="sign-in failed fallback">',
    '<input name="username" value="owner"><input name="password" value="pw">',
    '<p id="error" class="error"></p><button type="submit">go</button></form>',
  ].join('')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
  vi.stubGlobal('location', { reload: vi.fn() })
  new Function(authorizeScript)()
  const form = document.getElementById('login') as HTMLFormElement
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(document.getElementById('error')!.textContent).toBe('sign-in failed fallback')
})

it('reloads once for a failed start-up, then explains itself instead of looping', () => {
  document.body.innerHTML = '<div id="boot" aria-hidden="true"></div>'
  const reload = vi.fn()
  vi.stubGlobal('location', { reload })
  const recovery = startBootScript()

  recovery.fail()
  expect(reload).toHaveBeenCalledTimes(1)

  recovery.fail()
  expect(reload).toHaveBeenCalledTimes(1)
  const panel = document.querySelector('#boot .boot-failure')!
  expect(panel.getAttribute('role')).toBe('alert')
  expect(panel.querySelector('.boot-failure-title')!.textContent).toBe('Inkstone could not start')
  expect(panel.querySelector('.boot-failure-action')!.textContent).toBe('Reload')
  expect(document.getElementById('boot')!.hasAttribute('aria-hidden')).toBe(false)
})

it('answers a module script that never loads before the app is up', () => {
  document.body.innerHTML = '<div id="boot"></div>'
  const reload = vi.fn()
  vi.stubGlobal('location', { reload })
  startBootScript()

  failScriptLoad()
  expect(reload).toHaveBeenCalled()
})

it('leaves a script that fails after the app booted to the feature that loaded it', () => {
  document.body.innerHTML = '<div id="boot"></div>'
  const reload = vi.fn()
  vi.stubGlobal('location', { reload })
  const recovery = startBootScript()

  recovery.ready()
  failScriptLoad()
  expect(reload).not.toHaveBeenCalled()
  expect(document.querySelector('#boot .boot-failure')).toBeNull()
})

it('frees the reload guard for the next deploy once the app renders', () => {
  document.body.innerHTML = '<div id="boot"></div>'
  const reload = vi.fn()
  vi.stubGlobal('location', { reload })
  const recovery = startBootScript()

  recovery.ready()
  expect(sessionStorage.getItem('inkstone.boot-recovery')).toBeNull()

  recovery.fail()
  expect(reload).toHaveBeenCalledTimes(1)
})
