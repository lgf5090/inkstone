# Security Policy

## Supported versions

Security fixes target the latest released version and the current default branch. Older revisions may require updating before a fix can be applied.

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Use the repository's **Security** tab to open a private security advisory and include:

- the affected version or commit;
- the attacker prerequisites and expected impact;
- reproducible steps or a minimal proof of concept;
- any suggested remediation;
- whether the issue affects existing data, backups, sessions, or new-device sign-in.

Please avoid accessing data that is not yours, degrading a production service, or publishing details before a fix is available. Acknowledgement and remediation timing depend on severity and reproducibility.

## Security boundaries

Inkstone is self-hosted software, not a hosted service. Deployment owners are responsible for their Cloudflare account, custom domains, access policies, backup destinations, and timely updates. Inkstone does not provide a password-reset bypass; losing the owner password requires restoring from a trusted backup or reinitializing the instance.


## Reviewed code-execution exception

`AGENTS.md` rule 1 forbids unreviewed `eval` / `new Function`. Inkstone has one
such call, and it is here on purpose rather than by oversight: a note's JavaScript
block is a feature, and the only way to run a reader's own snippet in their own
browser is to build a function from text (`src/client/features/preview/js-runner-core.ts`).

What the review concluded, and what the code actually does:

- **Where it runs.** In a dedicated Web Worker (`js-runner.worker.ts`,
  `lib/dataview/js.worker.ts`), not in the page. A worker has no `document` and
  no `window`, so a snippet cannot touch the DOM, the cookies, or the session
  cookie by construction — and `hardenWorkerScope` additionally removes the
  ways out of that thread that a worker *does* have: `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource`, `RTCPeerConnection`, `indexedDB`, `caches`,
  `importScripts`, `postMessage`, `close`, `Worker`, `SharedWorker`,
  `ServiceWorker`.
- **The shadowing is not the boundary.** Shadowed parameter names only cover
  direct references; `Function('return this')()` still hands back the real
  scope, so the same names are taken off that object too. That is why
  `hardenWorkerScope` exists and is exported: the parameter list is a
  convenience, the neutralised worker scope is the guard.
- **Nothing the snippet produces is ever read as markup.** The outcome is
  written with `textContent` (`js-runner.ts`), so the output cannot become HTML.
  The only `innerHTML` on that path builds the Run / line-numbers controls from
  escaped translated strings.
- **It does not run by itself.** A block shows a "click to execute" placeholder
  until the reader presses Run, so loading a note is not execution.
- **What it does not protect against, stated plainly.** This is not a defence
  against the author of the note: they can open developer tools and run the same
  code with more privileges. What it defends is the much more likely accident —
  a snippet reaching the network, the account's stored data, or the page, and a
  shared page executing its author's code in a visitor's browser with DOM access.
  A visitor of a public share can still choose to run the author's snippet and
  watch it compute inside their own neutralised worker; that is the residual, and
  it is the same residual as pasting unknown code into a console.

Any second `new Function` / `eval` / `dangerouslySetInnerHTML` path needs its own
entry here before it merges.

## Deployment security notes

- **Keep `global_fetch_strictly_public` enabled.** The Worker makes outbound
  requests to user-configured backup endpoints (S3/WebDAV), client-provided
  OAuth metadata (CIMD), and update checks. The hostname blocklist in
  `src/worker/backup/validation.ts` cannot see through attacker-controlled DNS
  answers; the compatibility flag is the hard boundary that blocks internal
  and cloud-metadata addresses. It is required in every wrangler config.
- **`SETUP_TOKEN` (optional secret).** When set, the very first registration on
  an empty instance must supply it (`wrangler secret put SETUP_TOKEN`), which
  closes the window where any visitor could claim ownership between deploy and
  first sign-up. It must be at least 16 characters; a shorter value makes
  registration fail rather than fall back to the claim-anyone path. Every
  registration attempt, including the ones this check stops, spends the per-IP
  registration budget, and a wrong token costs the same password-hashing work as
  a wrong password. The sign-in page shows a setup-token field once the server
  asks for one.
- **`DO_AUTH_KEY` (optional secret).** When set, every request from the Worker
  to the `SyncHub` and `CredentialVault` Durable Objects carries a matching
  `X-Inkstone-Internal` header and the objects reject anything else. This is
  defense-in-depth around the vault's decrypt capability. A blank value is
  reported as a misconfiguration (HTTP 500) instead of quietly leaving the
  guard off.
- **`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (optional secrets).** Web Push is
  signed with this pair. The private half is a JWK used only inside the Worker to
  sign one claim per send and is never returned by any endpoint; the public half is
  the base64url of an uncompressed P-256 point, which is what a browser puts in
  `PushManager.subscribe`. With either unset, the push endpoints answer that the
  server has no push keys instead of sending nothing or claiming a send. Set them
  with `wrangler secret put`, never in a tracked wrangler config.
- **Push subscriptions are credentials and stay in the account.** A row of
  `chat_push_subscriptions` (endpoint + `p256dh` + `auth`) is the ability to place a
  notification on one device. It is excluded from JSON/ZIP export, from the assistant
  backup and its import whitelist, from shares, and from log output: an endpoint
  reaches a stored error or a response preview only as its origin plus a short
  digest, including when the push service echoes the URL back. A restored machine
  re-subscribes; it does not inherit another's devices.
- **`AI_CONNECT_HOSTS` (optional var).** Comma-separated bare hostnames (optionally
  with a port) added to the CSP `connect-src` list. AI requests go from the
  reader's browser straight to the provider, so a host that is not listed here is
  silently blocked and the reader loses the feature. The five built-in provider
  presets are always allowed and cannot be removed by this variable; a reader who
  typed a custom `openai-compatible` endpoint needs their deployment to add that
  host. Entries that are not a bare hostname are dropped and reported on the
  Worker log rather than pasted into the policy.
- **Sessions.** A session lives 90 days with sliding renewal, hard-capped at 180
  days from creation. Changing the password or the TOTP state revokes other
  sessions *and* every MCP API key and OAuth grant on the account, so rotating
  your credentials cannot leave a static key behind. An account that never turned
  on the write or trash preference mints read-only keys. Plain-HTTP deployments receive non-`Secure` cookies by design
  (self-hosted LAN trade-off); prefer HTTPS.
- **Share links.** New or changed passcodes require at least 8 characters, whether
  they come from the console or from the `create_note_share` MCP tool.
  Passcode brute-forcing is throttled per client IP (escalating lock) plus a
  per-slug global work budget whose lock is capped at 60 seconds: an IP that is
  already locked is refused before it can spend the shared budget, and a lock that
  has been served clears that counter, so sustained probing cannot keep a slug
  locked indefinitely.
- **Pinned rendering chain.** `dompurify`, `mermaid`, `katex`, `markdown-it` and `prismjs`
  are held to exact versions, and every `resolved` entry in `package-lock.json` points at
  `registry.npmjs.org` with an integrity hash. `tests/platform-contract.test.ts` fails if
  either stops being true, so replacing the sanitiser cannot happen silently through a
  floating range.
- **Deployment shapes.** R2 mode deploys `inkstone`; KV mode deploys a separate
  `inkstone-kv` Worker, because deploying the KV config over an R2 Worker replaces
  its bindings. Neither shape serves version preview URLs.
- **MCP / OAuth.** `/authorize` requires PKCE (`S256`). The consent page
  shows the `client_id` host for unregistered Client ID Metadata Document
  clients and leaves the write scope unchecked by default. Grant and token
  revocation propagates through KV and can lag briefly (eventual consistency).
- **API keys.** Static MCP API keys never expire; revoke them manually from
  settings. Only their SHA-256 hash is stored.
- **Remote images in Markdown.** Rendered notes and shared pages may load
  externally hosted images, revealing visitor IP/user-agent to the image host.
  The response header is `Referrer-Policy: strict-origin-when-cross-origin`; the
  protection for rendered images is the `referrerpolicy="no-referrer"` attribute
  the client puts on every `<img>` it emits.
  Remove or proxy such embeds if your audience must stay anonymous to third
  parties.
- **Client IP for throttling.** Rate limits trust `CF-Connecting-IP`, which the
  Cloudflare edge injects and clients cannot spoof there. Behind any non-Cloudflare
  proxy all users collapse into one bucket; deploy on Cloudflare or accept
  shared-bucket throttling.
- **CSP.** `script-src 'self' https://static.cloudflareinsights.com` (no inline
  scripts) and `form-action 'self'`. The Insights host is named because a zone with
  Web Analytics switched on gets the beacon `<script>` appended to every HTML
  response by Cloudflare's own edge, and `connect-src` names
  `https://cloudflareinsights.com` for the report it posts when the injected config
  carries no version. If you add inline scripts to `index.html`, you must update the
  policy. The only exception is a development build (`npm run dev`), which adds
  `'unsafe-inline'` to `script-src` for the HTML document so Vite's React refresh
  bootstrap can run; the flag folds to `false` in every deployed bundle, and API
  responses stay strict.
- **Memos app.** Memo share links and personal access tokens are stored only as
  SHA-256 hashes; a shared file is reachable only with a valid token for that memo.
  Public files use a short revalidating cache (`max-age=60, must-revalidate`) so a
  memo that becomes private is not kept alive by an immutable browser cache. Link
  previews are fetched through the shared outbound guard (no private hosts, no
  redirects, bounded time and bytes) and spend a per-user hourly budget. Webhooks
  must use HTTPS, are signed with a per-hook secret encrypted by the credential
  vault, and are delivered without redirects; the target URL is shown to its owner
  but never logged with the signed payload. Personal access tokens carry the
  account's full memo scope (as in the reference app); create them only for trusted
  clients and revoke them when no longer needed.
