import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import { walkSource } from './lib/scratch-files.mjs'

/**
 * `useEffect` has to say when it re-runs.
 *
 * `tsc -b` is the only static gate this repo runs on source, and there is no ESLint, so nothing checked
 * hook dependency arrays: one navigation shortcut registered and removed its global `keydown` listener on
 * every render (round 2, C2-01) and stayed green through typecheck, i18n, comments and the full suite.
 *
 * A missing second argument is not always wrong — running after every render is a real technique — so the
 * exemptions below are per file and per line, and a new bare `useEffect` fails until someone says so
 * deliberately.
 */
const EFFECTS = new Set(['useEffect', 'useLayoutEffect'])

/**
 * Files still carrying an unreviewed bare `useEffect`.
 *
 * Registered per file, the same way `check-i18n.mjs` registers its Chinese exemptions: the point is to
 * stop the number growing, not to adjudicate nineteen other features in the change that introduced the
 * gate. Removing an entry means that file has been looked through.
 */
const exemptFiles = new Set([
  'src/client/components/FilterInput.tsx',
  'src/client/components/activity-calendar/use-activity-calendar.ts',
  'src/client/features/chat/ComposerControls.tsx',
  'src/client/features/chat/MessageParts.tsx',
  'src/client/features/development/api-tester/components/RequestBuilder.tsx',
  'src/client/features/email/ComposePanel.tsx',
  'src/client/features/inknote/tools/RecordingPanel.tsx',
  'src/client/features/mindmap/MindmapStandaloneEditor.tsx',
  'src/client/features/mindmap/use-mindmap-document.ts',
  'src/client/features/presentation/deck-print.tsx',
  'src/client/features/presentation/use-audience-follow.ts',
  'src/client/features/reading/reader/EpubStage.tsx',
  'src/client/features/reading/reader/ReaderView.tsx',
  'src/client/features/reading/reader/usePointerPaging.ts',
  'src/client/features/rss/ArticlePreviewCard.tsx',
  'src/client/features/share/dashboard/use-auto-refresh.ts',
  'src/client/lib/hooks.ts',
  'src/client/lib/markdown/kanban/ui/kanban-panel.tsx',
  'src/client/lib/markdown/kanban/ui/kanban-view-tabs.tsx',
])

const seenExempt = new Set()
const failures = []
let checked = 0
for (const file of walkSource('src')) {
  if (!/\.tsx?$/.test(file) || file.includes(`${path.sep}locales${path.sep}`)) continue
  const text = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lineOf = (pos) => source.getLineAndCharacterOfPosition(pos).line
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && EFFECTS.has(node.expression.text)) {
      checked += 1
      if (node.arguments.length < 2 ) {
        if (exemptFiles.has(file)) seenExempt.add(file)
        else failures.push(`${file}:${lineOf(node.getStart(source)) + 1}: ${node.expression.text}() has no dependency array — it re-runs after every render`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

if (failures.length) {
  console.error(`hook policy check failed (${failures.length}):\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`hook policy check passed: ${checked} effect calls all declare when they re-run`)
