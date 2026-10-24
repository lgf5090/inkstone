import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from 'react'
import { Mail, User, Users, X } from 'lucide-react'
import type { EmailContact, EmailGroupWithMembers } from '@shared/email/contacts'
import { EMAIL_CONTACT_EMAIL_MAX_CHARS, EMAIL_CONTACT_QUERY_MAX_CHARS } from '@shared/email/contacts'
import { EMAIL_RECIPIENTS_MAX } from '@shared/email/model'
import { isValidEmailAddress, normalizeEmailAddress, splitEmailList } from '@shared/email/format'
import { TagChip } from '../../components/TagChip'
import { Spinner } from '../../components/primitives'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { isImeComposing } from '../../lib/ime'
import { api } from '../../lib/api'
import { detectTrigger } from '../chat/ComposerTriggers'
import { emailErrorText } from './errors'

const CONTACT_DEBOUNCE_MS = 200
const OPTION_LIMIT = 8

interface RecipientEntry {
  email: string
  label: string
}

interface AppliedGroup {
  id: string
  name: string
  emails: string[]
}

type RecipientOption =
  | { id: string; kind: 'address'; email: string; label: string }
  | { id: string; kind: 'contact'; email: string; label: string; hint: string }
  | { id: string; kind: 'group'; group: EmailGroupWithMembers }

function parseRecipientEntry(raw: string): RecipientEntry | null {
  const value = raw.trim()
  if (!value) return null
  const named = /^(.*?)<([^<>]+)>$/.exec(value)
  const address = (named?.[2] ?? value).trim()
  if (!isValidEmailAddress(address)) return null
  const name = named?.[1]?.trim().replace(/^"|"$/g, '') ?? ''
  return { email: normalizeEmailAddress(address), label: name || address }
}

function parseRecipientValue(value: string): RecipientEntry[] {
  const seen = new Set<string>()
  const entries: RecipientEntry[] = []
  for (const raw of splitEmailList(value)) {
    const entry = parseRecipientEntry(raw)
    if (!entry || seen.has(entry.email)) continue
    seen.add(entry.email)
    entries.push(entry)
  }
  return entries
}

function formatRecipientValue(entries: RecipientEntry[]): string {
  return entries.map((entry) => entry.email).join(', ')
}

function contactEntry(contact: EmailContact): RecipientEntry {
  return {
    email: normalizeEmailAddress(contact.email),
    label: contact.name.trim() || contact.email,
  }
}

export interface RecipientFieldProps {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
  'aria-required'?: boolean
}

export function RecipientField({
  id,
  value,
  onChange,
  placeholder,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-required': ariaRequired,
}: RecipientFieldProps) {
  const baseId = useId()
  const listId = `${baseId}-listbox`
  const messageId = `${baseId}-message`
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  const groupsRequest = useRef(0)
  const groupsLoaded = useRef(false)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [appliedGroups, setAppliedGroups] = useState<AppliedGroup[]>([])
  const [contacts, setContacts] = useState<EmailContact[]>([])
  const [contactsStatus, setContactsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [contactsError, setContactsError] = useState<string | null>(null)
  const [contactsRetry, setContactsRetry] = useState(0)
  const [groups, setGroups] = useState<EmailGroupWithMembers[] | null>(null)
  const [groupsStatus, setGroupsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [groupsError, setGroupsError] = useState<string | null>(null)
  const [groupsRetry, setGroupsRetry] = useState(0)

  useEffect(() => {
    valueRef.current = value
  }, [value])

  const entries = useMemo(() => parseRecipientValue(value), [value])
  const selectedEmails = useMemo(() => new Set(entries.map((entry) => entry.email)), [entries])
  const trigger = detectTrigger(query, query.length)
  const groupMode = trigger?.sigil === '@'
  const groupQuery = groupMode ? (trigger?.query ?? '').toLocaleLowerCase() : ''
  const searchTerm = groupMode ? '' : query.trim()
  const showList = open && query.trim().length > 0

  useEffect(() => {
    if (!searchTerm || searchTerm.length > EMAIL_CONTACT_QUERY_MAX_CHARS) {
      setContacts([])
      setContactsStatus('idle')
      setContactsError(null)
      return
    }
    let cancelled = false
    setContacts([])
    setContactsStatus('loading')
    setContactsError(null)
    const handle = window.setTimeout(() => {
      api.email.listContacts(searchTerm).then(
        (rows) => {
          if (cancelled) return
          setContacts(rows)
          setContactsStatus('ready')
          setActive(0)
        },
        (reason: unknown) => {
          if (cancelled) return
          setContactsStatus('error')
          setContactsError(emailErrorText(reason))
        },
      )
    }, CONTACT_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [searchTerm, contactsRetry])

  useEffect(() => {
    if (!groupMode || groupsLoaded.current) return
    const request = ++groupsRequest.current
    setGroupsStatus('loading')
    setGroupsError(null)
    api.email.listGroups().then(
      (rows) => {
        if (request !== groupsRequest.current) return
        groupsLoaded.current = true
        setGroups(rows)
        setGroupsStatus('ready')
        setActive(0)
      },
      (reason: unknown) => {
        if (request !== groupsRequest.current) return
        setGroupsStatus('error')
        setGroupsError(emailErrorText(reason))
      },
    )
  }, [groupMode, groupsRetry])

  useEffect(() => {
    setAppliedGroups((groupsState) => {
      const next = groupsState.filter((group) => group.emails.some((email) => selectedEmails.has(email)))
      return next.length === groupsState.length ? groupsState : next
    })
  }, [selectedEmails])

  useEffect(() => {
    if (!showList) return
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, showList])

  const rememberLabels = (adds: RecipientEntry[]) => {
    const named = adds.filter((entry) => entry.label !== entry.email)
    if (!named.length) return
    setLabels((current) => {
      const next = { ...current }
      for (const entry of named) next[entry.email] = entry.label
      return next
    })
  }

  const commit = (adds: RecipientEntry[], group?: EmailGroupWithMembers) => {
    const current = parseRecipientValue(valueRef.current)
    const seen = new Set(current.map((entry) => entry.email))
    const next = [...current]
    let limited = false
    for (const entry of adds) {
      if (seen.has(entry.email)) continue
      if (next.length >= EMAIL_RECIPIENTS_MAX) {
        limited = true
        break
      }
      seen.add(entry.email)
      next.push(entry)
    }
    rememberLabels([...current, ...adds])
    if (next.length !== current.length) {
      const nextValue = formatRecipientValue(next)
      valueRef.current = nextValue
      onChange(nextValue)
    }
    if (group) {
      setAppliedGroups((groupsState) => [
        ...groupsState.filter((entry) => entry.id !== group.id),
        { id: group.id, name: group.name, emails: group.members.map((member) => normalizeEmailAddress(member.email)) },
      ])
    }
    setQuery('')
    setOpen(false)
    setActive(0)
    setMessage(limited ? t('email.recipients.limit', { max: EMAIL_RECIPIENTS_MAX }) : null)
    inputRef.current?.focus()
  }

  const commitTyped = () => {
    const raw = query.trim()
    if (!raw) return
    const entry = parseRecipientEntry(raw)
    if (!entry) {
      setMessage(t('email.recipients.invalid', { value: raw }))
      return
    }
    commit([entry])
  }

  const chooseGroup = (group: EmailGroupWithMembers) => {
    if (!group.members.length) {
      setMessage(t('email.recipients.group_empty'))
      return
    }
    commit(group.members.map(contactEntry), group)
  }

  const pick = (option: RecipientOption) => {
    if (option.kind === 'address') commit([{ email: option.email, label: option.email }])
    else if (option.kind === 'contact') commit([{ email: option.email, label: option.label }])
    else chooseGroup(option.group)
  }

  const options = useMemo<RecipientOption[]>(() => {
    if (groupMode) {
      return (groups ?? [])
        .filter((group) => !groupQuery
          || group.name.toLocaleLowerCase().includes(groupQuery)
          || group.description.toLocaleLowerCase().includes(groupQuery))
        .slice(0, OPTION_LIMIT)
        .map((group) => ({ id: `group-${group.id}`, kind: 'group', group }))
    }
    const rows: RecipientOption[] = []
    const typed = parseRecipientEntry(query)
    if (typed) rows.push({ id: `address-${typed.email}`, kind: 'address', email: typed.email, label: typed.label })
    for (const contact of contacts) {
      const email = normalizeEmailAddress(contact.email)
      if (!isValidEmailAddress(email) || selectedEmails.has(email) || email === typed?.email) continue
      rows.push({
        id: `contact-${contact.id}`,
        kind: 'contact',
        email,
        label: contact.name.trim() || contact.email,
        hint: contact.email,
      })
      if (rows.length >= OPTION_LIMIT) break
    }
    return rows
  }, [groupMode, groups, groupQuery, query, contacts, selectedEmails])

  const busy = groupMode
    ? groupsStatus === 'loading' || (groupsStatus === 'idle' && !groupsLoaded.current)
    : contactsStatus === 'loading'
  const loadError = groupMode ? groupsError : contactsError
  const emptyLabel = groupMode ? t('email.recipients.no_groups') : t('email.recipients.no_contacts')
  const listLabel = groupMode ? t('email.recipients.groups_label') : t('email.recipients.suggestions')
  const optionId = (index: number) => `${baseId}-option-${index}`

  const removeEntry = (email: string) => {
    const next = parseRecipientValue(valueRef.current).filter((entry) => entry.email !== email)
    valueRef.current = formatRecipientValue(next)
    onChange(valueRef.current)
    setMessage(null)
    inputRef.current?.focus()
  }

  const removeAppliedGroup = (groupId: string) => {
    const group = appliedGroups.find((entry) => entry.id === groupId)
    if (!group) return
    const members = new Set(group.emails)
    const next = parseRecipientValue(valueRef.current).filter((entry) => !members.has(entry.email))
    valueRef.current = formatRecipientValue(next)
    onChange(valueRef.current)
    setAppliedGroups((groupsState) => groupsState.filter((entry) => entry.id !== groupId))
    setMessage(null)
    inputRef.current?.focus()
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value
    setMessage(null)
    if (/[,;]/.test(next)) {
      const parts = next.split(/[,;]/)
      const tail = parts.pop() ?? ''
      const adds: RecipientEntry[] = []
      const invalid: string[] = []
      for (const part of parts) {
        const raw = part.trim()
        if (!raw) continue
        const entry = parseRecipientEntry(raw)
        if (entry) adds.push(entry)
        else invalid.push(raw)
      }
      if (adds.length) commit(adds)
      setQuery(tail.trimStart())
      setOpen(Boolean(tail.trim()))
      setActive(0)
      if (invalid.length) setMessage(t('email.recipients.invalid', { value: invalid[0]! }))
      return
    }
    setQuery(next)
    setOpen(Boolean(next.trim()))
    setActive(0)
  }

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text')
    if (!/[,;\n]/.test(text)) return
    const adds: RecipientEntry[] = []
    const invalid: string[] = []
    const parts = text.split(/\r?\n/).flatMap((line) => splitEmailList(line))
    for (const part of parts) {
      const raw = part.trim()
      if (!raw) continue
      const entry = parseRecipientEntry(raw)
      if (entry) adds.push(entry)
      else invalid.push(raw)
    }
    if (!adds.length && !invalid.length) return
    event.preventDefault()
    commit(adds)
    if (invalid.length) setMessage(t('email.recipients.invalid', { value: invalid[0]! }))
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return
    if (event.key === 'Escape') {
      if (showList) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        return
      }
      if (query) {
        event.preventDefault()
        event.stopPropagation()
        setQuery('')
        setMessage(null)
        return
      }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!showList || !options.length) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) => (current + step + options.length) % options.length)
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (showList && options.length) {
        event.preventDefault()
        pick(options[Math.min(active, options.length - 1)]!)
        return
      }
      if (query.trim()) {
        if (event.key === 'Enter') event.preventDefault()
        commitTyped()
      }
      return
    }
    if (event.key === 'Backspace' && !query) {
      if (visibleEntries.length) {
        event.preventDefault()
        removeEntry(visibleEntries[visibleEntries.length - 1]!.email)
        return
      }
      const lastGroup = visibleGroups[visibleGroups.length - 1]
      if (!lastGroup) return
      event.preventDefault()
      removeAppliedGroup(lastGroup.id)
      return
    }
  }

  const visibleGroups = appliedGroups
    .map((group) => ({ ...group, present: group.emails.filter((email) => selectedEmails.has(email)).length }))
    .filter((group) => group.present > 0)
  const coveredEmails = new Set(
    visibleGroups.flatMap((group) => group.emails.filter((email) => selectedEmails.has(email))),
  )
  const visibleEntries = entries.filter((entry) => !coveredEmails.has(entry.email))

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
        setOpen(false)
      }}
    >
      <div className="flex min-h-11 w-full flex-wrap items-center gap-1 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-1.5 py-1 transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)] focus-within:border-[var(--accent)] focus-within:shadow-[var(--shadow-ring-focus)] md:min-h-[34px]">
        {visibleGroups.map((group) => (
          <TagChip
            key={`group-${group.id}`}
            label={group.name}
            count={group.present}
            countFormat="paren"
            glyph={<Users size={11} />}
            trailing={<X size={9} className="shrink-0" />}
            onPress={() => removeAppliedGroup(group.id)}
            ariaLabel={t('email.recipients.remove_group', { name: group.name })}
          />
        ))}
        {visibleEntries.map((entry) => (
          <TagChip
            key={entry.email}
            label={labels[entry.email] ?? entry.label}
            trailing={<X size={9} className="shrink-0" />}
            onPress={() => removeEntry(entry.email)}
            ariaLabel={t('email.recipients.remove', { address: entry.email })}
          />
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          value={query}
          onChange={handleChange}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (query.trim()) setOpen(true)
          }}
          aria-label={ariaLabelledBy ? undefined : (ariaLabel ?? t('email.recipients.label'))}
          aria-labelledby={ariaLabelledBy}
          aria-required={ariaRequired || undefined}
          aria-invalid={message ? true : undefined}
          aria-describedby={[ariaDescribedBy, message ? messageId : undefined].filter(Boolean).join(' ') || undefined}
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={showList && options[active] ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={EMAIL_CONTACT_EMAIL_MAX_CHARS}
          placeholder={entries.length || visibleGroups.length ? undefined : placeholder}
          className="h-7 min-w-[8rem] flex-1 border-0 bg-transparent px-1 text-[length:var(--text-13)] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] focus:outline-none"
        />
      </div>
      {message && (
        <p id={messageId} role="alert" className="mt-1 text-[length:var(--text-11-5)] text-[var(--danger)]">
          {message}
        </p>
      )}
      {showList && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={listLabel}
          aria-busy={busy}
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-[var(--z-pop)] max-h-64 overflow-y-auto rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)]"
        >
          {busy && (
            <p role="status" className="flex items-center gap-2 px-2.5 py-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">
              <Spinner size={12} />
              {t('common.loading')}
            </p>
          )}
          {!busy && loadError && (
            <div role="alert" className="flex flex-wrap items-center gap-2 px-2.5 py-2 text-[length:var(--text-12)] text-[var(--danger)]">
              <span className="min-w-0 flex-1">
                <span className="block">{groupMode ? t('email.recipients.groups_error') : t('email.recipients.contacts_error')}</span>
                <span className="mt-0.5 block text-[length:var(--text-11)] text-[var(--text-tertiary)]">{loadError}</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  if (groupMode) setGroupsRetry((current) => current + 1)
                  else setContactsRetry((current) => current + 1)
                }}
                className="shrink-0 rounded-[var(--r-sm)] px-1.5 py-0.5 font-medium text-[var(--accent-on-soft)] hover:bg-[var(--accent-soft)]"
              >
                {t('common.retry')}
              </button>
            </div>
          )}
          {!busy && !loadError && !options.length && (
            <p className="px-2.5 py-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{emptyLabel}</p>
          )}
          {!loadError && options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              id={optionId(index)}
              aria-selected={index === active}
              data-row={index}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(option)}
              className={cn(
                'flex w-full items-center gap-2 rounded-[var(--r-md)] px-2.5 py-1.5 text-left text-[length:var(--text-12-5)]',
                index === active
                  ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              {option.kind === 'group'
                ? <Users size={13} className="shrink-0" />
                : option.kind === 'contact'
                  ? <User size={13} className="shrink-0" />
                  : <Mail size={13} className="shrink-0" />}
              <span className="min-w-0 flex-1 truncate">
                {option.kind === 'group' ? option.group.name : option.kind === 'contact' ? option.label : option.email}
              </span>
              <span className="shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                {option.kind === 'group'
                  ? t('email.recipients.member_count', { count: option.group.members.length })
                  : option.kind === 'contact'
                    ? option.hint
                    : t('email.recipients.add_address')}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
