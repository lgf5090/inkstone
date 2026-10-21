// @vitest-environment node
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => fs.readFileSync(path, 'utf8')

const MODAL = 'src/client/features/excalidraw/library/ExcalidrawOfficialLibraryModal.tsx'
const TTD = 'src/client/features/excalidraw/TextToDiagramModal.tsx'
const LATEX = 'src/client/features/excalidraw/excalidraw-canvas-actions.ts'
const LIB_ROUTE = 'src/worker/routes/excalidraw-library.ts'
const AI_ROUTE = 'src/worker/routes/ai-proxy.ts'
const NO_REDIRECT_LIB = 'src/worker/lib/no-redirect.ts'
const GUARD = 'src/shared/ai-proxy-guard.ts'
const DEV_PROXY = 'vite.config.ts'

describe('the drawing module keeps its trust boundaries where they were put', () => {
  it('does not listen for cross-origin library installs it can never authenticate', () => {
    const source = read(MODAL)
    expect(source).not.toContain("addEventListener('message'")
    expect(source).not.toContain('event.origin')
    expect(source).not.toContain("excalidraw-library-install")
  })

  it('draws the text-to-diagram preview with nothing that reaches past the page', () => {
    const source = read(TTD)
    expect(source).toContain('links: false')
    expect(source).toContain('images: false')
    expect(source).not.toMatch(/\blinks:\s*true/)
    expect(source).not.toMatch(/\bimages:\s*true/)
  })

  it('escapes the formula source when the compiler fails instead of injecting it', () => {
    const source = read(LATEX)
    expect(source).toContain('escapeHtml(latex)')
    expect(source).not.toMatch(/<span class="katex">\$\{latex\}/)
  })

  it('scopes every library key to the requesting account', () => {
    const source = read(LIB_ROUTE)
    expect(source).not.toContain("'excalidraw/library/manifest.json'")
    expect(source).not.toContain("'excalidraw_library_manifest'")
    expect(source).not.toContain('`excalidraw/libraries/${safeName}`')
    expect(source).toContain('excalidraw/library/${userId}/manifest.json')
    expect(source).toContain('excalidraw/libraries/${userId}/${safeName}')
  })

  it('runs both AI relays off one endpoint policy with no private targets', () => {
    const guard = read(GUARD)
    expect(guard).toContain('ALLOWED_UPSTREAM_HEADERS')
    expect(guard).toContain('isBlockedTarget')
    expect(guard).toContain('assertRelayableEndpoint')

    const workerRoute = read(AI_ROUTE)
    expect(workerRoute).toContain("from '@shared/ai-proxy-guard'")
    expect(workerRoute).toContain('redirect: NO_REDIRECT')
    expect(workerRoute).toContain('isRedirectResponse(upstreamRes)')
    expect(workerRoute).not.toContain('const BLOCKED_HOSTNAMES')

    const dev = read(DEV_PROXY)
    expect(dev).toContain('assertRelayableEndpoint')
    expect(dev).toContain("redirect: 'error'")
    expect(dev).not.toMatch(/if \(lower === 'host' \|\| lower === 'connection'/)
  })

  it('refuses redirects with the option workerd actually accepts', () => {
    // `redirect: 'error'` is valid in Node, so the vite dev proxy keeps it, but workerd throws on it
    // before the request leaves the isolate: every upstream then reads as unreachable in production.
    const noRedirect = read(NO_REDIRECT_LIB)
    expect(noRedirect).toContain("export const NO_REDIRECT = 'manual'")
    for (const workerFile of [read(AI_ROUTE), read(LIB_ROUTE)]) {
      expect(workerFile).not.toContain("redirect: 'error'")
      expect(workerFile).toContain("from '../lib/no-redirect'")
    }
    const libRoute = read(LIB_ROUTE)
    expect(libRoute.match(/isRedirectResponse\(res\)/g)).toHaveLength(2)
  })

  it('refuses the addresses a relay must never reach', async () => {
    const { isBlockedTarget } = await import('../src/shared/ai-proxy-guard')
    for (const host of [
      '169.254.169.254', '127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5',
      '100.64.0.1', 'localhost', 'worker.default.svc.cluster.local', '::1',
      'fd00::1', 'fe80::1', '[::ffff:a9fe:a9fe]', '',
    ]) {
      expect(isBlockedTarget(host), host).toBe(true)
    }
    for (const host of ['api.deepseek.com', 'api.openai.com', 'generativelanguage.googleapis.com', '8.8.8.8']) {
      expect(isBlockedTarget(host), host).toBe(false)
    }
  })
})
