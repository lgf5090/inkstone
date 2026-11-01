import { t } from '../../../../lib/i18n'
import type { ColorHarmonyType, ColorSpaceAlgorithmType } from '@shared/tools/color/types'

type MessageKey = Parameters<typeof t>[0]

/**
 * The reader's own words for the schemes the colour engine computes.
 *
 * The harmony families and the algorithmic palettes used to carry English names and one-line descriptions
 * inside `@shared/tools/color`, which meant a Chinese interface showed prose nobody had translated between
 * two swatches — and the same strings were written into saved palettes. Both datasets now ship a machine
 * id only, and these four lookups are the single place that maps it to copy.
 */
export function harmonyName(type: ColorHarmonyType): string {
  return t(`tools.color.harmony.${type}` as MessageKey)
}

export function harmonyDescription(type: ColorHarmonyType): string {
  return t(`tools.color.harmony.${type}_desc` as MessageKey)
}

export function algorithmName(id: ColorSpaceAlgorithmType): string {
  return t(`tools.color.algorithm.${id}` as MessageKey)
}

export function algorithmDescription(id: ColorSpaceAlgorithmType): string {
  return t(`tools.color.algorithm.${id}_desc` as MessageKey)
}
