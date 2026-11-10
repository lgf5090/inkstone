import { useRef, useState, type ReactElement } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import type { ProjectProperty, ProjectPropertyType } from '@shared/project/model'
import { newProjectId } from '@shared/project/limits'
import { PROJECT_OPTION_COLORS, projectOptionColorName, projectOptionCssColor } from '@shared/project/option-color'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Input, Select } from '../../components/form'
import { Menu, Modal, type MenuItem } from '../../components/overlay'

const EDITABLE_TYPES: ProjectPropertyType[] = ['text', 'number', 'select', 'multiSelect', 'date', 'person', 'checkbox', 'url', 'email', 'phone']
const OPTION_TYPES = new Set(['select', 'multiSelect'])

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

  const update = (id: string, patch: Partial<ProjectProperty>) => {
    setDraft((current) => current.map((property) => (property.id === id ? { ...property, ...patch } : property)))
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
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('project.props.title')}
      width={640}
      footer={<>
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
              <Select className="w-32" value={property.type} aria-label={t('project.props.type')} onChange={(event) => update(property.id, { type: event.target.value as ProjectPropertyType })}>
                {EDITABLE_TYPES.map((type) => <option key={type} value={type}>{t(`project.prop.type.${type.toLowerCase()}` as Parameters<typeof t>[0])}</option>)}
              </Select>
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
          </div>
        ))}
        <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
          <Input className="min-w-0 flex-1" value={newName} placeholder={t('project.props.name')} aria-label={t('project.props.name')} onChange={(event) => setNewName(event.target.value)} />
          <Select className="w-32" value={newType} aria-label={t('project.props.type')} onChange={(event) => setNewType(event.target.value as ProjectPropertyType)}>
            {EDITABLE_TYPES.map((type) => <option key={type} value={type}>{t(`project.prop.type.${type.toLowerCase()}` as Parameters<typeof t>[0])}</option>)}
          </Select>
          <Button size="sm" variant="primary" icon={<Plus size={14} />} disabled={!newName.trim()} onClick={addProperty}>{t('project.props.add')}</Button>
        </div>
      </div>
    </Modal>
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
