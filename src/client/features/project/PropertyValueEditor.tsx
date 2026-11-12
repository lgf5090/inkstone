import { useEffect, useState, type ReactElement } from 'react'
import type { ProjectBoardMember, ProjectCard, ProjectProperty } from '@shared/project/model'
import { moveProjectDateValue, parseProjectDateValue, projectInputToStamp, projectStampToInput } from '@shared/project/date'
import { projectPropertyDisplayText } from '@shared/project/view-eval'
import { Checkbox, commitOnEnter, Input } from '../../components/form'
import { isImeComposing } from '../../lib/ime'
import { SelectMenu } from '../../components/select-menu'
import { optionDot } from './CardBadges'
import { DatePicker } from '../../components/date-picker'

interface PropertyValueEditorProps {
  property: ProjectProperty
  value: string
  members: ProjectBoardMember[]
  disabled: boolean
  onChange: (value: string | null) => void
  /** The four server-stamped types live on the card, not in `values`, so they need the card to read. */
  card?: ProjectCard
  /** Called when the reader is finished, whether or not the value changed, so an editor can close. */
  onDone?: () => void
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
  const parsed = parseProjectDateValue(value)
  if (parsed?.from === undefined) return ''
  return projectStampToInput(parsed.from, parsed.includeTime === true)
}

export function PropertyValueEditor({ property, value, members, disabled, onChange, card, onDone }: PropertyValueEditorProps): ReactElement {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])

  // An unchanged value still ends the edit: without this, Enter and blur on a cell the reader only
  // looked at left the editor open with no way out.
  const commitText = () => {
    if (draft !== value) onChange(draft === '' ? null : draft)
    else onDone?.()
  }

  switch (property.type) {
    case 'select':
      return (
        <SelectMenu className="w-full" value={value} disabled={disabled} label={property.name} onChange={(next) => onChange(next === '' ? null : next)} options={[{ value: '', label: '—' }, ...property.options.map((option) => ({ value: option.id, label: option.value, icon: optionDot(option.color) }))]} />
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
    case 'multiPerson': {
      const selected = readMulti(value)
      return (
        <div className="flex flex-wrap gap-2">
          {members.length === 0 && <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">—</span>}
          {members.map((member) => (
            <Checkbox
              key={member.userId}
              label={member.userId}
              checked={selected.includes(member.userId)}
              disabled={disabled}
              onChange={(checked) => {
                const next = checked ? [...selected, member.userId] : selected.filter((id) => id !== member.userId)
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
            const current = parseProjectDateValue(value)
            const from = raw ? projectInputToStamp(raw, current?.includeTime === true) : null
            if (from === null) { onChange(null); return }
            onChange(JSON.stringify(moveProjectDateValue(current ?? {}, from)))
          }}
        />
      )
    case 'person':
      return (
        <SelectMenu className="w-full" value={value} disabled={disabled} label={property.name} onChange={(next) => onChange(next === '' ? null : next)} options={[{ value: '', label: '—' }, ...members.map((member) => ({ value: member.userId, label: member.userId }))]} />
      )
    case 'createdBy':
    case 'updatedBy':
    case 'createdTime':
    case 'updatedTime':
      return <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{(card ? projectPropertyDisplayText(card, property) : value) || '—'}</span>
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
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !isImeComposing(event)) { event.preventDefault(); onDone?.(); return }
            commitOnEnter(event, commitText)
          }}
        />
      )
  }
}