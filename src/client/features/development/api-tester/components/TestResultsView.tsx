import { Check, X } from 'lucide-react'
import { t } from '../../../../lib/i18n'
import type { TestResult } from '@shared/development/api-tester/types'

export function TestResultsView({
  results,
  error,
}: {
  results: TestResult[]
  error?: string
}) {
  const passed = results.filter((result) => result.passed).length
  const failed = results.length - passed
  const pct = results.length > 0 ? Math.round((passed / results.length) * 100) : 0

  return (
    <div className="h-full space-y-1 overflow-y-auto overscroll-contain p-3" data-slot="api-tester-tests">
      {error && (
        <div className="mb-2 rounded-[var(--r-md)] border border-[var(--danger)] bg-[var(--danger-soft)] p-2 text-[length:var(--text-11)] text-[var(--danger)]">
          {t('development.apitester.script_execution_error', { msg: error })}
        </div>
      )}
      {results.length === 0 && !error && (
        <p className="py-4 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('development.apitester.no_test_results')}
        </p>
      )}
      {results.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-3 text-[length:var(--text-11)]">
            <span className="font-medium text-[var(--success)]">
              {t('development.apitester.tests_passed_count', { passed, total: results.length })}
            </span>
            {failed > 0 && (
              <span className="text-[var(--danger)]">
                {t('development.apitester.failed_count', { count: failed })}
              </span>
            )}
            <span className="text-[var(--text-tertiary)]">
              {t('development.apitester.total_tests', { count: results.length, pct })}
            </span>
          </div>
          <ul className="space-y-1">
            {results.map((result, index) => (
              <li
                key={`${result.name}-${index}`}
                className={
                  result.passed
                    ? 'flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--success)] bg-[var(--success-soft)] p-2 text-[length:var(--text-11)]'
                    : 'flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--danger)] bg-[var(--danger-soft)] p-2 text-[length:var(--text-11)]'
                }
              >
                {result.passed ? (
                  <Check size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--success)]" />
                ) : (
                  <X size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--danger)]" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-[var(--text-primary)]">{result.name}</div>
                  {!result.passed && result.error && (
                    <div className="mt-0.5 break-all font-mono text-[length:var(--text-10-5)] text-[var(--danger)]">
                      {result.error}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
