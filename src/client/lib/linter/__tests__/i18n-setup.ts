/**
 * Loads the English catalog before any linter test runs.
 *
 * Several assertions are about the sentence a reader sees when a rule gives up, and `t()` answers
 * with the raw key until the catalog is in memory. Doing it here, once, is what keeps those
 * assertions about the message rather than about the key.
 */
import { initI18n } from '../../i18n'

await initI18n()
