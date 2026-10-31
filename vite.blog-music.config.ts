import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { BLOG_RENDERER_VERSION } from './src/shared/blog/renderer.ts'

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: {
    alias: [
      { find: /^katex$/, replacement: r('./node_modules/katex/dist/katex.mjs') },
      { find: '@', replacement: r('./src/client') },
      { find: '@shared', replacement: r('./src/shared') },
    ],
  },
  build: {
    outDir: `dist/client/blog-runtime/${BLOG_RENDERER_VERSION}/music`,
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: r('./src/blog-runtime/music.tsx'),
      formats: ['es'],
      fileName: () => 'music.js',
      cssFileName: 'music',
    },
    rollupOptions: {
      output: {
        assetFileNames: (asset) => asset.names?.some((name) => name.endsWith('.css')) ? 'music.css' : 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
})
