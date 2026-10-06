import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const UPDATE = process.argv.includes('--update')
const UPDATE_ARMED = process.env.INKSTONE_COMMENTS_UPDATE === '1'
const RUNNER_DIRECTIVE = /^\/\/ @vitest-environment [\w-]+$/
const DECL_BLOCK = '\nconst allowed = new Map([\n'
const MAP_TAIL = '\n])\n'

const allowed = new Map([
  ["scripts/check-comments.mjs", [
    "// The rebuild rewrites this gate’s own allowlist, so it has to be armed explicitly and",
    "// cannot be reached by a plain flag; the summary makes the diff reviewable afterwards.",
  ]],
  ["scripts/check-i18n.mjs", [
    "// The OAuth consent page is a self-contained HTML document with its own",
    "// language switch (cookie-based); it does not use the React i18n layer.",
    "// The scatter table's own column vocabulary, matched against a note's cells and never rendered.",
    "// See inputVocabularyConstants for the AST half of the same allowance.",
    "// The demo data that exercises that vocabulary: the same column words plus two group labels, each",
    "// written once so the first-occurrence replacement below covers the whole file.",
    "// Slice-chart fixtures: the value column word appears in two tables, and the gate's allowance",
    "// replaces one occurrence per listed fragment, so it is named twice rather than widened.",
    "/**\n * Named constants that hold the vocabulary a note is written *with* rather than the copy a page renders.\n * A chart table's scatter headers name the columns the author chose, and they must mean the same chart\n * whatever language the reader's interface is in, so they cannot come from the locale catalog. Only these\n * constants' own initializers are exempt — a Han literal anywhere else still fails the gate.\n */",
  ]],
  ["src/client/components/activity-calendar.test.ts", [
    "// The same month total spread over thirty days keeps every one of them on the lightest level.",
    "// jsdom has no layout engine, so these guards assert the anti-wrap CSS contract",
    "// (whitespace-nowrap + truncate) instead of pixel measurement.",
    "// One seven-column row of clickable weekday labels above the heat cells.",
    "// One note is the whole year's busiest day, so it lands on the darkest level AA allows, and it",
    "// mixes into the same paper the quiet tiles show, so the ramp is one object at four saturations.",
    "// Neighbouring months' days draw nothing at all, so the paper run is what carries the month's shape.",
    "// 2026-09 has the first Monday on the 7th: column 0 (Mon) filters 09-07..09-13.",
  ]],
  ["src/client/components/activity-calendar/heat-cell.ts", [
    "/**\n * One day tile of a heat surface. `null` is not a day of this month at all, so it draws nothing.\n *\n * The whole ramp sits on paper rather than on the surface behind it: level 0 is the bare tile and\n * levels 1-4 mix the accent into that same white, so a quiet day and a busy day are the same object\n * at different saturation. Mixing over `transparent` made the quiet tiles read as shaded days,\n * because their fill was only a few points off the sunken sidebar behind them.\n */",
  ]],
  ["src/client/components/activity-calendar/index.tsx", [
    "// The calendar's inputs (counts, notesByDay, diary lookup) now keep their",
    "// identity whenever a notes-map commit touches none of the read fields, so a",
    "// shallow memo lets the whole heatmap subtree skip rendering on such commits",
    "// (typing pauses still legitimately rebuild today's slice and re-render).",
    "/** Reusable calendar + activity heatmap: navigable month grid, yearly month columns, and a GitHub-style weekly strip, with optional per-day note lists. */",
  ]],
  ["src/client/components/activity-calendar/props.ts", [
    "/** Increments each time an external jump (e.g. a settings-preview click) targets the month view, triggering a fade-in + accent ring flash. */",
  ]],
  ["src/client/components/activity-calendar/range.ts", [
    "/** Convert an inclusive month range (0-11 indices within a year) to inclusive day keys. */",
  ]],
  ["src/client/components/activity-calendar/strip.ts", [
    "// The darkest level is capped by contrast rather than by taste: a day number is primary text on",
    "// this tint, and the cap has to hold for every accent the appearance setting offers, in both",
    "// themes — at 70% the darkest cells read 3.58:1 under indigo (dark) and 3.90:1 under graphite",
    "// (light), where AA needs 4.5. 50% is the highest level all fourteen measure above it",
    "// (scripts/check-contrast.mjs re-measures the cells for each accent and theme).",
    "/** Per-month note totals and the busiest month, which is the scale the yearly grid divides by. */",
    "/**\n * A day is scaled by the busiest month's total rather than by the busiest day, so a month of steady\n * daily writing stays on the lightest level while one day holding a whole month's output goes dark.\n */",
  ]],
  ["src/client/components/activity-calendar/types.ts", [
    "// Shared hook state shapes for the activity calendar. Kept in their own module",
    "// so use-calendar-handlers.ts can consume them without importing the main hook",
    "// module (which imports the handlers back — a module cycle).",
  ]],
  ["src/client/components/activity-calendar/use-activity-calendar.ts", [
    "// Marks an external month jump (settings preview click) or an internal jump (week click, gap-cell follow, endpoint locate) with the same fade-in + receding accent ring.",
  ]],
  ["src/client/components/overlay.tsx", [
    "// With no host mounted there is no dialog to show, so the only answer we may give is the",
    "// cancelling one. Falling back to `window.confirm` would reintroduce a native prompt.",
  ]],
  ["src/client/components/primitives.tsx", [
    "// dicebear ships full micah style data; keep it out of the boot chunk.",
  ]],
  ["src/client/editor/CodeEditor.tsx", [
    "// Preserve undo history across mode changes once editing has started.",
  ]],
  ["src/client/editor/codeLanguages.ts", [
    "// Highlighting removed: no code languages are loaded.",
    "// Kept as empty array so the editor behaves as plain Markdown without syntax colors.",
  ]],
  ["src/client/editor/commands.test.ts", [
    "// jsdom has no Range.getClientRects, which CodeMirror's measurement needs once a view is",
    "// attached and focused; the shim keeps the completion path exercisable instead of untestable.",
  ]],
  ["src/client/editor/commands.ts", [
    "// openFenceBeforeLine walks every earlier line, so it only runs for lines that are",
    "// themselves fence markers.",
    "// A tab item lives inside an open set by definition, so only the set-level openers",
    "// have to check whether an earlier container is still waiting for its closer.",
    "// autocompletion only activates for a transaction tagged `input.type` (see getUpdateType",
    "// in @codemirror/autocomplete), so the empty-pair insert that wants the note list has to",
    "// carry that tag: `input.format` inserts the text and leaves no popup behind.",
  ]],
  ["src/client/editor/completion.ts", [
    "/**\n * closeBrackets() already paired the `[[` the user typed, so the caret usually sits in front of\n * a `]]` that is already there; appending another one produced `[[Title]]]]`.\n */",
  ]],
  ["src/client/editor/live-preview.ts", [
    "// Preserve the source line under the pointer, including rows inside tables/lists.",
    "/** Decorations change presentation only; all editing, undo, search and saving use Markdown. */",
    "// Keep typing synchronous and cheap. Reparse after a short idle window; never",
    "// display stale HTML for a block whose source was touched in the meantime.",
    "/**\n * Reparsing the whole document costs tens to hundreds of ms on big notes, so the idle\n * window widens with the document instead of reparsing on every keystroke pause.\n */",
    "/** Text.toString() rebuilds the whole document, so reuse it while the doc is unchanged. */",
  ]],
  ["src/client/features/auth/LoginPage.tsx", [
    "// Only the OAuth consent page may be resumed after sign-in, so a crafted ?next",
    "// can never send the browser somewhere else with an authenticated session.",
  ]],
  ["src/client/features/command/CommandPalette.tsx", [
    "// The pointer already sits on its row; scrolling would move other rows under it and",
    "// re-trigger the highlight, so only keyboard movement scrolls.",
  ]],
  ["src/client/features/command/palette-perf.test.ts", [
    "/** 30s into a minute, so a test that nudges the clock never crosses a tick boundary. */",
    "/** React synthesises onMouseEnter from native mouseover, so a raw mouseenter never reaches it. */",
  ]],
  ["src/client/features/graph/graph-panel/scene.ts", [
    "// Squared compare instead of Math.hypot: pointermove fires up to 240 times a second and",
    "// hypot does overflow scaling work this path never needs.",
  ]],
  ["src/client/features/list/NoteList.tsx", [
    "/** The concatenated key is the only copied string; bound it by characters, not entries. */",
    "// Only rendered rows ask for their position, so the map covers the window instead of",
    "// allocating one entry per note on every filter change.",
    "// Body text only ever reaches the search key through this record, so the memo has to",
    "// depend on it; reading it imperatively left freshly-opened notes unsearchable.",
    "// Crossing the tablet/desktop width is a layout change, not a new context: wiping the",
    "// query there loses a search the user is still typing.",
    "// Browsing the search panel shows the same collection as the sidebar, but typing into it",
    "// means \"find the note\", and the server layer already answers that including archived",
    "// notes; scoping the local layer to the view made archived notes findable online and",
    "// invisible offline.",
  ]],
  ["src/client/features/list/gap-indicator.ts", [
    "/** Latest non-deleted note's edit date key (null when there are no notes). */",
    "// The heatmap's gap banner and the list header both ask for the newest edit after every",
    "// derived commit; memoizing by map identity makes one commit cost one O(n) scan, and the",
    "// entry dies with the replaced map so nothing is retained strongly.",
    "/** Newest edit key with whole days it sits outside the selected window (null when it is inside or the inputs are empty). */",
  ]],
  ["src/client/features/preview/Lightbox.tsx", [
    "/* The lightbox reads the img IDL property, an absolute URL that never\n              passed the renderer’s protocol filter. */",
  ]],
  ["src/client/features/preview/NoteProperties.tsx", [
    "// Read the live buffer rather than taking the rendered text as a prop: a debounced or",
    "// cached copy here would silently overwrite whatever was typed in the last few frames.",
  ]],
  ["src/client/features/preview/Preview.tsx", [
    "// A chart is an instance plus a ResizeObserver, and neither is reachable from the note once this",
    "// host is thrown away, so nothing else would ever run their teardown.",
    "// Charts draw on the live host rather than in the staged copy: a canvas is pixels and an instance, and",
    "// neither survives the serialization and cloning the swap does.",
    "// The head is built here rather than on the live host so it is part of the markup the preview",
    "// diffs against; a toolbar added after the swap would be wiped by the next keystroke.",
    "// A write resolves the block's recorded line against the text the preview was built from, so it",
    "// only runs while that text is still what the note holds.",
    "// A drawn chart is a canvas plus a live instance, and neither is in innerHTML, so re-syncing this",
    "// subtree from the staging copy would put the placeholder text back over a chart that did not change.",
    "// The stated format is compared beside the body: which reader draws a chart is not written anywhere",
    "// in its body text, so a note that only moved `style=` has to look changed here.",
    "// The body did not change, so the picture still stands. Except when the staged copy is showing",
    "// its source instead: that is the renderer switch having been turned off, and the note text is",
    "// identical either way, so the class is the only thing that says the block must stop being a",
    "// canvas. Preserving it there left an off switch with a chart still drawn on screen.",
    "// The line is still re-stamped: a format toggle changes how many lines a block above occupies,",
    "// which moves this one, and the line is what the toolbar resolves its write against.",
  ]],
  ["src/client/features/preview/block-actions.ts", [
    "/**\n * The preview's entry point for the block settings toolbars and the runnable JavaScript block: one\n * enhancer and one click route, so a block family costs no new branch in the preview's handlers.\n *\n * The runnable block's controls come from `enhanceJsExampleControlsInRoot`, which only this surface\n * calls — a share page draws the same block with no run button.\n */",
  ]],
  ["src/client/features/preview/block-overlay.ts", [
    "/**\n * The shared prologue of a toolbar action: the note to edit and the committed text to edit it\n * against, or null when there is nothing to write. Writing while the preview still shows an older\n * document would move the fence the block was drawn from, and the patch would land somewhere else.\n */",
    "/**\n   * Builds a panel the first time it is asked for. A note can hold hundreds of code blocks and the\n   * preview is rebuilt on every typing pause, so the panel a reader never opens must cost nothing.\n   */",
  ]],
  ["src/client/features/preview/card-content-chart.test.ts", [
    "/**\n * A note card renders a few lines of another note and deliberately draws neither diagrams nor charts,\n * but it only runs the enhancer at all when it spots something that needs it. A chart fence becomes a\n * `div.chart-block`, which is none of `pre code` / `[data-math]` / `[data-mermaid]`, so a note whose\n * only rich content is a chart skipped the pass and the card showed \"Rendering chart…\" forever — a\n * loading state nothing would ever resolve.\n */",
  ]],
  ["src/client/features/preview/card-content.ts", [
    "// A card is a few lines of context, not a reading surface: a chart block left in its loading",
    "// state would say \"Rendering chart…\" forever, because nothing ever draws it here. Declining",
    "// outright shows the body instead, which is what the card can honestly offer — and the guard",
    "// above has to name `[data-chart]` too, or this call is skipped for exactly the notes that need it.",
  ]],
  ["src/client/features/preview/chart-block-toolbar.test.ts", [
    "// The keyword cell re-serializes its configuration, so the compact spelling is what a toggle writes.",
    "/** The live host after a chart was drawn, with the drawn canvas and marker the render pass leaves. */",
    "// A format toggle changes how many lines a block above occupies, which moves this one. The line is",
    "// what the toolbar resolves its write against, so a preserved subtree must still take the new line —",
    "// holding the old one made the next press report a block that had not moved at all.",
    "// The note text is identical whether the renderer switch is on or off, so the class is the only thing",
    "// that says the block must stop being a canvas. Preserving the drawn subtree here left an off switch",
    "// with the chart still on screen — which no unit test of the switch itself could see.",
  ]],
  ["src/client/features/preview/chart-block-toolbar.ts", [
    "/**\n * The toolbar a rendered chart carries: the format its body is written in, the source behind the\n * picture, and an image export. The format control is the only block tool in the preview that writes to\n * the note, so the write lives here rather than in the drawing layer — and it refuses rather than\n * approximates, because a rewrite that quietly changed what a chart means is worse than no rewrite.\n */",
    "/** The note's current text, which the block's recorded line is resolved against. */",
    "/** False while the preview and the note disagree, which is when a write would clobber a keystroke. */",
    "/** Why a body will not write the other way, in the words the author needs to act on. */",
    "// A toggle has to state the position it is in *before* it is first pressed, or a screen reader",
    "// announces a control whose state nobody can hear.",
    "/** The body the renderer encoded onto the block, or '' when the markup carries none. */",
    "/** The format the control switches *to*: the other one, whichever the body is written in. */",
    "// With charts switched off the block already shows its own body, so a panel repeating it would be a",
    "// second copy to disagree with, and there is no canvas left to rasterize. The format toggle stays:",
    "// it rewrites the note, which is something a reader can still want while the picture is off.",
    "/**\n * Wraps every chart block under a root in its head and source panel. Runs on the staged copy, so the\n * head is part of the markup the preview diffs against and a re-render cannot lose it.\n *\n * `drawn` is false when the account has charts switched off: the block is showing its own body, so it\n * gets the format toggle only.\n */",
    "/**\n * Which blocks have their source showing, keyed by the note line the block was drawn at — the same key\n * the preview's other interaction state is kept under, so a chart added above shifts with the rest.\n */",
    "/** The line a rendered block claims to sit on, or NaN when its markup carries none. */",
    "/**\n * Rewrites the fence as the other format. The block was drawn from the body the renderer encoded, so\n * that is what the fence is looked up by: when the note no longer holds it, nothing is written, in either\n * direction of the mistake.\n */",
    "// The size refusal names the ceiling it hit, because the author's next question is what to cut.",
    "// A rewrite that leaves styling behind has changed what the block looks like, even though nothing",
    "// about the data moved and the accent now paints the series. Say it, rather than let the author find out.",
    "/** Returns false when the click belonged to no chart tool, so the caller can keep walking its branches. */",
  ]],
  ["src/client/features/preview/js-runner-core.ts", [
    "/**\n * Everything a note's code could use to leave the worker thread. The shadowed parameter names above\n * only cover the direct route: `Function('return this')()` still hands back the real worker scope,\n * so the same names are taken away there too. `navigator` is reached through its own object because\n * `sendBeacon` hangs off that rather than off the scope.\n */",
    "// A property the engine refuses to redefine is one the note's code cannot reach either way;",
    "// the page-side timeout is the backstop, so a refusal here is never a reason to stop.",
  ]],
  ["src/client/features/preview/js-runner.ts", [
    "/**\n * The Worker thread is the sandbox: user code has no DOM and no parent reference, and `terminate()`\n * is the only hard stop for an endless loop. The page-side timeout is what bounds a run.\n */",
    "/**\n * The switch and the run button live here rather than in the rendered markup: a share page and an\n * export draw the same block with no controls nobody can press, and the code only ever runs on the\n * surface where the reader is the author.\n */",
    "/**\n * The code comes from the note's own fence rather than the rendered `<code>`: the line decoration\n * pads an empty line with a space so the gutter has something to draw, and that space would land\n * inside a multi-line string the note never wrote.\n */",
  ]],
  ["src/client/features/preview/markdown-tabs.ts", [
    "// A nested group numbers its own panels from zero, so an outer click that reached inside",
    "// would relabel the inner buttons and hide the panel the inner group has selected.",
    "/** Opens every collapsed block and selects every tab panel the target sits inside. */",
  ]],
  ["src/client/features/share/SharePage.tsx", [
    "// A shared page is read by visitors who have no settings of their own; the author's choice to",
    "// hide diagrams is theirs, not a property of the note, so a shared note always draws.",
  ]],
  ["src/client/features/share/share-form.ts", [
    "// A new or replaced passcode must be at least 8 characters (the server",
    "// enforces the same minimum); short codes are trivially brute-forced.",
  ]],
  ["src/client/features/shell/AppShell.tsx", [
    "// Keep settings prewarming out of the boot + first-sync window.",
    "// Ctrl+Shift+P is the first thing a returning user presses, and a cold chunk plus",
    "// `fallback={null}` reads as the shortcut being ignored.",
  ]],
  ["src/client/features/sidebar/ExplorerNote.tsx", [
    "// Every explorer row subscribes to several store slices; without memoising the row, a note",
    "// change re-renders every visible row in the explorer.",
  ]],
  ["src/client/features/sidebar/calendar-persist.ts", [
    "// Quota or private-mode writes can throw; the calendar view stays authoritative in memory.",
  ]],
  ["src/client/features/tags/tagMutations.ts", [
    "// The delta carries every note the server-side rewrite touched, and pull() falls back",
    "// to a full snapshot on its own when the server says the cursor is stale.",
    "// A failed move may still have renamed part of the family server-side, so restoring the",
    "// snapshot we took before our own optimistic edit would also undo any move that raced us.",
    "// Re-read instead of winding back.",
  ]],
  ["src/client/features/workspace/BacklinksPanel.tsx", [
    "// Debounced refresh on note revision changes; unrelated sync traffic",
    "// (cursor) no longer refetches, and stale links stay visible until the",
    "// fresh payload arrives.",
  ]],
  ["src/client/features/workspace/VersionsPanel.tsx", [
    "// The middle is only materialized when the LCS actually needs it; the unchanged head and",
    "// tail used to cost one object per line of the whole file (60k) before being truncated.",
  ]],
  ["src/client/features/workspace/reading-position.ts", [
    "// Reading position is optional when browser storage is unavailable.",
  ]],
  ["src/client/features/workspace/sync-scroll.ts", [
    "// Scrolling asks for the curve once per frame; rebuilding it walked and re-allocated",
    "// every anchor (2858 at 1 MB notes) 60 times a second.",
  ]],
  ["src/client/features/workspace/versions-diff.test.ts", [
    "/** The pre-change implementation: materialize every line, then truncate the array. */",
  ]],
  ["src/client/lib/calendar-activity.test.ts", [
    "// A mulberry32 PRNG so the differential run is deterministic across runs.",
    "// One random op against the map, mirroring the differential fuzz test's branch",
    "// probabilities; rand() is consumed in exactly the same order per step.",
    "// A missing target acts as a brand-new note.",
    "// Same-millisecond ties have no consumable order (the UI only reads id/title),",
    "// and only the order of equal timestamps can diverge: the naive rebuild follows",
    "// map insertion while the incremental re-appends notes that left and re-entered",
    "// a day. Compare with a canonical (updatedAt, id) sort instead.",
    "// The untouched day keeps its exact array identity.",
    "// The edited day is rebuilt with the new updatedAt ordering.",
    "// The owner changes title; note b (later in map order) takes over.",
    "// Renaming a non-owner leaves the slot untouched.",
    "// A late map-order note sharing a title never steals the slot.",
    "// Reviving re-adds the note everywhere with its new timeline position.",
  ]],
  ["src/client/lib/calendar-activity.ts", [
    "// The activity-heatmap calendar derives three whole-vault structures from each",
    "// note (per-day updatedAt counts, first-note-per-title lookup, per-day note",
    "// lists), and every typing pause commits a notes-map identity change, so all",
    "// three Object.values scans used to re-run over the full vault per commit.",
    "// Build the projection once and then repair it by diffing note references: a",
    "// commit only replaces the edited note's object, so untouched day buckets and",
    "// the title map keep their identities (memoized consumers skip them), and only",
    "// the edited note's old/new day slices and title slot are recomputed.",
    "// First-wins over insertion order, matching the naive rebuild: the map holds",
    "// the first alive note per title, so a vacated slot is re-claimed by the first",
    "// alive note in map order that still carries the title.",
    "// The naive rebuild only ever records days with at least one note, so the",
    "// incremental must drop a key when its count reaches zero (keeps the map",
    "// bounded and matches the reference shape exactly).",
    "// Copy-on-write helpers: the incremental path reuses the previous maps until",
    "// a note actually touches a slice, so every untouched output keeps its exact",
    "// identity (memoized consumers skip it). Each helper swaps in a fresh map only",
    "// once, before the first mutation of that slice.",
    "// An alive note whose projection fields actually changed.",
    "// Same day: per-day count is unchanged; only the day's list needs",
    "// rebuilding, so the counts map keeps its identity.",
    "// An id vanished from the map without a tombstone: drop its stale",
    "// contributions (a rare path that costs one extra walk when it fires).",
    "// A commit that touched fields this projection does not read",
    "// (excerpt, tags, pin, ...): keep every output identity stable.",
    "// updatedAt feeds both the day key and the day-list sort, so it",
    "// must match down to the millisecond for the slice to be skipped.",
  ]],
  ["src/client/lib/collator.ts", [
    "/** Cached Intl collator; constructing one per comparison dominates note-list sorting. */",
  ]],
  ["src/client/lib/db.ts", [
    "/** The store slices a shell snapshot is built from; identities decide whether to re-write. */",
    "/**\n   * Takes a getter so a keystroke only stores a closure: materialising 5000 summaries per\n   * change used to cost ~1.9 ms even though the debounced write happens once.\n   */",
    "/**\n   * One transaction for a whole flush. enqueueOutbox() reads and rewrites the entire queue,\n   * so calling it per queued write costs K reads plus K clones of an array that grows with K.\n   */",
  ]],
  ["src/client/lib/export-note.ts", [
    "// Pinned so an exported document cannot silently load a different stylesheet: the hash",
    "// is the sha384 of node_modules/katex/dist/katex.min.css for the version in package.json.",
    "// Same origin is what lets this code reach focus()/print(); without allow-scripts",
    "// nothing inside the exported document can execute as this origin.",
    "// Inlined so the print frame carries its own math styles: the frame inherits this",
    "// document's CSP (`style-src 'self' 'unsafe-inline'`, `font-src 'self' data:`), which",
    "// refuses the CDN stylesheet, and the bundled url()s resolve to our own /assets/fonts.",
    "// A downloaded .html has no CSP around it and is often opened away from the instance,",
    "// so it keeps the pinned CDN copy; the print frame cannot load it and inlines instead.",
    "// `false` because the exported page is always the light scheme.",
    "// Attachments reach 25 MB each, so the fetches are capped in flight and always time out",
    "// rather than hanging an export on a stalled object.",
    "// Embeds resolve first: their expanded bodies carry their own images, placeholders and",
    "// tab sets, and every pass below runs over the whole document, so going early covers them.",
    "// A tab panel only becomes visible through a click, and a collapsed <details> only through",
    "// a toggle; an exported .html carries no script and a print frame is sandboxed without",
    "// allow-scripts, so everything the author hid would simply be missing.",
    "// The bar only exists to switch panels, and nothing can switch them here.",
    "// The copy button and the diagram retry only exist because the preview has scripts.",
  ]],
  ["src/client/lib/fuzzy.ts", [
    "/**\n * Listings call this once per row per keystroke with a haystack the row already keeps a\n * stable reference to, so V8's cached string hash makes the lookup O(1) while\n * text.toLowerCase() would re-copy the whole body every time.\n */",
  ]],
  ["src/client/lib/hooks.ts", [
    "/**\n * A clock safe to keep in a dependency list: it only changes on a tick boundary,\n * so a caller that re-renders on pointer movement does not re-derive its inputs.\n */",
  ]],
  ["src/client/lib/i18n.ts", [
    "/** Provides typed runtime localization with on-demand locale loading. */",
    "// Preload the other locale in background for instant switching, but don't block init",
  ]],
  ["src/client/lib/markdown/chart/accent.ts", [
    "/**\n * The account's accent, read for the things that draw outside CSS.\n *\n * The pure oklch math lives in ./palette; this is the half that touches the document, kept apart so the\n * math stays testable without a DOM. Every call re-reads: a chart's colours must follow the accent the\n * account has now, not the one that happened to be set when the module was first loaded.\n */",
    "/** cinnabar, the accent the token layer ships with. Only reached with no stylesheet in reach. */",
    "/**\n * What the colours a chart would draw with currently depend on, in a string short enough to live in a\n * cache key. The accent is switchable per account and the palette leans on the light mode, so a key that\n * carried only the light mode would let a chart keep colours it read before the accent moved.\n *\n * The attribute is what the key reads rather than the resolved property: `--accent` is written by no rule\n * but `:root[data-accent][data-theme]`, and the key is taken once per block on every preview pass, where\n * resolving a style would force a recalculation the page otherwise would not have done.\n */",
  ]],
  ["src/client/lib/markdown/chart/body.test.ts", [
    "// A table whose delimiter row is broken is still a table: inference reads the first cell.",
  ]],
  ["src/client/lib/markdown/chart/body.ts", [
    "/**\n * The fence-level half of a ```chart block: which languages draw a chart, which body format a body\n * carries, and the surgery that writes a converted body back into the note.\n *\n * The format comes from the body unless the note states one with `style=` (see ./style), and both homes\n * travel inside the fence, so the same block answers the same way in the preview and in an export\n * without either of them being told.\n */",
    "/** Fence languages that render as a chart block. */",
    "/** The body a chart fence holds, the info line that opens it, and the line that holds both. */",
    "/**\n * The format a block reads its body as: what the note states, or what the body looks like when it states\n * nothing. The stated format is not a second opinion about the same fact — it decides which reader runs,\n * so a note that says `style=table` gets the message about its table even when the table is broken in a\n * way inference would not have recognised as a table at all.\n */",
    "/**\n * The chart fence sitting on a line of the note, or null when that line holds something else. A block\n * hands over the line its markup was stamped with, so this is how a write re-reads the body it is\n * replacing rather than trusting what travelled through an attribute.\n */",
    "/** Rewrites the fence's body, its stated format, or both in one edit — one press, one undo. */",
  ]],
  ["src/client/lib/markdown/chart/columns.ts", [
    "/**\n * Which columns of a scatter table mean x, y, size and series.\n *\n * The resolution lives beside the syntax rather than beside the drawing engine: a note that says\n * `cherry:mapping` must mean the same picture however it is drawn, and the day those two drift is the\n * day the format toggle starts losing data.\n */",
    "/**\n * The header words the syntax documents for a scatter's columns. These are matched against a note's own\n * cells and never rendered, so they are input vocabulary rather than UI copy: a note written in Chinese\n * means the same chart whatever language the reader's interface is in, which is why they cannot come from\n * the locale catalog. `SCATTER_HEADER_WORDS` is named in scripts/check-i18n.mjs as the one place Chinese\n * may sit in `src/client`; every other Han literal still fails that gate.\n */",
    "/** -1 when no column carries a size, which is what keeps a picture a scatter and not a bubble. */",
    "/** -1 when every point lands in one series. */",
    "// A column the note did not name is absent, not column zero: the keyword cell leaves an empty header",
    "// cell behind, and an empty string looked up in that header answers 0 — which handed a mapping of x",
    "// and y alone a size column and a series column the author never wrote, and drew a bubble nobody",
    "// asked for.",
    "// A mapping that names a column the header does not have is a mistake in the note, not a hint to",
    "// fall back: falling back would draw a chart over different columns than the author pointed at.",
    "/**\n * The documented order — name, x, y, size, series — with the header words the syntax also accepts.\n * The search starts at the second cell because the first one is where the point's name lives.\n *\n * A column the header does not name falls back to its slot in that order rather than to -1: a scatter\n * whose header says `name | temp | sales` means the second and third cells, and reading -1 would have\n * every point land on the same axis position — a picture of nothing, drawn confidently.\n */",
  ]],
  ["src/client/lib/markdown/chart/config.test.ts", [
    "// The keyword is matched case-insensitively, but the engine's name is camelCase: `:polarArea:` used to",
    "// answer unknown-kind because the lowercased spelling was looked up in a list holding the camelCase one.",
    "// The Chinese spellings name the columns a note is written with, not copy the page renders, so they",
    "// live beside the syntax rather than in the locale catalog.",
    "// A header that names nothing still has the documented order: name, x, y. Reading the absent column",
    "// as -1 put every point on the same axis position and drew a confident picture of nothing.",
    "// The keyword cell carries arbitrary configuration, so `options` beyond a title has a table home after",
    "// all — refusing it was what made an ordinary chart.js example unwritable as a table.",
    "// A series colour has no table cell, and the accent is what paints a table's series — so the rewrite",
    "// leaves the styling out and counts what it left, rather than refusing over something that changes",
    "// nothing about the numbers.",
  ]],
  ["src/client/lib/markdown/chart/config.ts", [
    "/**\n * The pair of translations between a chart table (./table) and a chart.js config.\n *\n * Both directions are total in one direction and partial in the other: a table always means *some*\n * config, but a config means a table only when everything in it survives being written as one. So\n * {@link chartConfigToTable} refuses rather than approximating — a toggle that quietly dropped a second\n * axis would leave the note drawing a different chart than it did before the press.\n */",
    "/** The kinds a chart fence draws from a table. `scatter` becomes `bubble` when a size column is read. */",
    "/** A config that will not survive the round trip, and why the toggle should decline to offer it. */",
    "/**\n * `dropped` counts the styling entries the table could not carry — colours, borders, point shapes —\n * which the accent paints over once the block is written as a table. The caller says so out loud: a\n * rewrite that changes a chart's colours has to be one the author hears about.\n */",
    "/**\n * The kinds whose categories are their rows rather than their series — one dataset, one slice per row.\n * Shared with the drawing layer because a palette applied per dataset would paint every slice the same\n * colour, and a chart that cannot tell its slices apart is not a chart.\n */",
    "/**\n * The kind a written name means, in the spelling this family hands to the engine.\n *\n * A keyword arrives lowercased — `:BAR:` and `:Bar:` are the same chart, and the reference syntax says\n * so — while the engine's own name is camelCase (`polarArea`), so the lookup has to fold the note's\n * spelling down and the answer has to come back in the casing chart.js reads. Matching the two directly\n * is what made `:polarArea:` unreachable: the list holds the camelCase name, the comparison held the\n * lowercased one, and no spelling of it was ever in the list.\n */",
    "/** The keyword cell's own configuration: `title` becomes the plugin, everything else is passed through. */",
    "// A scatter places its points by value, so it has no category row to carry; a pie's categories are",
    "// its slices, which the rows name rather than the header.",
    "/**\n * The config's `options`, written back as the keyword cell's own JSON.\n *\n * The cell carries arbitrary configuration — `keywordOptions` hands everything in it straight to\n * `options` — so the inverse is nearly the identity. The one thing it folds is the title, which the cell\n * writes as a bare string and `keywordOptions` turns into `plugins.title`; a title object with anything\n * beside `display` and `text` is left exactly as it is, because folding it away would be the loss this\n * file refuses everywhere else. Rejecting everything but a title, as this used to, turned `responsive`\n * into a reason a chart could not be written as a table — a key the cell would have carried without\n * complaint, and one every example in the reference docs has.\n */",
    "/**\n * What a table row holds about a series: its name and its numbers.\n *\n * Everything else a dataset carries is one of two things. A colour, a border width, a point shape or a\n * `fill` is styling, and a table has no cell for it — so the rewrite leaves it out and the accent paints\n * the series instead, which is the whole point of the accent palette. Which axis a series is measured\n * against, or which stack it joins, is not styling: a table gives every row the same axis and the same\n * stack, so dropping that would draw a different chart rather than the same one in other colours. Those\n * are refused, and the count of what was left out travels with the answer so the caller can say it.\n */",
    "// `bubble` has no keyword of its own: it is what a scatter table with a size column is drawn as, so a",
    "// config carrying it still has a table home.",
    "/** What one shape decides; `chartConfigToTable` adds the styling count on the way out. */",
    "/** A pie's value column has no place in a config, so the name a hand-written table gave it is dropped. */",
  ]],
  ["src/client/lib/markdown/chart/convert.test.ts", [
    "// `in` answers through the prototype chain, so it is the own property and the prototype itself",
    "// that have to be checked.",
  ]],
  ["src/client/lib/markdown/chart/convert.ts", [
    "/**\n * Reading a chart fence body whichever format it is written in, and rewriting it as the other one.\n *\n * The rewrite is the whole of what the toolbar's format control does: it never changes what the block\n * draws, only how the note says it. Both directions therefore refuse rather than approximate — a\n * conversion that quietly dropped a second axis would leave the note drawing a different chart than the\n * one the author was looking at when they pressed it.\n */",
    "/** Why a body cannot be written the other way. Every caller turns this into a sentence. */",
    "/** The config a chart fence means, from a JSON body or from a table one, as the note states it. */",
    "/** The body written the other way round, from the format the block is currently in. */",
  ]],
  ["src/client/lib/markdown/chart/json.ts", [
    "/**\n * The JSON half of a ```chart body. Chart blocks tolerate formatting: comment and `**` markers stripped\n * and trailing commas allowed before the strict parse is retried, because a config typed out of a\n * documentation page arrives with both.\n */",
    "/**\n * The config a note wrote, with the keys every other object shares refused on the way in. The keyword\n * cell of a chart table already runs its hand-written JSON through the reviver; a body is the same\n * author's hand-written JSON arriving by the other door, so it goes through the same guard.\n */",
  ]],
  ["src/client/lib/markdown/chart/limit.ts", [
    "/**\n * The ceiling on how much body a single chart block will read.\n *\n * A chart body is the note's own text, and both doors into it — `JSON.parse` for a config, the row walk\n * for a table — cost more the longer the string is, and the drawing engine then lays the picture out\n * synchronously. Nothing else bounds them: a shared note hands one author's text to a visitor's browser,\n * and a block can be written by hand as well as pasted. The limit is set far above anything a person\n * authors and reads on a chart — a ten-series year of daily points is a few tens of kilobytes — so it\n * refuses a blob rather than a big chart.\n */",
    "/** A body past that ceiling. Every caller turns this into the block's error state. */",
    "/** Checked before either reader runs, so the size is never paid for in order to be declined. */",
  ]],
  ["src/client/lib/markdown/chart/palette.ts", [
    "/**\n * Chart colours derived from the account's accent.\n *\n * A chart library's default palette is a rainbow chosen by nobody for the benefit of everybody, and it\n * sits badly against a page whose whole identity is one accent. So the series colours are built from\n * that accent instead: the accent itself, its own tint and shade, and then the two hues a designed\n * group is made of — the complement taken as a saturated spot, and a lean toward the neighbour of the\n * complement. That is the shape the reference groups have (a slate base, its lighter and darker\n * siblings, one gold spot, one mauve), and it keeps a multi-series chart reading as this page.\n *\n * oklch is where the arithmetic happens, because the tokens are written in it and its lightness axis\n * is perceptual (a ladder of equal steps *looks* like equal steps, which hsl does not give).\n *\n * The answer is sRGB hex, though, and that is not a style choice: the drawing engine parses the colours\n * it is handed — it lifts one for a hover state and mixes one for a translucent fill — and a colour it\n * cannot parse falls back to black or transparent rather than to the browser's own painter. Hex is what\n * every path reads the same way.\n */",
    "/** `oklch(49% 0.15 30)` and `oklch(0.49 0.15 30 / 0.6)` both appear in the token layer. */",
    "/** The sRGB channels of an oklch colour, unrounded and possibly outside 0..1. */",
    "/**\n * The colour as CSS can paint it and as the chart library can read it.\n *\n * A colour this side of the accent's chroma is out of sRGB for some hues — a saturated amber at the\n * lightness a chart needs is one of them — and the honest mapping is the *same colour with less chroma*,\n * not the same chroma clipped to the channel edges, which shifts the hue. So chroma is walked down\n * until the result fits, and only the last step is clamped to the edges.\n */",
    "/**\n * One stop of the group: where in the usable lightness band it sits, how far off the accent's hue it\n * leans, and what it does to the accent's chroma. `spot` is the complement at a chroma of its own — a\n * designed group keeps one saturated contrast even when the accent is a grey, which is what the\n * reference palettes do with a slate base and a gold spot.\n */",
    "/** The spot's floor, so a grey accent still gets a colour rather than a second grey. */",
    "/** The band a series colour may occupy, so nothing goes invisible against the page. */",
    "/** Where a stop may be re-placed when its own slot would land on a sibling of the same hue. */",
    "/** Two stops this far apart in hue are different colours however light they are; further apart, they are not. */",
    "/** Stops of one hue need this much lightness between them to be told apart in a legend. */",
    "/**\n * Where this stop sits in the band: its own slot when nothing of the same hue is already standing near\n * it, and otherwise the free slot furthest from those. Series one is the accent at its own lightness, so\n * a pale accent and a deep one both move the whole group around them rather than colliding with it.\n */",
    "/**\n * A categorical palette anchored on `accent`: the first entry is the accent exactly, and the rest are\n * the group it belongs to — its own tint and shade, a saturated spot at the complement, a lean toward\n * the complement's neighbour, and pale siblings of each.\n *\n * `dark` picks the band, because a colour that separates cleanly on paper can sit inside the background\n * on a dark canvas.\n */",
    "// A dark canvas washes colour out, so the chroma is held up a little rather than copied flat.",
    "/** How many series a palette is generated for. The engine cycles past the end; ten covers a real chart. */",
  ]],
  ["src/client/lib/markdown/chart/style.ts", [
    "/**\n * The `style=` annotation a chart fence may carry: `style=json` for a body made of data (a chart.js\n * config), `style=table` for a chart table body.\n *\n * The body already says which of the two it is, so this is not how a format is *discovered* — it is how\n * the note states one, and stating one changes what the block says when the body is not readable. A\n * table whose `--- |` row has a typo in it is recognisable as a table but not parseable as one, and a\n * block that has to guess then answers a JSON question about a table. With the format stated the right\n * reader runs, and its message is the one about the row. A value that names neither is reported rather\n * than ignored, because `style=tabel` asks for something no block draws, and redrawing as though the\n * note said nothing would hide the typo.\n */",
    "/** What a block reads off its own mark: the format it states, and a value that states nothing legible. */",
    "/** A fence that states nothing, which is what a surface without a chart block's mark reports. */",
    "/**\n * The info line cut into option tokens. A leading `{…}` brace group is one token even when it holds\n * spaces, because that is how the fork's own `{ts title=\"x\"}` fences are written.\n */",
    "/** `key=value` split out of a token, with either side's surrounding quotes dropped. */",
    "/** The `style=` value on a fence's info line, as written, or null when the fence states none. */",
    "/** The stated format checked against the two names a note may use; anything else is reported. */",
    "/**\n * The stated format in a form that can be compared between draws. Which reader runs is not written\n * anywhere in the body's text, so a note that only changed `style=` has to look changed here or the\n * block would keep the picture its old format drew.\n */",
    "/**\n * The same info line with its `style=` put at the end. Everything the line carries besides the\n * format — the language, a title — is left where it was.\n */",
  ]],
  ["src/client/lib/markdown/chart/table.test.ts", [
    "/** The line-chart example, taken from the reference table-chart demo with its labels in ASCII. */",
  ]],
  ["src/client/lib/markdown/chart/table.ts", [
    "/**\n * The table body a ```chart fence can carry instead of a JSON config: a markdown table whose first\n * header cell names the chart and optionally configures it (`| :bar:{\"title\": \"Tally\"} | … |`), which\n * is the shape Cherry's table-chart syntax uses.\n *\n * Only the *text* ↔ *model* half lives here. What a model means for a drawing engine is decided by\n * that engine (./config), so the syntax stays readable without importing one.\n */",
    "/**\n * The keyword cell, taken from Cherry verbatim: `:kind:` with an optional `{…}` configuration beside\n * it. `\\w+` is ASCII-only on purpose — a kind is an engine's own name, not a label.\n */",
    "/** A cell written `{\"title\": \"x\"}` reaches JSON.parse as `\"title\": \"x\"`, so it goes back wrapped. */",
    "/**\n * A hand-written configuration is data, and `__proto__` is a way of reaching the object every other\n * object shares. Every parser that reads one runs its keys through this.\n */",
    "/** The table as written: the keyword's own cell is consumed, so `header[0]` is `''`. */",
    "/** Why a body is not a usable chart table. Every caller turns this into the block's error state. */",
    "/**\n * The reason in the words the author can act on. The key lives beside the failure rather than in the\n * message because the block's banner is what a reader of a Chinese note sees, and a parser that threw\n * English into it would put one untranslated sentence on every broken table.\n */",
    "/** The cells of a markdown table row, with `\\|` held together and outer pipes dropped. */",
    "/**\n * Whether a fence body is *meant* to be a chart table. Structural only, because the renderer asks on\n * every keystroke: an unparseable table still reads as a table, so its error surfaces where the\n * config is actually read.\n */",
    "/**\n * Cherry re-wraps the cell's own braces and refuses a prototype key, because the configuration is\n * authored by hand and round-trips through a DOM attribute. Malformed JSON is an error here rather\n * than the silent `{}` Cherry answers with: a dropped title is a wrong picture, and the block can\n * say so.\n */",
    "/** Reads a chart table out of fence text. Ragged rows are padded, the way a rendered table pads them. */",
    "/**\n * The table text for a model. Unpadded: a body a toggle wrote should read like one a person typed, and\n * trailing spaces inside every cell would show up in the note as whitespace the editor keeps.\n */",
    "/** The number a cell means: thousands separators allowed, anything unreadable is zero. */",
  ]],
  ["src/client/lib/markdown/embeds.ts", [
    "/**\n * Embed bodies live in the note store, but every debounced preview re-ran the full render\n * pipeline (parse + markdown-it + sanitize) per embed, and the per-call fetch cache made two\n * panes embedding the same note ask the network twice. Both caches are exact: a key is only\n * reused while the markdown it was built from is still identical.\n */",
  ]],
  ["src/client/lib/markdown/enhance-chart.test.ts", [
    "// The border is left to the library so the arcs keep a hairline between them.",
    "// The catalog is not loaded under test, so t() answers with the key: this pins which message the",
    "// block chose. The KB figure it carries is pinned where the error is built, in chart/convert.",
  ]],
  ["src/client/lib/markdown/enhance.test.ts", [
    "// The second pass used to swap the shared config for its own, which re-allowed the",
    "// form controls and attributes the renderer deliberately forbids.",
  ]],
  ["src/client/lib/markdown/enhance.ts", [
    "// Layered on the shared config so its forbidden tag and attribute lists keep applying.",
    "// style is the only exception: mermaid paints SVG with inline styles and CSS blocks,",
    "// and DOMPurify sanitises the declarations themselves.",
    "/**\n * How many lines this block folds beyond: its own `collapse=` when it wrote one (0 meaning it never\n * folds), otherwise the preview's setting. A block states its own preference because the note is\n * what a reader shares, while the setting is only this account's default.\n */",
    "/**\n * The split ratio is a runtime number and the prose whitelist strips inline styles, so the grid's\n * tracks are handed to CSS as custom properties instead. A column split can be a real track list —\n * the prose column has a definite width, so `45fr 55fr` divides exactly what it says.\n *\n * A row split cannot. The block's height is whatever its two panels' content needs, so dividing\n * that sum proportionally always inflates the shorter panel: a five-line source beside a thirty-line\n * output at 6:4 measured 800px of empty panel. Rows therefore get the ratio as a ceiling on each\n * panel (`--ex-a` / `--ex-b`), which shrinks a generous pane into its own scrollbox and never adds\n * a pixel of blank. One axis is written and the other cleared, so a block that switches between a\n * row split and a column split cannot keep reading the stale one.\n */",
    "// `rl` moves the first panel to the right with `order`, and grid auto-placement follows",
    "// that order, so the track list has to be reversed to keep the ratio naming the two",
    "// panels of the pair rather than the left and right halves of the block.",
    "/**\n * Chart.js blocks. A chart is the one block whose rendered form is not markup: the picture is pixels on\n * a canvas plus a live instance, and neither survives being serialized or cloned. Everything below follows\n * from that — the instance is kept on the node, the signature check refuses to trust the marker attribute\n * on its own, and a block leaving the document has its instance destroyed by hand.\n */",
    "/** The axis and legend greys, held here because chart.js paints text from a colour string, not from CSS. */",
    "/**\n * The box a chart gets when its container has no layout to measure — an exported note is parsed into a\n * detached document, where every client box reads 0. chart.js's own default is 300×150, which is too\n * small to read a printed chart, so the block asks for the box it would have had in the page.\n */",
    "/** Why a body means no chart this fence can draw, in the words the author can act on. */",
    "// A failed chunk load must not be cached: one offline moment would leave every chart in",
    "// every note drawing an error for the rest of the session.",
    "/**\n * Every chart this module has drawn and not let go of. A block deleted from the note leaves no trace in\n * the document for a later pass to find, so the registry is how an instance and its ResizeObserver get\n * collected before the host itself is thrown away.\n */",
    "/** Lets go of any chart whose block has left the document. */",
    "/** Tears every chart under a root down. The preview calls it when a host is thrown away, since a removed\n * node never runs its own teardown and both the instance and its observer would outlive the note. */",
    "// The only thing in this path that parses JSON is the config reader, so a SyntaxError here is the",
    "// body not being readable — and the engine's own sentence about it is one the note's language has.",
    "/** Built from nodes rather than a markup string: the failing body is the author's own text and goes in\n * verbatim, so it must never be re-parsed as HTML on its way back out. */",
    "// Re-applies the app's axis colors under the user's own ticks/grid objects.",
    "/**\n * Colours the series the note left uncoloured. chart.js's own default palette is a rainbow nobody chose\n * for this page, so an unstyled dataset takes the accent ramp instead — but a note that named its own\n * colours keeps them, because that is a statement about the data, not an omission.\n *\n * A slice chart is the exception that inverts the rule: it has *one* dataset whose categories are the\n * rows, so a colour per dataset paints every slice identically and a pie of 35/20/15 becomes a disc.\n * There the palette is handed over one entry per slice, which is what chart.js reads for arc fills.\n * `borderColor` is deliberately left alone there, so the arcs keep the library's own hairline between\n * them — matching the border to the fill would weld the slices into one shape again.\n */",
    "// The size is handed in below, so the library must not measure the box again — and it has to",
    "// lose the note's own `responsive`, because a responsive chart re-measures a transform-scaled or",
    "// un-laid-out container and draws at the wrong size.",
    "// A surface that reads the canvas instead of a pair of eyes — the exported note — draws with no",
    "// entrance animation: chart.js animates towards its data, so a canvas sampled while an animation runs",
    "// is blank or partial.",
    "/** The size to draw at: the container's own box when it has one, and the printed-chart box when not. */",
    "// A layout change (a narrower window, the sidebar opening) resizes the container, and with `responsive`",
    "// off nothing else would notice, so the canvas would keep a size its box no longer has.",
    "/**\n * A chart is \"already drawn\" only when what is on screen still belongs to this body. The marker alone is\n * not enough: it is an attribute, so it survives being cloned into a fresh subtree while the canvas pixels\n * and the instance do not — trusting the marker alone showed an empty chart box wherever it was mounted\n * from a copy. An error banner is the exception, because its text really is in the markup.\n */",
    "/**\n * Shows a chart block's own body instead of drawing it, for an account that turned charts off. The\n * instance is let go first: a block going quiet while its chart still lives would keep a canvas and a\n * ResizeObserver pointed at text that replaced them. The marker is dropped so switching the setting back\n * on draws again rather than finding the block already \"rendered\".\n */",
    "/**\n * Draws every chart block under a root. `instant` is for the surfaces whose canvas is read rather than\n * looked at — an exported document — where an entrance animation is a picture of nothing at all.\n */",
    "// Read off the document once rather than per block: the accent is switchable per account and the",
    "// palette leans on the light mode, so a key that carried only the light mode would let a chart keep",
    "// the colours it read before the accent moved — and the blocks in one note all see the same answer.",
    "// A block showing its body was told so by the renderer switch, and this pass is not the one that",
    "// decides that. Carrying the refusal on the node means a caller that forgets to check the setting",
    "// cannot draw over it.",
    "// The stated format is in the key for the same reason the accent is: which reader runs is not",
    "// written anywhere in the body's text.",
    "/**\n * A canvas is pixels rather than markup, and an exported document is serialized out of `innerHTML`, where\n * a canvas carries nothing at all. So a chart drawn for an export is replaced with a picture of itself and\n * the instance is let go.\n */",
    "// The chart library is only ever reached from the draw pass, so declining here means the chunk is",
    "// never fetched — which is the whole point of the switch, and why it is decided before anything asks",
    "// for a picture.",
  ]],
  ["src/client/lib/markdown/fence-edit.test.ts", [
    "// markdown-it de-indents a fence's content by the fence's own run of spaces before handing it to the",
    "// renderer, so the block's recorded body has no leading spaces. Reading the raw lines instead made the",
    "// two disagree for every indented fence, and the write declined against a note it was looking at.",
  ]],
  ["src/client/lib/markdown/fence-edit.ts", [
    "/**\n * Fence surgery for the block languages that write themselves back into the note: locating the fence a\n * rendered instance came from, and rewriting it without touching a byte outside it.\n *\n * DOM-free and dependency-free on purpose — a chart block resolves its fence against the note's\n * *current* text on every write, so this runs on the preview's hot path and is unit-tested on its own.\n */",
    "/** 0-based line index of the opening fence, matching the renderer's `data-line`. */",
    "/** Fence body, EOL-normalized to `\\n`. */",
    "/** What one action asks of a fence; an omitted field is left exactly as the note has it. */",
    "/** Replacement for the opening fence's info string; omitted keeps it. */",
    "/** Fence bodies reach us from markdown-it (which keeps the document's EOLs) and from our own serializers (LF). */",
    "/**\n * The body as markdown-it would hand it over: a fence indented inside a list item or a blockquote\n * de-indents its content by the fence's own run of spaces, and the block compares this against what the\n * renderer encoded. Without the strip the two disagree for every indented fence and the block declines to\n * write a note it is looking straight at.\n */",
    "/** The run length a body line would need before it could close the surrounding fence. */",
    "// The body goes back at the fence's own indentation, which is where it was read from: a block inside",
    "// a list item has to stay inside it, and a body line at column zero would end the list around it.",
    "/**\n * Where the fence is *now*. The recorded line is tried first; when the fence moved (someone edited\n * above it) the single fence whose body still matches `target.body` is the one. Returns null when\n * neither holds — guessing would overwrite whatever the user typed since the block was rendered, so\n * every caller must then decline to write.\n */",
    "/**\n * The fence the renderer drew at `line`, read straight from the note: the opening line is a fence of\n * one of `languages` and the body runs to its closing line. Callers whose markup is known to match this\n * text (the preview only writes while the rendered document and the note agree) use it instead of\n * comparing a body, which would have to be scraped back out of the DOM.\n */",
    "/**\n * Rewrites one fence, keeping the note's EOL style and every line outside the block byte-identical. A\n * fence is widened when the new body contains a line that would otherwise close it early. Returns null\n * when the fence is no longer where the block last saw it, for the reason given in {@link locateFence}.\n */",
  ]],
  ["src/client/lib/markdown/renderer-chart.test.ts", [
    "/** markdown-it hands a fence body with its closing newline attached, so the attribute carries it too. */",
  ]],
  ["src/client/lib/markdown/renderer.ts", [
    "/** Builds the sanitized Markdown rendering pipeline and its Inkstone-specific syntax extensions. */",
    "/** Parse once with the full document environment so reference links retain their targets. */",
    "// A line with neither marker cannot change state, so rebuild-by-character is pure",
    "// overhead. The inComment test must stay: inside an open %% block the loop below",
    "// blanks the line instead of copying it.",
    "// Like an unclosed ``` fence, an unclosed container claims the rest of its own context",
    "// instead of throwing the author's text away.",
    "// A tab set without any tab-item still holds the author's content, so render",
    "// the body as ordinary blocks instead of consuming it.",
    "// An item that never closes runs to the end of its own set, so the typed text stays",
    "// readable instead of discarding the whole group.",
    "// One closer line closes the innermost container it can serve, so a `:::` inside a",
    "// `::::` set ends that inner block instead of truncating its parent.",
    "// A recognised directive opens a container; an unknown `::: name` still has to hold its",
    "// own closer, or a directive the renderer does not know would steal its parent's close.",
    "// An empty target would render a box that resolves to nothing and shows nothing, so the",
    "// author's text stays visible instead.",
    "// The whole target goes into the attribute, alias included: an attachment embed reads its",
    "// `|600x400` size back out of it, and stripping it here would lose the size and turn the",
    "// label into a bare number.",
    "// markdown-it fills alt from the label children at render time, so the size suffix has to",
    "// come off `token.content` and be removed from the last text child, not from the alt attr.",
    "/**\n * The runnable block. Its controls are deliberately absent: the markup is what a share page or an\n * export draws, and only the editing preview injects the switch and the run button (see\n * `features/preview/js-runner`). An output panel with nothing in it is the honest state elsewhere.\n */",
    "// The body rides along encoded because a chart table's own pipes and braces would otherwise be",
    "// read back out of markup the sanitizer has already rewritten. `data-line` is how the block finds",
    "// the fence again when the toolbar writes the note.",
  ]],
  ["src/client/lib/random-id.ts", [
    "// One helper for local identifiers, so no entry point has to fall back to Math.random().",
    "// No WebCrypto at all: still monotonic-unique inside this tab, never predictable",
    "// across tabs the way Math.random() was.",
  ]],
  ["src/client/lib/sync.ts", [
    "/**\n   * Applies live setting changes (realtime toggle, poll interval) without\n   * tearing down the engine, its WebSocket, or its leadership claim.\n   */",
    "// The engine is created exactly once; later setting changes are pushed",
    "// through updateConfig instead of rebuilding the whole engine.",
    "// Claims are \"latest wins\", so re-claiming on every focus made the tab you touched last",
    "// the permanent leader: each Alt-Tab tore down the previous leader's WebSocket and",
    "// re-ran a full pull. One reclaim per minute still takes over after the leader closes.",
  ]],
  ["src/client/lib/tag-tree.ts", [
    "/**\n * A parent that matches on its own keeps its whole subtree, so `work` still shows `work/meeting`;\n * a parent that only leads to a match is kept unhighlighted so the child stays reachable.\n */",
  ]],
  ["src/client/lib/test-render.ts", [
    "/** Idempotent jsdom shims needed to render React components in unit tests. */",
    "// jsdom answers every media query with `false`, which the app reads as a phone, so a case written",
    "// about what a wide window draws has to say which room it is describing. Only width queries answer the",
    "// call: a stub that also claimed `prefers-reduced-motion` or `(hover: hover)` would change what",
    "// unrelated readers of `matchMedia` see. Teardown is `vi.unstubAllGlobals()`.",
    "// The show as a wide window draws it: `useBreakpoint` reads desktop (jsdom answers every media query",
    "// with false, which is the phone layout — one door and no controls), and the two browser objects the",
    "// slide rail needs once it opens are stood up, the same way the rail's own cases do it. Teardown is",
    "// `vi.unstubAllGlobals()`.",
    "// jsdom defines no `scrollIntoView` at all, so it is assigned rather than spied — the same",
    "// stand-in the rail's own cases use.",
    "/** Render a React node into a fresh container appended to document.body (portals land on body as usual). */",
  ]],
  ["src/client/lib/time.ts", [
    "/** Day-key arithmetic: the key `delta` days after (or before) `key`. */",
    "/** Whole days from `a` to `b` (negative when `b` is earlier), using UTC day math to stay DST-safe. */",
    "/**\n * The weekday that opens a week grid, as a JS `getDay()` number. Not `0 | 1`: CLDR gives whole\n * calendars that open on Saturday, and every grid here takes this same 0-based index.\n */",
    "/**\n * Which weekday opens a reader's calendar is locale data, so it is read off `Intl` rather than off\n * the languages this app ships. `firstDay` is ISO-numbered (Monday = 1 … Sunday = 7) while the\n * grids index JS `getDay()`, where Sunday is 0 — hence the modulo. Runtimes without `getWeekInfo`\n * get the answer these calendars shipped with before the API existed.\n */",
    "/** The seven column labels of a grid, in the same order as that grid's columns. */",
    "// 2024-01-07 is a Sunday, so the offset alone selects the weekday.",
  ]],
  ["src/client/lib/year-grid-prefs.ts", [
    "// Corrupt or missing stored prefs fall back to the default below.",
    "// Quota or private-mode writes can throw; the pref stays authoritative in memory.",
  ]],
  ["src/client/store/notes.test.ts", [
    "// One write for the 500 optimistic patches, one for the folder removal itself.",
  ]],
  ["src/client/store/notes.ts", [
    "/** Coordinates the note cache, offline write-ahead log, optimistic updates, and server synchronization. */",
    "// Keep the current document for fast reads; only slow reads need a loading page.",
    "// Loaded content keeps its revision until the full note arrives.",
    "// Both split panes are on screen, and dirty notes hold unsent bodies: evicting any of",
    "// them leaves that pane stuck on its loading skeleton.",
    "// The size is tracked by hand: Object.keys(next) inside this loop made eviction O(K²)",
    "// exactly when the protected set pushes the survivors to the back of the key order.",
    "// zustand happens to call an updater once, but a set() that bumps module counters and",
    "// writes to IDB would double-fire the moment that stops holding.",
    "// A full snapshot carries fresh summaries for every note, and openNote() revalidates a",
    "// body the moment it is displayed, so the fan-out only spent requests on closed panes.",
    "// One transaction for the whole flush: enqueueOutbox() rewrites the entire queue, so",
    "// doing it per item cost K reads and K clones of an array that itself grows with K.",
    "// Alt-Tab storms used to rewrite the whole shell + outbox on every focus change. The",
    "// debounced timer still covers the tab while it is open, and pagehide stays immediate.",
    "/**\n * One Record copy and one shell save for a whole batch of optimistic patches. Deleting a\n * folder with 500 notes used to copy the full notes map once per note (3.0 ms each, so\n * 1.5–2.4 s of blocked main thread) before the request even started.\n */",
    "/**\n * A sync page can carry 500 notes whose cached bodies we hold, and each revalidation is a\n * whole-note GET plus a full-content IndexedDB write; unbounded fan-out froze the tab.\n */",
    "// `folders` only takes part in the folder and unfiled views, where a note's ownership is",
    "// resolved against the live folder set; without this the whole list re-derives whenever an",
    "// unrelated folder is renamed, reordered or created.",
    "// `beforeunload` and `pagehide` are browser-forced APIs, allowed as an exception to the no-native-",
    "// dialog rule: this listener only persists queued writes. It never calls preventDefault or sets",
    "// `returnValue`, so the browser shows no leave-page prompt (tests/no-native-dialogs.test.ts).",
  ]],
  ["src/client/store/pwa.ts", [
    "// Reset the flag once the toast is gone, so a later installed worker can",
    "// notify again instead of being permanently suppressed.",
  ]],
  ["src/client/store/session.ts", [
    "// Push unsaved offline edits before clearing local data, otherwise",
    "// they would be silently dropped. Dynamic import keeps the session",
    "// store free of a circular dependency on the notes store.",
    "// Loaded lazily so this store keeps depending on no component module.",
  ]],
  ["src/client/store/ui.ts", [
    "// The subscriber fires on every notification, including the ones that change nothing",
    "// persisted (toasts, selection). Serializing 22 keys per keystroke cost more than the",
    "// localStorage write the 220 ms debounce already coalesces, so serialization waits too.",
    "/** Tag filters in effect; one tag also matches its subtree, and several combine with AND. */",
  ]],
  ["src/client/styles/editor.css", [
    "/* Live preview shares the preview typography without nesting scroll containers. */",
  ]],
  ["src/client/styles/prose.css", [
    "/* A row split has no definite height to divide, so the ratio caps each panel rather than\n     sizing its track: a generous pane scrolls into its share, a short one costs nothing. */",
    "/* The canvas is sized from this box, so it has to carry a height of its own rather than collapse to\n     the canvas's intrinsic one — otherwise a re-measure would read back the size it just wrote. */",
  ]],
  ["src/client/styles/tokens.css", [
    "/* Small labels are used on both the editor and the darker sunken sidebar. */",
  ]],
  ["src/shared/constants.ts", [
    "// D1 limits an entire row to 2,000,000 bytes; reserve room for note metadata.",
    "/** Upper bound on simultaneously selected tag filters; the sidebar warns past it. */",
  ]],
  ["src/shared/markdown-utils.ts", [
    "/** Provides pure Markdown analysis shared by the browser and Worker runtimes. */",
    "// md-example fences are rendered as live markdown by the client renderer,",
    "// so references inside them count even though stripCodeRegions discards",
    "// them as ordinary code regions.",
    "// A closing fence may only be followed by spaces or tabs.",
    "// Each nesting level re-scans its own subtree, so uncapped md-example nesting makes",
    "// the work quadratic in depth: one note can cost seconds of CPU per read, per save",
    "// and per backup. Callers that only gate a read pass tighter limits than the ones",
    "// whose counts decide deletion or backup completeness.",
    "// A partial result would under-report references, and both attachment pruning and",
    "// backups delete or omit files on the strength of those counts. One flat pass over",
    "// the body is linear and over-counts code samples instead of missing a reference.",
    "// Same result as the /( ! )\\[([^\\]]*)\\]\\([^)]*\\)/g pass, as one left-to-right scan:",
    "// the regex backtracks across the rest of the text for every '[' whose '(' is never",
    "// closed, which costs seconds on a note near the content size limit.",
    "/** Code point count without materialising `[...text]`, which costs one array slot per character. */",
    "// The CJK ranges are all BMP, so scanning UTF-16 units matches the per-code-point test",
    "// while surrogate pairs (which decode outside those ranges) stay uncounted either way.",
    "/**\n * Tab labels render as plain text inside their buttons, so a `[[wikilink]]` or `#tag` written\n * on an item line is not a link anywhere else either. Blanked in place: the offsets that\n * `replaceTagInContent` splices with have to stay valid.\n */",
    "/** Obsidian's `|600` / `|600x400` suffix: a size, never a label. */",
    "/** What a `[[target|alias]]` reads as in plain text: the alias, unless the alias is only a size. */",
    "/**\n * The deduplication key `extractTags` uses: case- and width-insensitive. Listings call this once\n * per tag per keystroke, so the same handful of names are folded over and over; the bounded cache\n * follows the one in lib/fuzzy.ts.\n */",
    "/**\n * `yaml` pads flow collections by default, so a round-trip would rewrite the user's own\n * `tags: [a, b]` into `tags: [ a, b ]` on every property edit.\n */",
    "/**\n * A tag covers its whole subtree, so filtering or counting `work` also means `work/meeting`.\n * The notes list route spells the same rule in SQL, but `COLLATE NOCASE` only folds ASCII, so a\n * non-ASCII case variant can match here and not there. The offline shell is the stricter side.\n */",
  ]],
  ["src/shared/organizer-colors.ts", [
    "// Both the console and the MCP tools store icons truncated, so the limit lives",
    "// next to the colour list rather than at each call site.",
  ]],
  ["src/shared/settings-preview-chart.test.ts", [
    "/**\n * Each renderer switch is reached by its own accessible label, and a switch is found by name by a screen\n * reader and by a browser driver alike. `settings.diagram` already carried the same two-character word\n * for \"chart\" in Chinese that a naive `settings.chart` would, which gave two adjacent switches one name:\n * the panel then toggled the wrong one while looking correct. That is how this came to be checked at all.\n */",
    "/**\n * A stored settings object is older than any given key, so every renderer switch has to arrive through\n * `mergeSettings` rather than be read off the JSON: a stored `preview` that predates `chart` must come\n * back as the default, not as `undefined` coerced to \"off\" — that would silently stop drawing charts for\n * every account that existed before the switch shipped, with nothing wrong in the note.\n */",
  ]],
  ["src/shared/text-utils.ts", [
    "/**\n * UTF-8 byte length without allocating an encoded copy (note bodies reach 1.9 MB and\n * this runs on every write). Lone surrogates count as 3 bytes, matching TextEncoder's\n * U+FFFD replacement.\n */",
  ]],
  ["src/shared/types.ts", [
    "/** Only computed on the first page of a listing; later keyset pages return null. */",
    "/** `tag` nodes are synthesized from note tags, `unresolved` from links to missing notes. */",
    "/** Tags to filter by. Overrides `tag`; sent comma-separated. */",
    "/** How multiple tags combine: `any` (default) for union, `all` for intersection. */",
    "/** Draw each tag as its own node, linking the notes that carry it. Sent as `1`. */",
    "/** Notes the reader took out of the graph. Sent comma-separated, like `tags`. */",
    "/** Which side of a link a local graph walks. Only meaningful with `mode: 'local'`. */",
  ]],
  ["src/worker/attachments/backend.ts", [
    "/**\n * Ranged read for one chunk. R2 serves it storage-side; KV has no ranged get, so callers\n * must fall back to readAttachmentObject and slice in the isolate.\n */",
  ]],
  ["src/worker/attachments/references.ts", [
    "// Retained versions must remain restorable after unused attachments are pruned.",
    "// The instr() predicate discards rows that cannot contain an attachment URL",
    "// so full bodies only cross the wire for rows the regex will actually parse.",
  ]],
  ["src/worker/backup/archive.ts", [
    "// The restore limits are the real ceiling: a ZIP that can never be imported back is",
    "// not a backup, and building it would buffer hundreds of MB in this isolate.",
    "/** Files whose consistency re-read is in flight while the ZIP consumes the current one. */",
    "// Each file is still re-read at the moment its entry is produced (that is the consistency",
    "// guarantee), but the re-reads are now pipelined: waiting one D1 round trip per note made a",
    "// 5000 note backup spend 40–75 s purely waiting between entries.",
    "// A cancelled consumer must not leave the in-flight re-reads as unhandled rejections.",
  ]],
  ["src/worker/backup/retention.ts", [
    "// 50 removals were 50 serial R2 deletes each followed by its own D1 DELETE; one batched",
    "// delete plus bounded-parallel removals keeps the same end state in 1 round trip.",
  ]],
  ["src/worker/backup/scheduler.ts", [
    "/** Accounts only enter the trim loop once they are this far past the retention target. */",
    "// One aggregate pass finds the accounts that actually over-retained; previously every",
    "// account paid a DELETE, and each DELETE could only remove TRIM_ROWS_PER_ROUND rows.",
  ]],
  ["src/worker/backup/snapshot.ts", [
    "/** Produces restorable JSON, readable Markdown, and attachment files for every backup target. */",
  ]],
  ["src/worker/backup/validation.ts", [
    "// Hostname screening cannot see through attacker-controlled DNS answers",
    "// that resolve to private addresses; the deployment's",
    "// global_fetch_strictly_public compatibility flag remains the hard outer",
    "// guard and must stay enabled in every wrangler config.",
  ]],
  ["src/worker/db/fts.ts", [
    "/**\n * Queues every live note for re-indexing in one statement. Rebuilding in the request path\n * costs ~3 round trips per 50 notes (600 trips for 10k notes) plus a full-text tokenize\n * pass, which cannot finish inside one invocation; the queue drains in the background.\n */",
    "/** Removes search rows whose note no longer exists or was deleted. */",
  ]],
  ["src/worker/db/quota.ts", [
    "/**\n * Import runs hold a per-account import lease, so one count per request can budget every\n * note it inserts instead of paying a COUNT round trip per note.\n */",
  ]],
  ["src/worker/db/rows.ts", [
    "/** Body + metadata without the per-row tag GROUP_CONCAT subquery. */",
    "/** Listing columns without tags; pair with noteTagsQueryForPage so a page pays one join. */",
    "/**\n * The per-row subquery is the cheap shape for a handful of rows: SQLite runs it once per\n * note. A page of 500 turns it into 500 index walks whose tags are never indexed for it,\n * so listings use NOTE_COLUMNS_NOTAGS plus noteTagsQueryForPage in the same batch.\n */",
    "/**\n * Mirrors an already-built page query (`from` is the `FROM notes n WHERE … ORDER BY … LIMIT …`\n * tail) to fetch that page's tags as flat rows. `?1` must be bound to the account id.\n */",
    "/** Rewrites rows in place so the existing mappers keep reading `tag_names`. */",
  ]],
  ["src/worker/db/schema.ts", [
    "/** Defines the idempotent final D1 schema initialized by every Worker isolate. */",
    "// Explicit whitelist (not a regex over SCHEMA_STATEMENTS) so later",
    "// additions like mcp_api_keys can never be picked up accidentally.",
    "// Only CREATE TABLE / INDEX statements: D1 does not reliably support",
    "// ALTER TABLE ADD COLUMN with constraints, so the AI search preference",
    "// lives in app_meta (key `ai-search-enabled:<userId>`) instead of a",
    "// new column on the pre-existing mcp_preferences table.",
    "// Existing installations must converge additively. CREATE IF NOT EXISTS",
    "// never rewrites user data; running table creation before indexes also",
    "// lets a partially initialized database recover missing feature tables.",
    "// Keep the existing indexed text and rowids. The batch either replaces the",
    "// complete index or rolls back, including when an old installation retries.",
    "/** Cron claims one account's oldest due row, so the queue is indexed per account. */",
    "// The list endpoint can order by created_at or title as well; without a matching",
    "// compound index SQLite sorts every visible row (up to notesMaxPerUser) per page.",
    "// EXPLAIN on a 5k-row replica: created/title orderings report",
    "// \"USE TEMP B-TREE FOR ORDER BY\" until these exist.",
    "// EXPLAIN on a 594-link replica: /api/graph's edge fetch moves from",
    "// \"USING INDEX idx_links_user_target (user_id=?)\" — a scan of every link the",
    "// user owns — to \"(user_id=? AND source_note_id=?)\". The two OR-shaped",
    "// predicates (includeOrphans, local BFS) keep their old plans: one index",
    "// cannot serve an OR across two columns.",
  ]],
  ["src/worker/db/writes.ts", [
    "/** Keeps tags, backlinks, full-text indexes, and change records consistent with note writes. */",
    "/** Fan-out above this size is deferred to the background rewrite queue. */",
    "/**\n * Recompute the display-only columns from the note bodies, one keyset page per call.\n * `rev` and `content_hash` are matched in the guard but left alone: a rebuild is not an\n * edit, and bumping them would make every client re-download notes nobody changed.\n */",
  ]],
  ["src/worker/env.ts", [
    "/** Workers AI binding for semantic search; optional so AI search degrades gracefully. */",
  ]],
  ["src/worker/index.ts", [
    "// Codex CLI drops the `iss` callback parameter while its rmcp",
    "// dependency enforces it whenever the authorization server advertises",
    "// `authorization_response_iss_parameter_supported` (openai/codex#31573), so",
    "// login fails even though the parameter is on the wire. Serve the metadata",
    "// without that flag to keep codex compatible; the standard RFC 9207 `iss`",
    "// parameter is still appended to callbacks for conforming clients.",
    "// Index drains run on every cron fire; whole-library work (backups, attachment",
    "// cleanup, expired-record purges) only on the top of the hour, so a long backup",
    "// cannot take the embedding drains down with it.",
  ]],
  ["src/worker/lib/internal-auth.ts", [
    "/**\n * The Durable Object guard is opt-in, but a secret that was created and left blank reads\n * as falsy, which silently switches the guard off. Say so instead.\n */",
  ]],
  ["src/worker/lib/oauth-request.ts", [
    "// Rebuild after consuming the bounded body so the provider can read it once.",
  ]],
  ["src/worker/lib/request.ts", [
    "// CF-Connecting-IP is injected by the Cloudflare edge and cannot be",
    "// spoofed there. On any other runtime the header is client-controlled,",
    "// so ignore it rather than trusting it for throttling.",
  ]],
  ["src/worker/lib/rewrite-drain.ts", [
    "/** Notes a single queue row may rewrite per round; the tail is re-queued for the next one. */",
    "/**\n * Drains fan-out rewrites (note renames, tag renames/deletions) that were deferred\n * because they touched more notes than the inline budget allows. Rows are marked with\n * `claimed_at` rather than deleted up front, so an invocation killed mid-work leaves the\n * row recoverable; failures re-arm the row with a retry counter and are dropped after\n * REWRITE_MAX_ATTEMPTS instead of freezing the queue forever.\n */",
    "// Real progress: re-arm the row at attempt 0 so the next round continues.",
    "// Guarded UPDATE ... RETURNING is the claim: a concurrent drain either sees the newer",
    "// claimed_at and gets no row, or proceeds on a different account.",
    "/**\n * Pushes a row to the tail for a later round while keeping its claim marker, so this run\n * cannot re-pick it. The row becomes claimable again once REWRITE_CLAIM_TTL_MS has\n * passed, which must stay shorter than the cron interval.\n */",
  ]],
  ["src/worker/lib/security-headers.ts", [
    "// The OAuth provider and the MCP handler answer their own responses, so the app",
    "// middleware never sees them and the headers have to be applied at the edge.",
    "// Vite's dev server injects the React Fast Refresh bootstrap as an inline script,",
    "// which our own `script-src 'self'` refuses — and without that bootstrap the SPA",
    "// never mounts, so nobody can use `npm run dev`. Only a dev build serving an HTML",
    "// document may set this; the contract test pins the gate.",
  ]],
  ["src/worker/lib/update-check.ts", [
    "/** Isolate-level TTL cache: the published version changes daily at most. */",
  ]],
  ["src/worker/mcp/ai-search.ts", [
    "/**\n * Private AI semantic search for the MCP module.\n *\n * Notes are embedded with Workers AI (`@cf/baai/bge-m3`, 1024 dims,\n * multilingual) and the vectors live in D1 — no public query endpoint, one\n * index per account. Content changes are queued and drained in the\n * background; when the AI binding is missing or the model call fails the\n * feature degrades to plain lexical search instead of failing (the old\n * behavior that surfaced as HTTP 503s).\n */",
    "// Stored in app_meta instead of a column on mcp_preferences: D1 does not",
    "// reliably support ALTER TABLE ADD COLUMN with constraints, and app_meta",
    "// exists on every database without any migration.",
    "/**\n * Queues a note for embedding (or vector deletion). The single row per note\n * uses last-write-wins semantics: a delete supersedes a pending embed and\n * vice versa. Queuing is skipped entirely while the account has AI search\n * disabled, except deletions which always clean up stale vectors.\n */",
    "// The account turned AI search off; its queue would otherwise grow forever.",
    "/**\n * Semantic retrieval over the account's embedding index. Returns null when\n * AI is unavailable or the query embedding fails; the caller degrades to\n * lexical search.\n */",
    "/**\n * Reciprocal-rank fusion: merges two ranked lists into one by rank, so a\n * note that ranks well in both lexical and semantic search surfaces above\n * one that only appears in a single index.\n */",
    "/** Calls the Workers AI embedding model and returns a Float32Array. */",
    "/** Handles both the `{ data: [{ embedding }] }` and `{ shape, data }` shapes. */",
    "/** Calls the Workers AI embedding model for many texts in one round trip. */",
    "/** Query embeddings repeat constantly across MCP calls; cache per isolate. */",
    "// 2 pages of 500 vectors keep one response under D1's result cap (≈4.1 MB of BLOB) while",
    "// lifting the recall window from a fixed 200 notes to 1000.",
    "/**\n * Drain-only view of the preference. `noteIndexQueueStatement` keeps the authoritative\n * guard in SQL, so a stale entry can only skip or start an empty background drain; it\n * never queues work the account is not allowed to have.\n */",
    "/**\n * Processes queued embedding jobs. Called from cron with a large budget and from\n * write/import paths (via waitUntil) with a small one. Items are processed in\n * chunks so one Workers AI call covers up to EMBED_CHUNK notes, and sequentially so\n * rate limits are respected. A chunk that fails is retried item by item, and items\n * that still fail are pushed to the back of the queue with a retry delay instead of\n * freezing the whole account.\n */",
    "// DRAIN_PER_USER keeps multi-account rounds fair, while a lone busy account may",
    "// spend the whole budget instead of leaving 92% of it unused.",
    "/**\n * Coalesces background embedding drains per account inside one isolate so a burst of\n * writes cannot queue several drains over the same head items.\n */",
    "/** Queues a couple of embeddings right after a note write. Never blocks the response. */",
    "// Nothing committed: the whole window was pushed back with a retry delay, so",
    "// re-reading it in this run would only repeat the same failure.",
    "/**\n * Keeps one failing note from freezing the account's queue: the row is re-armed with a\n * retry delay, and dropped after EMBED_MAX_ATTEMPTS so the head always advances. The\n * note keeps `created_at` as its identity guard so a newer edit is never penalised.\n */",
    "// Keyset on (indexed_at, note_id): the window used to be a fixed 200-row freshness cut,",
    "// which for a 5000-note account meant 4% of the index could ever be recalled at all.",
    "/** Keeps the SEMANTIC_TOP_K strongest rows seen so far while scanning pages of vectors. */",
  ]],
  ["src/worker/mcp/api-keys.ts", [
    "/**\n * Static API keys for MCP access.\n *\n * Small or generic MCP clients (scripts, SDKs, unnamed agents) cannot run the\n * OAuth 2.1 dance, so they authenticate with a plain `Authorization: Bearer\n * <key>` header — the universal HTTP standard. The OAuth provider resolves\n * these tokens through its official `resolveExternalToken` hook; the key is\n * never stored or returned again, only its SHA-256 hash.\n */",
    "// 32 random bytes encoded as unpadded base64url is exactly 43 characters.",
    "/**\n * Resolves a bearer token to an account. Returns null for unknown, revoked,\n * or malformed keys so the OAuth provider can answer with 401 invalid_token.\n */",
  ]],
  ["src/worker/mcp/library.ts", [
    "/** Matches parseFrontMatter's own 64 KiB safety limit, so scanning never truncates. */",
    "// parseFrontMatter can only match a document starting with an optional BOM and '---',",
    "// so every other body can be skipped storage-side instead of shipping 500 full texts.",
    "// Results stay in request order, but the items are no longer strictly serial: each one is",
    "// an idempotent, revision-guarded write, so a 20-item call used to pay 120–140 sequential",
    "// D1 round trips (≈1.2–3.5 s) to flip twenty flags.",
    "/** Chunk bounds for read_attachment, kept pure so the arithmetic is testable. */",
    "/** KV has no ranged get, so only that backend still pays for a full object read. */",
  ]],
  ["src/worker/mcp/oauth.ts", [
    "// Static API keys let small or generic MCP clients authenticate with a",
    "// plain `Authorization: Bearer ink_...` header instead of running the",
    "// full OAuth 2.1 dance. Keys are hashed and revocable.",
    "// This path runs before the API handler, so ensure the schema exists",
    "// (cheap after the first request thanks to the initialization cache).",
    "/** The account role gates tool availability and changes rarely, so it is read once per window. */",
  ]],
  ["src/worker/mcp/operations.ts", [
    "// The mutation itself failed before committing; remove the pending row",
    "// so the client can retry the same operation_id cleanly.",
    "// The mutation already committed. Keep the pending row so a retry goes",
    "// through the recovery path instead of re-executing and colliding",
    "// (e.g. create_note with the same id).",
    "/**\n   * Shapes what the cache table persists. The write tools return a full note, but their\n   * responses never expose the body, and storing it would keep a second copy of every edited\n   * note in mcp_operations (approaching D1's row limit for a 1.9 MB note).\n   */",
  ]],
  ["src/worker/mcp/retrieval.ts", [
    "// AI unavailable, rate-limited, or malformed response: degrade to lexical.",
  ]],
  ["src/worker/mcp/settings.ts", [
    "/**\n * Every MCP HTTP request needs the switch, and the endpoint is hit once per tool call, so the\n * single-key read is memoized per isolate. Flipping the switch in this isolate drops the entry\n * immediately; another isolate converges within the window.\n */",
  ]],
  ["src/worker/mcp/writes.ts", [
    "// The quota read rides along with hashing instead of adding a serial round trip.",
    "// Organizing never reads the body, so the pre-read is metadata only; the response body",
    "// comes from the single read-back inside patchNote's batch.",
    "// The read-back rides in the same batch: the old shape paid a second full-note round trip",
    "// after every write, and its conflict branch paid a third.",
    "/**\n * What mcp_operations persists: the write tools' responses never expose the body (see\n * noteResult in server.ts), so caching it would store a second copy of every edited note and\n * push a 1.9 MB note past D1's row limit.\n */",
    "/** Appended to a write batch so the response body costs no extra round trip. */",
    "/** The same row without `content`: a 1.9 MB body a flag flip never looks at. */",
    "// The conflict payload keeps carrying the body even when the pre-read was metadata only.",
  ]],
  ["src/worker/routes/auth.ts", [
    "// Account-wide cap so a distributed botnet cannot retry one account",
    "// from many IPs forever; cleared on every successful sign-in, so a",
    "// normal user only ever notices it after 30 failed attempts per hour.",
    "// A successful sign-in proves this identity is legitimate: clear only the",
    "// identity-scoped throttling keys, never the shared per-IP buckets, or an",
    "// attacker with any low-value account could reset the per-IP failure",
    "// ceiling between bursts of password guessing.",
    "// Malformed names collapse to one shared identity, so they keep only the",
    "// per-IP buckets: otherwise strangers could lock out a user who mistypes.",
  ]],
  ["src/worker/routes/files.ts", [
    "// Anonymous share reads get a tighter work budget than the delete/backup paths:",
    "// an unfinished scan here only withholds one asset, which is the safe direction.",
    "/** 1 when a note change landed after `scanCursor`, i.e. the prune must hold off. */",
    "// One freshness probe per page replaces the NOT EXISTS subquery that used to run for",
    "// every attachment and every statement; a change landing mid-page only defers the",
    "// remaining rows to the next prune, which is what the guard already tolerated.",
  ]],
  ["src/worker/routes/mcp-settings.ts", [
    "// Kick off the first batch immediately; the rest is drained by the cron.",
  ]],
  ["src/worker/routes/notes.ts", [
    "/** Ids per dependent-table delete when emptying the trash. */",
    "// A keyset page continues a listing the client already counted; re-counting scans every",
    "// visible row (up to LIMITS.notesMaxPerUser) again on each page turn.",
    "// One statement per dependent table, over 500 ids at a time. The old shape inlined the same",
    "// unbounded `SELECT id FROM notes WHERE deleted_at IS NOT NULL` into 8 statements, so a 20k",
    "// note trash walked 8×20k rows inside a single D1 request and hit its CPU ceiling.",
    "/**\n * The dependent-table cleanup for one page of trashed note ids, in the order the cascade\n * needs: link retargeting before the notes go, share sessions before their shares.\n * Statements bind `?1` = account, `?2` = JSON id page (the note_tags delete has no account\n * column to filter, so it takes the id page as `?1`), `?3` = timestamp.\n */",
    "// The quota read rides along with hashing instead of adding a serial round trip.",
    "// Whether another note already answers to either title decides the wiki-link rewrite, so",
    "// it rides along with the mutation instead of costing the rename path its own round trip.",
    "// One lower() copy and one instr per row: SQLite does not share the repeated",
    "// lower(n.content) subexpression across the three references below.",
    "// Load and rewrite in small windows: a hub note referenced by thousands of others must",
    "// not hold every candidate body in the isolate at once.",
    "// Several `tag` params combine with AND, and each one also matches its whole subtree so the",
    "// rolled-up count in the sidebar and the result set agree. Both halves have to stay in step",
    "// with tagInScope(), which spells the same rule in TypeScript for the offline shell.",
  ]],
  ["src/worker/routes/search.ts", [
    "// Trashing queues an fts_index_queue 'delete' row and purgeStaleFtsRows drops any row whose",
    "// note is not live, so an in:trash query has nothing left in notes_fts to match against;",
    "// it is served by likeSearch instead. Keeping trash indexed would trade a niche ranking",
    "// improvement for an index lifecycle that has to survive restore and purge races.",
    "// A term-less query (folder:/tag:/is: only) must not emit `ORDER BY 0`: SQLite reads a bare",
    "// integer there as a result-column ordinal and rejects 0 outright.",
    "// The folder view is recursive, so folder: has to walk the subtree too. UNION rather than",
    "// UNION ALL keeps a parent_id cycle from looping forever.",
  ]],
  ["src/worker/routes/share.ts", [
    "/** Sweep at most once per window, and never let the map grow without a hard ceiling. */",
    "// View counts are display-only; dropping them beats paying an O(n) sweep per request",
    "// or growing the isolate without bound under many distinct visitors.",
  ]],
  ["src/worker/routes/sync.ts", [
    "// A non-empty `after` key always means the caller is mid-way through a",
    "// full snapshot page chain; keep serving snapshot pages regardless of",
    "// `since`, so following the returned nextKey can never silently drop",
    "// remaining pages.",
    "// Never move the client's cursor backwards, even if it reported a",
    "// seq ahead of the server (e.g. data was trimmed).",
    "// Tag counts are a projection over `note_tags`, and a note write only emits a `note` change",
    "// row. Without this the delta would carry stale counts forever. Note deletions never reach",
    "// `noteIds` (they become `deletions`), so the flag has to read the raw change rows.",
    "//",
    "// Only on the last page: the client applies every delta page through its own applySync, so",
    "// marking each one full would ship the whole tag list once per page (442 KB per 5 000 tags).",
    "// The final page's recount already covers everything the earlier pages moved.",
  ]],
  ["src/worker/routes/tags.ts", [
    "// Load and rewrite in small windows: a hub tag must not pin every candidate body in",
    "// the isolate before the first write happens.",
    "// The whole family is snapshotted before anything moves, so each step below only ever sees",
    "// the exact name it was asked about. Length-descending is just a stable, readable order for",
    "// the change rows clients receive. The `/` in the LIKE pattern is load-bearing: without that",
    "// boundary `a` would claim the unrelated sibling `ab` and rewrite every `#ab` in the library.",
    "// Bodies first, rows second: rewriteTagInNotes finds its candidates by joining on the source",
    "// tag row, so that row has to still exist. It also means the derived pass has already created",
    "// the destination rows, which is why the batch below copies onto them instead of renaming in",
    "// place (an UPDATE would hit idx_tags_unique).",
    "//",
    "// Known gap: past INLINE_REWRITE_LIMIT a member's rewrite is handed to rewrite_queue whose",
    "// rollback is a no-op, so if a LATER member fails, an earlier queued rename can still land.",
    "// That converges to a partially moved family with a duplicate tag, not to lost text.",
  ]],
  ["src/worker/routes/transfer.ts", [
    "// sha256/size were computed at persist time; re-downloading every matching",
    "// object to re-hash it doubles import transfer for no extra assurance.",
    "/** Imports queue thousands of embeddings at once; a cron-only drain would take days. */",
    "/**\n   * One note-count snapshot budgeting the whole request. The import route holds an\n   * account-level lease for its duration, so re-counting per note is pure overhead.\n   */",
    "/**\n * The two lookups a restored attachment needs — the import mapping for this hash, and the\n * oldest attachment that already carries this hash — in one round trip. They used to run as\n * separate queries for every entry of a restore.\n */",
  ]],
  ["src/worker/types/vite-env.d.ts", [
    "// Only `DEV` is read by the Worker, and only through optional chaining, so a bundle",
    "// that never went through Vite's replacement simply keeps the strict policy.",
  ]],
  ["tests/ai-drain-queue.test.ts", [
    "// The batch call fails, then every item is retried on its own.",
    "// Clear the backoff and the item is attempted again, incrementing attempts.",
  ]],
  ["tests/backup-archive-gate.test.ts", [
    "// Emitting the declared length is what lets a test consume the archive to completion:",
    "// the size guard in archive.ts rejects a short re-read.",
  ]],
  ["tests/doubles/d1-sqlite.ts", [
    "// D1 hands BLOB columns back as ArrayBuffer while node:sqlite returns a Uint8Array view;",
    "// decoding a typed array element-wise instead of reinterpreting its bytes changes results.",
    "// The realm check is by name: under jsdom `instanceof Uint8Array` can miss node's intrinsics.",
    "// node:sqlite happily runs a write through .all(), so the statement kind has to be",
    "// decided from the SQL text the way D1 does: reads return rows, writes return meta.",
    "// D1 runs a batch in one transaction: a later failing statement must not leave the",
    "// earlier writes applied.",
  ]],
  ["tests/export-hardening.test.ts", [
    "// Which stylesheet the frame gets is a build-time question (vitest stubs CSS), so",
    "// pin the import itself: the bundled copy, inlined, is the only source allowed here.",
    "// the SVG keeps its own styles, which is all the printed page needs to paint it",
    "// the embed pass has to run before the math pass, or the formula inside the expanded",
    "// body stays blank (the section itself also stays in the document, as transclusion does)",
  ]],
  ["tests/fts-tenant-index.test.ts", [
    "// Mirrors the shipped schema: user_id must be an indexed FTS5 column so the",
    "// tenant phrase filter runs inside the inverted index, not as an UNINDEXED",
    "// post-scan.",
  ]],
  ["tests/graph-hardening.test.ts", [
    "// The shared Select pins h-11 at md and above, so a compact row has to answer that breakpoint too.",
  ]],
  ["tests/graph-route-filters.test.ts", [
    "// D1 refuses a statement holding more than 100 bound variables, and node:sqlite does not,",
    "// so the only defence is a test that counts the bindings a page of notes produces.",
  ]],
  ["tests/login-throttle-targets.test.ts", [
    "// Malformed names all hash to one identity, so an anonymous caller used to be able",
    "// to lock out anybody who mistyped their username by filling that shared bucket.",
  ]],
  ["tests/markdown-scan-bounds.test.ts", [
    "/** One md-example fence costs 17 bytes; nesting requires a strictly longer outer fence. */",
    "// Pruning and backups delete or omit files on the strength of these ids, so an",
    "// unfinished descent must over-report rather than return a partial set.",
    "// Expected values captured from the pre-rewrite implementation at fc61e80.",
    "// 160 KB cost the regex version ~8.7 s and the blowup scales with the square of",
    "// the length, so the 1.9 MB content cap extrapolates to ~20 min per call.",
  ]],
  ["tests/markdown-text-hotpaths.test.ts", [
    "// Reference implementations kept from before the fast paths landed: these lock P2-01 /",
    "// P2-02 / P2-20 as behaviour-preserving. Code points are written numerically so ranges",
    "// cannot drift, and range boundaries are sampled on purpose.",
    "// CJK range boundaries: 2E80/9FFF and F900/FAFF are counted, neighbours are not.",
    "// A multi-line comment body carries no marker on its own lines, so those lines must",
    "// still be blanked by the inComment branch rather than passed through.",
  ]],
  ["tests/mcp-write-readback.test.ts", [
    "// Counts the statements that pull the note body: the whole point of the read-back merge.",
    "// The cached/returned note carries no body: the tool response never exposed one.",
    "// The conflict payload is built from a fresh full read, so it still carries the body.",
  ]],
  ["tests/note-list-tags.test.ts", [
    "// Corrupt row on purpose: tags owned by another account must never surface on this page.",
    "// The routes read a mid-batch SELECT by index (count, page, tags) while still using",
    "// results.at(-1) for the change seq, so position alignment is load bearing.",
  ]],
  ["tests/notes-tag-views.test.ts", [
    "// The route spells the subtree rule in SQL and the offline shell spells it in TypeScript;",
    "// one drifts silently and the sidebar count stops matching the list.",
  ]],
  ["tests/phase4-regressions.test.ts", [
    "// The curated hints stay, because they are what tells an operator what to fix.",
  ]],
  ["tests/platform-contract.test.ts", [
    "// Nothing else in this repository reads the deployment configs or the lockfile, so the",
    "// claims in SECURITY.md had no mechanical check at all. These assertions are that check.",
    "// The demo form is static assets only, so it must not grow a Worker entry point.",
    "// Postinstall code runs before any Worker policy applies, so the set is allow-listed.",
    "// Mirror-sourced `resolved` entries were normalised to the official registry once the",
    "// recorded hashes were confirmed identical there; new drift must be deliberate.",
    "// The sanitising chain decides what the browser is allowed to execute, so a floating range",
    "// means one `npm install` can swap the implementation with no gate going red.",
    "// the relaxation touches that one source expression and no other directive",
    "// opting in requires a Vite dev build *and* an HTML response, so /api/* stays strict",
    "// the provider/MCP edge responses build their own headers and never opt in",
  ]],
  ["tests/policy-single-source.test.ts", [
    "// A re-forked floor would reintroduce a hard-coded length comparison.",
  ]],
  ["tests/register-setup-token.test.ts", [
    "// The server has required this token since S-04, but the console never learned to send",
    "// it, so an operator who followed SECURITY.md could not create the first account.",
  ]],
  ["tests/rewrite-drain.test.ts", [
    "// Re-arm keeps the claim marker so one run cannot re-pick the row; clearing it",
    "// emulates the claim TTL expiring between cron rounds.",
  ]],
  ["tests/search-folder-scope.test.ts", [
    "// A parent_id cycle has to terminate rather than spin.",
    "// Control for the folder tests below: this query never reaches the folder clause, so the",
    "// same failure here means the defect is in the shared ORDER BY, not in folder scoping.",
  ]],
  ["tests/semantic-scan-window.test.ts", [
    "/** The query embedding the stub always returns; a match scores 1, everything else 0. */",
    "// The scan is newest-first, so index 500 of 1200 sits at row 700 of the window: reachable",
    "// now, invisible while the window was a fixed 200 rows.",
    "// A chunk of notes indexed inside the same millisecond shares indexed_at, so the page",
    "// boundary has to be resolved by note_id alone: no row may repeat, none may be skipped.",
  ]],
  ["tests/setup-token.test.ts", [
    "// Twelve guesses per ten minutes, then the fourteenth request is refused outright:",
    "// ordering this after the comparison left the zero-user window unthrottled.",
  ]],
  ["tests/tag-count-live-sync.test.ts", [
    "// `since <= 0` makes the route answer with a full snapshot, which always carries full facets.",
    "// Every delta assertion therefore needs a change row behind it to stay on the delta branch.",
    "// Fill the first page past syncBatchSize with tag rows (cheap to serve) plus one note row, so",
    "// the assertion is about the paging rule rather than about loading five hundred bodies.",
  ]],
  ["tests/throttle-lock-decay.test.ts", [
    "// The per-slug global work budget from shareVerifyThrottleTargets: 60 attempts per ten",
    "// minutes, punished with a fixed 60 second lock.",
    "// The 61st failure inside the window locks the shared slug key.",
    "// Without the restart, one request per minute kept the slug locked indefinitely:",
    "// a lock freezes last_fail_at, so the window never rolls over while traffic continues.",
    "// Work stays bounded, but the lock is no longer self-sustaining across four hours.",
  ]],
  ["tests/trash-purge-batch.test.ts", [
    "// Two notes share a title so the link can be retargeted before the trashed one disappears.",
  ]],
  ["vite.config.ts", [
    "// Keep optional preview renderers and their language modules behind dynamic-import boundaries.",
  ]],
])
const found = new Map()
const foundAll = new Map()
const failures = []
let approvedCount = 0
const roots = ['src', 'scripts', 'tests']
const files = [
  ...roots.filter((root) => fs.existsSync(root)).flatMap((root) => [...walk(path.resolve(root))]),
  ...['vite.config.ts', 'vitest.config.ts', 'index.html', 'wrangler.toml'].map((file) => path.resolve(file)),
]

for (const file of files) {
  const extension = path.extname(file).toLowerCase()
  const text = fs.readFileSync(file, 'utf8')
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) scanScript(file, text)
  else if (extension === '.css') scanCss(file, text)
  else if (extension === '.html' && /<!--[\s\S]*?-->/.test(text)) failures.push(`${relative(file)} contains an HTML comment`)
  else if (extension === '.toml' && /^[ \t]*#/m.test(text)) failures.push(`${relative(file)} contains a TOML comment`)
}

// The rebuild rewrites this gate’s own allowlist, so it has to be armed explicitly and
// cannot be reached by a plain flag; the summary makes the diff reviewable afterwards.
if (UPDATE) {
  if (!UPDATE_ARMED) {
    console.error(
      `--update rewrites the comment allowlist in scripts/check-comments.mjs itself.
Run it deliberately as: INKSTONE_COMMENTS_UPDATE=1 node scripts/check-comments.mjs --update`,
    )
    process.exit(1)
  }
  rebuildAllowlist()
} else {
  for (const [file, comments] of allowed) {
    approvedCount += comments.length
    const seen = found.get(file)
    for (const comment of comments) {
      if (!seen?.has(comment)) {
        failures.push(`${file} no longer contains an approved comment; remove it from the allowlist: ${preview(comment)}`)
      }
    }
  }
}

if (failures.length) {
  console.error(`comment policy check failed (${failures.length}):`)
  failures.forEach((failure) => console.error(`  ${failure}`))
  process.exit(1)
}

console.log(`comment policy check passed: ${approvedCount} approved English architecture notes across ${allowed.size} files and no other code comments`)

function scanScript(file, text) {
  const scriptKind = file.endsWith('.tsx') || file.endsWith('.jsx')
    ? ts.ScriptKind.TSX
    : file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind)
  const literalRanges = []
  collectLiterals(source)
  literalRanges.sort((left, right) => left.start - right.start)

  const comments = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g
  for (const match of text.matchAll(comments)) {
    if (!insideLiteral(match.index) && !RUNNER_DIRECTIVE.test(match[0])) check(file, match[0])
  }

  function collectLiterals(node) {
    if (
      ts.isRegularExpressionLiteral(node) ||
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) literalRanges.push({ start: node.getStart(source), end: node.getEnd() })
    ts.forEachChild(node, collectLiterals)
  }

  function insideLiteral(index) {
    return literalRanges.some((range) => index >= range.start && index < range.end)
  }
}

function scanCss(file, text) {
  let quote = null
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (char === '\\') index++
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end < 0) {
        failures.push(`${relative(file)} contains an unterminated CSS comment`)
        return
      }
      check(file, text.slice(index, end + 2))
      index = end + 1
    }
  }
}

function check(file, comment) {
  const name = relative(file)
  const all = foundAll.get(name) ?? new Set()
  all.add(comment)
  foundAll.set(name, all)
  if (!allowed.get(name)?.includes(comment)) {
    failures.push(`${name} contains an unapproved code comment: ${preview(comment)}`)
    return
  }
  const seen = found.get(name) ?? new Set()
  seen.add(comment)
  found.set(name, seen)
}

function preview(comment) {
  const flat = comment.replace(/\s+/g, ' ').trim()
  return flat.length > 96 ? `${flat.slice(0, 96)}...` : flat
}

function relative(file) {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(target)
    else yield target
  }
}

function rebuildAllowlist() {
  const names = [...new Set([...allowed.keys(), ...foundAll.keys()])].sort()
  const next = []
  for (const name of names) {
    const seen = foundAll.get(name)
    if (!seen) continue
    const old = allowed.get(name) ?? []
    const kept = old.filter((comment) => seen.has(comment))
    const added = [...seen].filter((comment) => !kept.includes(comment))
    const comments = [...kept, ...added]
    if (comments.length) next.push([name, comments])
  }
  let addedTotal = 0
  let staleTotal = 0
  for (const [name, comments] of next) {
    addedTotal += comments.length - (allowed.get(name)?.length ?? 0)
    staleTotal += (allowed.get(name)?.length ?? 0) - comments.filter((comment) => allowed.get(name)?.includes(comment)).length
  }
  const blocks = next.map(([name, comments]) =>
    `  [${JSON.stringify(name)}, [\n${comments.map((comment) => `    ${JSON.stringify(comment)},`).join('\n')}\n  ]],`)
  const scriptPath = path.resolve('scripts/check-comments.mjs')
  const source = fs.readFileSync(scriptPath, 'utf8')
  const start = source.indexOf(DECL_BLOCK)
  const end = source.indexOf(MAP_TAIL, start)
  if (start < 0 || end < 0) throw new Error('allowlist block markers not found')
  const head = start + DECL_BLOCK.length
  const updated = `${source.slice(0, head)}${blocks.join('\n')}${source.slice(end)}`
  fs.writeFileSync(scriptPath, updated)
  console.log(`comment allowlist rebuilt: ${next.reduce((total, [, comments]) => total + comments.length, 0)} approved comments across ${next.length} files`)
  console.log(`  net change: ${addedTotal >= 0 ? '+' : ''}${addedTotal} added, ${staleTotal} stale entries removed`)
  process.exit(0)
}
