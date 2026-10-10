import fs from 'node:fs'
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

  return {
    name: 'inkstone:excalidraw-vendor',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next()
        const cleanUrl = req.url.split('?')[0]
        if (cleanUrl === '/vendor/excalidraw/excalidraw.production.min.js') {
          res.setHeader('Content-Type', 'application/javascript')
          res.setHeader('Cache-Control', 'no-cache')
          if (fs.existsSync(vendorJsPath)) {
            res.end(fs.readFileSync(vendorJsPath))
            return
          }
        }
        if (cleanUrl === '/vendor/excalidraw/excalidraw.production.min.css') {
          res.setHeader('Content-Type', 'text/css')
          res.setHeader('Cache-Control', 'no-cache')
          if (fs.existsSync(vendorCssPath)) {
            res.end(fs.readFileSync(vendorCssPath))
            return
          }
        }
        next()
      })
    },
    generateBundle() {
      if (fs.existsSync(vendorJsPath)) {
        this.emitFile({
          type: 'asset',
          fileName: 'vendor/excalidraw/excalidraw.production.min.js',
          source: fs.readFileSync(vendorJsPath),
        })
      }
      if (fs.existsSync(vendorCssPath)) {
        this.emitFile({
          type: 'asset',
          fileName: 'vendor/excalidraw/excalidraw.production.min.css',
          source: fs.readFileSync(vendorCssPath),
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
