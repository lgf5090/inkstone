/**
 * The syntax reference, inside the app that has the syntax.
 *
 * Upstream's documentation lives on a separate site, so a reader who wants to know what `tp.file.move` takes
 * has to leave the note they are writing. Here the same table the completion popup and the capability gate
 * read is what this panel draws — one source, three surfaces, and no chance of the docs saying something the
 * engine does not.
 *
 * Two things it is deliberately not:
 *
 * - It is not a second list of functions. `reference/registry.ts` is the only table; this file only decides
 *   how to show it, so a function added there appears here without a change to this file.
 * - It is not a promise about a run. The "as which run" switch shows what a member *would* be allowed to
 *   reach under that profile, which is the reader's own setting read back to them — not a preview of some
 *   other template's rights.
 *
 * Every row is a disclosure: the button carries the name and the one-line description, and the region under
 * it carries the call, the parameters, the return, the examples, and the reason a member is greyed out. That
 * keeps the whole list on one keyboard path — no second pane to reach, nothing that only a mouse can open.
 */
import { useMemo, useState } from 'react'
import type { CapabilityProfile } from '../../lib/templater/protocol'
import { capabilitiesFor } from '../../lib/templater/protocol'
import {
  REFERENCE_ENTRIES,
  REFERENCE_MODULES,
  referenceIsAvailable,
  referenceIsMember,
  referenceMemberPath,
  type ReferenceDocEntry,
} from '../../lib/templater/reference/registry'
import { Modal } from '../../components/overlay'
import { Segmented } from '../../components/form'
import { FilterInput } from '../../components/FilterInput'
import { compileQuery, queryKeeps } from '../../lib/query-match'
import { usePinyinVersion } from '../../lib/pinyin'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import type { MessageKey } from '@shared/locales/en-US'

/** The three run shapes a reader can actually cause from this app, in the order the switch offers them. */
const PROFILES: Array<{ id: CapabilityProfile, labelKey: MessageKey }> = [
  { id: 'local', labelKey: 'templater.ref.profile_local' },
  { id: 'community', labelKey: 'templater.ref.profile_community' },
  { id: 'startup', labelKey: 'templater.ref.profile_startup' },
]

export function TemplateReference({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [profile, setProfile] = useState<CapabilityProfile>('local')
  const [expanded, setExpanded] = useState<string | null>(null)
  const pinyinVersion = usePinyinVersion()
  const capabilities = useMemo(() => capabilitiesFor(profile), [profile])
  const compiled = useMemo(() => compileQuery(query), [query, pinyinVersion])
  const groups = useMemo(() => {
    // Names only. A fuzzy box is a subsequence match, and a description is long enough that almost every one
    // of them contains the letters of any word typed into it — searching the prose turns the box into a no-op.
    const subject = (entry: ReferenceDocEntry): string => referenceMemberPath(entry)
    const kept = REFERENCE_ENTRIES.filter((entry) => queryKeeps(compiled, subject(entry)))
    return REFERENCE_MODULES
      .map((module) => ({ module, entries: kept.filter((entry) => entry.module === module.module) }))
      .filter((group) => group.entries.length > 0)
  }, [compiled, pinyinVersion])
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('templater.ref.title')}
      description={t('templater.ref.hint')}
      width={680}>
      <div className="space-y-2 pb-1">
        <FilterInput
          data-autofocus
          value={query}
          onChange={setQuery}
          query={compiled}
          label={t('templater.ref.filter')}
          placeholder={t('templater.ref.filter')}
          size="panel"
          escapeWhenEmpty="release"/>
        <Segmented
          label={t('templater.ref.profile')}
          size="sm"
          value={profile}
          options={PROFILES.map((option) => ({ value: option.id, label: t(option.labelKey) }))}
          onChange={setProfile}/>
      </div>
      {query.trim() !== '' && (
        <p className="pb-1 text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">
          {t('templater.ref.matches', { value0: String(total) })}
        </p>
      )}
      {groups.length === 0 && (
        <p className="py-6 text-center text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('templater.ref.none')}</p>
      )}
      <div className="max-h-[52vh] space-y-4 overflow-y-auto pr-1">
        {groups.map((group) => (
          <section key={group.module.module} aria-label={`tp.${group.module.module}`}>
            <h3 className="text-[length:var(--text-12)] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {`tp.${group.module.module}`}
            </h3>
            <p className="mt-0.5 mb-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
              {t(group.module.descriptionKey)}
            </p>
            <ul className="space-y-1">
              {group.entries.map((entry) => (
                <ReferenceRow
                  key={`${entry.module}.${entry.name}`}
                  entry={entry}
                  dynamicModule={group.module.dynamic}
                  capabilities={capabilities}
                  expanded={expanded === `${entry.module}.${entry.name}`}
                  onToggle={() => setExpanded((current) => (
                    current === `${entry.module}.${entry.name}` ? null : `${entry.module}.${entry.name}`
                  ))}/>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  )
}

function ReferenceRow({
  entry,
  dynamicModule,
  capabilities,
  expanded,
  onToggle,
}: {
  entry: ReferenceDocEntry
  dynamicModule: boolean
  capabilities: ReturnType<typeof capabilitiesFor>
  expanded: boolean
  onToggle: () => void
}) {
  const available = referenceIsAvailable(entry, capabilities)
  const id = `${entry.module}.${entry.name}`
  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={`ref-${id}`}
        onClick={onToggle}
        className={cn(
          'flex w-full items-baseline gap-2 rounded-[var(--r-md)] px-2 py-1.5 text-left',
          'transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] focus-visible:outline-none',
          available ? 'text-[var(--text-primary)]' : 'text-[var(--text-quaternary)]',
        )}>
        <span className="min-w-0 shrink font-mono text-[length:var(--text-12-5)]">
          {referenceIsMember(entry) ? referenceMemberPath(entry) : `tp.${entry.module}`}
        </span>
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {t(entry.descriptionKey)}
        </span>
        {!available && (
          <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t('templater.ref.blocked')}
          </span>
        )}
      </button>
      {expanded && (
        <div id={`ref-${id}`} className="mb-1 mt-0.5 space-y-1 rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-2">
          <p className="font-mono text-[length:var(--text-12)] text-[var(--text-primary)]">{entry.signature}</p>
          <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">{t(entry.descriptionKey)}</p>
          {entry.args.map((arg) => (
            <p key={arg.name} className="text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
              <span className="font-mono">{arg.name}</span>
              {': '}
              {t(arg.descriptionKey)}
            </p>
          ))}
          {entry.returnsKey && (
            <p className="text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
              <span className="font-medium">{t('templater.ref.returns')}</span>
              {': '}
              {t(entry.returnsKey)}
            </p>
          )}
          {entry.examples.map((example) => (
            <pre key={example} className="overflow-x-auto rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1 font-mono text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
              <code>{example}</code>
            </pre>
          ))}
          {dynamicModule && (
            <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('templater.ref.open_ended')}</p>
          )}
          {!available && (
            <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
              {t('templater.ref.blocked_reason', { value0: t('templater.error.capability_blocked') })}
            </p>
          )}
        </div>
      )}
    </li>
  )
}
