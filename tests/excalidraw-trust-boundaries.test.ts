// @vitest-environment node
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => fs.readFileSync(path, 'utf8')

const MODAL = 'src/client/features/excalidraw/library/ExcalidrawOfficialLibraryModal.tsx'
const TTD = 'src/client/features/excalidraw/TextToDiagramModal.tsx'
const LATEX = 'src/client/features/excalidraw/excalidraw-canvas-actions.ts'
const LIB_ROUTE = 'src/worker/routes/excalidraw-library.ts'
const AI_ROUTE = 'src/worker/routes/ai-proxy.ts'
const GUARD = 'src/shared/ai-proxy-guard.ts'
const DEV_PROXY = 'vite.config.ts'

describe('the drawing module keeps its trust boundaries where they were put', () => {
  it('does not listen for cross-origin library installs it can never authenticate', () => {
    const source = read(MODAL)
    expect(source).not.toContain("addEventListener('message'")
    expect(source).not.toContain('event.origin')
    expect(source).not.toContain("excalidraw-library-install")
  })

  it('keeps the mermaid preview at the strict security level', () => {
    const source = read(TTD)
    expect(source).toContain("securityLevel: 'strict'")
    expect(source).not.toContain("securityLevel: 'loose'")
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
    expect(workerRoute).toContain("redirect: 'error'")
    expect(workerRoute).not.toContain('const BLOCKED_HOSTNAMES')

    const dev = read(DEV_PROXY)
    expect(dev).toContain('assertRelayableEndpoint')
    expect(dev).toContain("redirect: 'error'")
    expect(dev).not.toMatch(/if \(lower === 'host' \|\| lower === 'connection'/)
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
