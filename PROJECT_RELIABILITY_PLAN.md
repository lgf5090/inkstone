# Project App Reliability Plan

- Baseline: `7592a935aa9777a3d765e9ffcf0ef8d2fdeb467b`
- Branch: `fix/project-app-reliability`
- Worktree: `E:\projects\cloudflare\inkstone-project-reliability`
- Rule: one atomic task per commit; update this file in the same commit; no WIP commits.
- Status: `pending` | `in_progress` | `done` | `blocked`

## P0 Security and platform limits

| ID | Status | Task | Acceptance | Commit |
|---|---|---|---|---|
| P0-01 | done | F1 unify field visibility across card APIs, properties, search, rollup, move, exports and AI tools | viewer/editor/admin HTTP + AI + export tests; hidden values never leave server | b2e6bc67 |
| P0-02 | done | F2 move idempotency replay after resource authorization; bind method/path/body hash; claim concurrent keys | revoked member replay fails; same key different request conflicts; concurrent key creates once | ee99b54f |
| P0-03 | done | F3 enforce board token scope on body targets; narrow account-wide token scopes | board token cannot move/link across boards; high-risk routes session-only | 59e9c3c2 |
| P0-04 | done | F4 chunk every dynamic IN query to D1's 100-binding limit | 101/200/500 id requests paginate or reject cleanly, never 500 | ddc509d0 |
| P0-05 | done | F8 fail incomplete archive exports; support complete or explicit multipart export | truncated contents/comments/files produce explicit error or complete archive | 16079bfd |
| P0-06 | done | F9 reject parent cycles in archive import and hierarchy writes | cyclic archive/batch returns 400; no unbounded traversal | 84a2c46f |
| P0-07 | done | F13 scope property relation deletion by board; version property patches; enforce property cap | deleting a copied property never affects source board; stale patch conflicts | c32790aa |
| P0-08 | done | F20 distinguish unchanged/set/remove share password; show protection state | empty save keeps password; explicit remove clears it; expiry UI works | 0897b0be |

## P1 Data integrity and core correctness

| ID | Status | Task | Acceptance | Commit |
|---|---|---|---|---|
| P1-01 | done | F5 mint idempotency key before first write; retry 429 with Retry-After; sequence outbox; isolate 5xx | lost response does not duplicate; FIFO; one failure does not block shared queue | 7f45b0c4 |
| P1-02 | done | F6 make move/copy/import/attachment delete recoverable and atomic | injected mid-batch/R2 failures leave no visible half-state or orphan bytes | 40e9aa47 |
| P1-03 | done | F7 remap property config/formula/relation/permissions on move; rebuild copied relations; enforce quotas | moved/copy cards retain config and relation edges; target caps enforced | 30ef877f |
| P1-04 | done | F10 make cross-category drag move and reorder atomically | source board appears only in target category at requested position | dd2a4c7b |
| P1-05 | done | F11 make board/list drag one command; fix expanded subtask index | failed drag rolls back; expanded list drop lands on intended root | 9baaec50 |
| P1-06 | done | F12 re-check role/field permission for Todo sync, notifications and trash attachments | viewer cannot mutate via Todo; private/trash data not delivered | 4046cc94 |
| P1-07 | done | F14 preserve relation edges on soft delete; prevent same-batch parent cycles; validate Sprint ownership | restore rebuilds references; A→B/B→A rejected; wrong Sprint card rejected | f85d8e79 |
| P1-08 | done | F15 validate imported schema and rewrite actor/author ids | unknown property/type/oversized metadata rejected; importer is author | 473881c3 |
| P1-09 | done | F16 materialize reminders and create real notifications; filter notified/deleted/archived rows | due reminder arrives once; later cards are not starved | 74409397 |
| P1-10 | done | F17 add explicit status categories; make recurrence generation idempotent | Incomplete/Not done/待完成 are not done; each instance spawns once | 7a11b8785 |
| P1-11 | done | F18 formula display values, dependency order and visible errors; enable formula/multiPerson/file creation | formulas match UI semantics; errors visible; new types creatable | 50f077744 |
| P1-12 | done | F19 unify date timezone/range/DST semantics; preserve includeTime/timeZone on drag | same-day filters match; inclusive end; DST has no duplicate/missing day | 48b34a160 |
| P1-13 | done | F21 fix Gantt Delete/person lanes, table subtasks and author swimlanes | dialog keypress does not mutate; person cards render; filtered children do not leak | 4347672d9 |
| P1-14 | done | F22 make text blocks editable; automation UI uses property/option selectors; public views avoid member APIs | edit persists; no internal id typing; public dashboard/sprint/collection render | 14f24ed44 |
| P1-15 | done | F23 route automation writes through permission/relation/effect pipeline and return fresh card | automation cannot bypass editRoles; response includes automation result | 3c37bca54 |
| P1-16 | done | F24 serialize content_order; unique running timer; uncapped time totals | concurrent edits preserve order; double start rejected; totals include all entries | 4a7f57885 |
| P1-17 | done | F25 cap search pattern to production-safe bytes and add regression coverage | >50-byte query is safely truncated/rejected before D1 | 04fb59372 |
| P1-18 | done | F26 webhook claim/lease, stable delivery id, cleanup and secret encryption | concurrent drain sends once; retries dedupe; old rows pruned; export hides usable secret | c07a60ce0 |

## P2 Product completeness, performance and UX

| ID | Status | Task | Acceptance | Commit |
|---|---|---|---|---|
| P2-01 | done | F27 paginate/on-demand bundle; FTS search; indexed reminders; streaming/multipart export | 5000-card board stays within response/time/memory budgets | - |
| P2-01a | done | F27 reminder pending index and bounded starvation-free sweep | pending reminders use partial index; oversized subscriber groups do not block later cards | 5f2da1e91 |
| P2-01b | done | F27 project FTS index and tokenized search | title/content/comment/property search uses FTS and preserves field visibility | 37257187c |
| P2-01c | done | F27 keyset bundle pagination and on-demand card loading | initial bundle is bounded; deep links and older pages load without stale overwrite | 321cfc7db |
| P2-01d | done | F27 bounded streaming or multipart export | large exports avoid whole-ZIP memory and never return truncated success | f1605a0da |
| P2-02 | done | F28 lazy views; virtualize board/list/gallery; stabilize derived props | large board interaction remains responsive; bundle size reduced | 0376c45db, 75f6bbf9 |
| P2-02a | done | F28 lazy view chunks and stable chart/sidebar derived data | inactive views are split into chunks; chart/sidebar avoid needless rebuilds | 0376c45db |
| P2-02b | done | F28 virtualize large board, list and gallery surfaces | rendered card count stays bounded while scrolling, keyboard and drag still work | 75f6bbf9 |
| P2-03 | done | F29 route all refreshes through one stale-response queue | delayed old response never overwrites newer local patch | b46e61fdd |
| P2-04 | done | F30 clear hidden selections; refresh today; correct dashboard in-progress KPI | no invisible batch delete; midnight correct; KPI matches definition | c3153d1a0 |
| P2-05 | done | F31 recent-opened semantics, unique DOM ids, keyboard order and list metadata | sidebar has no duplicate ids; list shows count/update/category | f14529b54 |
| P2-06 | done | F32 scope subscription cache by account; revalidate public share owner/archive state | account switch cannot leak watch state; archived/private share inaccessible | bdbb5afc2 |
| P2-07 | done | F33 explicit loading/error/empty states and retry for silent catches | failed reads never masquerade as empty/no-access | cc5aa9c28 |
| P2-08 | done | F34 reliable undo/redo and keyboard error handling | failed undo restores stack; dialog edits and drag order undo correctly | 8f8e210e4 |
| P2-09 | done | F35 keyboard equivalents for drag; pointercancel/unmount cleanup | Tab/arrow/Enter reorder works; cancelled pointer never mutates | 1d26ce4e8 |
| P2-10 | done | F36 readable CSV values and spreadsheet-safe escaping | labels/ISO dates exported; formula payloads neutralized | 5ac0b42b2 |
| P2-11 | done | F37 reject unknown property ids and redact invisible backreferences | unknown id 400; invisible references expose no ids | 525aca436 |
| P2-12 | done | F38 remove dead code, centralize API/network access, split giant components, i18n/style cleanup | gates pass; no unused public helpers; responsibilities separated | e6b12170d, 1a1603f23 |
| P2-12a | done | F38 dead exports, shared request, localized notices, user-row layering and static style cleanup | verified unused code removed; no project data-to-middleware import; notices follow recipient locale | e6b12170d |
| P2-12b | done | F38 split CardDialog sections and BoardPage paging state | dialog sections and pagination orchestration have separate modules without behavior change | 1a1603f23 |
| P2-13 | done | Add editable Markdown card body and editable/assignable checklist | card description edits persist with Markdown preview | 08ede20cb |
| P2-14 | done | Add personal views/filters without mutating shared view | viewer can personalize; shared filter unchanged | 79d92f2ba |
| P2-15 | done | Add offline board read cache and conflict indicators | offline opens cached board; reconnect shows conflicts | 6c0648abb |
| P2-16 | done | Add presence, comment realtime, field-level audit and version restore | collaborators see presence; audit answers who/what/when; restore works | 9bb380c2d, ff62e2e00, 075fbc5c5 |
| P2-16a | done | Add board presence and realtime comment convergence | online members render; remote comments appear in an open card without reload | 9bb380c2d |
| P2-16b | done | Add field-level activity audit with sensitive-field exclusion | activity explains who changed which field from what to what; passwords never persist | ff62e2e00 |
| P2-16c | done | Add card/content version history and restore | old card fields and content restore atomically while newer comments remain | 075fbc5c5 |
| P2-17 | done | Add form intake and restricted editable guests | public form creates card; guest cannot exceed scope | 2e0d7db23, 0cd16af2f |
| P2-17a | done | Add anonymous public form intake with configured fields | public form creates a card with idempotency, throttling and share revalidation | 2e0d7db23 |
| P2-17b | done | Add per-submission restricted guest editing | guest capability edits only its card and granted fields; audit values stay redacted | 0cd16af2f |
| P2-18 | done | Add workload/capacity, estimates and time reports | cross-board capacity and estimate-vs-actual visible | 57e8ebc21 |
| P2-19 | done | Add note↔card links, embedded board views and AI meeting-note card generation | bidirectional references and generated cards work | 18896095d |
| P2-20 | done | Add native Slack/GitHub/Jira integrations and two-way calendar sync | vault-backed Slack/GitHub/Jira flows and two-way calendar sync verified | f511f9354, 50daccfa7 |
| P2-20a | done | Add two-way project card and calendar event sync | card date/title updates event; event updates card date; delete clears it | f511f9354 |
| P2-20b | done | Add Slack notifications and GitHub/Jira issue links | credentials stay in vault; issue create/update is scoped, concurrency-safe and never queued offline | 50daccfa7 |

## Verification gates

| ID | Status | Task | Acceptance | Commit |
|---|---|---|---|---|
| V-01 | pending | Focused project tests and typecheck | all related tests and tsc pass | - |
| V-02 | pending | i18n/comments/hooks/a11y gates | all static gates pass | - |
| V-03 | pending | Full build | build:types + vite + runtime pass | - |
| V-04 | pending | External browser golden paths | create board/card, edit, views, drag, share, permissions, offline, dates verified with screenshots/logs | - |
| V-05 | pending | Failure/concurrency drills | lost response, revoked member, D1 limits, mid-batch failure, webhook race verified | - |
| V-06 | pending | Final plan reconciliation | every row done or explicitly blocked with reason; no hidden pending work | - |

## Progress log

- 2026-11-25: worktree and baseline plan created.
- 2026-11-25: P0-01 completed in `b2e6bc67`; 19 focused tests passed, 10 downstream files exercised (the 4 card-contract failures were fixed and its 9 tests rerun green), Worker/test typecheck, ESLint and four static gates passed.
- 2026-11-25: P0-02 completed in `ee99b54f`; request-bound receipts, resource reauthorization, pending claims and stale-claim recovery covered by 25 passing tests.
- 2026-11-25: P0-03 completed in `59e9c3c2`; board-token cross-board move/relation and account-token high-risk routes covered by 25 passing tests.
- 2026-11-25: P0-04 completed in `ddc509d0`; 101-id batch, 101-task date lookup and 101-card subtree move pass under a D1 double enforcing 100 bindings.
- 2026-11-25: P0-05 completed in `16079bfd`; truncated bundles, missing attachment bytes and ZIP/file-size budget overruns now fail explicitly.
- 2026-11-25: P0-06 completed in `84a2c46f`; archive and same-batch parent cycles are rejected, and legacy cyclic subtrees cannot loop during move.
- 2026-11-25: P0-07 completed in `c32790aa`; property relation deletion is board-scoped, stale property revisions conflict, and accumulated property count is capped.
- 2026-11-25: P0-08 completed in `0897b0be`; empty password save is inert, removal is explicit and confirmed, and share expiry is editable.
- 2026-11-25: P1-01 completed in `7f45b0c4`; first write and replay share an idempotency key, 429/5xx retry without stopping the shared queue, and queue timestamps are monotonic.
- 2026-11-25: P1-02 completed in `40e9aa47`; oversized multi-step writes reject before mutation, relation edges commit with copies/imports, account import rolls back earlier boards, and attachment deletion leaves retryable cleanup rows.
- 2026-11-25: P1-03 completed in `30ef877f`; moved properties remap formula/relation/rollup/permission config, copied cards rebuild relation edges, quotas are enforced, and time/sprint/source cursor follow the move.
- 2026-11-25: P1-04 completed in `dd2a4c7b`; category reorder now atomically moves cross-category boards and validates board visibility.
- 2026-11-25: P1-05 completed in `9baaec50`; board/list drag commits card values and manual order in one batch, and child rows no longer distort list drop indices.
- 2026-11-25: P1-06 completed in `4046cc94`; Todo sync rechecks editor/field permissions, notifications recheck current board access, and trashed card attachments are hidden from non-admins.
- 2026-11-25: P1-07 completed in `f85d8e79`; soft delete preserves relation edges, restore rebuilds every related board, deleted parents hide content/comments, and Sprint unbind validates membership.
- 2026-11-27: P2-11 completed in `525aca436`; unknown property IDs and oversized value maps are rejected before mutation, batch limits retain priority, and backreferences hidden by board or field permissions expose no IDs or titles; 321 project tests, forced typechecks, static gates and production build passed.
- 2026-11-27: P2-05 completed in `f14529b54`; recents now follow per-account opens, search renders one ordered list with unique IDs and one active board marker, and board rows/tiles show count, update date and viewer folder; 671 related tests, typechecks, static gates, production build and headed Chrome verification passed.
- 2026-11-27: P2-07 completed in `cc5aa9c28`; project reads now distinguish loading, failure, empty and no-access with retry, stale responses are discarded across slug/board/account changes, and failed attachment/rollup/watch reads no longer corrupt visible state; 697 related tests, typechecks, static gates and production build passed, with headed Chrome confirming share failure/retry and automation failure rendering.
- 2026-11-27: P2-08 completed in `8f8e210e4`; undo/redo is serialized and retryable, card/dialog/drag/property/view edits register inverse commands, stale board writes are isolated, and full content-order patches reindex positions; 710 related tests plus the added-view redo case, typechecks, static gates, production build and headed Chrome undo/redo verification passed.
- 2026-11-27: P2-09 completed in `1d26ce4e8`; card/column/sidebar/content grips support Enter/arrow keyboard sorting, pointer sessions cancel on pointercancel/Escape and dispose silently on unmount, and Gantt keyboard date changes accumulate through a serialized queue; 723 related tests, typechecks, static gates, production build and headed Chrome keyboard-drag verification passed.
- 2026-11-27: P2-01a completed in `5f2da1e91`; pending reminders gained a partial index and the sweep now pages with a due/card/property cursor while skipping oversized subscriber groups; 324 project tests, typechecks, static gates and production build passed.
- 2026-11-27: P2-01b completed in `37257187c`; project title/content/comment/value documents are maintained in FTS5 with a migration backfill, token-prefix search and runtime field visibility filtering; 327 project tests, typechecks, static gates and production build passed.
- 2026-11-27: P2-01c completed in `321cfc7db`; interactive bundles now load 200-card keyset pages, page reads scope values/details/relations, single-card deep links reuse formula/rollup/redaction, and refresh replays loaded cursors through one queue; 727 related tests, forced typechecks, static gates and production build passed, with headed Chrome confirming 200/205 → 205, refresh replay and a page-external card opening at 201/205.
- 2026-11-27: P2-01d completed in `f1605a0da`; archives stream attachment bytes through fflate into bounded R2 multipart parts, publish only after complete, clean up failed/cancelled uploads, record actual file sizes, and cap the no-R2 memory fallback at 4MiB; 29 focused archive tests, static gates, production build and headed-Chrome ZIP download passed.
- 2026-11-27: P2-02a completed in `0376c45db`; all 11 project views load as separate chunks behind an accessible Suspense state, chart labels/values and sidebar lookups keep stable references; 734 project tests, production/test typechecks, static gates and production build passed, with headed Chrome opening every view and the build emitting separate Kanban/Table/Gallery/List/Chart chunks.
- 2026-11-27: P2-02b completed in `75f6bbf9`; large Kanban columns, list rows and gallery rows render only the measured window while full geometry preserves pointer/keyboard ordering, per-column auto-scroll, padding and tail drop space; 738 project tests, production/test typechecks, static gates and build passed, with headed Chrome showing 16–30 rendered cards out of 200/205, working tail scrolling, size changes, same/cross-column pointer drag and isolated auto-scroll.
- 2026-11-27: P2-12a completed in `e6b12170d`; removed eight zero-reference exports, routed collection previews through the shared request client, localized project notices by recipient language, moved user-row conversion below middleware, and replaced the remaining static subtask padding with a utility class; 763 project/auth tests, worker-layering tests, typechecks, static gates and build passed, with headed Chrome confirming the centralized text preview.
- 2026-11-27: P2-12b completed in `1a1603f23`; CardDialog now composes dedicated comment/attachment/dependency/subtask sections, and BoardPage delegates bundle paging, refresh serialization and deep-link races to useBoardSession; 739 project tests, typechecks, static gates and build passed, with headed Chrome confirming all dialog sections, comment posting, 205-card pagination and a page-external deep link.
- 2026-11-27: P2-13 completed in `08ede20cb`; card text blocks render editable Markdown, checklist items persist title/assignee/UTC due date with undo, and single/batch writes share member validation; 744 project tests, typechecks, static gates and build passed, with headed Chrome confirming Markdown emphasis, assignment metadata and date persistence across reload.
- 2026-11-27: P2-14 completed in `79d92f2ba`; account settings now persist per-board/view filter, sort, grouping, density and layout overrides without patching shared views, with byte budgets, deep debounce merging, public-share disabling and viewer-safe controls; 761 project/settings tests, typechecks, static gates and build passed, with headed Chrome confirming personal filter persistence and an unchanged shared filter.
- 2026-11-27: P2-15 completed in `6c0648abb`; account-scoped board snapshots hydrate before refresh, cache loaded pages and deep links, fall back read-only on offline failures, reject stale snapshots and retain 409/412 writes for explicit conflict resolution; 757 project/cache tests, typechecks, static gates and build passed, with headed Chrome confirming API-blocked cache mode, reconnect recovery and the conflict dialog.
- 2026-11-27: P2-16a completed in `9bb380c2d`; board writes emit validated entity-level realtime events through the existing per-user hub, open cards converge remote comments, and a 45-second presence heartbeat renders online members without polluting board activity; 347 project tests, source/test typechecks, static gates, ESLint and production build passed, with headed Chrome confirming the presence indicator and a cross-tab WebSocket comment update in `tmp/project-collaboration.png`.
- 2026-11-27: P2-16b completed in `ff62e2e00`; successful writes capture before/after entity snapshots and append bounded field-level audit rows for cards, comments, contents, views, boards and batches, while allowlisted fields exclude passwords, tokens and secrets; 350 project tests plus 36 final focused tests, source/test typechecks, static gates, ESLint and production build passed, with headed Chrome showing `title: Collaboration card → Audited card` in the activity dialog (`tmp/project-activity-audit.png`).
- 2026-11-27: P2-16c completed in `075fbc5c5`; authorized card/content writes keep up to 50 bounded snapshots per card, and restore atomically rewrites card fields, property values and content blocks while preserving newer comments and rejecting stale `expectedUpdateAt` writes; 352 project tests, source/test typechecks, static gates, ESLint and production build passed, with headed Chrome selecting an older version, confirming restore, and verifying `Audited card` plus `Version body` with all 3 comments retained (`tmp/project-version-history.png`).
- 2026-11-27: P2-17a completed in `2e0d7db23`; owners can enable a public intake form with allowlisted fields and required markers, anonymous submissions use per-share idempotency receipts plus independent write throttles, and every create/replay rechecks passcode, expiry, archive and revocation before advancing the board cursor, audit, realtime and `card.created` webhook; 355 project tests plus 14 final UI/server tests, source/test typechecks, static gates, ESLint and production build passed, with headed Chrome submitting `Browser intake` through the public form (`tmp/project-public-intake.png`).
- 2026-11-27: P2-17b completed in `0cd16af2f`; each editable submission receives a one-time fragment-based edit capability stored only as a SHA-256 hash, and guest open/patch routes revalidate share state, grant expiry, card ownership, field allowlist and `expectedUpdateAt` while recording redacted field audit entries; 358 project tests plus 17 final schema/intake tests and 11 share UI tests, source/test typechecks, static gates, ESLint and production build passed, with headed Chrome following the private edit link and persisting `Guest edited in Chrome` / `Updated details` (`tmp/project-guest-edit.png`).
- 2026-11-27: P2-18 completed in `57e8ebc21`; cards gain a numeric `estimate` property, editors can create/edit closed time entries, and a cross-board weekly workload report clamps actual intervals to the selected range, respects board/field visibility, prorates per-user capacity and shows estimate-vs-actual utilization; 362 project tests, source/test typechecks, static gates, ESLint and production build passed, with headed Chrome adding a 90-minute entry, opening `/project/workload`, and changing weekly capacity from 40h to 35h with immediate report refresh (`tmp/project-manual-time.png`, `tmp/project-workload-capacity.png`).
- 2026-11-27: P2-19 completed in `18896095d`; cards and notes now link in both directions with ownership/encryption checks, `![[project/<board>/<view>]]` renders a permission-checked read-only iframe without board tabs, and the assistant can create a Markdown card from an owned note; 371 project tests plus 29 final focused tests, source/test typechecks, static gates, ESLint and production build passed, with headed Chrome linking `Meeting notes for card` to a card and opening the embedded table view (`tmp/project-card-note-link.png`, `tmp/project-board-embed.png`).
- 2026-11-27: P2-20a completed in `f511f9354`; cards can link a date property to a writable calendar event, card date/title changes update the event, local/provider calendar changes write the date back, and event deletion clears the card date without a revision loop; 53 focused calendar/schema tests, source/test typechecks, static gates and ESLint passed, with headed Chrome verifying both directions and the linked-event row (`tmp/project-calendar-bridge.png`).
- 2026-11-28: P2-20b completed in `50daccfa7`; Slack card events, GitHub/Jira issue creation and later card-title/body synchronization now use vault-encrypted credentials, scoped routes, bounded outbound requests and pending-link claims, while credential and external-side-effect requests bypass the offline outbox; 40 focused integration/schema/outbox tests, source/test typechecks, i18n/comments/hooks/a11y gates, ESLint and production build passed, with headed Chrome verifying configuration, secret non-display, card issue controls and the provider failure path (`tmp/project-native-integrations.png`, `tmp/project-native-integrations-saved.png`, `tmp/project-card-external-links.png`).
