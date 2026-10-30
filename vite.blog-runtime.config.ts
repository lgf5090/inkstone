import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { BLOG_RENDERER_VERSION } from './src/shared/blog/renderer.ts'

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/**
 * The reading runtime is a standalone build on purpose: it is deployed under
 * `dist/client/blog-runtime/<rendererVersion>/` and served through the blog's proxy, so every asset
 * it imports has to live under that directory rather than in the app's own content-hashed chunks.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The bundle is fetched as a plain module by a page that has no bundler; React's production switch
  // reads `process.env.NODE_ENV`, which no browser defines.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  resolve: {
    alias: [
      { find: /^katex$/, replacement: r('./node_modules/katex/dist/katex.mjs') },
      { find: /^katex\/dist\/katex\.min\.css$/, replacement: r('./src/blog-runtime/katex-stub.css') },
      { find: '@', replacement: r('./src/client') },
      { find: '@shared', replacement: r('./src/shared') },
      { find: '@zsviczian/excalidraw/obsidian-js', replacement: r('./node_modules/@zsviczian/excalidraw/dist/obsidian/excalidraw.production.min.js') },
      { find: '@zsviczian/excalidraw/obsidian-css', replacement: r('./node_modules/@zsviczian/excalidraw/dist/obsidian/excalidraw.production.min.css') },
    ],
  },
  build: {
    outDir: `dist/client/blog-runtime/${BLOG_RENDERER_VERSION}`,
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: false,
    // One stylesheet under a stable name: the blog links it next to the script, and every rule the
    // surface can need (including stylesheet imports behind dynamic block loaders) is already in it.
    cssCodeSplit: false,
    lib: {
      entry: r('./src/blog-runtime/main.tsx'),
      formats: ['es'],
      fileName: () => 'runtime.js',
      cssFileName: 'runtime',
    },
    rollupOptions: {
      output: {
        assetFileNames: (asset) => asset.names?.some((name) => name.endsWith('.css'))
          ? 'runtime.css'
          : 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
})
