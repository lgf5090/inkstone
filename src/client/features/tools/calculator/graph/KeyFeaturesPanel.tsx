import { Modal } from '../../../../components/overlay'
import type { GraphAnalysisResult } from '@shared/tools/calculator/types'
import { calcT } from '../lib/calc-i18n'

export function KeyFeaturesPanel({
  open,
  expression,
  result,
  onClose,
}: {
  open: boolean
  expression: string
  result: GraphAnalysisResult | null
  onClose: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={calcT('tools.calculator.graph.key_features')}
      description={expression}
      width={520}
    >
      {!result ? (
        <p className="py-6 text-center text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{calcT('tools.calculator.common.loading')}</p>
      ) : result.error !== 'none' ? (
        <p className="py-6 text-center text-[length:var(--text-12-5)] text-[var(--danger)]">
          {calcT(result.error === 'variable_not_x' ? 'tools.calculator.graph.variable_not_x' : result.error === 'not_supported' ? 'tools.calculator.graph.not_supported' : 'tools.calculator.graph.analysis_error')}
        </p>
      ) : (
        <dl className="divide-y divide-[var(--border-subtle)]">
          {result.features.map((feature) => (
            <div key={feature.titleKey} className="grid grid-cols-[150px_1fr] gap-3 py-2">
              <dt className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{calcT(`tools.calculator.graph.feature.${feature.titleKey}`)}</dt>
              <dd className="min-w-0 text-[length:var(--text-12-5)] tabular-nums text-[var(--text-primary)]">
                {feature.values.length === 0 ? (
                  <span className="text-[var(--text-tertiary)]">{calcT('tools.calculator.common.none')}</span>
                ) : (
                  <span className="space-x-2">
                    {feature.values.map((value, index) => {
                      const translated = value
                        .replace(/\bincreasing\b/g, calcT('tools.calculator.graph.increasing'))
                        .replace(/\bdecreasing\b/g, calcT('tools.calculator.graph.decreasing'))
                        .replace(/\beven\b/g, calcT('tools.calculator.graph.parity.even'))
                        .replace(/\bodd\b/g, calcT('tools.calculator.graph.parity.odd'))
                        .replace(/\bneither\b/g, calcT('tools.calculator.graph.parity.neither'))
                      return <span key={`${value}-${index}`}>{translated}</span>
                    })}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Modal>
  )
}
