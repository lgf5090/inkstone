/**
 * A time-zone field that can be typed into, not only scrolled.
 *
 * The IANA list is about four hundred entries; a native select makes a reader hunt through all of
 * them. The datalist keeps the same underlying value and lets the browser filter suggestions, while
 * the component only commits a zone the runtime recognises. An invalid draft is abandoned on blur.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { Input } from '../../components/form'
import { supportedTimeZones } from './timezone'

interface CalendarTimeZoneFieldProps {
  id?: string
  value: string
  label: string
  onChange: (zone: string) => void
  allowEmpty?: boolean
  disabled?: boolean
  className?: string
  placeholder?: string
}

export function CalendarTimeZoneField({
  id,
  value,
  label,
  onChange,
  allowEmpty = false,
  disabled = false,
  className,
  placeholder,
}: CalendarTimeZoneFieldProps) {
  const listId = useId()
  const zones = useMemo(supportedTimeZones, [])
  const [draft, setDraft] = useState(value)

  useEffect(() => setDraft(value), [value])

  const commit = (next: string): void => {
    if (next === value) return
    if (next === '' && allowEmpty) {
      onChange('')
      return
    }
    if (zones.includes(next)) onChange(next)
  }

  return (
    <>
      <Input
        id={id}
        className={className}
        list={listId}
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          commit(next)
        }}
        onBlur={() => setDraft(value)}
      />
      <datalist id={listId}>
        {zones.map(zone => <option key={zone} value={zone} />)}
      </datalist>
    </>
  )
}
