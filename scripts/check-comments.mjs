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
    "// Typing the markers opens the note list through activateOnTyping, but the toolbar had no",
    "// way to ask for it: an inserted `[[]]` left the caret in an empty pair with no popup.",
    "// The toolbar button still holds focus at this point and autocompletion runs with",
    "// closeOnBlur, so the view has to be focused first or the popup is dismissed at once.",
    "// The dropdown that held the button is still closing and reclaims focus after this",
    "// command returns, so the popup has to be started one task later or it is dismissed",
    "// straight away by closeOnBlur.",
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
  ["src/client/features/graph/GraphPanel.tsx", [
    "// Private browsing or a locked-down browser can reject local preferences.",
    "// Physics-parameter tweaks resume the simulation without rebuilding nodes.",
    "// Draw-only toggles just need one repaint.",
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
  ["src/client/features/preview/Lightbox.tsx", [
    "/* The lightbox reads the img IDL property, an absolute URL that never\n              passed the renderer’s protocol filter. */",
  ]],
  ["src/client/features/preview/Outline.tsx", [
    "// One pass per layout change instead of one querySelector + one layout read per",
    "// heading per frame: 1428 headings used to cost ~43k DOM queries a second while scrolling.",
    "// Heads are in document order, so the active one is the last entry at or above top.",
  ]],
  ["src/client/features/preview/markdown-tabs.ts", [
    "// A nested group numbers its own panels from zero, so an outer click that reached inside",
    "// would relabel the inner buttons and hide the panel the inner group has selected.",
    "/** Opens every collapsed block and selects every tab panel the target sits inside. */",
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
  ["src/client/features/tags/tagMutations.ts", [
    "// The delta carries every note the server-side rewrite touched, and pull() falls back",
    "// to a full snapshot on its own when the server says the cursor is stale.",
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
  ["src/client/lib/markdown/embeds.ts", [
    "/**\n * Embed bodies live in the note store, but every debounced preview re-ran the full render\n * pipeline (parse + markdown-it + sanitize) per embed, and the per-call fetch cache made two\n * panes embedding the same note ask the network twice. Both caches are exact: a key is only\n * reused while the markdown it was built from is still identical.\n */",
  ]],
  ["src/client/lib/markdown/enhance.test.ts", [
    "// The second pass used to swap the shared config for its own, which re-allowed the",
    "// form controls and attributes the renderer deliberately forbids.",
  ]],
  ["src/client/lib/markdown/enhance.ts", [
    "// Layered on the shared config so its forbidden tag and attribute lists keep applying.",
    "// style is the only exception: mermaid paints SVG with inline styles and CSS blocks,",
    "// and DOMPurify sanitises the declarations themselves.",
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
    "// `folders` only takes part in the folder view; without this the whole list re-derives",
    "// whenever a folder is renamed, reordered or created.",
  ]],
  ["src/client/store/pwa.ts", [
    "// Reset the flag once the toast is gone, so a later installed worker can",
    "// notify again instead of being permanently suppressed.",
  ]],
  ["src/client/store/session.ts", [
    "// Push unsaved offline edits before clearing local data, otherwise",
    "// they would be silently dropped. Dynamic import keeps the session",
    "// store free of a circular dependency on the notes store.",
  ]],
  ["src/client/store/ui.ts", [
    "// The subscriber fires on every notification, including the ones that change nothing",
    "// persisted (toasts, selection). Serializing 22 keys per keystroke cost more than the",
    "// localStorage write the 220 ms debounce already coalesces, so serialization waits too.",
  ]],
  ["src/client/styles/editor.css", [
    "/* Live preview shares the preview typography without nesting scroll containers. */",
  ]],
  ["src/client/styles/tokens.css", [
    "/* Small labels are used on both the editor and the darker sunken sidebar. */",
  ]],
  ["src/shared/constants.ts", [
    "// D1 limits an entire row to 2,000,000 bytes; reserve room for note metadata.",
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
  ]],
  ["src/shared/organizer-colors.ts", [
    "// Both the console and the MCP tools store icons truncated, so the limit lives",
    "// next to the colour list rather than at each call site.",
  ]],
  ["src/shared/text-utils.ts", [
    "/**\n * UTF-8 byte length without allocating an encoded copy (note bodies reach 1.9 MB and\n * this runs on every write). Lone surrogates count as 3 bytes, matching TextEncoder's\n * U+FFFD replacement.\n */",
  ]],
  ["src/shared/types.ts", [
    "/** Only computed on the first page of a listing; later keyset pages return null. */",
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
  ]],
  ["src/worker/routes/tags.ts", [
    "// Load and rewrite in small windows: a hub tag must not pin every candidate body in",
    "// the isolate before the first write happens.",
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
