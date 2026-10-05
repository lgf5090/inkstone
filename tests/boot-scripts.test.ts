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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
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
