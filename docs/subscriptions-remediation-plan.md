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
| SUB-012 | completed | Fix reminder row drafts, settings autosave races, bulk pending/rollback, and log filters | `ReminderRuleRow`, `SubscriptionSettings`, `BulkBar`, `LogsView` | 39 tests; headed browser PUT 0→1 and saved value 14; typecheck/lint/static gates/build | `3914c30a4` |
| SUB-013 | completed | Complete CSV portability, mobile deep links, and next-reminder refresh | `csv`, `open-subscription`, client `store` | 81 tests; typecheck/lint/static gates/build | `35eb67f30` |
| SUB-014 | completed | Complete trial lifecycle and add week billing | model, scheduler, form, detail, migrations | 84 tests; typecheck/lint/i18n/comments/a11y/build; Chrome showed weekly card, trial reminder 2026-12-01 00:00, and ended-trial detail | `5582979b7` |
| SUB-015 | completed | Add payment method, management URL, pause-until, fixed-term, and intro price | model, schema/migration, store, form, detail, CSV/backup | 129 tests; typecheck/lint/static gates/build; Chrome showed payment method, management link, pause date, fixed term, and ¥6 first receipt | `3e9f90ee4` |
| SUB-016 | completed | Add ICS recurrence and alarms | `calendar`, settings, inbound route | 19 RFC/ICS tests; typecheck/lint/static gates/build; calendar client inspection through parsed ICS | `0392cbb3c` |
| SUB-017 | completed | Add daily/weekly digest notifications | settings, scheduler, channels, migrations | 115 tests; typecheck/lint/static gates/build; Chrome showed digest frequency and hour controls | `d5477c4f8` |
| SUB-018 | completed | Optimize bundle, import, bulk operations, list rendering, and label identity | routes, store, overview, list/grid, label identity | 75 route/view tests; typecheck/lint/static gates/build; Chrome opened lazy form and showed all period units | `2889aaea2` |
| SUB-019 | completed | Add month calendar, receipts/refunds, and historical-rate disclosure | model, schema/migration, API, UI | 149 tests; typecheck/lint/static gates/build; Chrome showed December event, refund rows, and ¥28 net total | `6547924ef` |
| SUB-020 | completed | Add rate limits, single-flight rates refresh, and safe error mapping | subscription routes, rate limit, overview | 68 route tests; typecheck/lint/static gates/build; overlapping refresh fetched once and sixth import returned 429 | `e6cc5b05f` |
| SUB-021 | completed | Accessibility and compliance cleanup | shortcuts, ARIA, portal focus, dead code, constants, public feature entry points | 24 UI tests; typecheck/lint/static gates/build; Chrome confirmed shortcuts do not fire under settings dialog | `8c4d95b14` |
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
- SUB-012 completed in `3914c30a4`: number and rule edits use drafts committed on blur/Enter, channel switches roll back on failure, bulk/import operations are mutually exclusive, and log filters apply immediately. Headed Chrome confirmed zero reminder PUTs while typing and exactly one after blur, with the saved rule value equal to 14.
- SUB-013 completed in `35eb67f30`: CSV now preserves active state, trial end, and reminder rules; external subscription links open the mobile drawer; rule mutations reload the detail so next-reminder summaries stay accurate.
- SUB-014 completed in `5582979b7`: week billing uses the same solar/lunar period arithmetic and annualization; trials create no opening receipt, add a three-day trial reminder, and convert to exactly one deterministic first charge when they end. The detail says “试用已结束” instead of a negative countdown. Eighty-four targeted tests and all static gates/build passed; headed Chrome showed the weekly card, the trial reminder, and the ended-trial drawer.
- SUB-015 completed in `3e9f90ee4`: migration 444 adds payment method, management URL, pause-until, fixed-term, and intro price. Paused plans skip renewal and reminders; fixed-term plans convert a trial once but never recur; the first receipt honors intro price. Management URLs accept only HTTP(S), including on backup restore. CSV/JSON round trips, old-database migration, 129 targeted tests, all gates/build, and headed Chrome detail inspection passed.
- SUB-016 completed in `0392cbb3c`: solar auto-renew plans publish RFC 5545 `RRULE`; lunar/reset/fixed/manual plans remain single events rather than inventing recurrence. Enabled future expiry and trial rules become `VALARM` entries, with trial events anchored separately. Nineteen ICS tests, typecheck/lint/static gates/build, and ical.js round-trip parsing passed.
- SUB-018 completed in `2889aaea2`: bulk activate/deactivate/category/trash now use one `IN (...)` update instead of one round trip per row; selection checks use a `Set`; overview, logs, trash, settings, label manager, and dialogs load on demand. Seventy-five route/view tests and all gates/build passed; headed Chrome opened the lazy create form and confirmed day/week/month/year options. Import atomicity and high-cost route limits are completed with SUB-020 rather than duplicated here.
- SUB-020 completed in `e6cc5b05f`: import, notification tests, and rate refresh enforce independent account/IP budgets through the shared 429 mapper; overlapping rate refreshes share one upstream promise; unexpected errors are logged with URLs, credentials, SQL, and stack detail removed. Sixty-eight route tests, all gates, and build passed.
- SUB-017 completed in `d5477c4f8`: migration 445 adds digest frequency, local hour, and next due time. The scheduler scans only due digest accounts, sends overdue/next-7-day/trial summaries, deduplicates by local day or ISO week, and excludes paused plans. Empty summaries use explicit copy. Settings and backups round-trip the preference. One hundred fifteen tests, all gates/build, and headed Chrome settings inspection passed.
- SUB-019 completed in `6547924ef`: a lazy month calendar places expiry and trial events on account-local days and opens the plan. Refunds are negative receipts that reduce monthly/yearly/category/net totals without moving expiry or entering price history; the payment dialog records them and formats the sign before the currency symbol. The dashboard now states that historical receipts use the selected current rate table. One hundred forty-nine tests, all gates/build, and headed Chrome December-calendar/refund-detail inspection passed.
- SUB-021 completed in `8c4d95b14`: global shortcuts now respect the shared overlay stack; the month calendar uses table/cell semantics with a current-date marker; the portalled label picker uses the shared dialog focus trap and returns focus to its trigger; the unused settings-dialog wrapper was removed. The public client entry remains the lazy `AppTabHost` container and the worker entry remains `app.route('/api/subscriptions', ...)`. Twenty-four UI tests, all gates/build, and a headed Chrome keyboard check passed.

### 2026-11-28

- Final verification found and fixed two digest edge cases in `ee51f1cb3`: weekly summaries now target Monday correctly from Sunday and normalize month/year boundaries; migration 446 indexes `(digest, next_digest_at)` so due-account lookup stays selective.
- Final verification found and fixed converted-trial empty scans in `f1411a105`: the scheduler candidate query now requires the deterministic first payment to be absent, so an account does not remain due every minute after conversion.
- Closed the remaining default-rule path in `6eea8e6d4`: `before_trial_end` also requires the first payment to be absent, and the regression test keeps that rule present after conversion.
- Removed the unused `loadAllSettings` export in `e7227530a` to satisfy the repository's no-dead-code rule.
- The first parallel full-suite attempt hit the 600-second tool limit without summary lines and is explicitly not counted as a pass. Final verification is running sequentially with an extended timeout.
- Shard 1 passed: 758 files / 8461 tests. Shard 2 exposed one real regression in `CommitNumberInput` (Escape/Enter during IME composition), fixed in `5c17abf64`; the IME guard and related form/subscription tests now pass. The other shard-2 failures were timeout flakes and passed in isolation.
- `tests/calendar-sync.test.ts` is unchanged from the baseline and date-sensitive: its fixed 2026-10-28 event falls outside the 30-day sync window on 2026-11-28. It passes all 49 tests when run under its intended 2026-10-29 date. Final verification therefore runs the three shards with that single baseline file excluded, then runs it separately under the fixed date.
- Shard 3 exposed the repository's one-column-per-migration ledger rule. `3c0a73596` splits the token, plan-metadata, and digest columns into migrations 442–453, updates the old-database upgrade tests, and advances the global maximum-version assertion. The migration ledger, WebSSH schema, subscription schema/migrations, and backup suites all pass after the split.
- The first final shard-3 run hit two 10-second hook timeouts and two fork-worker response timeouts under heavy concurrency. All four affected files pass in isolation (109 tests). Shard 3 is being rerun with `--maxWorkers=2` to obtain a clean full-shard summary.
