import type { MessageKey } from '@shared/locales/en-US'
import type { WebsshRegionHint } from '@shared/webssh/types'
import { WEBSSH_REGION_HINTS, WEBSSH_REGION_HINTS_NEARBY } from '@shared/webssh/types'
import { t } from '../../lib/i18n'

export const REGION_LABEL_KEY: Record<WebsshRegionHint, MessageKey> = {
  wnam: 'webssh.egress.region.wnam',
  enam: 'webssh.egress.region.enam',
  weur: 'webssh.egress.region.weur',
  eeur: 'webssh.egress.region.eeur',
  apac: 'webssh.egress.region.apac',
  'apac-ne': 'webssh.egress.region.apac_ne',
  'apac-se': 'webssh.egress.region.apac_se',
  oc: 'webssh.egress.region.oc',
  sam: 'webssh.egress.region.sam',
  afr: 'webssh.egress.region.afr',
  me: 'webssh.egress.region.me',
}

export function regionLabel(region: WebsshRegionHint): string {
  return t(REGION_LABEL_KEY[region])
}

export function regionOptions(): Array<{ value: WebsshRegionHint; label: string }> {
  return [
    ...WEBSSH_REGION_HINTS.map((region) => ({ value: region, label: regionLabel(region) })),
    ...WEBSSH_REGION_HINTS_NEARBY.map((region) => ({
      value: region,
      label: `${regionLabel(region)} · ${t('webssh.egress.region.nearby')}`,
    })),
  ]
}
