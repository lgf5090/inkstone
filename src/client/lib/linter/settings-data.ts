/**
 * The engine's view of a reader's settings.
 *
 * The persisted shape, its budgets, and the normalizer all live in `@shared/linter` so the worker
 * can validate the same blob; this file only re-exports them plus the run-time fields the engine
 * needs and a settings blob never carries.
 */
import type { LinterSettings, LinterRuleConfig } from '@shared/linter'

export * from '@shared/linter'

export type { LinterSettings, LinterRuleConfig }

/** The parts of a stored config for one rule the engine reads as a record. */
export type RuleConfigRecord = Record<string, unknown>

export function ruleConfig(settings: LinterSettings, alias: string): LinterRuleConfig {
  return settings.ruleConfigs[alias] ?? {}
}
