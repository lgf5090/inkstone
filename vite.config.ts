import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, UserConfigFnPromise } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { inkstonePwa } from './pwa.config.ts'
import { applyExcalidrawPatches } from './scripts/excalidraw-patch.mjs'
import { assertRelayableEndpoint, pickRelayHeaders } from './src/shared/ai-proxy-guard.ts'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const ephemeralDevState = process.env.INKSTONE_EPHEMERAL_DEV === '1'

const normalizeModuleId = (id: string) => id.replace(/\\/g, '/')


const preservesOnDemandBoundary = (id: string) => {
  const path = normalizeModuleId(id)
  // Keep optional preview renderers and their language modules behind dynamic-import boundaries.
  return (
    /\/node_modules\/(?:mermaid|@mermaid-js\/[^/]+|cytoscape|cytoscape-cose-bilkent|elkjs|dagre-d3-es|d3-[^/]+|mind-elixir|@zsviczian)\//.test(
      path,
    ) ||
    /\/node_modules\/@lezer\/(?!common\/|highlight\/|lr\/|markdown\/)/.test(path) ||
    /\/node_modules\/prismjs\/components\/prism-(?!core(?:\.js)?$)/.test(path)
  )
}

const isLucideModule = (id: string) =>
  normalizeModuleId(id).includes('/node_modules/lucide-react/')

const isReactModule = (id: string) => {
  const path = normalizeModuleId(id)
  return (
    path.includes('/node_modules/') &&
    /react-dom|\/react\/|scheduler|use-sync-external-store|zustand/.test(path)
  )
}

const katexWoff2Only = (): Plugin => ({
  name: 'inkstone:katex-woff2-only',
  enforce: 'pre',
  transform(code, id) {
    const path = normalizeModuleId(id).split('?', 1)[0]
    if (!path.endsWith('/node_modules/katex/dist/katex.min.css')) return null


    return code.replace(
      /,\s*url\([^)]*\.woff\)\s*format\((["'])woff\1\),\s*url\([^)]*\.ttf\)\s*format\((["'])truetype\2\)/g,
      '',
    )
  },
})

const excalidrawVendorPlugin = (): Plugin => {
  const vendorJsPath = r('./node_modules/@zsviczian/excalidraw/dist/obsidian/excalidraw.production.min.js')
  const vendorCssPath = r('./node_modules/@zsviczian/excalidraw/dist/obsidian/excalidraw.production.min.css')
  const prodDir = r('./node_modules/@zsviczian/excalidraw/dist/prod')

  const getPatchedJs = () => {
    if (!fs.existsSync(vendorJsPath)) return Buffer.alloc(0)
    const source = fs.readFileSync(vendorJsPath, 'utf8')
    const { content, applied, already, unmatched } = applyExcalidrawPatches(source)
    if (unmatched.length) {
      throw new Error(
        '[inkstone:excalidraw-vendor] ' + unmatched.length + ' engine patches did not match: ' +
        unmatched.join(', ') + ' — refusing to serve a bundle with the Obsidian-only paths intact.',
      )
    }
    if (applied.length) fs.writeFileSync(vendorJsPath, content, 'utf8')
    void already
    return content
  }

  const getFilesRecursively = (dir: string, base = ''): { rel: string; full: string }[] => {
    const result: { rel: string; full: string }[] = []
    if (!fs.existsSync(dir)) return result
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = base ? `${base}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        result.push(...getFilesRecursively(full, rel))
      } else {
        result.push({ rel, full })
      }
    }
    return result
  }

  const mimeTypes: Record<string, string> = {
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  }

  return {
    name: 'inkstone:excalidraw-vendor',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next()
        const cleanUrl = req.url.split('?')[0]
        if (cleanUrl === '/vendor/excalidraw/excalidraw.production.min.js') {
          res.setHeader('Content-Type', 'application/javascript')
          res.setHeader('Cache-Control', 'no-cache')
          res.end(getPatchedJs())
          return
        }
        if (cleanUrl === '/vendor/excalidraw/excalidraw.production.min.css') {
          res.setHeader('Content-Type', 'text/css')
          res.setHeader('Cache-Control', 'no-cache')
          if (fs.existsSync(vendorCssPath)) {
            res.end(fs.readFileSync(vendorCssPath))
            return
          }
        }
        if (cleanUrl.startsWith('/vendor/excalidraw/')) {
          const rel = cleanUrl.slice('/vendor/excalidraw/'.length)
          const target = path.join(prodDir, rel)
          if (target.startsWith(prodDir) && fs.existsSync(target) && fs.statSync(target).isFile()) {
            const ext = path.extname(target)
            res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream')
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
            res.end(fs.readFileSync(target))
            return
          }
        }
        if ((cleanUrl === '/api/ai/proxy' || cleanUrl === '/api/excalidraw/ai/proxy') && req.method === 'POST') {
          const chunks: Buffer[] = []
          let received = 0
          let rejected = false
          req.on('data', (chunk) => {
            const buf = Buffer.from(chunk)
            received += buf.length
            if (received > 512 * 1024) {
              rejected = true
              res.writeHead(413, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: { message: 'Request body too large' } }))
              req.destroy()
              return
            }
            chunks.push(buf)
          })
          req.on('end', async () => {
            if (rejected) return
            try {
              const raw = Buffer.concat(chunks).toString('utf8')
              const parsed = JSON.parse(raw)
              const { endpoint, headers = {}, body } = parsed
              const targetUrl = assertRelayableEndpoint(endpoint)
              const upstreamHeaders = new Headers(pickRelayHeaders(headers))
              if (!upstreamHeaders.has('content-type')) {
                upstreamHeaders.set('content-type', 'application/json')
              }
              const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {})
              const upstreamRes = await fetch(targetUrl.toString(), {
                method: 'POST',
                headers: upstreamHeaders,
                body: payload,
                redirect: 'error',
              })
              const resHeaders: Record<string, string> = {
                'content-type': upstreamRes.headers.get('content-type') || 'application/json',
                'cache-control': 'no-cache',
              }
              res.writeHead(upstreamRes.status, resHeaders)
              if (upstreamRes.body) {
                const { Readable } = await import('node:stream')
                Readable.fromWeb(upstreamRes.body as any).pipe(res)
              } else {
                res.end()
              }
            } catch (err: any) {
              res.writeHead(502, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: { message: err?.message || String(err) } }))
            }
          })
          return
        }
        next()
      })
    },
    generateBundle() {
      const patchedJs = getPatchedJs()
      if (patchedJs.length > 0) {
        this.emitFile({
          type: 'asset',
          fileName: 'vendor/excalidraw/excalidraw.production.min.js',
          source: patchedJs,
        })
      }
      if (fs.existsSync(vendorCssPath)) {
        this.emitFile({
          type: 'asset',
          fileName: 'vendor/excalidraw/excalidraw.production.min.css',
          source: fs.readFileSync(vendorCssPath),
        })
      }
      for (const { rel, full } of getFilesRecursively(prodDir)) {
        this.emitFile({
          type: 'asset',
          fileName: `vendor/excalidraw/${rel}`,
          source: fs.readFileSync(full),
        })
      }
    },
  }
}

/**
 * PDF.js needs three things it cannot bundle: a module worker, the Adobe CMaps that non-embedded CJK
 * fonts are decoded with, and the standard-14 fonts a PDF may name without carrying. All three are
 * fetched at read time by URL, so they are served as vendor assets the same way the drawing engine's
 * are — and none of them belongs in the offline shell, which is why they are not in
 * `pwa.config.ts`'s core list. A 1.7 MB cmap directory costs nothing until a PDF asks one of its
 * files by name.
 */
const pdfjsVendorPlugin = (): Plugin => {
  const dist = './node_modules/pdfjs-dist'
  const workerPath = r(`${dist}/build/pdf.worker.min.mjs`)
  const cmapDir = r(`${dist}/cmaps`)
  const fontDir = r(`${dist}/standard_fonts`)
  const wasmDir = r(`${dist}/wasm`)
  const prefix = '/vendor/pdfjs/'

  const listFiles = (dir: string, base: string): { rel: string; full: string }[] => {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      const rel = base ? `${base}/${entry.name}` : entry.name
      return entry.isDirectory() ? listFiles(full, rel) : [{ rel, full }]
    })
  }

  const mimeFor = (file: string) => (file.endsWith('.mjs') || file.endsWith('.js')
    ? 'application/javascript'
    : file.endsWith('.css') ? 'text/css'
    : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')

  return {
    name: 'inkstone:pdfjs-vendor',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith(prefix)) return next()
        const rel = req.url.slice(prefix.length).split('?')[0]
        // The directory names are part of the URL space pdfjs builds, so only their own files serve.
        if (rel.includes('..') || rel.startsWith('/') || rel.includes('.mjs.map')) return next()
        const full = path.join(r(dist), rel)
        if (!full.startsWith(r(dist)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return next()
        res.setHeader('Content-Type', mimeFor(full))
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        res.end(fs.readFileSync(full))
      })
    },
    generateBundle() {
      const emitted = [
        ...listFiles(cmapDir, 'cmaps'),
        ...listFiles(fontDir, 'standard_fonts'),
        ...listFiles(wasmDir, 'wasm').filter((entry) => /\.(wasm|js)$/.test(entry.full)),
      ]
      if (fs.existsSync(workerPath)) {
        emitted.push({ rel: 'build/pdf.worker.min.mjs', full: workerPath })
      }
      for (const { rel, full } of emitted) {
        this.emitFile({ type: 'asset', fileName: `vendor/pdfjs/${rel}`, source: fs.readFileSync(full) })
      }
    },
  }
}

const getVendorChunkName = (id: string) => {

  if (!id.includes('node_modules') || preservesOnDemandBoundary(id)) return null

  const path = normalizeModuleId(id)

  if (path.includes('/katex/') && !path.includes('.css')) return 'vendor-katex'
  if (/@codemirror|@lezer|crelt|style-mod|w3c-keyname/.test(path)) return 'vendor-editor'
  if (/markdown-it|mdurl|entities|linkify-it|punycode|uc\.micro/.test(path)) {
    return 'vendor-markdown'
  }
  if (path.includes('/pdfjs-dist/')) return 'vendor-pdfjs'
  if (isReactModule(id)) return 'vendor-react'

  return null
}

/**
 * A file the dev server cannot watch is one save that does not hot-reload, not a dead server.
 *
 * chokidar emits `error` when `fs.watch` answers EBUSY (Windows locks a file while an editor, an
 * agent harness or an archiver is renaming it into place). EventEmitter treats an unhandled `error`
 * as fatal, so the dev server used to exit mid-keystroke and the next page load read as a start-up
 * failure. The listener is the fix; `server.watch.ignored` below keeps the known writers out of the
 * tree so the warning stays rare.
 */
const watcherErrorsAreNotFatal = (): Plugin => ({
  name: 'inkstone:watcher-errors',
  configureServer(server) {
    server.watcher.on('error', (error) => {
      console.warn('[inkstone] dev watcher could not follow a path; this change will not hot-reload.', error)
    })
  },
})

const config: UserConfigFnPromise = async ({ mode, command }) => ({
  plugins: [
    watcherErrorsAreNotFatal(),
    react(),
    katexWoff2Only(),
    excalidrawVendorPlugin(),
    pdfjsVendorPlugin(),
    tailwindcss(),
    inkstonePwa(),
    ...(mode === 'demo'
      ? []
      : [
          (await import('@cloudflare/vite-plugin')).cloudflare({
            configPath: mode === 'kv' ? './wrangler.kv.toml' : undefined,
            persistState: !ephemeralDevState,
            ...(command === 'serve' && mode !== 'ai'
              ? { config: (worker) => { delete worker.ai } }
              : {}),
          }),
        ]),
  ],

  resolve: {
    alias: [
      { find: /^katex$/, replacement: r('./node_modules/katex/dist/katex.mjs') },
      { find: '@', replacement: r('./src/client') },
      { find: '@shared', replacement: r('./src/shared') },
      { find: '@zsviczian/excalidraw/obsidian-js', replacement: r('./node_modules/@zsviczian/excalidraw/dist/obsidian/excalidraw.production.min.js') },
      { find: '@zsviczian/excalidraw/obsidian-css', replacement: r('./node_modules/@zsviczian/excalidraw/dist/obsidian/excalidraw.production.min.css') },
    ],
  },

  server: {
    port: 7712,
    strictPort: false,
    watch: {
      /*
       * Windows reports EBUSY for a path that is being renamed into place, and chokidar treats that
       * as a fatal error: one atomic save anywhere under the project used to end the dev server with
       * an uncaught FSWatcher exception, which the person in front of the screen experiences as
       * "Inkstone did not start". Editors and agent harnesses write through a locked temp directory
       * next to the target; browser profiles and Wrangler's local state are locked for as long as
       * they run. None of them is source to reload, so they are kept out of the watched tree.
       */
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/.wrangler/**',
        '**/.worktrees*/**',
        '**/.freebuff/**',
        '**/.workbuddy-ai/**',
        '**/tmp/**',
        '**/.*.tmpdir/**',
        '**/.tmp-*',
        '**/*.tmp',
        '**/*.TMP',
        '**/*~RF*',
        '**/~$*',
        '**/*.swp',
      ],
    },
  },

  preview: {
    port: 7713,
  },

  build: {
    ...(mode === 'demo' ? { outDir: 'dist/demo' } : {}),
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 250,
    cssMinify: 'lightningcss',
    rolldownOptions: {
      checks: {
        pluginTimings: false,
      },
      output: {
        minify: true,
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: (id) => isReactModule(id),
              priority: 40,
            },
            {
              name: 'initial',
              test: /[\\/]src[\\/]client[\\/]/,
              tags: ['$initial'],
              priority: 35,
            },
            {
              name: 'vendor-katex',
              test: (id) => (id === 'katex' || normalizeModuleId(id).includes('/katex/')) && !id.includes('.css'),
              priority: 30,
            },
            {
              name: 'vendor-icons',
              test: isLucideModule,
              priority: 25,
            },
            {
              name: getVendorChunkName,
              priority: 20,
            },
          ],
        },
      },
    },
  },
})

export default config
