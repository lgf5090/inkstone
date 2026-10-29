import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 120_000 })

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
    'src/client/features/excalidraw/library/ExcalidrawOfficialLibraryModal.tsx',
    'The import buttons switch their own caption: while a download runs they draw a spinner plus a different string, so the read sees a conditional fragment where the name is. A screen reader reads the span the component writes, which is the name the button has at that moment.',
  ],
  [
    'src/client/features/settings/SettingsPanel.tsx',
    'A search hit is named by `<HitTitle>`, the component that emphasises the matched substring inside nested spans. The name is text a component writes, which is exactly what a static read cannot see and a screen reader does.',
  ],
  [
    'src/client/features/tags/ManageTagsModal.tsx',
    'The tag row is named by `<ManagedTagName>`, the same highlighting component one level down: the row\'s only child draws the tag name as text, and this read stops at the child.',
  ],
  [
    'src/client/features/omnisearch/OmnisearchPrompt.tsx',
    'A search result row is a `role="option"` whose name is the note title, drawn by `<Highlighted>` as text split across the matched ranges. A listbox option is named by its content, so giving the element an `aria-label` as well would only risk the label and the visible title disagreeing.',
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
    'src/client/components/color-swatch.tsx',
    'The swatch every palette draws: a colour is a fixed-size round or rounded-square hit target carrying a background style, an active ring and a check mark, none of which `Button`\'s fixed height, padding and single inline span can express. Every colour menu in the app reaches it from here rather than writing its own button.',
  ],
  [
    'src/client/components/TagChip.tsx',
    'The chip every tag surface draws: a height-free, padding-sized inline-flex box carrying a colour dot or glyph, a truncating label with an optional `#`, a tabular count and an `aria-pressed` toggle. `Button` fixes a height per size and its responsive `md:h-*` still outranks a caller\'s `h-auto`, so a strip of chips holding different counts cannot keep one baseline through it. Every tag rail, chip filter and board label row reaches the box from here instead of writing its own.',
  ],
  [
    'src/client/components/copy-button.tsx',
    'A compact icon-only copy affordance: it is a 28px inline control whose padding and hover surface are deliberately smaller than every IconButton size, so it keeps its own element instead of enlarging a code-block toolbar.',
  ],
  [
    'src/client/components/json-tree.tsx',
    'The disclosure chevron on one JSON row: it is a 16px hit target aligned with the row text, while IconButton\'s smallest box would raise every row and break the tree\'s line rhythm.',
  ],
  [
    'src/client/components/tabs.tsx',
    'The tab itself: role="tab", aria-selected and roving tabindex are the component\'s contract, and the shared Button wraps its label in a truncating span and fixes a height that a tab strip cannot inherit.',
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
    'src/client/components/date-picker.tsx',
    'The picker draws three shapes no primitive sizes: a field-height trigger that has to sit on the same row box as every `Input`, 28px day cells on a seven-column grid, and the half-height chevrons that step the month and the clock. `Button` fixes a height per size and wraps its children in one non-stretching span, so none of them keep their geometry through it.',
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
    'src/client/components/activity-calendar/today-card.tsx',
    'The whole card is the target: two truncated lines, a week number and a year position on their own baselines. `Button` fixes a height and wraps its children in one non-stretching span, so neither line could keep its own width.',
  ],
  [
    'src/client/components/activity-calendar/weeks-strip.tsx',
    'Calendar cells and the note rows inside an expanded day, all laid out on the strip grid.',
  ],
  [
    'src/client/components/activity-calendar/header.tsx',
    'The calendar header control, aligned with the strip it heads rather than sized by the button scale.',
  ],
  [
    'src/client/components/select-menu.tsx',
    'The select\'s own trigger: it opens a menu rather than acting, so it carries `aria-haspopup="menu"` and hands the panel a ref to anchor to, and it wears the same 34/44px two-breakpoint height `Input` and `Select` share. `Button` fixes a height per size and wraps its children in one non-stretching span, so the trigger owns its element.',
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
        if ((tag === 'div' || tag === 'span') && literalValue(attributes.get('role')) === 'button')
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
  const role = literalValue(attributes.get('role'))
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
    'src/client/features/excalidraw/library/ExcalidrawLibraryTree.tsx',
    {
      sites: 1,
      reason: 'The "All folders" root row: it clears the folder filter on click and owns a hover menu button, so it is not a plain button, and it sits outside `role="tree"` because it is not a branch of that tree. The stencil tiles and folder rows that used to be registered here are real buttons now.',
    },
  ],
  [
    'src/client/features/inknote/components/InkTextStyleBar.tsx',
    {
      sites: 1,
      reason: 'The text style toolbar: its mouse-down handler only prevents a pressed style button from taking focus away from the textarea, because blur would commit the edit before the style applies. The handler is not an affordance of the container; every child acts through its own button or select.',
    },
  ],
  [
    'src/client/features/preview/wiki-link-hover-card/index.tsx',    {
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
    'src/client/features/imgbed/library/LibraryPage.tsx',
    {
      sites: 1,
      reason: 'The file grid\'s marquee surface: a pointer-down drag starts a rubber-band selection only when the press lands on empty space, and presses that start on a button, link, input or label are ignored so every control under it keeps its own behaviour. The selection itself is still each card\'s checkbox.',
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
    'src/client/features/preview/property-colors.tsx',
    {
      sites: 1,
      reason: 'The property colour panel is the same shape as the tag and folder panels: its root box stops a click from reaching the note surface that opened the flyout, so tapping a swatch, the hex field or the native picker does not dismiss the submenu that hosts them. The panel is not an affordance of its own; the swatches inside it are.',
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
  [
    'src/client/features/chat/CanvasSelectionBar.tsx',
    {
      sites: 1,
      reason: 'The selection toolbar is a role="toolbar" whose children are the action buttons. Its mouse-down handler only stops the press from collapsing the editor selection before a button can act; it is not an affordance of its own.',
    },
  ],
  [
    'src/client/features/todos/CalendarView.tsx',
    {
      sites: 1,
      reason: 'The day column is a drag-to-schedule surface: a press on it starts a box-select that files a task across the dragged hours, and the slot buttons inside it are the click-to-add affordance for the same gesture. A drag handle is a hit target that legitimately holds buttons.',
    },
  ],
  [
    'src/client/features/memos/components/MemoLightbox.tsx',
    {
      sites: 1,
      reason: 'The image stage is the gesture surface: pointer handlers pan, zoom and swipe the picture, and the download link in its failure state is a control drawn inside that surface. A press on empty stage space is the gesture, not a button; the arrows and zoom controls sit outside the handler.',
    },
  ],])

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

/**
 * The rules below guard convergences that are already done, so a regression fails instead of
 * quietly re-forming. They extend the discipline of this file: read the written source, keep a
 * baseline that carries a reason per entry, and fail in both directions — a new violation and an
 * entry whose violation is gone both fail.
 */

const FEATURES_DIR = path.join('src', 'client', 'features')
const WORKER_DIR = path.join('src', 'worker')

/** Any file under a directory, no extension filter — the z-index and worker rules read CSS and TS. */
function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else out.push(full)
  }
  return out
}

/** Source text of a repo-relative path, or null when it does not exist. */
function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    // Absent by design here: the caller has nothing to report for a file that is not there.
    return null
  }
}

/** Whatever an attribute was written with, as the text the browser will interpolate. */
function attributeText(initializer: ts.JsxAttribute['initializer']): string {
  if (!initializer) return ''
  return initializer.getText()
}

/**
 * A list-filter input the shared box exists to write. A hand-written `<input>` was never flagged by
 * the rule above, because `input` is in `CONTROL_TAGS` and that set only answers "is this a control"
 * — which is why 24 divergent search boxes survived the whole project. Inside a feature, a text
 * filter is `FilterInput` or `useFilterInput`, or it is on the list below with a reason.
 */
const FILTER_LABEL_PROPS = ['placeholder', 'aria-label', 'aria-labelledby', 'title']
const FILTER_BEHAVIOUR_PROPS = ['value', 'onChange', 'onInput', 'onKeyDown', 'role', 'list', 'aria-expanded', 'aria-controls']
const FILTER_TEXT_TYPES = new Set(['', 'text', 'search'])
/** Files that own a raw text input by design, so their internal box is not a divergence. */
const FILTER_CANONICAL_FILES = new Set(['src/client/components/form.tsx', 'src/client/components/ui/index.tsx'])

/** A residual raw filter input, with the reason it is allowed to stay for now. */
const LIST_FILTER_BASELINE = new Map<string, { sites: number; reason: string }>([
  ['src/client/features/email/RecipientField.tsx', { sites: 1, reason: 'The recipient combobox narrows contact suggestions inside a chip field; FilterInput cannot hold chips beside the caret, so this is a distinct control with its own listbox contract.' }],
  ['src/client/features/attachment-hub/attachment-hub-sidebar/folder-row.tsx', { sites: 1, reason: 'The folder rename draft (`sidebar.rename`): it edits one row’s existing name in place, so it is a form field with no result list to filter.' }],
  ['src/client/features/attachment-hub/attachment-inspector.tsx', { sites: 1, reason: 'The add-a-tag field on the inspector: it appends a name to the file’s own tag list rather than narrowing a list on screen.' }],
  ['src/client/features/excalidraw/library/LibraryFolderRow.tsx', { sites: 2, reason: 'Two inline text rows in the library folder row (name editing at 383 and 496). Not verified as list filters; converge once the folder-tree editing work lands.' }],
  ['src/client/features/folders/FolderAppearanceMenus.tsx', { sites: 2, reason: 'A folder-name rename draft and the icon picker search field (`folders.icon_search`). The icon search is a genuine list filter and should move to FilterInput; the rename draft is a form field.' }],
  ['src/client/features/mindmap/MindmapStandaloneEditor.tsx', { sites: 1, reason: 'Inline text field in the mindmap editor surface (397). Not verified as a list filter; baseline so the rule can block new ones.' }],
  ['src/client/features/preview/NoteProperties.tsx', { sites: 2, reason: 'Property key/value entry fields (`properties.new_key` at 464 and its value editor). A form, not a list filter.' }],
  ['src/client/features/preview/property-colors.tsx', { sites: 1, reason: 'The colour property editor writes its own labelled value field (496) with an aria-label and placeholder; a field, not a list filter.' }],
  ['src/client/features/quickadd/launcher.tsx', { sites: 1, reason: 'QuickAdd draft entry (84) — it filters the command list, so it is a real filter that has not been converged onto FilterInput.' }],
  ['src/client/features/quickadd/prompts.tsx', { sites: 4, reason: 'The QuickAdd prompt family (text, number and date prompts) each write a labelled field. Prompts, not list filters.' }],
  ['src/client/features/share/SharePanel.tsx', { sites: 1, reason: 'Read-only share link field that selects on focus (221). Not a filter at all.' }],
  ['src/client/features/settings/FeedSettings.tsx', { sites: 1, reason: 'The read-only subscription address that selects on focus (236); a copy field, not a list filter.' }],
  ['src/client/features/calendar/CalendarDialogs.tsx', { sites: 1, reason: 'The read-only public calendar link that selects on focus (745), the same shape as SharePanel and FeedSettings; a copy field, not a list filter.' }],
  ['src/client/features/share/ConversationSharePanel.tsx', { sites: 1, reason: 'The same read-only share link field as SharePanel (178), for a published conversation. Not a filter at all.' }],
  ['src/client/features/tags/tag-row-parts.tsx', { sites: 1, reason: 'Tag rename row (`tags.rename` at 42) with autoFocus and a default value; an inline editor, not a list filter.' }],
  ['src/client/features/workspace/Workspace.tsx', { sites: 1, reason: 'Inline text field in the workspace surface (557). Not verified as a list filter; baseline so the rule can block new ones.' }],
  ['src/client/features/inkpad/InkNoteEditor.tsx', { sites: 1, reason: 'The note title field in the editor header: it renames the open drawing, not a list filter, and has no result list to narrow.' }],
  ['src/client/features/inknote/InknoteApp.tsx', { sites: 1, reason: 'The open note title field in the editor header (`inknote.rename`): it renames the current note on blur or Enter, not a list filter, the same shape as the inkpad editor title.' }],
  ['src/client/features/todos/OrganizerEditors.tsx', { sites: 1, reason: 'The custom-colour draft (`#rrggbb`, 124) beside the colour wheel: an inline editor for one value, the same shape as the editor colour menu\'s name draft, not a list filter.' }],
])

function isFilterishInput(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  const attributes = attributesOf(node)
  const type = literalValue(attributes.get('type')) ?? ''
  if (!FILTER_TEXT_TYPES.has(type)) return false
  // A named field is a filter only if it is labelled like one; a typeless form row is not.
  if (!FILTER_LABEL_PROPS.some((name) => attributes.has(name))) return false
  return FILTER_BEHAVIOUR_PROPS.some((name) => attributes.has(name))
}

/** Every raw filter input written under a feature, keyed by file. */
function listFilterSites(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const file of walkFiles(FEATURES_DIR)) {
    if (!/\.tsx$/.test(file)) continue
    const name = relative(file)
    if (FILTER_CANONICAL_FILES.has(name)) continue
    const text = readText(file)
    if (text === null) continue
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (node: ts.Node): void => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === 'input') {
        if (isFilterishInput(node)) counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return counts
}

describe('converged list filters keep using FilterInput', () => {
  const SITES = listFilterSites()

  it('fails when a feature hand-writes a filter input instead of FilterInput or useFilterInput', () => {
    const lines: string[] = []
    for (const [file, sites] of SITES) {
      // A feature that reached for the shared hook is converged; a raw box beside it is not a second
      // divergence, it is that hook's own implementation, so it is allowed to write the element.
      const text = readText(file) ?? ''
      if (text.includes('FilterInput') || text.includes('useFilterInput')) continue
      const allowed = LIST_FILTER_BASELINE.get(file)
      if (allowed === undefined) lines.push(`${file}: ${sites} raw filter input(s), no FilterInput/useFilterInput and no baseline entry — use the shared box or add this with a reason`)
      else if (sites > allowed.sites) lines.push(`${file}: ${sites} raw filter input(s), the baseline allows ${allowed.sites}`)
    }
    for (const [file, allowed] of LIST_FILTER_BASELINE) {
      if (!SITES.has(file)) lines.push(`${file}: baseline allows ${allowed.sites} raw filter input(s) but the file writes none — delete the entry`)
    }
    expect(lines, `${lines.length} feature file(s) diverged from FilterInput.`).toEqual([])
  })
})

/**
 * The one indent formula is `treeIndent()` in `src/client/lib/tree/indent.ts`. Nine competing
 * formulas were converged onto it, so this is near-zero: a depth variable multiplied or added into a
 * spacing property is a second source of truth for one visual rule. Adding a fixed gutter to
 * `treeIndent()` is not a competing formula, so a call inside the expression clears the site.
 */
const TREE_DEPTH_NAME_RE = /^(depth|level|tier|childDepth|nodeDepth|branchDepth|parentDepth|indentLevel|indentDepth)$/i
const TREE_SPACING_KEYS = new Set(['paddingLeft', 'marginLeft', 'paddingInlineStart'])
const ARITHMETIC_KINDS = new Set([ts.SyntaxKind.BinaryExpression, ts.SyntaxKind.PrefixUnaryExpression, ts.SyntaxKind.PostfixUnaryExpression])
/** Residual formulas that predate this guard, keyed `file:line` so a new one fails and a fix fails too. */
const INLINE_TREE_INDENT_BASELINE = new Map<string, string>([
  ['src/client/features/preview/Outline.tsx:703', 'Competing formula `OUTLINE_INDENT_BASE + tier * OUTLINE_INDENT_STEP` with its own constants — a real second source of truth that should call treeIndent(tier). Recorded, not audited as correct.'],
])

/** Inline tree indents today: a spacing property whose value does arithmetic on a depth variable. */
function inlineTreeIndents(): string[] {
  const found: string[] = []
  for (const file of walkFiles(CLIENT_DIR)) {
    if (!/\.(ts|tsx)$/.test(file)) continue
    const name = relative(file)
    if (name === 'src/client/lib/tree/indent.ts') continue
    const text = readText(file)
    if (text === null) continue
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const mentionsDepth = (node: ts.Node): boolean => {
      let hit = false
      const probe = (current: ts.Node): void => {
        if (hit) return
        if (ts.isIdentifier(current) && TREE_DEPTH_NAME_RE.test(current.text)) hit = true
        else ts.forEachChild(current, probe)
      }
      probe(node)
      return hit
    }
    const report = (node: ts.Node, key: string, value: ts.Node): void => {
      if (!ARITHMETIC_KINDS.has(value.kind) || !mentionsDepth(value)) return
      // Adding a gutter to the shared formula is still the shared formula; only a competing one fails.
      if (value.getText().includes('treeIndent(')) return
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
      found.push(`${name}:${line} — ${key} computed inline from a depth variable; call treeIndent()`)
    }
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && TREE_SPACING_KEYS.has(node.name.getText()) && node.initializer) {
        const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer
        if (value) report(node, node.name.getText(), value)
      }
      if (ts.isPropertyAssignment(node) && TREE_SPACING_KEYS.has(node.name.getText())) {
        report(node, node.name.getText(), node.initializer)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found
}

describe('converged tree indent keeps using treeIndent()', () => {
  it('fails when a client file computes an indent from a depth variable inline', () => {
    const found = inlineTreeIndents()
    const keys = new Set(found.map((entry) => entry.split(' — ')[0]))
    const lines: string[] = []
    for (const entry of found) {
      const key = entry.split(' — ')[0]
      if (!INLINE_TREE_INDENT_BASELINE.has(key)) lines.push(`${entry} — no baseline entry; use treeIndent() or add this with a reason`)
    }
    for (const key of INLINE_TREE_INDENT_BASELINE.keys()) {
      if (!keys.has(key)) lines.push(`${key}: baseline lists an inline indent that no longer exists — delete the entry`)
    }
    expect(lines, `${lines.length} inline tree indent(s): the nine formulas that were converged must not regrow.`).toEqual([])
  })
})

/**
 * `z-index` has one scale — `Z_INDEX` in `src/client/lib/z-index.ts`, mirrored by `--z-*` tokens.
 * `shared-component-contract.test.ts` pins the scale; this is the complementary check that call
 * sites reach for it instead of a raw number, in every form it gets written: a `z-[N]` utility, a
 * `zIndex` property, and a `z-index` declaration in a stylesheet.
 */
const Z_INDEX_CLASS_RE = /(?<![\w-])z-\[([\d.]+)\]/g
const Z_INDEX_CSS_RE = /z-index\s*:\s*([^;}\r\n]+)/g
/** A CSS value that resolves through the scale rather than naming a level. */
const Z_INDEX_TOKEN_VALUE_RE = /^\s*(?:var\(\s*--z-[a-z0-9-]+\s*\)|Z_INDEX\.[A-Za-z0-9_]+)\s*$/

/** Every raw z-index the client tree writes, as `file:line` with the number and the form. */
function rawZIndexSites(): Array<{ key: string; file: string; value: string; form: string }> {
  const sites: Array<{ key: string; file: string; value: string; form: string }> = []
  const push = (file: string, line: number, value: string, form: string): void => {
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) return
    sites.push({ key: `${file}:${line}`, file, value: trimmed, form })
  }
  for (const pathName of walkFiles(CLIENT_DIR)) {
    const name = relative(pathName)
    const text = readText(pathName)
    if (text === null) continue
    if (name.endsWith('.css')) {
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        for (const match of lines[index].matchAll(Z_INDEX_CSS_RE)) {
          if (!Z_INDEX_TOKEN_VALUE_RE.test(match[1])) push(name, index + 1, match[1], 'css declaration')
        }
      }
      continue
    }
    if (!/\.(ts|tsx)$/.test(name)) continue
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (node: ts.Node): void => {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
      if (ts.isJsxAttribute(node)) {
        const attributeName = node.name.getText()
        const raw = attributeText(node.initializer)
        if (attributeName === 'className' || attributeName === 'class') {
          for (const match of raw.matchAll(Z_INDEX_CLASS_RE)) push(name, line, match[1], 'className z-[N]')
        }
        // `zIndex={240}` arrives here with its braces, which is a number the browser will read but the
        // digit test below would not have seen.
        if (attributeName === 'zIndex') push(name, line, raw.replace(/[{}]/g, ''), 'zIndex prop')
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        // A class list built in a variable or a helper never reaches a `className` attribute node, so
        // reading only attributes left `const base = 'fixed z-[255] …'` invisible to this guard.
        for (const match of node.getText().matchAll(Z_INDEX_CLASS_RE)) push(name, line, match[1], 'string z-[N]')
      }
      if (ts.isPropertyAssignment(node)) {
        const key = node.name.getText()
        if (key === 'zIndex') push(name, line, node.initializer.getText(), 'style zIndex')
      }
      if (ts.isJsxExpression(node) && node.expression && ts.isCallExpression(node.expression)) {
        // Values passed through cn()/styles.* are still read above through the attribute text.
        void node.expression
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return sites
}

/**
 * Component sites that are still raw, each with the token it should use. Keyed `file:line` and
 * checked by value, so moving one does not clear the entry and changing one fails.
 */
const RAW_Z_INDEX_BASELINE = new Map<string, { value: string; reason: string }>([
  ['src/client/features/excalidraw/TextToDiagramModal.tsx:424', { value: '100', reason: 'Inside the Excalidraw host, whose canvas already fixes its own stacking context; the app scale governs the viewport-fixed tiers and reaching for one here would fight the vendor surface.' }],
  ['src/client/features/graph/graph-panel/overlays.tsx:46', { value: '1', reason: 'Local stacking lift inside the graph panel, not a shell layer.' }],
  ['src/client/features/graph/graph-panel/overlays.tsx:169', { value: '3', reason: 'Local stacking lift inside the graph panel, not a shell layer.' }],
  ['src/client/features/graph/graph-panel/settings.tsx:53', { value: '235', reason: 'The panel’s own settings drawer: deliberately above the workspace tier it opens from and below every prompt, which no band in the scale names. A band would be invented for one site; arithmetic on two bands would be a tier nobody can look up.' }],
  ['src/client/features/reading/reader/CommentCard.tsx:62', { value: '7', reason: 'Local stacking lift inside the reader card, not a shell layer.' }],
  ['src/client/features/reading/reader/LookupCard.tsx:52', { value: '8', reason: 'Local stacking lift inside the reader card, not a shell layer.' }],
  ['src/client/features/reading/reader/ReaderPanel.tsx:56', { value: '6', reason: 'Local stacking lift inside the reader panel, not a shell layer.' }],
  ['src/client/features/inkpad/ink-elements.tsx:42', { value: '1', reason: 'Local card-body layer inside the ink canvas; the shell z-index scale does not describe layers between a drawing and its cards.' }],
  ['src/client/features/inkpad/ink-elements.tsx:47', { value: '3', reason: 'Local card-control layer inside the ink canvas; it must sit above the drawing but has no shell tier of its own.' }],
  ['src/client/features/inkpad/ink-hud.tsx:73', { value: '4', reason: 'Local HUD layer inside the ink canvas; it sits above the drawing surface and below app menus.' }],
])

/** Stylesheet declarations are the bulk of the residual, so they are budgeted per file by count. */
const RAW_Z_INDEX_CSS_BASELINE = new Map<string, number>([
  ['src/client/styles/app.css', 1],
  ['src/client/styles/editor.css', 3],
  ['src/client/styles/prose.css', 11],
  ['src/client/styles/reading.css', 5],
  ['src/client/styles/inkpad.css', 1],
])

describe('converged z-index keeps using the token scale', () => {
  const SITES = rawZIndexSites()

  it('fails when a component writes a raw z-index instead of the token scale', () => {
    const componentSites = SITES.filter((site) => !site.file.endsWith('.css'))
    const byKey = new Map(componentSites.map((site) => [site.key, site]))
    const lines: string[] = []
    for (const site of componentSites) {
      const allowed = RAW_Z_INDEX_BASELINE.get(site.key)
      if (allowed === undefined) lines.push(`${site.key}: raw ${site.form} ${site.value} — use Z_INDEX/var(--z-*), or baseline it with a reason`)
      else if (allowed.value !== site.value) lines.push(`${site.key}: baseline records ${allowed.value} but the file now writes ${site.value}`)
    }
    for (const key of RAW_Z_INDEX_BASELINE.keys()) {
      if (!byKey.has(key)) lines.push(`${key}: baseline lists a raw z-index site that no longer exists — delete the entry`)
    }
    expect(lines, `${lines.length} component z-index site(s) are outside the ${RAW_Z_INDEX_BASELINE.size} baselined with a reason.`).toEqual([])
  })

  it('fails when a stylesheet grows a raw z-index beyond its baseline', () => {
    const counts = new Map<string, number>()
    for (const site of SITES) {
      if (!site.file.endsWith('.css')) continue
      counts.set(site.file, (counts.get(site.file) ?? 0) + 1)
    }
    const lines: string[] = []
    for (const [file, sites] of counts) {
      const allowed = RAW_Z_INDEX_CSS_BASELINE.get(file)
      if (allowed === undefined) lines.push(`${file}: ${sites} raw z-index declaration(s), none baselined`)
      else if (sites > allowed) lines.push(`${file}: ${sites} raw z-index declaration(s), the baseline allows ${allowed}`)
    }
    for (const [file, allowed] of RAW_Z_INDEX_CSS_BASELINE) {
      if (!counts.has(file)) lines.push(`${file}: baseline allows ${allowed} raw z-index declaration(s) but the file has none — delete the entry`)
    }
    expect(lines, `${lines.length} stylesheet(s) changed their raw z-index count.`).toEqual([])
  })
})

/**
 * AGENTS.md rule 2: a swallow that ignores a rejection has to say why beside the catch. The backup subtree now
 * routes through `discardBody()`; anything else silent is the failure mode the rule exists for. A
 * block whose only content is a comment is still silent — the reason belongs outside the braces.
 */
const WORKER_CATCH_BASELINE = new Map<string, { sites: number; reason: string }>([
  ['src/worker/assistant/upstream.ts', { sites: 1, reason: 'Line 200 cancels a streaming reader and ignores a failed cancel — nothing to report when the stream is already being discarded.' }],
  ['src/worker/attachments/storage.ts', { sites: 1, reason: 'Line 145 discards a best-effort delete failure in the attachment storage path.' }],
  ['src/worker/avatars/storage.ts', { sites: 1, reason: 'Line 82 discards a best-effort avatar delete failure.' }],
  ['src/worker/backup/archive.ts', { sites: 2, reason: 'Lines 88 and 144 drain pending stream promises so an unobserved rejection does not surface as an unhandled error during archiving.' }],
  ['src/worker/backup/common.ts', { sites: 1, reason: 'Line 50 is the shared body-discard helper itself; the swallow is the helper\'s whole purpose.' }],
  ['src/worker/backup/s3.ts', { sites: 3, reason: 'Lines 82 and 306 cancel a stream or reader that is being discarded, and lines 441-442 swallow a failed XML parse of an error body where the raw text is used instead.' }],
  ['src/worker/backup/snapshot.ts', { sites: 4, reason: 'Lines 476, 480, 484 and 501 cancel or abort snapshot bodies on every discard path; a failed cancel cannot change the outcome.' }],
  ['src/worker/backup/webdav.ts', { sites: 2, reason: 'Lines 133 and 258 cancel an archive stream and a replaced remote body while uploading.' }],
  ['src/worker/lib/update-check.ts', { sites: 2, reason: 'Lines 93 and 99 drain the response body before and after reading it so Workers does not report a dangling stream.' }],
  ['src/worker/mcp/operations.ts', { sites: 1, reason: 'Line 84 persists operation state on a fire-and-forget path; the row is re-derived on read.' }],
  ['src/worker/middleware/auth.ts', { sites: 1, reason: 'Line 104 swallows an optional background write inside the auth middleware.' }],
  ['src/worker/routes/excalidraw-library.ts', { sites: 1, reason: 'Line 278 swallows a fire-and-forget queue write behind a library route response.' }],
  ['src/worker/routes/mcp-settings.ts', { sites: 2, reason: 'Lines 121 and 134 hand `waitUntil` a drain whose failure must not fail the already-sent response.' }],
  ['src/worker/routes/reader-library.ts', { sites: 1, reason: 'Line 600 deletes a replaced cover object and ignores the failure; the new cover is already stored.' }],
  ['src/worker/routes/tools-password.ts', { sites: 1, reason: 'Line 319 deletes a backup object from R2 after its record is already gone from D1; a failed delete leaves one unreachable blob, and the response has no surface left to report it on — the same disposition the reader library\'s replaced cover carries.' }],
  ['src/worker/routes/transfer.ts', { sites: 1, reason: 'Line 580 rolls attachments back after a failed mapping write; the mapping SQL now lives in transfer/store.ts, but this swallow is the route\'s and a failed rollback has nowhere to report.' }],
  ['src/worker/imgbed/dav.ts', { sites: 2, reason: 'Both discard a response body after a WebDAV method whose status has already decided the answer; a failed cancel cannot change it.' }],
  ['src/worker/imgbed/manage.ts', { sites: 1, reason: 'A malformed restored settings group is rejected by parseSettingsGroup and counted as failed; the catch only keeps the other groups restoring.' }],
  ['src/worker/imgbed/serve.ts', { sites: 2, reason: 'Both cancel a body that has already been answered by a 304 or HEAD, where a failed cancel has no surface left to report on.' }],
  ['src/worker/imgbed/storage.ts', { sites: 19, reason: 'Each cancels or aborts an upstream body after its status has decided the outcome (S3/Discord/HF/WebDAV reads and deletes), and one discards a WebDAV MKCOL answer when creating the destination folder before MOVE, where a 405 already means the folder exists; a failed cancel cannot change a response already chosen.' }],
  ['src/worker/imgbed/upload-routes.ts', { sites: 2, reason: 'One discards a redirect body while following the fetch-url guard, and one deletes a failed upload session; both are cleanup after the reported outcome.' }],
  ['src/worker/imgbed/upload-service.ts', { sites: 2, reason: 'Both release a remote object after a D1 write failed, where the original failure is the one returned to the caller.' }],
])

/**
 * One walker for both rules below, so the Worker and the client cannot drift into two different policies.
 * A site is a rejection discarded with nothing between the braces:
 *
 *  - `try { … } catch { }` — a catch clause whose block holds no statement and no character;
 *  - `.catch(() => {})`, `.catch(function () {})` — the same, in promise form;
 *  - `.catch(() => undefined)` when `voidHandler` is on: the same no-op written with an expression body,
 *    which the block test above cannot see. `.catch(() => null)` is deliberately not a site — there the
 *    handler hands the caller a value it then branches on (the mindmap export's `if (!blob)` and the PDF
 *    engine's optional metadata both do this), so the rejection was answered, not discarded.
 *
 * What makes a block non-blank is anything written inside the braces, so a comment inside it is accepted
 * as the reason. The client does not use that door — the reason goes above the line, in English, and the
 * site is still counted and still baselined, exactly as the Worker slice did it. `voidHandler` is off for
 * the Worker because its 15-file, 24-site baseline was settled against the block form only; three Worker
 * sites are written this way (assistant/chat-files.ts:132, assistant/mcp-client.ts:203 and
 * routes/assistant.ts:975) and belong to that slice to disposition, not to this one. The client turns it
 * on because 54 of its swallows were measured in that spelling at the branch point.
 */
function silentCatches(dir: string, voidHandler: boolean): string[] {
  const found: string[] = []
  for (const pathName of walkFiles(dir)) {
    if (!pathName.endsWith('.ts') && !pathName.endsWith('.tsx')) continue
    const name = relative(pathName)
    const text = readText(pathName)
    if (text === null) continue
    const source = ts.createSourceFile(
      name,
      text,
      ts.ScriptTarget.Latest,
      true,
      pathName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const innerIsBlank = (block: ts.Node): boolean => text.slice(block.getStart(source) + 1, block.getEnd() - 1).trim().length === 0
    const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1
    const visit = (node: ts.Node): void => {
      if (ts.isCatchClause(node) && node.block.statements.length === 0 && innerIsBlank(node.block)) {
        found.push(`${name}:${lineOf(node)} — empty catch clause with no comment beside it`)
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch') {
        const handler = node.arguments[0]
        if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
          if (handler.body && ts.isBlock(handler.body)) {
            if (handler.body.statements.length === 0 && innerIsBlank(handler.body)) {
              found.push(`${name}:${lineOf(node)} — .catch(() => {}) with no comment beside it`)
            }
          } else if (voidHandler && handler.body) {
            if (handler.body.getText(source).trim() === 'undefined') {
              found.push(`${name}:${lineOf(node)} — .catch(() => undefined) with no comment beside it`)
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found
}

/** Worker swallows with nothing between the braces: an empty `catch {}` or `.catch(() => {})`. */
function silentWorkerCatches(): string[] {
  return silentCatches(WORKER_DIR, false)
}

/** The same read over the client tree, plus the `.catch(() => undefined)` spelling. */
function silentClientCatches(): string[] {
  return silentCatches(CLIENT_DIR, true)
}

describe('worker swallows state their reason beside the catch', () => {
  it('fails when a worker catch ignores a rejection without a comment', () => {
    const found = silentWorkerCatches()
    const counts = new Map<string, number>()
    for (const site of found) counts.set(site.split(':')[0], (counts.get(site.split(':')[0]) ?? 0) + 1)
    const lines: string[] = []
    for (const [file, sites] of counts) {
      const allowed = WORKER_CATCH_BASELINE.get(file)
      if (allowed === undefined) lines.push(`${file}: ${sites} silent catch(es) — state the reason beside the catch, or baseline it with a reason`)
      else if (sites > allowed.sites) lines.push(`${file}: ${sites} silent catch(es), the baseline allows ${allowed.sites}`)
    }
    for (const [file, allowed] of WORKER_CATCH_BASELINE) {
      if (!counts.has(file)) lines.push(`${file}: baseline allows ${allowed.sites} silent catch(es) but the file has none — delete the entry`)
    }
    expect(lines, `${lines.length} worker file(s) changed their silent-catch count.`).toEqual([])
  })
})

/**
 * The same rule over `src/client`, baselined per file with a reason, both directions enforced exactly as
 * above. rule 2 allows a swallow only when it is genuinely best-effort and says why; a user-facing action
 * whose rejection nobody ever hears is not that, and the chat copy failure and the mindmap fullscreen
 * rejection were both turned into visible feedback rather than baselined.
 */
const CLIENT_CATCH_BASELINE = new Map<string, { sites: number; reason: string }>([
  ['src/client/editor/paste.ts', { sites: 1, reason: 'settleUploads: a refused upload falls into the in-document upload_failed marker a few lines below, which is the report the reader sees; the catch keeps one bad file from cancelling every sibling of the same paste.' }],
  ['src/client/features/chat/assistant-store.ts', { sites: 2, reason: 'dropAttachment releases an object the draft no longer references, and stop sends a cancel after the request was already aborted and the turn marked done locally; both are notices about work the reader can see finished.' }],
  ['src/client/features/chat/multi-model-store.ts', { sites: 1, reason: 'closePane deletes a pane\'s ephemeral conversation after the pane has already left the screen; the hourly sweep removes a thread a failed delete leaves behind, so there is nothing to report to a reader who asked to close it.' }],
  ['src/client/features/chat/pdf-text.ts', { sites: 1, reason: 'The finally that destroys the opened PDF: the words have already been read, and a document that refuses to be closed has nowhere to be reported from — the upload keeps the file either way.' }],
  ['src/client/features/chat/voice-realtime.ts', { sites: 1, reason: 'The audio element is primed inside the Start press with no source yet; a refused play is not the failure that matters, because the remote track plays again when it arrives and that second refusal is reported.' }],
  ['src/client/features/excalidraw/excalidraw-canvas-actions.ts', { sites: 2, reason: 'fitView tries the engine scrollToContent, then zoomToFit, then its own arithmetic: the first two catches only fall through to the next mechanism in the same ladder, and the third is the un-caught answer.' }],
  ['src/client/features/excalidraw/excalidraw-settings-store.ts', { sites: 1, reason: 'persistSettings writes a localStorage mirror of settings already applied to the in-memory store; a refused write (quota, private mode) costs the next reload, not this change.' }],
  ['src/client/features/excalidraw/ExcalidrawStandaloneEditor.tsx', { sites: 2, reason: 'One is the code-to-canvas round trip that still switches the view to the canvas it just failed to parse, and one is a localStorage chat-log write for the text-to-diagram panel inside a third-party callback.' }],
  ['src/client/features/excalidraw/library/ExcalidrawLibraryTree.tsx', { sites: 2, reason: 'A vendor-chunk warm-up whose null state is the one the panel is already in, and the official-catalog prefetch — the modal that draws the catalog asks again on open and owns that error state on screen.' }],
  ['src/client/features/excalidraw/library/ExcalidrawOfficialLibraryModal.tsx', { sites: 1, reason: 'Unwrapping an addLibrary= query parameter: on a malformed value the download keeps the raw URL it was given, and the fetch that follows reports the failure.' }],
  ['src/client/features/excalidraw/library/library-store.ts', { sites: 3, reason: 'Two are the localStorage mirror of a manifest held in memory (read side falls back to the server copy), and one is the boot-time name heal whose next real edit carries the rename up regardless.' }],
  ['src/client/features/excalidraw/library/LibraryFolderRow.tsx', { sites: 1, reason: 'exitFullscreen refuses only when the document is not fullscreen, which the guard on the same line just established it is; unreachable, and the delete continues to its confirmation either way.' }],
  ['src/client/features/links/LinkEditorPopover.tsx', { sites: 1, reason: 'A debounced heading check on a note this tab does not hold: a rejected read leaves targetState at idle, which the popover renders as not checked rather than as a verified link, and the link the reader saves does not depend on the probe.' }],
  ['src/client/features/mindmap/mindmap-settings-store.ts', { sites: 1, reason: 'persistSettings writes a localStorage mirror of settings already applied in memory; a refused write costs the next reload only.' }],
  ['src/client/features/mindmap/MindmapStandaloneEditor.tsx', { sites: 1, reason: 'exitFullscreen on the branch that has just read document.fullscreenElement — unreachable rejection, and the request branch beside it is the one that can genuinely be refused and toasts.' }],
  ['src/client/features/reading/engine/chapter.ts', { sites: 1, reason: 'A srcset assembled from several resolutions of one image: on failure the element keeps the plain src it was given, so the picture draws and only the resolution switch is lost.' }],
  ['src/client/features/reading/engine/zip.ts', { sites: 3, reason: 'Two drain a ZipWriter whose error the inflate call already reported, and one cancels a reader being discarded on the over-limit path that throws immediately after.' }],
  ['src/client/features/reading/reader/FixedStage.tsx', { sites: 1, reason: 'Turning a page cancels the render in flight and PDF.js rejects that promise; the observation exists only so the rejection is not reported as unhandled while the real outcome is read from cancelled below.' }],
  ['src/client/features/reading/reader/ReaderView.tsx', { sites: 1, reason: 'exitFullscreen under the fullscreenElement guard — unreachable, and the request branch beside it reports its own refusal out loud.' }],
  ['src/client/features/reading/store/library.ts', { sites: 5, reason: 'Four are evictions and an offline-copy write under keys the shelf no longer reads, and one is deleteBookOnServer whose row the next shelf push drops anyway because replace() re-inserts only the payload it is given.' }],
  ['src/client/features/reading/store/reader-settings.ts', { sites: 1, reason: 'removeFont evicts bytes for a font already taken out of state and persisted below; a failure leaves bytes under a key the font list no longer names.' }],
  ['src/client/features/settings/sections.ts', { sites: 2, reason: 'warmSettingsSection prefetches a panel chunk and a resource cache entry; each panel calls the same loader itself and owns the error state beside it (BackupSettings sets loadError from its own catch).' }],
  ['src/client/features/settings/SettingsPanel.tsx', { sites: 1, reason: 'Remembering which section was last open in localStorage; the section has already been switched in state, and the read beside it falls back to appearance.' }],
  ['src/client/features/settings/SharedNotes.tsx', { sites: 1, reason: 'visitNote pulls to find a source note, and the same check two lines later is that pull error path — it says source_note_unavailable as a toast; swallowing only avoids reporting the missing note twice.' }],
  ['src/client/features/settings/TotpSettings.tsx', { sites: 1, reason: 'cancelSetup deletes a pending secret the reader walked away from; the row is bound to this session and expires before the confirm route could read it, and the form is already reset.' }],
  ['src/client/features/inknote/library/LibraryPanel.tsx', { sites: 1, reason: 'The first-page cover render behind each library row: a note whose page cannot be read or rasterised keeps the title initial the row already draws, so the fallback is visible and the list is not blocked by one cover.' }],
  ['src/client/features/inknote/store.ts', { sites: 1, reason: 'refreshLibrary after a page save that already answered successfully: the save state is `saved` on screen and the library panel re-reads on its own next open, so a failed side refresh has no reader waiting on it.' }],
  ['src/client/features/share/SharePage.tsx', { sites: 1, reason: 'Rewriting one asset URL in exported share markup: a href that does not parse or does not match the file route is left as it is and skipped, exactly like the origin check above it.' }],
  ['src/client/features/tags/tagMutations.ts', { sites: 3, reason: 'Two are the re-read that follows an optimistic rollback whose own failure the caller is told with the server reason, and one is a write queue tail kept un-rejecting so a failed link cannot become an unhandled rejection.' }],
  ['src/client/features/templates/gallery-actions.ts', { sites: 1, reason: 'communityTemplates.use bumps an author usage counter; the import itself was created and reported on the line above, and nothing on screen reads the count this answers with.' }],
  ['src/client/lib/ai/stream-client.ts', { sites: 3, reason: 'Two read an error response body for a nicer message and fall back to the HTTP status text they return to the caller, and one skips one malformed SSE frame of a stream that keeps going.' }],
  ['src/client/lib/calendar-display-prefs.ts', { sites: 1, reason: 'setCalendarDisplayPrefs has already replaced the in-memory value and notified every listener; the localStorage write only carries it to the next load.' }],
  ['src/client/lib/calendar-prefs.ts', { sites: 1, reason: 'Same shape as the display prefs: state applied and listeners notified first, the storage write is the persistence of a change already in effect.' }],
  ['src/client/lib/db.ts', { sites: 13, reason: 'Every IndexedDB cache write and eviction in the layer (session, shell, note bodies, search bodies, RSS articles, omnisearch cache), plus the outbox replay lease heartbeat and release whose lease expires on its own after 90 s, and a BroadcastChannel post to tabs that may already be gone.' }],
  ['src/client/lib/emoji-prefs.ts', { sites: 1, reason: 'writeStorage persists preferences already applied in memory; no storage means the next load re-reads defaults.' }],
  ['src/client/lib/export-note.ts', { sites: 1, reason: 'Inlining one image into an exported note: a fetch or conversion that fails leaves that img src pointing at the original URL, which is what the same loop does for a non-OK response above.' }],
  ['src/client/lib/folder-prefs.ts', { sites: 1, reason: 'writeStorage persists preferences already applied in memory.' }],
  ['src/client/lib/format-colors.ts', { sites: 1, reason: 'pushRecentColor has already rebuilt the recent list in memory and notified listeners; only the cross-session memory of it is lost.' }],
  ['src/client/lib/i18n.ts', { sites: 1, reason: 'detectInitialLocale reads a saved choice; on a storage it cannot read it falls through to the navigator.language answer two lines below, which is the intended default.' }],
  ['src/client/lib/image.ts', { sites: 1, reason: 'Closing a bitmap the caller already replaced with an optimized File; the finally block runs on the success path too, and a bitmap that refuses to close has nowhere to be reported from.' }],
  ['src/client/lib/linter/drive.ts', { sites: 1, reason: 'lintMany refreshes the library after its own toast has already counted what changed and what failed; the bodies this run wrote are in the client own copies.' }],
  ['src/client/lib/markdown/enhance.ts', { sites: 1, reason: 'getPele prefetches the renderer chunk; the diagram that needed it is still drawn by the pass that awaits the same loader and owns its own error state.' }],
  ['src/client/lib/markdown/excalidraw/registry.tsx', { sites: 1, reason: 'Unmounting a React root on a deferred destroy, after the instance was already removed from the registry; the drawing surface is gone from the document either way.' }],
  ['src/client/lib/markdown/kanban/ui/kanban-file-preview-modal.tsx', { sites: 1, reason: 'Cancelling a reader that is being discarded on the over-limit path; the TextPreviewTooLargeError thrown on the next line is what the reader is told.' }],
  ['src/client/lib/sync.ts', { sites: 10, reason: 'Three are a passive cross-tab notice to re-read the session, settings or site — no reader action waits on them and the next auth check or reload re-reads the same fields; three are the engine own pull, replay and bootstrap, where lastPullAt is not advanced on failure so the next scheduled tick retries, the outbox rows a replay did not drain are still queued, and the engine starts regardless in the then below the bootstrap catch. The four task-stream sites are the same best-effort shape: the leadership takeover replay, the todo cursor read and write, and the online replay all leave the row queued or the same delta to be read again, and the applied delta is idempotent.' }],
  ['src/client/features/todos/store.ts', { sites: 5, reason: 'Five IndexedDB bookkeeping writes on the replay path: advancing revisions, marking a poisoned row, retargeting a local id after a create, marking an invalid snooze, and recording a failure after its toast. Each is best-effort — the row stays queued and the same pass retries — and none is a reader action that can be reported twice.' }],
  ['src/client/store/note-templates.ts', { sites: 1, reason: 'Mirroring a template library that was just written to the server, after the fetch that answered it; a failed local copy is re-written by the next mutation and re-read on the next boot.' }],
  ['src/client/store/notes.ts', { sites: 19, reason: 'The outbox and cache bookkeeping around a write that already succeeded or already failed loudly: cross-tab refresh pings, post-mutation re-pulls, markOutboxFailure and advanceOutboxDependents writes whose loss only means a retry, plus a folder reconcile whose next pull rewrites the list.' }],
  ['src/client/store/pinned-windows.ts', { sites: 1, reason: 'Persisting pinned windows that are live in the store; lastPersisted is only advanced on success, so a refused write is retried by the next change.' }],
  ['src/client/store/pwa.ts', { sites: 2, reason: 'A background update check fired on visibilitychange, and the guard around registering the service worker at all: an app with no registered worker still runs, it just is not installable or offline-ready.' }],
  ['src/client/store/quickadd.ts', { sites: 1, reason: 'Mirroring QuickAdd settings that were just pushed and answered by the server; the local row is rewritten by the next mutation and re-read on boot.' }],
  ['src/client/store/session.ts', { sites: 3, reason: 'Two await an in-flight session cache write purely so it settles before localDb.clear() wipes it on sign-out, and one keeps the queue chain un-rejecting while the caller still awaits the task itself.' }],
  ['src/client/store/ui.ts', { sites: 2, reason: 'A localStorage write of UI state already applied in the store, and a ViewTransition clip-path reveal that the browser skips when the transition is skipped — the theme change it wraps is applied inside the callback.' }],
  ['src/client/store/update.ts', { sites: 1, reason: 'writeIgnoredVersion records a dismissal the reader already got; if storage refuses, the same update offer returns on the next check, which is the safe direction.' }],
  ['src/client/features/tools/qrcode/api.ts', { sites: 1, reason: 'Reading an error response body for a nicer sentence; a body that is not JSON falls through to the generic message thrown on the next line, which is the report the caller gets.' }],
  ['src/client/features/tools/qrcode/content/QrContentEditor.tsx', { sites: 1, reason: 'Restoring a saved draft is best-effort: an unreadable draft leaves the editor empty instead of stopping the reader from typing a new one.' }],
  ['src/client/features/tools/qrcode/history/QrHistoryView.tsx', { sites: 1, reason: 'A record whose stored options do not parse is restored without them: the toast on the next line still tells the reader the record was opened, and the defaults of the generator are what it falls back to.' }],
  ['src/client/features/tools/qrcode/settings/QrSettingsView.tsx', { sites: 1, reason: 'The first read of saved preferences falls back to the defaults the component already holds; every save reports its own failure through the toast in handleSave.' }],
  ['src/client/features/imgbed/api.ts', { sites: 1, reason: 'Deleting an upload session after the part that failed is already reported to the caller; a refused cleanup leaves only an expired row for the cron sweep.' }],
  ['src/client/features/imgbed/upload/UploadPage.tsx', { sites: 1, reason: 'Reading saved upload history for the history panel; an unreadable history is shown as empty and never blocks an upload.' }],
])

/**
 * A date is picked with `DatePicker`, never with the browser's own field.
 *
 * `<input type="date">` is a native control in the sense AGENTS.md rule 10 means: the calendar it opens
 * is the operating system's, so it cannot be themed, cannot be pointed at a lunar calendar, cannot carry
 * the app's own wording, and on the five subscription fields that used it it drew a 32px box between
 * 34px inputs. `DatePicker` already exists (`src/client/components/date-picker.tsx`), is what the
 * kanban, the tasks plugin, the automations and the model editor use, and is keyboard reachable through
 * real `<button>` cells.
 *
 * The read takes the whole written `type` attribute, so a field that switches between a native date and
 * free text is caught the same way a plain one is — the switch is the interesting half of the shape. And
 * it reads both spellings of the element: the raw `<input>`, and the `Input` primitive that forwards
 * `type` straight through to it, which is how all five subscription fields were actually written.
 * What it cannot see is a type assembled from a variable, which is the same limit every other rule here
 * accepts, and which the browser gates do not share.
 */
const NATIVE_DATE_TYPES = ['date', 'datetime-local', 'time', 'month', 'week'] as const
/** The elements that hand a `type` through to a real input. */
const INPUT_ELEMENTS = new Set(['input', 'Input'])

/** Sites that keep a native date field, each with the reason it was not converged. */
const NATIVE_DATE_BASELINE = new Map<string, { sites: number; reason: string }>([
  [
    'src/client/features/quickadd/prompts.tsx',
    {
      sites: 1,
      reason: 'The date prompt answers a free-text draft as well as a picked day: while the reader is typing it switches the element to `text`, and a `DatePicker` has no way to hold a half-typed value. Converging it means teaching the shared picker to carry a draft string, which is a bigger change than this prompt is worth.',
    },
  ],
  [
    'src/client/features/settings/TodoSettings.tsx',
    {
      sites: 1,
      reason: 'The daily digest schedule (234) edits a time of day with no date attached. The shared `TimeField` carries neither the disabled state the row needs while the schedule loads and saves nor the described-by that points at its hint, so converging it means widening the shared control first.',
    },
  ],
])

/** Every native date input the client tree writes, keyed by file. */
function nativeDateSites(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const file of walkFiles(CLIENT_DIR)) {
    if (!/\.tsx$/.test(file)) continue
    const name = relative(file)
    if (name === 'src/client/components/date-picker.tsx') continue
    const text = readText(file)
    if (text === null) continue
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (node: ts.Node): void => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && INPUT_ELEMENTS.has(node.tagName.getText())) {
        const written = attributeText(attributesOf(node).get('type'))
        if (NATIVE_DATE_TYPES.some((type) => written.includes(`'${type}'`) || written.includes(`"${type}"`))) {
          counts.set(name, (counts.get(name) ?? 0) + 1)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return counts
}

describe('date fields keep using the shared DatePicker', () => {
  const SITES = nativeDateSites()

  it('fails when a client file writes a native date input instead of DatePicker', () => {
    const lines: string[] = []
    for (const [file, sites] of SITES) {
      const allowed = NATIVE_DATE_BASELINE.get(file)
      if (allowed === undefined) lines.push(`${file}: ${sites} native date input(s) — use DatePicker or baseline this with a reason`)
      else if (sites > allowed.sites) lines.push(`${file}: ${sites} native date input(s), the baseline allows ${allowed.sites}`)
    }
    for (const [file, allowed] of NATIVE_DATE_BASELINE) {
      if (!SITES.has(file)) lines.push(`${file}: baseline allows ${allowed.sites} native date input(s) but the file writes none — delete the entry`)
    }
    expect(lines, `${lines.length} file(s) changed their native date-field count.`).toEqual([])
  })

  it('keeps the native date exceptions honest', () => {
    for (const [file, { reason }] of NATIVE_DATE_BASELINE) {
      expect(reason.length, `${file} has no reason written`).toBeGreaterThan(40)
      expect(SITES.has(file), `${file} is listed but writes no native date input`).toBe(true)
    }
  })
})

describe('client swallows state their reason beside the catch', () => {
  it('fails when a client catch ignores a rejection without a comment', () => {
    const found = silentClientCatches()
    const counts = new Map<string, number>()
    for (const site of found) counts.set(site.split(':')[0], (counts.get(site.split(':')[0]) ?? 0) + 1)
    const lines: string[] = []
    for (const [file, sites] of counts) {
      const allowed = CLIENT_CATCH_BASELINE.get(file)
      if (allowed === undefined) lines.push(`${file}: ${sites} silent catch(es) — state the reason beside the catch, or baseline it with a reason`)
      else if (sites > allowed.sites) lines.push(`${file}: ${sites} silent catch(es), the baseline allows ${allowed.sites}`)
    }
    for (const [file, allowed] of CLIENT_CATCH_BASELINE) {
      if (!counts.has(file)) lines.push(`${file}: baseline allows ${allowed.sites} silent catch(es) but the file has none — delete the entry`)
    }
    expect(lines, `${lines.length} client file(s) changed their silent-catch count.`).toEqual([])
  })
})

