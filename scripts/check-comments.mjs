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
  ["src/client/editor/live-preview.ts", [
    "// Preserve the source line under the pointer, including rows inside tables/lists.",
    "/** Decorations change presentation only; all editing, undo, search and saving use Markdown. */",
    "// Keep typing synchronous and cheap. Reparse after a short idle window; never",
    "// display stale HTML for a block whose source was touched in the meantime.",
  ]],
  ["src/client/features/auth/LoginPage.tsx", [
    "// Only the OAuth consent page may be resumed after sign-in, so a crafted ?next",
    "// can never send the browser somewhere else with an authenticated session.",
  ]],
  ["src/client/features/graph/GraphPanel.tsx", [
    "// Private browsing or a locked-down browser can reject local preferences.",
    "// Physics-parameter tweaks resume the simulation without rebuilding nodes.",
    "// Draw-only toggles just need one repaint.",
  ]],
  ["src/client/features/preview/Lightbox.tsx", [
    "/* The lightbox reads the img IDL property, an absolute URL that never\n              passed the renderer’s protocol filter. */",
  ]],
  ["src/client/features/share/share-form.ts", [
    "// A new or replaced passcode must be at least 8 characters (the server",
    "// enforces the same minimum); short codes are trivially brute-forced.",
  ]],
  ["src/client/features/shell/AppShell.tsx", [
    "// Keep settings prewarming out of the boot + first-sync window.",
  ]],
  ["src/client/features/workspace/BacklinksPanel.tsx", [
    "// Debounced refresh on note revision changes; unrelated sync traffic",
    "// (cursor) no longer refetches, and stale links stay visible until the",
    "// fresh payload arrives.",
  ]],
  ["src/client/features/workspace/reading-position.ts", [
    "// Reading position is optional when browser storage is unavailable.",
  ]],
  ["src/client/lib/collator.ts", [
    "/** Cached Intl collator; constructing one per comparison dominates note-list sorting. */",
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
    "// The preview fills `[data-math]` and `[data-mermaid]` placeholders from enhance(),",
    "// which needs scripts; an exported or printed document has none, so both have to be",
    "// rendered here. `false` because the exported page is always the light scheme.",
  ]],
  ["src/client/lib/i18n.ts", [
    "/** Provides typed runtime localization with on-demand locale loading. */",
    "// Preload the other locale in background for instant switching, but don't block init",
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
  ]],
  ["src/client/store/notes.ts", [
    "/** Coordinates the note cache, offline write-ahead log, optimistic updates, and server synchronization. */",
    "// Keep the current document for fast reads; only slow reads need a loading page.",
    "// Loaded content keeps its revision until the full note arrives.",
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
  ]],
  ["src/shared/organizer-colors.ts", [
    "// Both the console and the MCP tools store icons truncated, so the limit lives",
    "// next to the colour list rather than at each call site.",
  ]],
  ["src/worker/attachments/references.ts", [
    "// Retained versions must remain restorable after unused attachments are pruned.",
    "// The instr() predicate discards rows that cannot contain an attachment URL",
    "// so full bodies only cross the wire for rows the regex will actually parse.",
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
  ["src/worker/db/rows.ts", [
    "/** Body + metadata without the per-row tag GROUP_CONCAT subquery. */",
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
  ]],
  ["src/worker/db/writes.ts", [
    "/** Keeps tags, backlinks, full-text indexes, and change records consistent with note writes. */",
    "/** Fan-out above this size is deferred to the background rewrite queue. */",
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
    "/**\n * Drains fan-out rewrites (note renames, tag renames/deletions) that were\n * deferred because they touched more notes than the inline budget allows.\n * Rows are claimed with a guarded DELETE ... RETURNING so overlapping cron\n * runs cannot double-process them.\n */",
    "// A rewrite still failing a day later needs an operator, not another cron slot.",
  ]],
  ["src/worker/lib/security-headers.ts", [
    "// The OAuth provider and the MCP handler answer their own responses, so the app",
    "// middleware never sees them and the headers have to be applied at the edge.",
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
    "/**\n * Processes queued embedding jobs. Called from the hourly cron with a large\n * budget and from write paths (via waitUntil) with a small one. Items are\n * processed sequentially so Workers AI rate limits are respected; a failing\n * item stops the batch and is retried on the next run.\n */",
    "// The account turned AI search off; its queue would otherwise grow forever.",
    "/**\n * Semantic retrieval over the account's embedding index. Returns null when\n * AI is unavailable or the query embedding fails; the caller degrades to\n * lexical search.\n */",
    "/**\n * Reciprocal-rank fusion: merges two ranked lists into one by rank, so a\n * note that ranks well in both lexical and semantic search surfaces above\n * one that only appears in a single index.\n */",
    "/** Calls the Workers AI embedding model and returns a Float32Array. */",
    "/** Handles both the `{ data: [{ embedding }] }` and `{ shape, data }` shapes. */",
    "/**\n * Drains a couple of queued embeddings right after a write so semantic\n * results stay fresh between cron runs. Never blocks the response.\n */",
    "/** Calls the Workers AI embedding model for many texts in one round trip. */",
    "/** Query embeddings repeat constantly across MCP calls; cache per isolate. */",
  ]],
  ["src/worker/mcp/api-keys.ts", [
    "/**\n * Static API keys for MCP access.\n *\n * Small or generic MCP clients (scripts, SDKs, unnamed agents) cannot run the\n * OAuth 2.1 dance, so they authenticate with a plain `Authorization: Bearer\n * <key>` header — the universal HTTP standard. The OAuth provider resolves\n * these tokens through its official `resolveExternalToken` hook; the key is\n * never stored or returned again, only its SHA-256 hash.\n */",
    "// 32 random bytes encoded as unpadded base64url is exactly 43 characters.",
    "/**\n * Resolves a bearer token to an account. Returns null for unknown, revoked,\n * or malformed keys so the OAuth provider can answer with 401 invalid_token.\n */",
  ]],
  ["src/worker/mcp/oauth.ts", [
    "// Static API keys let small or generic MCP clients authenticate with a",
    "// plain `Authorization: Bearer ink_...` header instead of running the",
    "// full OAuth 2.1 dance. Keys are hashed and revocable.",
    "// This path runs before the API handler, so ensure the schema exists",
    "// (cheap after the first request thanks to the initialization cache).",
  ]],
  ["src/worker/mcp/operations.ts", [
    "// The mutation itself failed before committing; remove the pending row",
    "// so the client can retry the same operation_id cleanly.",
    "// The mutation already committed. Keep the pending row so a retry goes",
    "// through the recovery path instead of re-executing and colliding",
    "// (e.g. create_note with the same id).",
  ]],
  ["src/worker/mcp/retrieval.ts", [
    "// AI unavailable, rate-limited, or malformed response: degrade to lexical.",
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
  ]],
  ["src/worker/routes/mcp-settings.ts", [
    "// Kick off the first batch immediately; the rest is drained by the cron.",
  ]],
  ["src/worker/routes/sync.ts", [
    "// A non-empty `after` key always means the caller is mid-way through a",
    "// full snapshot page chain; keep serving snapshot pages regardless of",
    "// `since`, so following the returned nextKey can never silently drop",
    "// remaining pages.",
    "// Never move the client's cursor backwards, even if it reported a",
    "// seq ahead of the server (e.g. data was trimmed).",
  ]],
  ["src/worker/routes/transfer.ts", [
    "// sha256/size were computed at persist time; re-downloading every matching",
    "// object to re-hash it doubles import transfer for no extra assurance.",
  ]],
  ["tests/export-hardening.test.ts", [
    "// Which stylesheet the frame gets is a build-time question (vitest stubs CSS), so",
    "// pin the import itself: the bundled copy, inlined, is the only source allowed here.",
    "// the SVG keeps its own styles, which is all the printed page needs to paint it",
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
  ["tests/phase4-regressions.test.ts", [
    "// The curated hints stay, because they are what tells an operator what to fix.",
    "// notes/tags tables are absent on purpose: every rewrite attempt must fail.",
    "// The retried row keeps its original age so it can eventually age out.",
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
  ]],
  ["tests/policy-single-source.test.ts", [
    "// A re-forked floor would reintroduce a hard-coded length comparison.",
  ]],
  ["tests/register-setup-token.test.ts", [
    "// The server has required this token since S-04, but the console never learned to send",
    "// it, so an operator who followed SECURITY.md could not create the first account.",
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
