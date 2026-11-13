import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import type { ProjectBoardSummary, ProjectProperty, ProjectPropertyConfig, ProjectPropertyType, ProjectRole, ProjectRollupAggregation, ProjectRollupConfig } from '@shared/project/model'
import { newProjectId } from '@shared/project/limits'
import { PROJECT_ROLES, PROJECT_ROLLUP_AGGREGATIONS } from '@shared/project/model'
import { PROJECT_OPTION_COLORS, projectOptionColorName, projectOptionCssColor } from '@shared/project/option-color'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Input } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { Menu, Modal, type MenuItem } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { fetchBoardProperties, fetchProjectBoards } from './api'
import { AutomationsDialog } from './AutomationsDialog'
import { IntegrationsDialog } from './IntegrationsDialog'

const EDITABLE_TYPES: ProjectPropertyType[] = ['text', 'number', 'select', 'multiSelect', 'date', 'person', 'checkbox', 'url', 'email', 'phone', 'relation', 'rollup']
const OPTION_TYPES = new Set(['select', 'multiSelect'])

const typeOptions = () => EDITABLE_TYPES.map((type) => ({ value: type, label: t(`project.prop.type.${type.toLowerCase()}` as Parameters<typeof t>[0]) }))

interface BoardPropertiesDialogProps {
  boardId: string
  properties: ProjectProperty[]
  onClose: () => void
  onSave: (properties: ProjectProperty[], deletedIds: string[]) => Promise<void>
}

export function BoardPropertiesDialog({ boardId, properties, onClose, onSave }: BoardPropertiesDialogProps): ReactElement {
  const [draft, setDraft] = useState<ProjectProperty[]>(properties)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<ProjectPropertyType>('text')
  const [optionDraft, setOptionDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [boards, setBoards] = useState<ProjectBoardSummary[]>([])
  const [automationsOpen, setAutomationsOpen] = useState(false)
  const [integrationsOpen, setIntegrationsOpen] = useState(false)
  const [targetProperties, setTargetProperties] = useState<Record<string, ProjectProperty[]>>({})
  useEffect(() => {
    let alive = true
    fetchProjectBoards()
      .then((list) => { if (alive) setBoards(list) })
      .catch(() => { if (alive) setBoards([]) })
    return () => { alive = false }
  }, [])

  const targetBoardIds = [...new Set(draft
    .filter((entry) => entry.type === 'rollup' && entry.config?.rollup?.relationPropertyId)
    .map((entry) => draft.find((relation) => relation.type === 'relation' && relation.id === entry.config?.rollup?.relationPropertyId)?.config?.targetBoardId)
    .filter((id): id is string => Boolean(id)))]
  const targetBoardKey = targetBoardIds.join(',')
  useEffect(() => {
    const missing = targetBoardIds.filter((id) => !(id in targetProperties))
    if (!missing.length) return
    let alive = true
    const controllers = missing.map((id) => {
      const controller = new AbortController()
      fetchBoardProperties(id, controller.signal)
        .then((list) => { if (alive) setTargetProperties((previous) => ({ ...previous, [id]: list })) })
        .catch(() => { if (alive) setTargetProperties((previous) => ({ ...previous, [id]: [] })) })
      return controller
    })
    return () => { alive = false; for (const controller of controllers) controller.abort() }
  }, [targetBoardKey, targetProperties])

  const rollupTargetOptions = (property: ProjectProperty) => {
    const relation = draft.find((entry) => entry.type === 'relation' && entry.id === property.config?.rollup?.relationPropertyId)
    const targetBoardId = relation?.config?.targetBoardId
    return [
      { value: '', label: t('project.value.empty') },
      ...(targetBoardId ? targetProperties[targetBoardId] ?? [] : []).map((entry) => ({ value: entry.id, label: entry.name })),
    ]
  }

  const update = (id: string, patch: Partial<ProjectProperty>) => {
    setDraft((current) => current.map((property) => (property.id === id ? { ...property, ...patch } : property)))
  }
  const toggleRole = (property: ProjectProperty, key: 'viewRoles' | 'editRoles', role: ProjectRole) => {
    const current = property.config?.[key] ?? []
    const next = current.includes(role) ? current.filter((entry) => entry !== role) : [...current, role]
    const config: ProjectPropertyConfig = { ...property.config }
    if (next.length) config[key] = next
    else delete config[key]
    update(property.id, { config: Object.keys(config).length ? config : undefined })
  }
  const updateRollup = (property: ProjectProperty, patch: Partial<ProjectRollupConfig>) => {
    const current = property.config?.rollup ?? { relationPropertyId: '', targetPropertyId: '', aggregation: 'count' as ProjectRollupAggregation }
    const config = { ...property.config, rollup: { ...current, ...patch } }
    update(property.id, { config: Object.keys(config).length ? config : undefined })
  }

  const move = (index: number, delta: number) => {
    setDraft((current) => {
      const next = [...current]
      const target = index + delta
      if (target < 0 || target >= next.length) return current
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item!)
      return next
    })
  }
  const addProperty = () => {
    const name = newName.trim()
    if (!name) return
    setDraft((current) => [...current, { id: newProjectId('property'), name, type: newType, options: [] }])
    setNewName('')
  }
  const addOption = (propertyId: string) => {
    const value = (optionDraft[propertyId] ?? '').trim()
    if (!value) return
    update(propertyId, { options: [...(draft.find((p) => p.id === propertyId)?.options ?? []), { id: newProjectId('property'), value, color: '' }] })
    setOptionDraft((current) => ({ ...current, [propertyId]: '' }))
  }

  const save = async () => {
    setSaving(true)
    try {
      const deletedIds = properties.filter((p) => !draft.some((d) => d.id === p.id)).map((p) => p.id)
      await onSave(draft, deletedIds)
      onClose()
    } catch (reason) {
      useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={t('project.props.title')}
        width={640}
        footer={<>
          <Button variant="ghost" onClick={() => setAutomationsOpen(true)}>{t('project.automations.open')}</Button>
          <Button variant="ghost" onClick={() => setIntegrationsOpen(true)}>{t('project.integrations.open')}</Button>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>{t('common.save')}</Button>
        </>}
      >
        <div className="space-y-3" data-board-props={boardId}>
          {draft.length === 0 && <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.props.empty')}</p>}
          {draft.map((property, index) => (
            <div key={property.id} className="space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
              <div className="flex items-center gap-2">
                <Input className="min-w-0 flex-1" value={property.name} aria-label={t('project.props.name')} onChange={(event) => update(property.id, { name: event.target.value })} />
                <SelectMenu className="w-32" value={property.type} label={t('project.props.type')} onChange={(value) => update(property.id, { type: value as ProjectPropertyType })} options={typeOptions()} />
                <IconButton label={t('project.props.move_up')} size="sm" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></IconButton>
                <IconButton label={t('project.props.move_down')} size="sm" disabled={index === draft.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></IconButton>
                <IconButton label={t('common.delete')} size="sm" onClick={() => setDraft((current) => current.filter((p) => p.id !== property.id))}><Trash2 size={15} /></IconButton>
              </div>
              {OPTION_TYPES.has(property.type) && (
                <div className="space-y-1 pl-1">
                  <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.props.options')}</p>
                  {property.options.map((option) => (
                    <div key={option.id} className="flex items-center gap-2">
                      <OptionColorPicker
                        color={option.color}
                        label={`${t('project.props.option_color')}: ${option.value}`}
                        onPick={(color) => update(property.id, { options: property.options.map((entry) => (entry.id === option.id ? { ...entry, color } : entry)) })}
                      />
                      <Input
                        className="min-w-0 flex-1"
                        value={option.value}
                        aria-label={`${t('project.props.option_value')}: ${option.value}`}
                        onChange={(event) => update(property.id, { options: property.options.map((entry) => (entry.id === option.id ? { ...entry, value: event.target.value } : entry)) })}
                      />
                      <IconButton label={t('common.delete')} size="sm" onClick={() => update(property.id, { options: property.options.filter((o) => o.id !== option.id) })}><Trash2 size={13} /></IconButton>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <Input
                      className="min-w-0 flex-1"
                      value={optionDraft[property.id] ?? ''}
                      placeholder={t('project.props.option_value')}
                      aria-label={t('project.props.option_value')}
                      onChange={(event) => setOptionDraft((current) => ({ ...current, [property.id]: event.target.value }))}
                    />
                    <Button size="sm" icon={<Plus size={14} />} onClick={() => addOption(property.id)}>{t('project.props.add_option')}</Button>
                  </div>
                </div>
              )}
              {property.type === 'formula' && (
                <div className="space-y-1 pl-1">
                  <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.props.expression')}</p>
                  <Input
                    className="w-full font-mono"
                    value={property.config?.expression ?? ''}
                    placeholder={t('project.props.expression_hint')}
                    aria-label={`${t('project.props.expression')}: ${property.name}`}
                    onChange={(event) => {
                      const expression = event.target.value.trim() ? event.target.value : undefined
                      const config = { ...property.config, expression }
                      if (!expression) delete config.expression
                      update(property.id, { config: Object.keys(config).length ? config : undefined })
                    }}
                  />
                  <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('project.props.expression_help')}</p>
                </div>
              )}
              {property.type === 'relation' && (
                <div className="space-y-1 pl-1">
                  <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.props.relation_board')}</p>
                  <SelectMenu
                    className="w-full"
                    value={property.config?.targetBoardId ?? ''}
                    label={t('project.props.relation_board')}
                    onChange={(value) => {
                      const config = { ...property.config, targetBoardId: value || undefined }
                      if (!value) delete config.targetBoardId
                      update(property.id, { config: Object.keys(config).length ? config : undefined })
                    }}
                    options={[{ value: '', label: '—' }, ...boards.map((board) => ({ value: board.id, label: board.title }))]}
                  />
                  <Checkbox
                    label={t('project.props.relation_multiple')}
                    checked={property.config?.multiple === true}
                    onChange={(checked) => {
                      const config = { ...property.config }
                      if (checked) config.multiple = true
                      else delete config.multiple
                      update(property.id, { config: Object.keys(config).length ? config : undefined })
                    }}
                  />
                </div>
              )}
              {property.type === 'rollup' && (
                <div className="space-y-1 pl-1">
                  <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.props.rollup_relation')}</p>
                  <SelectMenu
                    className="w-full"
                    value={property.config?.rollup?.relationPropertyId ?? ''}
                    label={t('project.props.rollup_relation')}
                    onChange={(value) => updateRollup(property, { relationPropertyId: value })}
                    options={[{ value: '', label: '—' }, ...draft.filter((entry) => entry.type === 'relation').map((entry) => ({ value: entry.id, label: entry.name }))]}
                  />
                  <SelectMenu
                    className="w-full"
                    value={property.config?.rollup?.targetPropertyId ?? ''}
                    label={t('project.props.rollup_target')}
                    onChange={(value) => updateRollup(property, { targetPropertyId: value })}
                    options={rollupTargetOptions(property)}
                  />
                  <SelectMenu
                    className="w-full"
                    value={property.config?.rollup?.aggregation ?? 'count'}
                    label={t('project.props.rollup_aggregation')}
                    onChange={(value) => updateRollup(property, { aggregation: value as ProjectRollupAggregation })}
                    options={PROJECT_ROLLUP_AGGREGATIONS.map((aggregation) => ({ value: aggregation, label: t(`project.rollup.${aggregation}` as Parameters<typeof t>[0]) }))}
                  />
                </div>
              )}
              <details className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1">
                <summary className="cursor-pointer text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.props.access')}</summary>
                <div className="mt-1.5 space-y-1">
                  {(['viewRoles', 'editRoles'] as const).map((key) => (
                    <div key={key} className="flex flex-wrap items-center gap-1">
                      <span className="w-16 shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                        {t(key === 'viewRoles' ? 'project.props.access_view' : 'project.props.access_edit')}
                      </span>
                      {PROJECT_ROLES.map((role) => {
                        const active = property.config?.[key]?.includes(role) ?? false
                        return (
                          <button
                            key={role}
                            type="button"
                            aria-pressed={active}
                            onClick={() => toggleRole(property, key, role)}
                            className={`rounded-full border px-2 py-0.5 text-[length:var(--text-11)] transition-colors ${active ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
                          >
                            {t(`project.role.${role}` as Parameters<typeof t>[0])}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                  <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('project.props.access_hint')}</p>
                </div>
              </details>
            </div>
          ))}
          <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
            <Input className="min-w-0 flex-1" value={newName} placeholder={t('project.props.name')} aria-label={t('project.props.name')} onChange={(event) => setNewName(event.target.value)} />
            <SelectMenu className="w-32" value={newType} label={t('project.props.type')} onChange={(value) => setNewType(value as ProjectPropertyType)} options={typeOptions()} />
            <Button size="sm" variant="primary" icon={<Plus size={14} />} disabled={!newName.trim()} onClick={addProperty}>{t('project.props.add')}</Button>
          </div>
        </div>
      </Modal>
      {automationsOpen && <AutomationsDialog boardId={boardId} onClose={() => setAutomationsOpen(false)} />}
      {integrationsOpen && <IntegrationsDialog boardId={boardId} onClose={() => setIntegrationsOpen(false)} />}
    </>
  )
}
function OptionColorPicker({ color, label, onPick }: { color: string, label: string, onPick: (color: string) => void }): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const resolved = projectOptionCssColor(color)
  const items: MenuItem[] = [
    { id: '', label: t('project.props.option_no_color'), checked: color === '', onSelect: () => { setOpen(false); onPick('') } },
    ...PROJECT_OPTION_COLORS.map((token) => ({
      id: token,
      label: t(`project.color.${projectOptionColorName(token)}` as Parameters<typeof t>[0]),
      icon: <span aria-hidden="true" className="size-3 rounded-full" style={{ backgroundColor: projectOptionCssColor(token) ?? undefined }} />,
      checked: token === color,
      onSelect: () => { setOpen(false); onPick(token) },
    })),
  ]
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex size-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        <span aria-hidden="true" className="size-3 rounded-full" style={{ backgroundColor: resolved ?? 'var(--text-quaternary)' }} />
      </button>
      <Menu anchor={anchor} open={open} onClose={() => setOpen(false)} items={items} label={label} />
    </>
  )
}
