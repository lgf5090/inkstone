import { useRef, useState, type ReactElement } from 'react'
import { ArrowUpDown, Eye, Filter, Plus, Trash2 } from 'lucide-react'
import type { ProjectBoardBundle, ProjectCard, ProjectProperty, ProjectViewPatch, ProjectViewType } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { groupProjectCards, matchProjectFilterGroup, sortProjectCards } from '@shared/project/view-eval'
import { t } from '../../lib/i18n'
import { IconButton } from '../../components/primitives'
import { Select } from '../../components/form'
import { Menu, type MenuItem } from '../../components/overlay'
import { Empty } from '../../components/feedback'
import { FilterModal, PropertiesModal, SortModal } from './ViewSettingsModals'

const VIEW_LABEL: Record<string, Parameters<typeof t>[0]> = {
  board: 'project.view.board',
  table: 'project.view.table',
  gallery: 'project.view.gallery',
  calendar: 'project.view.calendar',
}

function optionLabel(property: ProjectProperty, id: string): string {
  return property.options.find((option) => option.id === id)?.value ?? id
}

function cellText(card: ProjectCard, property: ProjectProperty): string {
  const raw = card.values[property.id] ?? ''
  switch (property.type) {
    case 'select': return raw ? optionLabel(property, raw) : ''
    case 'multiSelect': {
      if (!raw) return ''
      try {
        const ids: unknown = JSON.parse(raw)
        if (Array.isArray(ids)) return ids.map((id) => optionLabel(property, String(id))).join(', ')
      } catch { /* scalar falls through */ }
      return raw
    }
    case 'checkbox': return raw === 'true' ? '✓' : ''
    case 'createdBy': return card.createdBy
    case 'updatedBy': return card.modifiedBy
    case 'createdTime': return new Date(card.createAt).toLocaleDateString()
    case 'updatedTime': return new Date(card.updateAt).toLocaleDateString()
    default: return raw
  }
}

interface BoardViewsProps {
  bundle: ProjectBoardBundle
  canEdit: boolean
  onDeleteCard: (id: string) => void
  onCreateView: (type: ProjectViewType) => void
  onOpenCard: (id: string) => void
  onPatchView: (viewId: string, patch: ProjectViewPatch) => void
}

export function BoardViews({ bundle, canEdit, onDeleteCard, onCreateView, onOpenCard, onPatchView }: BoardViewsProps): ReactElement {
  const [activeId, setActiveId] = useState<string | null>(null)
  const addAnchor = useRef<HTMLButtonElement>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [settings, setSettings] = useState<'sort' | 'filter' | 'properties' | null>(null)
  const active = bundle.views.find((view) => view.id === activeId) ?? bundle.views[0] ?? null
  const fields = active?.fields ?? emptyProjectViewFields()
  const viewType = active?.viewType ?? 'table'
  const filtered = bundle.cards.filter((card) => matchProjectFilterGroup(card, fields.filter, bundle.properties))
  const sorted = sortProjectCards(filtered, fields.sortOptions, bundle.properties)
  const columns = fields.visiblePropertyIds.length
    ? fields.visiblePropertyIds.map((id) => bundle.properties.find((p) => p.id === id)).filter((p): p is ProjectProperty => Boolean(p))
    : bundle.properties

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-3 py-1.5" role="tablist" aria-label={t('project.view.add')}>
        {bundle.views.map((view) => (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={active?.id === view.id}
            className={`rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-12)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${active?.id === view.id ? 'bg-[var(--bg-hover)] font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}
            onClick={() => setActiveId(view.id)}
          >
            {view.title || t(VIEW_LABEL[view.viewType] ?? 'project.view.table')}
          </button>
        ))}
        {canEdit && (
          <>
            <IconButton ref={addAnchor} label={t('project.view.add')} size="sm" onClick={() => setAddOpen(true)}>
              <Plus size={15} />
            </IconButton>
            <Menu
              anchor={addAnchor}
              open={addOpen}
              onClose={() => setAddOpen(false)}
              label={t('project.view.add')}
              items={([['table', 'project.view.table'], ['board', 'project.view.board']] as const).map(([type, key]) => ({
                id: type,
                label: t(key),
                onSelect: () => onCreateView(type),
              })) as MenuItem[]}
            />
          </>
        )}
        {active && viewType === 'board' && (
          <Select
            className="ml-auto w-40"
            value={fields.groupById ?? ''}
            aria-label={t('project.view.group_by')}
            disabled={!canEdit}
            onChange={(event) => onPatchView(active.id, { fields: { groupById: event.target.value || undefined } })}
          >
            <option value="">{t('project.view.group_by')}</option>
            {bundle.properties.filter((property) => property.type === 'select' || property.type === 'person').map((property) => (
              <option key={property.id} value={property.id}>{property.name}</option>
            ))}
          </Select>
        )}
        {active && (
          <span className={`flex items-center gap-1 ${viewType === 'board' ? '' : 'ml-auto'}`}>
            <IconButton label={t('project.view.sort')} size="sm" onClick={() => setSettings('sort')}><ArrowUpDown size={15} /></IconButton>
            <IconButton label={t('project.view.filter')} size="sm" onClick={() => setSettings('filter')}><Filter size={15} /></IconButton>
            <IconButton label={t('project.view.properties')} size="sm" onClick={() => setSettings('properties')}><Eye size={15} /></IconButton>
          </span>
        )}
      </div>
      {sorted.length === 0
        ? <Empty art="folder" title={t('project.board.empty_cards')} />
        : viewType === 'board'
          ? <BoardColumns cards={sorted} groupById={fields.groupById} properties={bundle.properties} canEdit={canEdit} onDeleteCard={onDeleteCard} onOpenCard={onOpenCard} />
          : (
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full border-collapse text-[length:var(--text-13)]">
                  <thead>
                    <tr className="border-b border-[var(--border-subtle)] text-left text-[length:var(--text-12)] text-[var(--text-secondary)]">
                      <th scope="col" className="px-3 py-2 font-medium">{t('project.board.title_column')}</th>
                      {columns.map((property) => <th key={property.id} scope="col" className="px-3 py-2 font-medium">{property.name}</th>)}
                      {canEdit && <th scope="col" className="w-10 px-2 py-2"><span className="sr-only">{t('project.board.delete_card')}</span></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((card) => (
                      <tr key={card.id} className="border-b border-[var(--border-subtle)]" data-project-card={card.id}>
                        <td className="px-3 py-2 text-[var(--text-primary)]">
                          <button type="button" className="min-w-0 truncate text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => onOpenCard(card.id)}>
                            {card.title || t('project.board.untitled_card')}
                          </button>
                        </td>
                        {columns.map((property) => <td key={property.id} className="px-3 py-2 text-[var(--text-secondary)]">{cellText(card, property)}</td>)}
                        {canEdit && (
                          <td className="px-2 py-1">
                            <IconButton label={t('project.board.delete_card')} size="sm" onClick={() => onDeleteCard(card.id)}>
                              <Trash2 size={15} />
                            </IconButton>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      {active && settings === 'sort' && <SortModal view={active} properties={bundle.properties} onClose={() => setSettings(null)} onPatch={(fields) => onPatchView(active.id, { fields })} />}
      {active && settings === 'filter' && <FilterModal view={active} properties={bundle.properties} onClose={() => setSettings(null)} onPatch={(fields) => onPatchView(active.id, { fields })} />}
      {active && settings === 'properties' && <PropertiesModal view={active} properties={bundle.properties} onClose={() => setSettings(null)} onPatch={(fields) => onPatchView(active.id, { fields })} />}
    </div>
  )
}

function BoardColumns({ cards, groupById, properties, canEdit, onDeleteCard, onOpenCard }: {
  cards: ProjectCard[]
  groupById?: string
  properties: ProjectProperty[]
  canEdit: boolean
  onDeleteCard: (id: string) => void
  onOpenCard: (id: string) => void
}): ReactElement {
  const groupProperty = properties.find((property) => property.id === groupById)
  const groups = groupProjectCards(cards, groupById, properties)
  const columnKeys = groupProperty && groupProperty.options.length
    ? [...groupProperty.options.map((option) => option.id), '']
    : ['']
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
      {columnKeys.map((key) => {
        const bucket = groups.get(key) ?? []
        const label = key === '' ? t('project.view.no_value') : optionLabel(groupProperty!, key)
        return (
          <section key={key || 'empty'} className="flex w-64 shrink-0 flex-col rounded-[var(--r-md)] bg-[var(--bg-subtle)]" aria-label={label}>
            <header className="flex items-center gap-2 px-3 py-2 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="text-[var(--text-tertiary)]">{bucket.length}</span>
            </header>
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {bucket.length === 0 && <li className="px-1 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.view.empty_column')}</li>}
              {bucket.map((card) => (
                <li key={card.id} className="flex items-center gap-2 rounded-[var(--r-sm)] bg-[var(--bg-base)] px-2 py-2 shadow-[var(--shadow-1)]" data-project-card={card.id}>
                  <button type="button" className="min-w-0 flex-1 truncate text-left text-[length:var(--text-13)] text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => onOpenCard(card.id)}>
                    {card.title || t('project.board.untitled_card')}
                  </button>
                  {canEdit && (
                    <IconButton label={t('project.board.delete_card')} size="sm" onClick={() => onDeleteCard(card.id)}>
                      <Trash2 size={14} />
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}