import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import { walkSource } from './lib/scratch-files.mjs'

/**
 * Static accessibility rules for the things a green suite cannot see.
 *
 * Round 2 found a status icon carrying `aria-label` on a bare `<svg>` — a name on an element the
 * accessibility tree may never surface — and a progress bar whose value was announced only once the scan
 * had already been cancelled. Neither is visible to `tsc`, and both survived every gate at the time.
 *
 * The icon rule is scoped to components imported from `lucide-react` on purpose: `<Input aria-label>` and
 * friends name themselves correctly without a role, and a rule that swept them up would have been
 * silenced on its first run.
 */
const ICON_PACKAGE = 'lucide-react'

/**
 * Findings outside the navigation app, registered so the rules can land without adjudicating nine other
 * features in the change that introduced them. Each is `file:line`, so editing the surrounding code
 * retires the entry and the site has to be looked at again.
 */
const exempt = new Set([
  'src/client/features/chat/ChatAttachments.tsx:151',
  'src/client/features/cloudflare/screens/DashboardScreen.tsx:250',
  'src/client/features/cloudflare/screens/WorkersScreen.tsx:232',
  'src/client/features/cloudflare/screens/accounts/AccountTable.tsx:247',
  'src/client/features/cloudflare/screens/ai/StatsTab.tsx:396',
  'src/client/features/development/database/StudioSidebar.tsx:684',
  'src/client/features/imgbed/settings/SettingsPage.tsx:200',
  'src/client/features/memos/pages/memo-settings/ImportExportSettings.tsx:194',
  'src/client/features/sidebar/Sidebar.tsx:988',
  'src/client/features/subscriptions/SubscriptionDetail.tsx:137',
  'src/client/features/youtube/quota/QuotaDialog.tsx:168',
])

const failures = []
let labelledIcons = 0
let progressBars = 0

for (const file of walkSource('src')) {
  if (!/\.tsx$/.test(file) || file.includes(`${path.sep}locales${path.sep}`)) continue
  const text = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  const iconNames = new Set()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (statement.moduleSpecifier.getText().slice(1, -1) !== ICON_PACKAGE) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) bindings.elements.forEach((element) => iconNames.add(element.name.getText()))
  }

  const attributeOf = (node, name) => node.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === name,
  )
  const attributeValue = (node, name) => attributeOf(node, name)?.initializer?.getText().replace(/^["']|["']$/g, '') ?? ''

  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) && iconNames.has(node.tagName.getText())) {
      const labelled = Boolean(attributeOf(node, 'aria-label'))
      if (labelled && !attributeOf(node, 'role') && !attributeOf(node, 'aria-hidden')) {
        if (!exempt.has(`${file}:${lineOf(node)}`)) failures.push(`${file}:${lineOf(node)}: <${node.tagName.getText()}> carries aria-label without role="img"`)
      }
      if (labelled) labelledIcons += 1
    }
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && attributeValue(node, 'role') === 'progressbar') {
      progressBars += 1
      if (!attributeOf(node, 'aria-valuetext')) {
        if (!exempt.has(`${file}:${lineOf(node)}`)) failures.push(`${file}:${lineOf(node)}: a progressbar needs aria-valuetext, or a reader is told only a number`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

if (failures.length) {
  console.error(`accessibility policy check failed (${failures.length}):\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`accessibility policy check passed: ${labelledIcons} labelled icons and ${progressBars} progress bars all carry their role and value`)
