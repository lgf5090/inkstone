import { useEffect, useState, type ReactElement } from 'react'
import type { ProjectBoardMember, ProjectProperty } from '@shared/project/model'
import { Checkbox, commitOnEnter, Input, Select } from '../../components/form'
import { DatePicker } from '../../components/date-picker'

interface PropertyValueEditorProps {
  property: ProjectProperty
  value: string
  members: ProjectBoardMember[]
  disabled: boolean
  onChange: (value: string | null) => void
}

function readMulti(value: string): string[] {
  if (!value.trim().startsWith('[')) return value ? [value] : []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function readDateFrom(value: string): string {
  if (!value) return ''
  try {
    const parsed: unknown = JSON.parse(value)
    const from = (parsed as { from?: number })?.from
    if (typeof from === 'number') return new Date(from).toISOString().slice(0, 10)
  } catch {
    const stamp = Number(value)
    if (Number.isFinite(stamp)) return new Date(stamp).toISOString().slice(0, 10)
  }
  return ''
}

export function PropertyValueEditor({ property, value, members, disabled, onChange }: PropertyValueEditorProps): ReactElement {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])

  const commitText = () => {
    if (draft !== value) onChange(draft === '' ? null : draft)
  }

  switch (property.type) {
    case 'select':
      return (
        <Select className="w-full" value={value} disabled={disabled} aria-label={property.name} onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}>
          <option value="">—</option>
          {property.options.map((option) => <option key={option.id} value={option.id}>{option.value}</option>)}
        </Select>
      )
    case 'multiSelect': {
      const selected = readMulti(value)
      return (
        <div className="flex flex-wrap gap-2">
          {property.options.map((option) => (
            <Checkbox
              key={option.id}
              label={option.value}
              checked={selected.includes(option.id)}
              disabled={disabled}
              onChange={(checked) => {
                const next = checked ? [...selected, option.id] : selected.filter((id) => id !== option.id)
                onChange(next.length ? JSON.stringify(next) : null)
              }}
            />
          ))}
        </div>
      )
    }
    case 'checkbox':
      return <Checkbox ariaLabel={property.name} checked={value === 'true'} disabled={disabled} onChange={(checked) => onChange(checked ? 'true' : 'false')} />
    case 'date':
      return (
        <DatePicker
          className="w-full"
          label={property.name}
          value={readDateFrom(value)}
          onChange={(raw) => {
            if (!raw) onChange(null)
            else onChange(JSON.stringify({ from: new Date(`${raw}T00:00:00`).getTime() }))
          }}
        />
      )
    case 'person':
      return (
        <Select className="w-full" value={value} disabled={disabled} aria-label={property.name} onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}>
          <option value="">—</option>
          {members.map((member) => <option key={member.userId} value={member.userId}>{member.userId}</option>)}
        </Select>
      )
    case 'createdBy':
    case 'updatedBy':
    case 'createdTime':
    case 'updatedTime':
      return <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{value || '—'}</span>
    default:
      return (
        <Input
          className="w-full"
          value={draft}
          disabled={disabled}
          aria-label={property.name}
          inputMode={property.type === 'number' ? 'decimal' : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => commitOnEnter(event, commitText)}
        />
      )
  }
}