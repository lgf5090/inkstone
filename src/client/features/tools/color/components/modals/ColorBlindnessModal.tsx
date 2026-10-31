import { recommendedTextColor, simulateColorBlindness } from '@shared/tools/color/a11y'
import type { ColorBlindnessType } from '@shared/tools/color/types'
import { Modal } from '../../../../../components/overlay'
import { Button } from '../../../../../components/primitives'
import { t } from '../../../../../lib/i18n'
import { useColorStudioStore } from '../../store'

/**
 * The five conditions the simulator shows.
 *
 * Prevalence stays as data: it is a number and a scope, not copy — the catalog carries the name and the
 * one-line explanation beside it, keyed on the same machine type the simulator switches on.
 */
const DEFICIENCIES: Array<{ type: ColorBlindnessType; prevalence: string }> = [
  { type: 'normal', prevalence: '91%' },
  { type: 'deuteranopia', prevalence: '~5% ♂' },
  { type: 'protanopia', prevalence: '~1% ♂' },
  { type: 'tritanopia', prevalence: '~0.008%' },
  { type: 'achromatopsia', prevalence: '~0.003%' },
]

export function ColorBlindnessModal() {
  const isOpen = useColorStudioStore((s) => s.isColorBlindnessModalOpen)
  const onClose = useColorStudioStore((s) => s.closeColorBlindnessModal)
  const currentHex = useColorStudioStore((s) => s.currentHex)

  // Five colour-blindness simulations ran on every colour change while this modal sat closed.
  if (!isOpen) return null

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={t('tools.color.blindness.title')}
      width={680}
      footer={
        <div className="flex w-full items-center justify-between">
          <span className="font-mono text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('tools.color.blindness.active_color', { hex: currentHex })}
          </span>
          <Button size="sm" variant="primary" onClick={onClose}>
            {t('tools.color.common.done')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">
          {t('tools.color.blindness.desc')}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {DEFICIENCIES.map((def) => {
            const simulatedHex = simulateColorBlindness(currentHex, def.type)
            return (
              <div
                key={def.type}
                className="flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3.5 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-[length:var(--text-13)] font-bold text-[var(--text-primary)]">
                      {t(`tools.color.blindness.type.${def.type}`)}
                    </h4>
                    <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      {def.prevalence}
                    </span>
                  </div>
                </div>

                {/* Swatch & Simulated Hex */}
                <div className="flex items-center gap-3">
                  <div
                    className="h-12 w-16 shrink-0 rounded-[var(--radius-md)] border border-black/10 shadow-xs"
                    style={{ backgroundColor: simulatedHex }}
                  />
                  <div>
                    <span className="font-mono text-[length:var(--text-14)] font-bold text-[var(--text-primary)] uppercase">
                      {simulatedHex}
                    </span>
                    <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)] mt-0.5 line-clamp-2">
                      {t(`tools.color.blindness.type.${def.type}_desc`)}
                    </p>
                  </div>
                </div>

                {/* Mini Mockup Demo */}
                <div
                  className="rounded-[var(--radius-md)] p-2.5 text-center text-[length:var(--text-11)] font-semibold border border-black/5"
                  style={{
                    backgroundColor: simulatedHex,
                    color: recommendedTextColor(simulatedHex),
                  }}
                >
                  {t('tools.color.blindness.button_preview')}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}
