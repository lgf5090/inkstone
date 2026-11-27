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
| SUB-001 | in_progress | Create branch, worktree, and living plan | `docs/subscriptions-remediation-plan.md` | git worktree/branch checks | pending |
| SUB-002 | pending | Unify date parsing and local display | `SubscriptionForm`, `routes/subions`, `store`, `SubscriptionDetail`, `csv`, `calendar` | Shanghai/New York/Sydney round-trip tests + browser | pending |
| SUB-003 | pending | Deduplicate before/on reminders by local day and compute next fire inside notification window | `reminder-engine`, `scheduler`, `store`, `SubscriptionDetail` | cross-hour scheduler test + browser | pending |
| SUB-004 | pending | Fix multi-period renewal amounts, period metadata, price normalization, and auto-renew concurrency | `store`, `currency`, schema/migration | API tests for multiplier/catch-up/concurrency | pending |
| SUB-005 | pending | Preserve expired state on edit and separate price correction from future price changes | `store`, `SubscriptionForm` | expired edit and initial receipt tests | pending |
| SUB-006 | pending | Stop destroying lifetime payment totals when trimming visible history | `store`, schema/migration, backup | limit/rollup/backup tests | pending |
| SUB-007 | pending | Make backup restore staged and recoverable | `backup`, schema/migration | injected failure at each chunk | pending |
| SUB-008 | pending | Split calendar read token from webhook write token | inbound routes, settings, schema/migration, UI | read token cannot POST; write token cannot GET calendar | pending |
| SUB-009 | pending | Make scheduler due-driven and aggregate routine logs | `scheduler`, `logs`, schema/indexes | query/write-count test at 100/1000 accounts | pending |
| SUB-010 | pending | Refresh overview after activation changes and add frontend request ordering | client `store` | delayed-response tests + browser | pending |
| SUB-011 | pending | Fix toolbar wrappers, narrow-screen overflow, drawer close, and toolbar semantics | `form`, `SubscriptionsApp`, `SubscriptionDetail`, `Drawer` | 390/1100/1440/1800 browser geometry and screenshots | pending |
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
- Began dependency installation and task decomposition.
