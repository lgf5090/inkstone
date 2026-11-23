# Local Univer collaboration service

Univer's history panel, realtime sessions and conflict resolution come from one collaboration core. This
directory stands that core up for local development so the Office tab can offer the official surfaces.

```bash
cd services/univer-collab
npm install --registry=https://registry.npmjs.org
npm start   # http://127.0.0.1:3090
```

## What it provides

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness for scripts and the app's diagnostics. |
| `POST /inkstone/seed` | Adopt a document the app already has: `{ unitId, type, name?, snapshot?, userId? }`. Idempotent — a unit that exists answers `created: false`. |
| `POST /universer-api/authz/-/object/-/batch_allowed` | The authorization probe the client sends before reading. Grants the local reader everything; a deployment must replace it with the app's own permissions. |
| `*` (transport) | Snapshot reads, changeset submission, the WebSocket session and the history routes are served by `UniverCollabEndpoint` via `transport.attach`. |

The memory adapter keeps documents in this process only. The app's own R2 revisions (`office_file_version`)
remain the file of record; this service is the collaboration origin, not a second store.

## Identity

`transport.use` reads `x-inkstone-user` and falls back to `local-reader`. The app's worker is expected to
proxy these requests and stamp that header from the session it already verified — the dev service trusts
it, which is exactly the boundary a real deployment replaces with its own middleware.

## License

The Collaboration SDK runs on the free tier without a license (single node, localhost). Set
`UNIVER_LICENSE` before `npm start` for a licensed node; the same license string is what the Office
settings page accepts for the browser side.

## Not done yet

The browser side still loads documents from the app's own snapshot API. Pointing the editors at this
service is the remaining step: seed the unit from `GET /api/office/files/:id/snapshot` on first open,
then register `UniverCollaborationClientPlugin` + `UniverCollaborationClientUIPlugin` +
`UniverEditHistoryPlugin` + `UniverSheetsHistoryPlugin` + `UniverSheetsHistoryUIPlugin({ univerContainerId })`
and let the collaboration service own revisioning. Until that lands, the app's own version dialog is the
only history surface.
