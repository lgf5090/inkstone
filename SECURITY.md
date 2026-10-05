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
  first sign-up.
- **`DO_AUTH_KEY` (optional secret).** When set, every request from the Worker
  to the `SyncHub` and `CredentialVault` Durable Objects carries a matching
  `X-Inkstone-Internal` header and the objects reject anything else. This is
  defense-in-depth around the vault's decrypt capability.
- **Sessions.** A session lives 90 days with sliding renewal, hard-capped at 180
  days from creation. Changing the password or TOTP state revokes other
  sessions. Plain-HTTP deployments receive non-`Secure` cookies by design
  (self-hosted LAN trade-off); prefer HTTPS.
- **Share links.** New or changed passcodes require at least 8 characters.
  Passcode brute-forcing is throttled per client IP (escalating lock) plus a
  per-slug global work budget whose lock is capped at 60 seconds so a third
  party cannot lock out legitimate readers for long.
- **MCP / OAuth.** `/authorize` requires PKCE (`S256`). The consent page
  shows the `client_id` host for unregistered Client ID Metadata Document
  clients and leaves the write scope unchecked by default. Grant and token
  revocation propagates through KV and can lag briefly (eventual consistency).
- **API keys.** Static MCP API keys never expire; revoke them manually from
  settings. Only their SHA-256 hash is stored.
- **Remote images in Markdown.** Rendered notes and shared pages may load
  externally hosted images, revealing visitor IP/user-agent to the image host
  (the app already sends `Referrer-Policy: no-referrer` on rendered images).
  Remove or proxy such embeds if your audience must stay anonymous to third
  parties.
- **Client IP for throttling.** Rate limits trust `CF-Connecting-IP`, which the
  Cloudflare edge injects and clients cannot spoof there. Behind any non-Cloudflare
  proxy all users collapse into one bucket; deploy on Cloudflare or accept
  shared-bucket throttling.
- **CSP.** `script-src 'self'` (no inline scripts) and `form-action 'self'`.
  If you add inline scripts to `index.html`, you must update the policy.
