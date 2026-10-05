import type { JSX } from 'react'
import { t } from '../../lib/i18n'
import { heatCell } from './heat-cell'

export function HeatLegend(): JSX.Element {
  return (<div className='mt-[var(--sp-1-5)] flex items-center gap-[var(--sp-1)] px-[var(--sp-1)]'>
    <span className='text-[length:var(--text-9)] text-[var(--text-quaternary)]'>{t('sidebar.calendar_less')}</span>
    {[0, 1, 2, 3, 4].map((level) => (<span key={level} aria-hidden='true' className='size-2.25 rounded-[var(--r-2)]' style={heatCell(level)}/>))}
    <span className='text-[length:var(--text-9)] text-[var(--text-quaternary)]'>{t('sidebar.calendar_more')}</span>
  </div>)
}
