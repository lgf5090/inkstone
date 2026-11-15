/**
 * The locale keys this round adds. The catalog entries are filled in by the coordinating i18n change;
 * until they land, the casts keep the chat views type-checking against the strict `MessageKey` union.
 * A runtime `t()` falls back to the key text, so these names must match the catalog exactly.
 */
import type { MessageKey } from '@shared/locales/en-US'

export const EXPORT_DONE = 'assistant.logs.export_done' as MessageKey
export const EXPORT_PARTIAL = 'assistant.logs.export_partial' as MessageKey
export const REFRESH_FACETS = 'assistant.logs.refresh_facets' as MessageKey
export const BALANCE_FAILED_COUNT = 'assistant.balance.failed_count' as MessageKey
export const REVEAL_PARTIAL = 'assistant.keys.reveal_partial' as MessageKey
export const INSIGHT_TABS = 'assistant.insights.tabs' as MessageKey
export const INSIGHT_SCOPE = 'assistant.insights.scope' as MessageKey
