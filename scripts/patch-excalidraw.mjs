import fs from 'node:fs'
import path from 'node:path'
import { applyExcalidrawPatches, EXCALIDRAW_PATCHES } from './excalidraw-patch.mjs'

const vendorJsPath = path.resolve('node_modules/@zsviczian/excalidraw/dist/obsidian/excalidraw.production.min.js')

if (!fs.existsSync(vendorJsPath)) {
  process.exit(0)
}

const source = fs.readFileSync(vendorJsPath, 'utf8')
const { content, applied, already, unmatched } = applyExcalidrawPatches(source)

if (unmatched.length) {
  console.error(
    '[patch-excalidraw] ' + unmatched.length + '/' + EXCALIDRAW_PATCHES.length +
    ' edits did not match the vendored engine build: ' + unmatched.join(', ') +
    '. The bundle would ship unpatched, which is the failure this script exists to prevent.'
  )
  process.exit(1)
}

if (applied.length) {
  fs.writeFileSync(vendorJsPath, content, 'utf8')
}

console.log('[patch-excalidraw] ' + applied.length + ' applied, ' + already.length + ' already present of ' + EXCALIDRAW_PATCHES.length)
