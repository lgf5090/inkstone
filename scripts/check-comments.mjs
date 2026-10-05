import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const UPDATE = process.argv.includes('--update')
const RUNNER_DIRECTIVE = /^\/\/ @vitest-environment [\w-]+$/
const DECL_BLOCK = '\nconst allowed = new Map([\n'
const MAP_TAIL = '\n])\n'

const allowed = new Map([
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
  ["src/client/editor/commands.ts", [
    "// openFenceBeforeLine walks every earlier line, so it only runs for lines that are",
    "// themselves fence markers.",
  ]],
  ["src/client/editor/live-preview.ts", [
    "// Preserve the source line under the pointer, including rows inside tables/lists.",
    "/** Decorations change presentation only; all editing, undo, search and saving use Markdown. */",
    "// Keep typing synchronous and cheap. Reparse after a short idle window; never",
    "// display stale HTML for a block whose source was touched in the meantime.",
  ]],
  ["src/client/features/graph/GraphPanel.tsx", [
    "// Private browsing or a locked-down browser can reject local preferences.",
    "// Physics-parameter tweaks resume the simulation without rebuilding nodes.",
    "// Draw-only toggles just need one repaint.",
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
  ["src/client/lib/i18n.ts", [
    "/** Provides typed runtime localization with on-demand locale loading. */",
    "// Preload the other locale in background for instant switching, but don't block init",
  ]],
  ["src/client/lib/markdown/renderer.ts", [
    "/** Builds the sanitized Markdown rendering pipeline and its Inkstone-specific syntax extensions. */",
    "/** Parse once with the full document environment so reference links retain their targets. */",
    "// A line with neither marker cannot change state, so rebuild-by-character is pure",
    "// overhead. The inComment test must stay: inside an open %% block the loop below",
    "// blanks the line instead of copying it.",
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
    "/** Code point count without materialising `[...text]`, which costs one array slot per character. */",
    "// The CJK ranges are all BMP, so scanning UTF-16 units matches the per-code-point test",
    "// while surrogate pairs (which decode outside those ranges) stay uncounted either way.",
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
    "/**\n * Processes queued embedding jobs. Called from cron with a large budget and from\n * write/import paths (via waitUntil) with a small one. Items are processed in\n * chunks so one Workers AI call covers up to EMBED_CHUNK notes, and sequentially so\n * rate limits are respected. A chunk that fails is retried item by item, and items\n * that still fail are pushed to the back of the queue with a retry delay instead of\n * freezing the whole account.\n */",
    "// DRAIN_PER_USER keeps multi-account rounds fair, while a lone busy account may",
    "// spend the whole budget instead of leaving 92% of it unused.",
    "/**\n * Coalesces background embedding drains per account inside one isolate so a burst of\n * writes cannot queue several drains over the same head items.\n */",
    "/** Queues a couple of embeddings right after a note write. Never blocks the response. */",
    "// Nothing committed: the whole window was pushed back with a retry delay, so",
    "// re-reading it in this run would only repeat the same failure.",
    "/**\n * Keeps one failing note from freezing the account's queue: the row is re-armed with a\n * retry delay, and dropped after EMBED_MAX_ATTEMPTS so the head always advances. The\n * note keeps `created_at` as its identity guard so a newer edit is never penalised.\n */",
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
    "/** Chunk bounds for read_attachment, kept pure so the arithmetic is testable. */",
    "/** KV has no ranged get, so only that backend still pays for a full object read. */",
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
  ["src/worker/mcp/writes.ts", [
    "// The quota read rides along with hashing instead of adding a serial round trip.",
  ]],
  ["src/worker/routes/auth.ts", [
    "// Account-wide cap so a distributed botnet cannot retry one account",
    "// from many IPs forever; cleared on every successful sign-in, so a",
    "// normal user only ever notices it after 30 failed attempts per hour.",
    "// A successful sign-in proves this identity is legitimate: clear only the",
    "// identity-scoped throttling keys, never the shared per-IP buckets, or an",
    "// attacker with any low-value account could reset the per-IP failure",
    "// ceiling between bursts of password guessing.",
  ]],
  ["src/worker/routes/files.ts", [
    "/** 1 when a note change landed after `scanCursor`, i.e. the prune must hold off. */",
    "// One freshness probe per page replaces the NOT EXISTS subquery that used to run for",
    "// every attachment and every statement; a change landing mid-page only defers the",
    "// remaining rows to the next prune, which is what the guard already tolerated.",
  ]],
  ["src/worker/routes/mcp-settings.ts", [
    "// Kick off the first batch immediately; the rest is drained by the cron.",
  ]],
  ["src/worker/routes/notes.ts", [
    "// One lower() copy and one instr per row: SQLite does not share the repeated",
    "// lower(n.content) subexpression across the three references below.",
    "// Load and rewrite in small windows: a hub note referenced by thousands of others must",
    "// not hold every candidate body in the isolate at once.",
    "// The quota read rides along with hashing instead of adding a serial round trip.",
    "// A keyset page continues a listing the client already counted; re-counting scans every",
    "// visible row (up to LIMITS.notesMaxPerUser) again on each page turn.",
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
  ]],
  ["tests/ai-drain-queue.test.ts", [
    "// The batch call fails, then every item is retried on its own.",
    "// Clear the backoff and the item is attempted again, incrementing attempts.",
  ]],
  ["tests/doubles/d1-sqlite.ts", [
    "// node:sqlite happily runs a write through .all(), so the statement kind has to be",
    "// decided from the SQL text the way D1 does: reads return rows, writes return meta.",
    "// D1 runs a batch in one transaction: a later failing statement must not leave the",
    "// earlier writes applied.",
  ]],
  ["tests/fts-tenant-index.test.ts", [
    "// Mirrors the shipped schema: user_id must be an indexed FTS5 column so the",
    "// tenant phrase filter runs inside the inverted index, not as an UNINDEXED",
    "// post-scan.",
  ]],
  ["tests/markdown-text-hotpaths.test.ts", [
    "// Reference implementations kept from before the fast paths landed: these lock P2-01 /",
    "// P2-02 / P2-20 as behaviour-preserving. Code points are written numerically so ranges",
    "// cannot drift, and range boundaries are sampled on purpose.",
    "// CJK range boundaries: 2E80/9FFF and F900/FAFF are counted, neighbours are not.",
    "// A multi-line comment body carries no marker on its own lines, so those lines must",
    "// still be blanked by the inComment branch rather than passed through.",
  ]],
  ["tests/rewrite-drain.test.ts", [
    "// Re-arm keeps the claim marker so one run cannot re-pick the row; clearing it",
    "// emulates the claim TTL expiring between cron rounds.",
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

if (UPDATE) {
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
  process.exit(0)
}
