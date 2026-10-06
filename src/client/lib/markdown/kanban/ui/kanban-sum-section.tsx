/**
 * G-12's picker: the view options row where a board view chooses which number column its headers
 * total. It lives apart from `kanban-view-options.tsx` because that file is at the size line, and
 * because this section is self-contained — one select fed by its own candidate rule.
 */
import { useId } from 'react'
import { Sigma } from 'lucide-react'
import { t } from '../../../i18n'
import { formatKanbanPropertyName } from '../i18n-helpers'
import type { KanbanProperty } from '../types'
import { Select } from '../../../../components/form'
import { PANEL_FIELD } from './kanban-panel'

/**
 * The number columns a header could total. A field set before it stopped being a number stays listed
 * (same rule as the swimlane picker): the header keeps drawing whatever it last summed, and the
 * picker is where the reader turns it off rather than a field that vanished.
 */
export function sumCandidates(columns: KanbanProperty[], current?: string): KanbanProperty[] {
  const eligible = columns.filter((col) => col.type === 'number')
  if (!current || eligible.some((col) => col.id === current)) return eligible
  const pinned = columns.find((col) => col.id === current)
  return pinned ? [...eligible, pinned] : eligible
}

export function SumBySection({
  sumBy,
  columns,
  onChangeSumBy,
}: {
  sumBy?: string
  columns: KanbanProperty[]
  onChangeSumBy: (propId: string | undefined) => void
}) {
  const candidates = sumCandidates(columns, sumBy)
  const fieldId = useId()
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex items-center gap-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]'>
        <Sigma size={13} aria-hidden />
        <label htmlFor={fieldId}>{t('preview.kanban_sum_by')}</label>
      </div>
      <Select
        id={fieldId}
        value={sumBy ?? ''}
        onChange={(e) => onChangeSumBy(e.target.value || undefined)}
        className={`${PANEL_FIELD} h-[var(--sp-8)] md:h-8 bg-[var(--bg-raised)] text-[length:var(--text-12)]`}
      >
        <option value=''>{t('preview.kanban_sum_off')}</option>
        {candidates.map((col) => (
          <option key={col.id} value={col.id}>
            {formatKanbanPropertyName(col)}
          </option>
        ))}
      </Select>
    </div>
  )
}
