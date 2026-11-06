/**
 * Repairs the e2e fixture's missing render snapshot for one blog post.
 *
 * The audit fixture's `long-token` row was inserted with a placeholder `render_key` and no R2
 * object, so the public article page has no stored still to show. This script patches that note to
 * valid blog frontmatter and then publishes a real snapshot: the browser runs the same
 * `captureBlogSnapshot` the admin publish panel uses, and the server receives it through
 * `/api/blog/admin/posts/:noteId/publish`, which writes R2 and the render columns.
 *
 * It never writes D1 or R2 directly, and it is idempotent: a post whose content hash and render
 * snapshot already match is reported as ready and nothing is published again.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FIXTURE_CONTENT = '---\nblogType: post\nisPublished: true\n---\n\nx'
const DEFAULT_SLUG = 'long-token'
const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

function readArg(argv, name, envName) {
  const flag = `--${name}`
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === flag && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1]
    if (value.startsWith(`${flag}=`)) return value.slice(flag.length + 1)
  }
  return envName ? process.env[envName] : undefined
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fail(message) {
  console.error(`[fixture] ${message}`)
  process.exit(1)
}

function usage() {
  console.error(`Usage:
  node scripts/fixture-blog-e2e.mjs --base-url <api url> --dev-url <vite dev url> \\
    --proxy-key <blog proxy key> (--session-token <64 hex chars> | --session-cookie "<name=value>")

Options:
  --slug <slug>        Post to repair (default: ${DEFAULT_SLUG})
  --chrome <path>      Chrome/Chromium binary (default: CHROME_PATH or a known path)
  --headless           Run Chrome headless (default: headed; set DISPLAY for a real window)

Environment fallbacks:
  INKSTONE_BASE_URL, INKSTONE_DEV_URL, INKSTONE_BLOG_PROXY_KEY,
  INKSTONE_SESSION_TOKEN, INKSTONE_SESSION_COOKIE, INKSTONE_FIXTURE_SLUG, CHROME_PATH`)
}

function createClient(baseUrl, cookie) {
  return async function request(pathname, options = {}) {
    const headers = { 'x-inkstone-client': '1', ...(options.headers ?? {}) }
    if (options.auth !== false && cookie) headers.cookie = cookie
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!response.ok) {
      throw new Error(`${options.method ?? 'GET'} ${pathname} -> ${response.status} ${text.slice(0, 400)}`)
    }
    return { response, json, text }
  }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitForJson(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch {
      // Chrome is still binding the debugging port.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Chrome debugging endpoint did not answer: ${url}`)
}

class CdpConnection {
  constructor(url) {
    this.url = url
    this.pending = new Map()
    this.nextId = 1
    this.socket = null
  }

  async open() {
    this.socket = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (typeof message.id !== 'number') return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    })
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed'))
      this.pending.clear()
    })
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try {
      this.socket.close()
    } catch {
      // already closed
    }
  }
}

async function launchChrome(options) {
  const binary = options.chrome
  if (!binary || !fs.existsSync(binary)) {
    throw new Error(`Chrome binary not found: ${binary ?? 'none'}. Pass --chrome or CHROME_PATH.`)
  }
  const port = await freePort()
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkstone-fixture-chrome-'))
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    'about:blank',
  ]
  if (options.headless) args.unshift('--headless=new')
  const process = spawn(binary, args, { stdio: 'ignore' })
  const version = await waitForJson(`http://127.0.0.1:${port}/json/version`)
  return { process, port, userDataDir, version }
}

async function pageTarget(port) {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`)
  const page = targets.find((target) => target.type === 'page')
  if (page?.webSocketDebuggerUrl) return page
  const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  if (!created.ok) throw new Error(`Could not open a Chrome page target: ${created.status}`)
  return created.json()
}

async function captureSnapshot(options, noteId, content) {
  const chrome = await launchChrome(options)
  let cdp = null
  try {
    const target = await pageTarget(chrome.port)
    cdp = new CdpConnection(target.webSocketDebuggerUrl)
    await cdp.open()
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate', { url: `${options.devUrl.replace(/\/+$/, '')}/` })
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const state = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
      if (state.result?.value === 'complete') break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const expression = `(async () => {
      const session = await import('/src/client/store/session.ts');
      const current = session.useSession.getState();
      session.useSession.setState({ settings: { ...(current.settings || {}), preview: { emojiShortcodes: true, math: true, mermaid: true, chart: true, codeBlockCollapse: true, codeBlockCollapseLines: 24, jsonView: 'source', jsonFold: 0, jsonTolerant: false } } });
      const snapshot = await import('/src/client/features/blog/snapshot.ts');
      return snapshot.captureBlogSnapshot(${JSON.stringify(noteId)}, ${JSON.stringify(content)});
    })()`
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, 180000)
    if (result.exceptionDetails) {
      throw new Error(`captureBlogSnapshot threw: ${result.exceptionDetails.text ?? 'unknown error'}`)
    }
    if (!result.result?.value) throw new Error('captureBlogSnapshot returned no snapshot')
    return result.result.value
  } finally {
    cdp?.close()
    chrome.process.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 300))
    fs.rmSync(chrome.userDataDir, { recursive: true, force: true })
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (hasFlag(argv, 'help')) {
    usage()
    return
  }
  const baseUrl = (readArg(argv, 'base-url', 'INKSTONE_BASE_URL') ?? '').replace(/\/+$/, '')
  const devUrl = (readArg(argv, 'dev-url', 'INKSTONE_DEV_URL') ?? '').replace(/\/+$/, '')
  const proxyKey = readArg(argv, 'proxy-key', 'INKSTONE_BLOG_PROXY_KEY')
  const sessionToken = readArg(argv, 'session-token', 'INKSTONE_SESSION_TOKEN')
  const sessionCookie = readArg(argv, 'session-cookie', 'INKSTONE_SESSION_COOKIE')
  const slug = readArg(argv, 'slug', 'INKSTONE_FIXTURE_SLUG') ?? DEFAULT_SLUG
  const chrome = readArg(argv, 'chrome', 'CHROME_PATH')
    ?? CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate))
  const headless = hasFlag(argv, 'headless')

  if (!baseUrl || !devUrl || !proxyKey) {
    usage()
    fail('--base-url, --dev-url and --proxy-key are required.')
  }
  if (!sessionToken && !sessionCookie) {
    usage()
    fail('Pass --session-token or --session-cookie for the owner account.')
  }
  if (sessionToken && !/^[a-f0-9]{64}$/.test(sessionToken)) fail('--session-token must be 64 lowercase hex characters.')
  const cookieName = baseUrl.startsWith('https:') ? '__Host-inkstone_session' : 'inkstone_session'
  const cookie = sessionCookie ?? `${cookieName}=${sessionToken}`
  const request = createClient(baseUrl, cookie)
  const publicRequest = createClient(baseUrl, null)

  console.log(`[fixture] target ${baseUrl}, renderer host ${devUrl}, post slug ${slug}`)
  const list = (await request(`/api/blog/admin/posts?status=all&limit=100&q=${encodeURIComponent(slug)}`)).json
  const post = list?.items?.find((item) => item.slug === slug)
  if (!post) fail(`No admin post with slug "${slug}" was found.`)

  const note = (await request(`/api/notes/${encodeURIComponent(post.noteId)}`)).json
  if (!note?.id) fail(`Note ${post.noteId} could not be read.`)
  const contentBefore = note.content
  const targetHash = sha256(FIXTURE_CONTENT)
  if (contentBefore !== FIXTURE_CONTENT) {
    console.log(`[fixture] note ${note.id} is not the fixture body; patching (rev ${note.rev}).`)
    console.log(`[fixture] content hash ${sha256(contentBefore)} -> ${targetHash}`)
    const patched = (await request(`/api/notes/${encodeURIComponent(note.id)}`, {
      method: 'PATCH',
      body: { rev: note.rev, content: FIXTURE_CONTENT },
    })).json
    if (patched?.content !== FIXTURE_CONTENT) fail('The note patch did not store the fixture body.')
    console.log(`[fixture] note patched to rev ${patched.rev}.`)
  } else {
    console.log(`[fixture] note content already matches the fixture body (rev ${note.rev}).`)
  }

  const adminDetail = (await request(`/api/blog/admin/posts/by-note/${encodeURIComponent(post.noteId)}`)).json
  const publicDetail = (await publicRequest(`/api/blog/posts/${encodeURIComponent(slug)}`, {
    auth: false,
    headers: { 'x-blog-proxy-key': proxyKey, 'x-blog-view': 'none' },
  })).json
  const storedHtml = publicDetail?.render?.html ?? ''
  const ready = adminDetail?.contentHash === targetHash
    && adminDetail?.renderStatus === 'ready'
    && Boolean(adminDetail?.renderHash)
    && storedHtml.trim().length > 0
  if (ready) {
    console.log(`[fixture] \u5df2\u5c31\u7eea: ${slug} snapshot already stored (contentHash=${adminDetail.contentHash}, renderHash=${adminDetail.renderHash}, ${storedHtml.length} chars). Skipping publish.`)
    return
  }
  console.log(`[fixture] snapshot missing or stale (contentHash=${adminDetail?.contentHash ?? 'n/a'}, renderStatus=${adminDetail?.renderStatus ?? 'n/a'}, stored render ${storedHtml.length} chars). Generating.`)

  const snapshot = await captureSnapshot({ devUrl, chrome, headless }, post.noteId, FIXTURE_CONTENT)
  if (snapshot.noteId !== post.noteId) fail(`captureBlogSnapshot returned noteId ${snapshot.noteId}, expected ${post.noteId}.`)
  if (snapshot.contentHash !== targetHash) fail(`captureBlogSnapshot hashed ${snapshot.contentHash}, expected ${targetHash}.`)
  console.log(`[fixture] generated snapshot: html=${JSON.stringify(snapshot.html)} rendererVersion=${snapshot.rendererVersion} contentHash=${snapshot.contentHash}`)

  const published = (await request(`/api/blog/admin/posts/${encodeURIComponent(post.noteId)}/publish`, {
    method: 'POST',
    body: { snapshot },
  })).json
  console.log(`[fixture] publish response: status=${published?.status} renderStatus=${published?.render_status} renderKey=${published?.render_key} rendererVersion=${published?.renderer_version}`)

  const readBackAdmin = (await request(`/api/blog/admin/posts/by-note/${encodeURIComponent(post.noteId)}`)).json
  const readBackPublic = (await publicRequest(`/api/blog/posts/${encodeURIComponent(slug)}`, {
    auth: false,
    headers: { 'x-blog-proxy-key': proxyKey, 'x-blog-view': 'none' },
  })).json
  const readBackHtml = readBackPublic?.render?.html ?? ''
  const expectedRenderHash = sha256(readBackHtml)
  if (!readBackHtml.trim()) fail('Read-back failed: the public article still has no render HTML.')
  if (readBackAdmin?.contentHash !== targetHash) fail('Read-back failed: stored content hash does not match the fixture body.')
  if (readBackAdmin?.renderHash !== expectedRenderHash) fail(`Read-back failed: render hash ${readBackAdmin?.renderHash} does not match HTML hash ${expectedRenderHash}.`)
  console.log(`[fixture] read-back: renderStatus=${readBackAdmin.renderStatus} renderHash=${readBackAdmin.renderHash} html=${JSON.stringify(readBackHtml)}`)
  console.log(`[fixture] \u5b8c\u6210: ${slug} is published through the admin route with a real snapshot.`)
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
