import type { ReactNode } from 'react'
import { t } from '../../../i18n'
import { formatKanbanGroupLabel } from '../i18n-helpers'
import { kanbanBandColumn } from '../swimlane'
import type { KanbanBoardCell, KanbanSwimlane } from '../swimlane'
import type { KanbanGroup } from '../filter-sort'

/**
 * A board cut into bands is one grid: every column of the plain board, repeated once per band. The
 * column is titled once in the strip above the grid so the band rows stay comparable, and each cell
 * below is drawn by the board itself — this file only decides where a cell goes.
 */
export interface SwimlaneCell {
  cell: KanbanBoardCell
  group: KanbanGroup
  /** The strip answers for the whole column; a row cell only for that column within that band. */
  variant: 'head' | 'body'
}

interface KanbanBoardSwimlanesProps {
  bands: KanbanSwimlane[]
  /** The columns as the plain board sees them: the strip's order, and its totals. */
  groups: KanbanGroup[]
  renderCell: (cell: SwimlaneCell) => ReactNode
  addColumnSlot?: ReactNode
}

/** The gutter every row reserves for its band label, so the columns of all rows line up. */
const LANE_GUTTER = 'w-32 shrink-0'

function bandLabel(lane: KanbanGroup): string {
  return lane.groupKey === '__none__'
    ? t('preview.kanban_swimlane_none')
    : formatKanbanGroupLabel(lane.groupKey, lane.label)
}

export function KanbanBoardSwimlanes({ bands, groups, renderCell, addColumnSlot }: KanbanBoardSwimlanesProps) {
  return (
    <div className='flex w-max flex-col gap-4'>
      <div data-kanban-strip className='flex gap-4'>
        <div aria-hidden className={LANE_GUTTER} />
        {groups.map((group) => renderCell({ cell: { groupKey: group.groupKey }, group, variant: 'head' }))}
        {addColumnSlot}
      </div>
      {bands.map((band) => (
        <div
          key={band.lane.groupKey}
          data-kanban-band={band.lane.groupKey}
          role='group'
          aria-label={bandLabel(band.lane)}
          className='flex gap-4'
        >
          <div className={`${LANE_GUTTER} flex items-center gap-1.5 px-1 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]`}>
            <span className='truncate' aria-hidden>{bandLabel(band.lane)}</span>
            <span
              data-kanban-lane-count
              className='ml-auto shrink-0 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]'
            >
              {band.lane.items.length}
            </span>
          </div>
          {groups.map((column) => {
            const cell: KanbanBoardCell = { groupKey: column.groupKey, laneKey: band.lane.groupKey }
            return renderCell({ cell, group: kanbanBandColumn(band, column), variant: 'body' })
          })}
        </div>
      ))}
    </div>
  )
}
