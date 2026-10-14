# Contributing to Inkstone

Thank you for helping improve Inkstone.

## Before opening a change

- Search existing issues and pull requests to avoid duplicate work.
- Keep changes focused. Separate unrelated refactors from bug fixes or features.
- Preserve Markdown source compatibility, import and backup compatibility, strict HTML sanitization, offline writes, and mobile behavior.
- User-facing text must use an English message ID from both locale resources. Do not use Chinese text or full sentences as translation keys.
- Literal Chinese text in source files is allowed only in `src/shared/locales/zh-CN.ts`. Tests for Chinese behavior must use locale values or Unicode escapes.
- Code comments are reserved for necessary file-level architecture notes and must be written in English.

## Development setup

```bash
npm ci
npm run dev
```

The local application is available at `http://localhost:7712`. Wrangler stores local D1, R2, and Durable Object state under `.wrangler/state/`.

`npm run dev` omits the Workers AI binding so startup does not wait for a remote AI connection. The local Worker and MCP remain available, with keyword search instead of AI semantic search. Use `npm run dev:ai` to test real Workers AI (requires Cloudflare authentication and network access). Production builds keep the AI binding from `wrangler.toml`.

### Run the checks on the pinned Node version

`.nvmrc` pins the same version `package.json` declares in `engines` (`24.15.0`). Install it (`nvm install`, `fnm install --pin`, or `volta install node@24.15.0`) before running the gates.

The version is not a formality. From Node 22.4 the runtime defines its own lazy `localStorage` accessor on `globalThis`, and unless the process was started with `--localstorage-file` that accessor answers `undefined` instead of the implementation jsdom installs. Every test that touches stored state then fails for a reason that has nothing to do with the change under test: an unmodified checkout loses tens of files and hundreds of tests here, and one sampled file went from nine failures to none once the flag pointed the runtime at a file.

Where switching Node is not possible, give the runtime a throwaway file so the tests measure the code and not the environment:

```bash
NODE_OPTIONS="--localstorage-file=/tmp/inkstone-localstorage" npm run test:unit
```

```powershell
$env:NODE_OPTIONS = "--localstorage-file=$env:TEMP\inkstone-localstorage"; npm run test:unit
```

The file is a runtime artifact of your machine, not project output: keep it outside the working tree, as the paths above do, and remove it when you are done. Comparison between a run before your change and a run after it only means something when both used the same Node version and the same flag.

## Required checks

Run the relevant focused tests while developing, then run the complete release gates before opening a pull request:

```bash
npm run typecheck
npm run i18n:check
npm run comments:check
npm run test:unit
npm run build
```

Changes to Worker routes, persistence, synchronization, imports, exports, or backups should also run the isolated end-to-end suite described by `npm run test:e2e`.

## Releases

The root `package.json` is the only version source. The application imports its
`version` field at build time, and deployed instances compare that embedded
version with the official repository's `main` branch `package.json`. Set the
field to a stable SemVer value such as `0.2.0` only when that version is ready
to be announced to existing installations. Do not use a `v` prefix or a
prerelease identifier.

## Pull requests

Describe the user-visible outcome, important compatibility effects, security implications, and the exact checks you ran. Include screenshots for interface changes and explain narrow-screen behavior when layout is affected.

By contributing, you agree that your contribution is licensed under the repository's LGPL-3.0-only license.
