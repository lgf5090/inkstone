# Subscriptions remediation plan

- Base: `41bb785cf4a55b0bb0c702a4744dc276aa0fa9b6`
- Branch: `fix/subscriptions-remediation`
- Worktree: `E:/projects/cloudflare/inkstone-subscriptions-fix`
- Source audit: `reports/subscriptions-audit-final.md` in the primary worktree
- Rule: every completed task gets a code commit, then this document is updated with the commit and verification evidence.

## Scope

Implemented locally in this branch:

- All P1/P2 correctness, security, reliability, accessibility, and performance findings.
- Locally implementable feature gaps: week billing, trial reminders, payment method, management URL, ICS recurrence/alarms, digest, pause-until, fixed-term/intro price, month calendar, receipts/refunds, historical-rate disclosure.
- Repository compliance cleanup and full verification.

Not implemented because they require external product contracts or provider credentials:

- Bank aggregation/open-banking synchronization.
- Human subscription cancellation and bill negotiation services.
- Multi-user household sharing. The current account isolation model is intentional; adding collaboration requires a separate authorization design.

These three are marked `external-product-decision`, not silently skipped.

## Task ledger

| ID | Status | Task | Primary files | Verification | Commit |
|---|---|---|---|---|---|
| SUB-001 | completed | Create branch, worktree, and living plan | `docs/subscriptions-remediation-plan.md` | git worktree/branch checks | `17dc3d608` |
| SUB-002 | completed | Unify date parsing and local display | `SubscriptionForm`, `routes/subscriptions`, `store`, `SubscriptionDetail`, `csv`, `calendar` | 101 related tests; typecheck/lint/i18n/comments/a11y/build; headed Chrome local-date inspection | `acd90a003` |
| SUB-003 | completed | Deduplicate before/on reminders by local day and compute next fire inside notification window | `reminder-engine`, `scheduler`, `store`, `SubscriptionDetail` | 108 tests; typecheck/lint/static gates/build; headed Chrome shows 2027-12-14 09:00 | `f05552fd2` |
| SUB-004 | completed | Fix multi-period renewal amounts, period metadata, price normalization, and auto-renew concurrency | `store`, `currency`, schema/migration | 171 related tests; typecheck/lint/static gates/build; browser confirmed per-cycle label | `02784d2de` |
| SUB-005 | completed | Preserve expired state on edit and separate price correction from future price changes | `store`, `SubscriptionForm` | 66 tests; typecheck/lint/static gates/build; browser attempt blocked by reused Chrome target | `32689d174` |
| SUB-006 | completed | Stop destroying lifetime payment totals when trimming visible history | `store`, schema/migration, backup | 81 tests; typecheck/lint/static gates/build | `6c91d5071` |
| SUB-007 | completed | Make backup restore staged and recoverable | `backup`, schema/migration | 29 tests incl. injected final-batch failure; typecheck/lint/static gates/build | `b72040165` |
| SUB-008 | completed | Split calendar read token from webhook write token | inbound routes, settings, schema/migration, UI | 117 backend/migration tests + 26 UI/security tests; typecheck/lint/static gates/build | `bdf50101e` |
| SUB-009 | completed | Make scheduler due-driven and aggregate routine logs | `scheduler`, `logs`, schema/indexes | 26 tests; typecheck/lint/static gates/build | `c39582eae` |
| SUB-010 | completed | Refresh overview after activation changes and add frontend request ordering | client `store` | 4 race tests; headed Chrome shows 0 of 1; typecheck/lint/static gates/build | `05ca600cb` |
| SUB-011 | completed | Fix toolbar wrappers, narrow-screen overflow, drawer close, and toolbar semantics | `form`, `SubscriptionsApp`, `SubscriptionDetail`, `Drawer` | 22 tests; headed Chrome menu screenshot + 390px wrapped layout; typecheck/lint/static gates/build | `86c29ac9b` |
| SUB-012 | pending | Fix reminder row drafts, settings autosave races, bulk pending/rollback, and log filters | `ReminderRuleRow`, `SubscriptionSettings`, `BulkBar`, `LogsView` | component tests + browser | pending |
| SUB-013 | pending | Complete CSV portability, mobile deep links, and next-reminder refresh | `csv`, `open-subscription`, client `store` | round-trip/deep-link tests + browser | pending |
| SUB-014 | pending | Complete trial lifecycle and add week billing | model, scheduler, form, detail, migrations | trial transition/week tests + browser | pending |
| SUB-015 | pending | Add payment method, management URL, pause-until, fixed-term, and intro price | model, schema/migration, store, form, detail, CSV/backup | CRUD/round-trip tests + browser | pending |
| SUB-016 | pending | Add ICS recurrence and alarms | `calendar`, settings, inbound route | RFC 5545 tests + calendar client inspection | pending |
| SUB-017 | pending | Add daily/weekly digest notifications | settings, scheduler, channels, migrations | digest scheduling/dedupe tests | pending |
| SUB-018 | pending | Optimize bundle, import, bulk operations, list rendering, and label identity | routes, store, overview, list/grid, label identity | query-count and render benchmarks | pending |
| SUB-019 | pending | Add month calendar, receipts/refunds, and historical-rate disclosure | model, schema/migration, API, UI | CRUD/statistics tests + browser | pending |
| SUB-020 | pending | Add rate limits, single-flight rates refresh, and safe error mapping | subscription routes, rate limit, overview | abuse/concurrency tests | pending |
| SUB-021 | pending | Accessibility and compliance cleanup | shortcuts, ARIA, portal focus, dead code, constants, public feature entry points | a11y/type/i18n/comments/lint + keyboard browser checks | pending |
| SUB-022 | pending | Final full verification and report | all changed files | full unit suite, gates, build, external browser golden paths | pending |

## Verification protocol

For each task:

1. Add or update a failing regression test before the fix when practical.
2. Run the narrow test file and `npm run typecheck`.
3. For UI tasks, start `INKSTONE_EPHEMERAL_DEV=1 npm run dev -- --port <port>` and an isolated headed Chrome profile outside the repository.
4. Verify the golden path and at least one edge case in the real browser; capture screenshots for layout changes.
5. Run `npm run i18n:check`, `npm run comments:check`, `npm run a11y:check`, `npm run lint`, and `npm run build` before final merge.
6. Commit code with Conventional Commits and file-level body details.
7. Update this ledger with status, commit hash, and exact verification evidence.

## Progress log

### 2026-11-27

- Created worktree and branch from the requested base.
- Committed the living plan as `17dc3d608`.
- Repaired the pre-existing `scripts/e2e.mjs` comment allowlist mismatch as `929aa6edd`; `comments:check` now passes.
- Began dependency installation and task decomposition.
- SUB-002 completed in `acd90a003`: bare dates are parsed in the account timezone; form/detail/CSV/ICS/log diagnostics use local formatting. Regression tests cover Shanghai, New York, and renew/edit round trips. Headed Chrome showed local expiry and reminder text correctly; the lazy dialog automation was unstable, so the round-trip assertion is covered by real store/route tests.
- SUB-003 completed in `f05552fd2`: before/on reminders deduplicate by local day; next fire respects the notification window; invalid hours are rejected. Cross-hour scheduler and window tests pass, and headed Chrome shows `Next reminder: 2027-12-14 09:00`.
- SUB-004 completed in `02784d2de`: migration 440 adds `period_count`; manual and automatic renewals charge every period, record the final period start, normalize price changes, and prevent overlapping auto-renew duplicates. The browser confirmed the per-cycle price label; lazy-dialog automation remained unstable, so amount/period assertions are covered by store/route tests.
- SUB-005 completed in `32689d174`: editing no longer advances an expired date or rewrites the opening receipt. Route tests cover both behaviors. The headed-browser probe was blocked because the isolated Chrome port was reused by another session; no product failure was inferred from that tooling issue.
- SUB-006 completed in `6c91d5071`: payment history is no longer physically trimmed. The setting now limits visible receipts only; lifetime totals and yearly statistics use the complete ledger. Regression tests show 10 visible receipts while 11 receipts and the full 660 total remain.
- SUB-007 completed in `b72040165`: migration 441 adds an isolated restore staging table. Restores normalize and stage first, then switch live tables in one atomic batch. An injected final-batch failure leaves the old library unchanged and cleans staging.
- SUB-008 completed in `bdf50101e`: migration 442 adds a separate calendar read token. Calendar GET and webhook POST reject each other's tokens; the settings UI rotates and displays them independently. This is a recorded breaking change: existing calendar links must be regenerated.
- SUB-009 completed in `c39582eae`: the scheduler now selects only accounts with due auto-renewals or reminders inside their lead window. Routine minutes no longer write schedule rows; events and an hourly heartbeat remain. Migration 443 adds the due-query index.
- SUB-010 completed in `05ca600cb`: bundle/detail/log requests use generation guards, and stopping a subscription refreshes the overview. Headed Chrome confirmed the active count changes to `0 of 1` and committed yearly becomes zero.
- SUB-011 completed in `86c29ac9b`: shared Input/Select wrappers accept layout classes; the toolbar uses the app SelectMenu with an end-aligned panel, wraps on narrow screens, and the detail close button is always visible. Headed Chrome confirmed the menu opens below the trigger without covering the bell.
