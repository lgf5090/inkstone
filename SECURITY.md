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
- **CSP.** `script-src 'self'` (no inline scripts) and `form-action 'self'`.
  If you add inline scripts to `index.html`, you must update the policy.
