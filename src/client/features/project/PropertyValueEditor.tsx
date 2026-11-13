import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { ProjectBoardMember, ProjectCard, ProjectPeople, ProjectProperty } from '@shared/project/model'
import { projectMultiValueIds, projectPersonLabel } from '@shared/project/model'
import { moveProjectDateValue, parseProjectDateValue, projectInputToStamp, projectStampToInput, projectTimeZoneName } from '@shared/project/date'
import { projectPropertyDisplayText } from '@shared/project/view-eval'
import { useLocale } from '../../lib/i18n'
import { Avatar } from '../../components/primitives'
import { Checkbox, commitOnEnter, Input } from '../../components/form'
import { isImeComposing } from '../../lib/ime'
import { SelectMenu } from '../../components/select-menu'
import { useSession } from '../../store/session'
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
  people?: ProjectPeople
}

function readDateFrom(value: string): string {
  const parsed = parseProjectDateValue(value)
  if (parsed?.from === undefined) return ''
  return projectStampToInput(parsed.from, parsed.includeTime === true, parsed.timeZone)
}

export function PropertyValueEditor({ property, value, members, disabled, onChange, card, onDone, people }: PropertyValueEditorProps): ReactElement {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const self = useSession((state) => state.user)
  const locale = useLocale()

  /** The roster plus the reader: an open board lets an editor assign themselves before they join. */
  const directory = useMemo<ProjectPeople>(() => {
    if (!self || people?.[self.id]) return people ?? {}
    return { ...people, [self.id]: { id: self.id, name: self.name, avatarUrl: self.avatarUrl } }
  }, [people, self])
  const candidates = useMemo(() => {
    const ids = members.map((member) => member.userId)
    if (self && !ids.includes(self.id)) ids.push(self.id)
    return ids
  }, [members, self])

  const personFace = (userId: string): ReactElement => (
    <span className="flex min-w-0 items-center gap-1.5">
      <Avatar src={directory[userId]?.avatarUrl} name={projectPersonLabel(directory, userId)} size={18} />
      <span className="truncate">{projectPersonLabel(directory, userId)}</span>
    </span>
  )

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
      const selected = projectMultiValueIds(value)
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
      const selected = projectMultiValueIds(value)
      return (
        <div className="flex flex-wrap gap-2">
          {candidates.length === 0 && <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">—</span>}
          {candidates.map((userId) => (
            <Checkbox
              key={userId}
              label={personFace(userId)}
              checked={selected.includes(userId)}
              disabled={disabled}
              onChange={(checked) => {
                const next = checked ? [...selected, userId] : selected.filter((id) => id !== userId)
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
            const timeZone = current?.timeZone ?? projectTimeZoneName()
            const from = raw ? projectInputToStamp(raw, current?.includeTime === true, timeZone) : null
            if (from === null) { onChange(null); return }
            const next = moveProjectDateValue(current ?? {}, from)
            next.timeZone ??= timeZone
            onChange(JSON.stringify(next))
          }}
        />
      )
    case 'person':
      return (
        <SelectMenu className="w-full" value={value} disabled={disabled} label={property.name} onChange={(next) => onChange(next === '' ? null : next)} options={[{ value: '', label: '—' }, ...candidates.map((userId) => ({ value: userId, label: projectPersonLabel(directory, userId), icon: <Avatar src={directory[userId]?.avatarUrl} name={projectPersonLabel(directory, userId)} size={18} /> }))]} />
      )
    case 'formula':
      return <span className="text-[length:var(--text-12)] text-[var(--text-secondary)] tabular">{value || '—'}</span>
    case 'createdBy':
    case 'updatedBy':
    case 'createdTime':
    case 'updatedTime':
      return <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{(card ? projectPropertyDisplayText(card, property, directory, locale) : value) || '—'}</span>
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