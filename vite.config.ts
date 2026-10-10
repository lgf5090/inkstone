import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, UserConfigFnPromise } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { inkstonePwa } from './pwa.config.ts'

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
    let content = fs.readFileSync(vendorJsPath, 'utf8')
    content = content.replace(
      'return o.push(new URL(t,mu.ASSETS_FALLBACK_URL)),o',
      'return(o.length||o.push(new URL(t,this.normalizeBaseUrl(mu.ASSETS_FALLBACK_URL)))),o',
    )
    const fallbackTarget = 'F(mu,"ASSETS_FALLBACK_URL",`https://esm.sh/${y.PKG_NAME?`${y.PKG_NAME}@${y.PKG_VERSION}`:"@excalidraw/excalidraw"}/dist/prod/`);'
    if (content.includes(fallbackTarget)) {
      content = content.replace(fallbackTarget, 'F(mu,"ASSETS_FALLBACK_URL","/vendor/excalidraw/");')
    }
    content = content.replace(
      'let o=this.app.props.UIOptions.canvasActions;',
      'let o=this.app?.props?.UIOptions?.canvasActions;if(!this.app||!o)return null;',
    )
    content = content.replace(
      'this.unmounted=!0,this.viewport.destroy(),this.removeEventListeners(),this.library.destroy()',
      'this.unmounted=!0,this.viewport?.destroy?.(),this.removeEventListeners(),this.library?.destroy?.()',
    )
    content = content.replace(
      'this.iFrameRefs.forEach((i,a)=>{t.has(a)||this.iFrameRefs.delete(a)})',
      'this.iFrameRefs?.forEach?.((i,a)=>{t.has(a)||this.iFrameRefs.delete(a)})',
    )
    content = content.replace(
      '(0,AB.useEffect)(()=>{A.canvas.style.width=',
      '(0,AB.useEffect)(()=>{if(!A?.canvas)return;A.canvas.style.width=',
    )
    content = content.replace(
      'this.store.onStoreIncrementEmitter.clear(),this.store.onDurableIncrementEmitter.clear()',
      'this.store?.onStoreIncrementEmitter?.clear?.(),this.store?.onDurableIncrementEmitter?.clear?.()',
    )
    content = content.replace(
      'componentDidUpdate(t,o){let i=this.renderOverridesUpdatePending;',
      'componentDidUpdate(t,o){if(this.unmounted)return;let i=this.renderOverridesUpdatePending;',
    )
    content = content.replace(
      'this.store.commit(r,this.state)',
      'this.store?.commit?.(r,this.state)',
    )
    content = content.replace(
      'this.iFrameRefs.clear(),this.iFrameRefs=null',
      'this.iFrameRefs?.clear?.(),this.iFrameRefs=null',
    )
    content = content.replace(
      'this.embedsValidationStatus.clear(),this.embedsValidationStatus=null',
      'this.embedsValidationStatus?.clear?.(),this.embedsValidationStatus=null',
    )
    content = content.replace(
      'this.initializedEmbeds.clear(),this.initializedEmbeds=null',
      'this.initializedEmbeds?.clear?.(),this.initializedEmbeds=null',
    )
    content = content.replace(
      'this.elementsPendingErasure.clear(),this.elementsPendingErasure=null',
      'this.elementsPendingErasure?.clear?.(),this.elementsPendingErasure=null',
    )
    content = content.replace(
      'componentWillUnmount(){this.api={...this.api,isDestroyed:!0};',
      'componentWillUnmount(){if(this.unmounted)return;this.unmounted=!0;this.api={...this.api,isDestroyed:!0};',
    )
    content = content.replace(
      'this.history.clear(),this.store.clear()',
      'this.history?.clear?.(),this.store?.clear?.()',
    )
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
          req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8')
              const parsed = JSON.parse(raw)
              const { endpoint, headers = {}, body } = parsed
              const targetUrl = new URL(endpoint)
              const upstreamHeaders = new Headers()
              for (const [k, v] of Object.entries(headers)) {
                const lower = k.toLowerCase()
                if (lower === 'host' || lower === 'connection' || lower === 'content-length') continue
                if (typeof v === 'string') upstreamHeaders.set(k, v)
              }
              if (!upstreamHeaders.has('content-type')) {
                upstreamHeaders.set('content-type', 'application/json')
              }
              const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {})
              const upstreamRes = await fetch(targetUrl.toString(), {
                method: 'POST',
                headers: upstreamHeaders,
                body: payload,
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

const getVendorChunkName = (id: string) => {
  if (!id.includes('node_modules') || preservesOnDemandBoundary(id)) return null

  const path = normalizeModuleId(id)

  if (path.includes('/katex/') && !path.includes('.css')) return 'vendor-katex'
  if (/@codemirror|@lezer|crelt|style-mod|w3c-keyname/.test(path)) return 'vendor-editor'
  if (/markdown-it|mdurl|entities|linkify-it|punycode|uc\.micro/.test(path)) {
    return 'vendor-markdown'
  }
  if (isReactModule(id)) return 'vendor-react'

  return null
}

const config: UserConfigFnPromise = async ({ mode, command }) => ({
  plugins: [
    react(),
    katexWoff2Only(),
    excalidrawVendorPlugin(),
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
