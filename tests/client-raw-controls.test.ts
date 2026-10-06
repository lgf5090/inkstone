import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * SH-49 asked for interactive controls to come from the component system, and for a `div`/`span`
 * with a click handler never to be passed off as one. That guard only read `features/share`, so the
 * shared components every feature uses kept the very shapes it forbade — the hub rows were
 * `div[role=button]` rows, and an account with any tag made the share center's own axe pass report
 * `button-name` and `nested-interactive` (SH-93). This reads the whole client tree instead.
 *
 * Three rules, in the order they matter:
 *
 *  1. No `div`/`span` that says `role='button'`. A fake control is wrong wherever it is, so this
 *     applies everywhere, with no exceptions: the last three the rule tolerated were the kanban
 *     board's card, its gallery tile and its list row, and each was a card that opened a detail and
 *     held controls of its own (SH-107). Redesigning the card — the title is a real button, the card
 *     is a container — took all three entries away rather than keeping an exemption nobody needs.
 *  2. Every raw `<button>` has to carry an accessible name — `aria-label`, `aria-labelledby`,
 *     `title`, or visible text. This is the `button-name` rule axe applies, read statically, and it
 *     is what the 37 unnamed icon buttons across the app were failing. Names are read from the
 *     element's own attributes and its subtree: a name a wrapper component injects, or one spread
 *     in with `{...rest}`, is not something this can see, so an entry is never needed for it — but a
 *     raw button that only *looks* named because of a wrapper is not caught here either. That limit
 *     is the price of not rendering the app; the browser gates read what a real screen reader sees.
 *
 *     What counts as text was measured against a browser rather than guessed: an expression that
 *     renders an element — `{expanded ? <ChevronDown/> : <ChevronRight/>}` — is an icon, not a
 *     label, and axe reports those buttons as unnamed. Reading any expression as text (which is what
 *     this rule did at first) called eight icon-only buttons named while the browser called them
 *     nameless: the kanban board's row, group and list expand toggles, the attachment drive's two
 *     selection cells, a folder icon picker and the blog category colour swatches. `{t('…')}` and
 *     `{name}` are still text: they are what a label is usually written as, and no static read can
 *     tell a bare identifier apart from a variable holding an icon.
 *  3. Inside `src/client/components` — the layer every feature shares — a raw `<button>` needs a
 *     written reason. These are the primitive implementations and the rows and cells whose geometry
 *     the primitives cannot express (a menu row stretches a flexible label between two fixed slots,
 *     a calendar cell is a grid track); the rule's job is to keep the next one from arriving
 *     unnoticed, not to relitigate the ones already argued.
 *  4. A container with a hit target of its own — a click or pointer-down handler on a `div`/`span`/
 *     row element — must not hold a control. This is the half of SH-107 rule 1 could not see: taking
 *     the `role` off a card that holds its own buttons leaves a click target that *looks* like a
 *     container, and the browser still reads `nested-interactive` (and, without a keyboard path, a
 *     keyboard cannot reach the card at all — the same shape SH-110 fixed in three more views). A
 *     pointer-down on a drag handle is read too: it is the other way a container becomes a hit
 *     target. What is left after both fixes is nine sites in six files, every one of them a container
 *     whose handler *stops* a click from reaching an outer one, watches for a row so a sheet can
 *     close, or is the backdrop of the dialog it holds — each is listed with its reason and its
 *     count, so a new site, or a tenth in a listed file, fails here.
 *
 * Features outside that layer are not required to funnel every button through the primitives: that
 * is a per-context judgement (146 files and 397 sites today), and an allowlist of 146 entries would
 * be a graveyard rather than a reason. Rules 1 and 2 are the part that holds for them.
 *
 * Both directions fail throughout: an unlisted file that grows a violation, and an entry for a file
 * whose violation is gone.
 */
const CLIENT_DIR = path.join('src', 'client')

/**
 * Buttons this rule reads as unnamed but a browser does not: the name is rendered by a component the
 * static read cannot see into. Entries are per file and fail in both directions, like the others.
 */
const COMPONENT_NAMED_BUTTONS = new Map<string, string>([
  [
    'src/client/components/form.tsx',
    'The checkbox row takes its name from its `label`, which the row draws inside a `<span>`: this read sees an element where a browser reads that span\'s text. A row created with no label is unnamed, and that is the caller\'s contract, not this element\'s.',
  ],
  [
    'src/client/features/settings/SettingsPanel.tsx',
    'A search hit is named by `<HitTitle>`, the component that emphasises the matched substring inside nested spans. The name is text a component writes, which is exactly what a static read cannot see and a screen reader does.',
  ],
  [
    'src/client/features/tags/ManageTagsModal.tsx',
    'The tag row is named by `<ManagedTagName>`, the same highlighting component one level down: the row\'s only child draws the tag name as text, and this read stops at the child.',
  ],
])

/**
 * The shared layer's raw buttons, each with why it is not a `Button`/`IconButton`. `Button` fixes a
 * height and padding per size and wraps its children in one inline-flex span, which is the wrong
 * shape for a row that stretches a label between two fixed slots or for a control drawn as a grid
 * cell; the primitives themselves are the files the components are supposed to come from.
 */
const SHARED_RAW_BUTTONS = new Map<string, string>([
  [
    'src/client/components/primitives.tsx',
    'The `<button>` inside `Button`/`IconButton` itself: the component system points here, so the element has to be written somewhere.',
  ],
  [
    'src/client/components/form.tsx',
    'Form primitives (chips, the segmented control, the switch and its rows) — the same position as `primitives.tsx`: this is the layer features call, not a caller of it.',
  ],
  [
    'src/client/components/overlay.tsx',
    'The one menu row both menu surfaces draw; this fork keeps it in `overlay.tsx` rather than a menu-row module. A row is a fixed-height track holding an icon, a label that has to stretch and truncate, a check mark and a shortcut or a panel arrow as siblings, and `Button` fixes a size and wraps its children in one non-stretching span, so the row owns its own element.',
  ],
  [
    'src/client/components/ErrorBoundary.tsx',
    'The reload action on the crash screen. That screen is what renders after the tree above it has already thrown, so it holds a raw element rather than reaching back into the component system that failed.',
  ],
  [
    'src/client/components/feedback.tsx',
    'The dismiss affordance inside a toast: a 12px icon on the text line, wrapped in the `Tooltip` that names it. `IconButton`\'s smallest box is larger than that line and would grow every toast in the stack.',
  ],
  [
    'src/client/components/activity-calendar/year-view.tsx',
    'Calendar cells: the hit area is a grid track, and the element carries the roving tabIndex and `aria-label` the calendar navigation needs. `Button` sizes do not apply to a cell.',
  ],
  [
    'src/client/components/activity-calendar/month-view.tsx',
    'Calendar cells, the same grid geometry as the year view.',
  ],
  [
    'src/client/components/activity-calendar/weeks-strip.tsx',
    'Calendar cells and the note rows inside an expanded day, all laid out on the strip grid.',
  ],
  [
    'src/client/components/activity-calendar/header.tsx',
    'The calendar header control, aligned with the strip it heads rather than sized by the button scale.',
  ],
])

/** A control a source file writes by hand, and whether it carries a name of its own. */
interface Site {
  file: string
  line: number
  named: boolean
}

/**
 * A non-interactive element that is a hit target itself and holds a control. Only intrinsic tags are
 * read: a component that renders a control passes it through its own file, where the container and
 * the control are written in the same place, and one that only *consumes* children cannot be judged
 * from here. `onPointerDown`/`onMouseDown` are read alongside `onClick` — a drag handle is a hit
 * target too, and it is the one kind of container that legitimately holds buttons.
 */
interface ClickContainerSite {
  file: string
  line: number
  tag: string
  holds: string
}

function describeSite(site: Site): string {
  return `${site.file}:${site.line}`
}

function describeContainer(site: ClickContainerSite): string {
  return `${site.file}:${site.line} <${site.tag}> holds <${site.holds}>`
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function relative(file: string): string {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

/** The attributes written on a JSX element, and whether it spreads any in. */
function attributesOf(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): Map<string, ts.JsxAttribute['initializer']> {
  const attributes = new Map<string, ts.JsxAttribute['initializer']>()
  for (const property of node.attributes.properties) {
    if (ts.isJsxAttribute(property)) attributes.set(property.name.getText(), property.initializer)
  }
  return attributes
}

/** A literal attribute value, or `null` when it is an expression this cannot evaluate. */
function literalValue(initializer: ts.JsxAttribute['initializer']): string | null {
  if (!initializer) return null
  return ts.isStringLiteral(initializer) ? initializer.text : null
}

/**
 * Whether a subtree carries text a person could read as the name. A nested element is not text (it
 * is an icon), and neither is an expression that renders one — the browser is the judge of that, and
 * what it found is in the rule 2 note above. An expression that holds no element is text: `{t('…')}`
 * and `{name}` are how labels are written, and an identifier holding an icon cannot be told apart
 * from one holding a label by reading the source.
 */
function hasReadableText(node: ts.JsxChild): boolean {
  if (ts.isJsxText(node)) return node.text.trim().length > 0
  if (ts.isJsxExpression(node)) {
    const expression = node.expression
    if (!expression) return false
    return !rendersElement(expression)
  }
  if (ts.isJsxElement(node) || ts.isJsxFragment(node)) return node.children.some(hasReadableText)
  return false
}

/** Whether anything in this expression draws an element rather than text. */
function rendersElement(node: ts.Node): boolean {
  let found = false
  const visit = (child: ts.Node): void => {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) found = true
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

/** Whether a raw `<button>` carries a name: an attribute, or text inside it. */
function hasAccessibleName(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, attributes: Map<string, ts.JsxAttribute['initializer']>): boolean {
  if (attributes.has('aria-label') || attributes.has('aria-labelledby') || attributes.has('title')) return true
  const element = node.parent
  return ts.isJsxElement(element) && element.children.some(hasReadableText)
}

/** Every raw button and every fake control the client tree writes by hand. */
function scan(): { rawButtons: Site[]; fakeControls: Site[]; clickContainers: ClickContainerSite[] } {
  const rawButtons: Site[] = []
  const fakeControls: Site[] = []
  const clickContainers: ClickContainerSite[] = []
  for (const file of sourceFiles(CLIENT_DIR)) {
    const text = fs.readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const name = relative(file)
    clickContainers.push(...scanClickContainers(name, source))
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText()
        const attributes = attributesOf(node)
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        if (tag === 'button') rawButtons.push({ file: name, line, named: hasAccessibleName(node, attributes) })
        // Only a written-out role: one passed as an expression is read at runtime, and the browser
        // gates are what read it.
        if ((tag === 'div' || tag === 'span') && literalValue(attributes.get('role') ?? null) === 'button')
          fakeControls.push({ file: name, line, named: false })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { rawButtons, fakeControls, clickContainers }
}

const CONTROL_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea'])
const CONTROL_ROLES = new Set(['button', 'link', 'tab', 'option', 'menuitem', 'checkbox', 'switch'])
const NON_INTERACTIVE_TAGS = new Set(['div', 'span', 'li', 'td', 'tr', 'section', 'article', 'aside', 'p', 'label'])
const HIT_TARGET_ATTRIBUTES = ['onClick', 'onPointerDown', 'onMouseDown']

/** Whether this element is a control: the tag says so, or a literal role on it does. */
function isControl(tag: string, attributes: Map<string, ts.JsxAttribute['initializer']>): boolean {
  if (CONTROL_TAGS.has(tag)) return true
  const role = literalValue(attributes.get('role') ?? null)
  return role !== null && CONTROL_ROLES.has(role)
}

/**
 * The containers that are hit targets and hold a control, read from the written JSX. A self-closing
 * element has no subtree, so the only elements that can hold anything are the paired ones — reading
 * a self-closing element's *parent* would report the container's siblings as its contents, which is
 * the false positive that put a prose host and the footer link beside it on this list.
 */
function scanClickContainers(file: string, source: ts.SourceFile): ClickContainerSite[] {
  const sites: ClickContainerSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText()
      const attributes = attributesOf(node)
      const isHitTarget = HIT_TARGET_ATTRIBUTES.some((attribute) => attributes.has(attribute))
      if (!isControl(tag, attributes) && NON_INTERACTIVE_TAGS.has(tag) && isHitTarget) {
        const holds = findControl(node.parent as ts.JsxElement)
        if (holds) {
          sites.push({
            file,
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            tag,
            holds,
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites
}

/** The tag of the first control inside this element's own JSX, if it writes one. */
function findControl(element: ts.JsxElement): string | null {
  let found: string | null = null
  const walk = (node: ts.Node): void => {
    if (found) return
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText()
      if (isControl(tag, attributesOf(node))) {
        found = tag
        return
      }
    }
    ts.forEachChild(node, walk)
  }
  for (const child of element.children) walk(child)
  return found
}

/**
 * The containers that are hit targets holding a control and are not the affordance. Every one is a
 * `stopPropagation` guard: the outer element owns the click and the container exists to keep it from
 * reaching it (the card's pane activation, the submenu row's own click), or — the hover card's — the
 * element is the drag handle of a pinned window and the controls are that window's own. Each entry
 * carries the number of sites in the file, so a new one there fails rather than hiding behind it.
 */
const CLICK_CONTAINER_EXCEPTIONS = new Map<string, { sites: number; reason: string }>([
  [
    'src/client/features/preview/wiki-link-hover-card/index.tsx',
    {
      sites: 1,
      reason: "The pinned window's header: a pointer-down drag handle whose children are the window's own pin and stack buttons. Clicking the header does nothing on its own — the drag is what the handler is for, and a drag handle has to be under the pointer the controls are drawn on.",
    },
  ],
  [
    'src/client/features/preview/Lightbox.tsx',
    {
      sites: 2,
      reason: 'Both are the viewer\'s own chrome: the backdrop is the modal element, and closing on a press that misses the image is what a lightbox does; the strip beside it stops the press so tapping zoom or download does not close the viewer. The links inside are that dialog\'s toolbar.',
    },
  ],
  [
    'src/client/features/shell/MobileLibraryFilters.tsx',
    {
      sites: 1,
      reason: 'The sheet\'s scroll body. Its handler only watches for a row so the sheet can close after the row activates — the rows are the affordances, and the container exists so a long list scrolls without stealing a tap.',
    },
  ],
  [
    'src/client/features/tags/TagAppearanceMenus.tsx',
    {
      sites: 1,
      reason: 'The colour panel stops a click from reaching the row that opened it, so picking a swatch does not also dismiss the flyout that hosts the panel. The panel is not an affordance of its own: the swatches inside it are.',
    },
  ],
  [
    'src/client/lib/markdown/kanban/ui/kanban-card-subtasks.tsx',
    {
      sites: 3,
      reason: 'The subtask list, one subtask row and the add-subtask field: all three stop a click from reaching the card (or the pane) that holds them, which is what keeps ticking a checkbox from also activating what is behind it. The card is a container now (SH-107) and these guards stay because the pane underneath is not the card.',
    },
  ],
  // The archive shelf and the import/export panel used to be listed here: each wrote its own
  // `stopPropagation` div. Both are drawn by the board's shared panel now, which stops the same
  // presses at one place (`ui/kanban-panel.tsx`) while placing them under their own control, so the
  // written shape is gone from those two files and the entries had to go with it — the guard reads
  // what a file writes, and the presses it used to excuse are held by `kanban-panel.test.ts`
  // (`a press inside the panel does not reach the board behind it`).
  [
    'src/client/lib/markdown/kanban/ui/kanban-person-picker.tsx',
    {
      sites: 1,
      reason: 'The person panel stops a click from reaching the field that opened it, so typing a name into its search box does not reselect that field. The panel is not an affordance of its own: the search box and the teammate rows inside it are.',
    },
  ],
])

const SCAN = scan()
const SHARED_PREFIX = 'src/client/components/'
const SHARED_BUTTON_FILES = new Set(SCAN.rawButtons.filter((site) => site.file.startsWith(SHARED_PREFIX)).map((site) => site.file))

describe('client controls are real and named (SH-93, widening SH-49)', () => {
  it('scans the whole client tree', () => {
    const scanned = sourceFiles(CLIENT_DIR)
    expect(scanned.length).toBeGreaterThan(300)
    expect(scanned.some((file) => file.endsWith(path.join('client', 'App.tsx')))).toBe(true)
    expect(scanned.some((file) => file.includes(path.join('markdown', 'kanban', 'ui')))).toBe(true)
    expect(scanned.some((file) => fs.readFileSync(file, 'utf8').includes('<button'))).toBe(true)
  })

  it('models no control as a div or span with a button role', () => {
    expect(SCAN.fakeControls.map(describeSite)).toEqual([])
  })

  it('names every raw button it can read', () => {
    const offenders = SCAN.rawButtons
      .filter((site) => !site.named)
      .filter((site) => !COMPONENT_NAMED_BUTTONS.has(site.file))
      .map(describeSite)
    expect(offenders).toEqual([])
  })

  it('keeps the component-named exceptions honest', () => {
    for (const [file, reason] of COMPONENT_NAMED_BUTTONS) {
      expect(reason.length, `${file} has no reason written`).toBeGreaterThan(40)
      const unnamed = SCAN.rawButtons.filter((site) => site.file === file && !site.named)
      expect(unnamed.length, `${file} is listed as component-named but this rule now reads it`).toBeGreaterThan(0)
    }
  })

  it('keeps shared components on the component system, or says why not', () => {
    const offenders = SCAN.rawButtons
      .filter((site) => site.file.startsWith(SHARED_PREFIX))
      .filter((site) => !SHARED_RAW_BUTTONS.has(site.file))
      .map((site) => `${describeSite(site)} (no entry in this guard; use the component system or add it with its reason)`)
    expect(offenders).toEqual([])
  })

  it('keeps the shared-component exceptions honest', () => {
    for (const [file, reason] of SHARED_RAW_BUTTONS) {
      expect(reason.length, `${file} has no reason written`).toBeGreaterThan(40)
      expect(SHARED_BUTTON_FILES.has(file), `${file} is listed as a raw-button file but no longer writes one`).toBe(true)
    }
  })

  it('models no container as a click target holding a control', () => {
    const offenders = SCAN.clickContainers
      .filter((site) => !CLICK_CONTAINER_EXCEPTIONS.has(site.file))
      .map((site) => `${describeContainer(site)} (no entry in this guard; make it the control, or add it with its reason)`)
    expect(offenders).toEqual([])
  })

  // Both directions: an entry whose file no longer writes the shape it excuses fails, and so does a
  // file that grew a second one — the reason above describes the sites that were read, and a site
  // nobody reasoned about is exactly what this list is for.
  it('keeps the click-container exceptions honest', () => {
    for (const [file, { sites, reason }] of CLICK_CONTAINER_EXCEPTIONS) {
      expect(reason.length, `${file} has no reason written`).toBeGreaterThan(40)
      const found = SCAN.clickContainers.filter((site) => site.file === file)
      expect(
        found.map(describeContainer),
        `${file} is listed as a click container but does not hold exactly ${sites} control(s) under one`,
      ).toHaveLength(sites)
    }
  })
})
