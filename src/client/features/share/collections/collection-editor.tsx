/**
 * Publishing a directory, and changing one that is already published.
 *
 * The shape of this form is the shape of the route behind it, and the places where the two agree are the
 * places a UI would otherwise promise something the server cannot give:
 *
 * - a folder or tag is addressed by its *record id* (`targetValue`), never by its name. `shares.tags` holds
 *   names and `share_collections.target_value` holds ids, and `resolveShareTarget()` is the only bridge —
 *   writing the name here would publish a page that matches nothing, which is a real past failure;
 * - the label is optional for a folder or a tag, because a derived page prints the live name of its
 *   target, and a title typed here would freeze that name against the next rename;
 * - a hand-picked set has no order control, because it has no derived members: the roster's own order is
 *   the order the page lists, and the four named sorts move a folder or tag page only;
 * - the passcode travels as plain text to a route that hashes it before it stores anything, and it is sent
 *   only when it changed. Nothing here keeps a copy of it, prints it back, or puts it in an address.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { LIMITS } from '@shared/constants'
import type { ShareCollection, ShareFolder, ShareTag } from '@shared/share-hub'
import type { ShareListItem } from '@shared/types'
import { Button } from '../../../components/primitives'
import { Checkbox, Field, Input, Segmented, Select, Switch } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { DatePicker } from '../../../components/date-picker'
import { shareHubApi } from '../../../lib/api-share-hub'
import { t } from '../../../lib/i18n'
import { dateKey, endOfDay, parseDateKey } from '../../../lib/time'

/** The three kinds of directory the route answers for. */
const KINDS = ['folder', 'tag', 'manual'] as const

type CollectionKind = (typeof KINDS)[number]

/** The orders a derived page can be listed with; `default` is the shipped one. */
const MEMBER_SORTS = ['default', 'newest', 'oldest', 'title'] as const

type MemberSort = (typeof MEMBER_SORTS)[number]

/** The longest label a directory can be given — the route's own ceiling, refused here before a 400. */
const TITLE_MAX = 200

/**
 * How many links one hand-picked directory may name.
 *
 * Mirrors `MAX_BATCH_SHARE_IDS` in the worker, which is the ceiling `shareBatchNoteIds` enforces. The
 * client cannot import that module — it is server code — so the number is a named constant here and the
 * route's own refusal remains the last word.
 */
const MAX_MANUAL_MEMBERS = 200

export function CollectionEditorDialog({ folders, tags, shares, initial, onClose, onSaved }: {
  folders: ShareFolder[]
  tags: ShareTag[]
  shares: ShareListItem[]
  /** The collection being changed; absent for a new publish. */
  initial?: ShareCollection | null
  onClose: () => void
  onSaved: (slug: string) => void
}) {
  const editing = initial ?? null
  const [kind, setKind] = useState<CollectionKind>(editing ? editing.targetType : 'folder')
  const [folderId, setFolderId] = useState(editing?.targetType === 'folder' ? editing.targetValue : '')
  const [tagId, setTagId] = useState(editing?.targetType === 'tag' ? editing.targetValue : '')
  const [title, setTitle] = useState(editing?.targetType === 'manual' ? editing.title : '')
  const [passcode, setPasscode] = useState('')
  const [clearPasscode, setClearPasscode] = useState(false)
  const [permanent, setPermanent] = useState(editing ? editing.expiresAt === null : true)
  const [expiryKey, setExpiryKey] = useState(editing?.expiresAt ? dateKey(new Date(editing.expiresAt)) : '')
  const [memberSort, setMemberSort] = useState<MemberSort>(editing?.memberSort ?? 'default')
  const [noteIds, setNoteIds] = useState<string[]>([])
  const [rosterDirty, setRosterDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // A collection that already has a passcode cannot be shown one, so typing a new one and asking to clear
  // the old cannot both be true; the last gesture wins, and the checkbox lets go on its own.
  useEffect(() => {
    if (passcode) setClearPasscode(false)
  }, [passcode])

  const targets = useMemo(() => shares.filter((share) => share.deletedAt === null), [shares])

  const toggleMember = (noteId: string) => {
    setRosterDirty(true)
    setNoteIds((current) => (
      current.includes(noteId)
        ? current.filter((id) => id !== noteId)
        // The order this list is built in is the order the page lists in: a hand-picked directory has no
        // other ordering, so a selection rewritten by title would print sorted by title.
        : [...current, noteId]
    ))
  }

  const submit = async () => {
    const problem = validate({ kind, folderId, tagId, title, passcode, permanent, expiryKey, noteIds, editing })
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    setSaving(true)
    try {
      const expiresAt = permanent ? null : endOfDay(parseDateKey(expiryKey)).getTime()
      const titleValue = title.trim()
      if (editing) {
        // Only what the owner actually touched is sent: the route reads an absent field as "keep it" and a
        // null as "clear it", so a form that always wrote all four would drop a passcode nobody meant to.
        await shareHubApi.collections.patch(editing.id, {
          ...(titleValue ? { title: titleValue } : {}),
          ...(passcode ? { password: passcode } : clearPasscode ? { password: null } : {}),
          ...(permanent ? (editing.expiresAt === null ? {} : { expiresAt: null }) : { expiresAt }),
          ...(kind === 'manual' ? {} : { memberSort }),
        })
        // A hand-picked roster is replace-all, and the hub never learns the ids it already holds, so it is
        // written only when this form actually changed the selection.
        if (kind === 'manual' && rosterDirty) await shareHubApi.collections.setMembers(editing.id, noteIds)
        onSaved(editing.slug)
        return
      }
      const created = await shareHubApi.collections.create({
        targetType: kind,
        ...(kind === 'manual' ? { noteIds } : { targetValue: kind === 'folder' ? folderId : tagId }),
        ...(titleValue ? { title: titleValue } : {}),
        ...(passcode ? { password: passcode } : {}),
        ...(!permanent ? { expiresAt } : {}),
        ...(kind === 'manual' ? {} : { memberSort }),
      })
      onSaved(created.slug)
    } catch (cause) {
      // The route's own sentence is the useful half of a 409 ("this folder already has a published
      // collection"), so it is what goes on screen — not a generic failure with the reason thrown away.
      setSaving(false)
      setError(cause instanceof Error ? cause.message : t('share.collection_save_failed'))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={620}
      title={editing ? t('share.collection_edit_title') : t('share.collection_publish_title')}
      description={t('share.collection_editor_hint')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {editing ? t('common.save') : t('share.collection_publish_action')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[var(--sp-3)]">
        {error && <p role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>}

        {editing === null && (
          <Segmented
            label={t('share.collection_kind_label')}
            value={kind}
            onChange={setKind}
            options={KINDS.map((option) => ({ value: option, label: t(kindKey(option)) }))}
          />
        )}

        {kind === 'folder' && (
          <Field label={t('share.collection_folder_label')}>
            <Select value={folderId} onChange={(event) => setFolderId(event.target.value)}>
              <option value="">{t('share.collection_folder_pick')}</option>
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </Select>
          </Field>
        )}
        {kind === 'tag' && (
          <Field label={t('share.collection_tag_label')}>
            <Select value={tagId} onChange={(event) => setTagId(event.target.value)}>
              <option value="">{t('share.collection_tag_pick')}</option>
              {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </Select>
          </Field>
        )}

        {(kind === 'manual' || editing !== null) && (
          <Field
            label={t('share.collection_title_label')}
            hint={kind === 'manual' ? t('share.collection_title_required') : t('share.collection_title_optional')}
          >
            <Input
              value={title}
              maxLength={TITLE_MAX}
              placeholder={t('share.collection_title_placeholder')}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
        )}

        {kind === 'manual' && (
          <RosterField
            targets={targets}
            selected={noteIds}
            onToggle={toggleMember}
            currentCount={editing?.targetType === 'manual' ? editing.count : null}
          />
        )}

        <Field label={t('share.passcode')} hint={t('share.leave_blank_to_keep_the_current_passcode')}>
          <Input
            type="password"
            value={passcode}
            autoComplete="off"
            placeholder={editing?.hasPassword
              ? t('share.collection_passcode_set_placeholder')
              : t('share.collection_passcode_placeholder')}
            onChange={(event) => setPasscode(event.target.value)}
          />
        </Field>
        {editing?.hasPassword && (
          <Checkbox checked={clearPasscode} onChange={setClearPasscode} label={t('share.collection_clear_passcode')} />
        )}

        <div className="flex flex-col gap-[var(--sp-1-5)]">
          <SettingLine
            title={t('share.expiration')}
            note={permanent ? t('share.never_expires') : t('share.collection_expiry_ends')}
            control={(
              <Switch
                checked={permanent}
                onChange={(next) => {
                  setPermanent(next)
                  if (next) setExpiryKey('')
                }}
                label={t('share.collection_permanent')}
              />
            )}
          />
          {!permanent && (
            <Field label={t('share.collection_expiry_label')}>
              <DatePicker label={t('share.collection_expiry_label')} value={expiryKey} onChange={setExpiryKey} />
            </Field>
          )}
        </div>

        {kind !== 'manual' && (
          <Field label={t('share.collection_sort_label')} hint={t('share.collection_sort_hint')}>
            <Select value={memberSort} onChange={(event) => setMemberSort(event.target.value as MemberSort)}>
              {MEMBER_SORTS.map((option) => <option key={option} value={option}>{t(memberSortKey(option))}</option>)}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  )
}

/** The roster: the links of this account whose note has not been thrown away. */
function RosterField({ targets, selected, onToggle, currentCount }: {
  targets: ShareListItem[]
  selected: string[]
  onToggle: (noteId: string) => void
  currentCount: number | null
}) {
  return (
    <Field
      label={t('share.collection_roster_label')}
      hint={currentCount === null
        ? t('share.collection_roster_hint', { max: MAX_MANUAL_MEMBERS })
        : t('share.collection_roster_edit_hint', { count: currentCount })}
    >
      <div className="flex max-h-60 flex-col gap-[var(--sp-0-5)] overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[var(--sp-2)]">
        {targets.length === 0 ? (
          <p className="py-[var(--sp-2)] text-center text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t('share.no_shared_notes')}
          </p>
        ) : (
          targets.map((share) => (
            <Checkbox
              key={share.noteId}
              checked={selected.includes(share.noteId)}
              onChange={() => onToggle(share.noteId)}
              label={share.noteTitle}
            />
          ))
        )}
      </div>
    </Field>
  )
}

function SettingLine({ title, control, note }: { title: string, control: ReactNode, note: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-[var(--sp-2)]">
      <span className="flex items-baseline gap-[var(--sp-1-5)] text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
        {title}
        <span className="text-[length:var(--text-11)] font-normal text-[var(--text-quaternary)]">{note}</span>
      </span>
      {control}
    </div>
  )
}

function kindKey(kind: CollectionKind): 'share.collection_kind_folder' | 'share.collection_kind_tag' | 'share.collection_kind_manual' {
  return kind === 'folder'
    ? 'share.collection_kind_folder'
    : kind === 'tag'
      ? 'share.collection_kind_tag'
      : 'share.collection_kind_manual'
}

function memberSortKey(sort: MemberSort): 'share.collection_sort_default' | 'share.collection_sort_newest' | 'share.collection_sort_oldest' | 'share.collection_sort_title' {
  return sort === 'default'
    ? 'share.collection_sort_default'
    : sort === 'newest'
      ? 'share.collection_sort_newest'
      : sort === 'oldest'
        ? 'share.collection_sort_oldest'
        : 'share.collection_sort_title'
}

/**
 * What this form refuses to send, said here rather than learned from a 400.
 *
 * The end date is the field worth checking locally: the route requires a moment in the future, and a
 * directory that "expires" at a time already passed is a page the owner believes is live.
 */
function validate(input: {
  kind: CollectionKind
  folderId: string
  tagId: string
  title: string
  passcode: string
  permanent: boolean
  expiryKey: string
  noteIds: string[]
  editing: ShareCollection | null
}): string | null {
  if (input.editing === null && input.kind === 'folder' && !input.folderId) return t('share.collection_need_folder')
  if (input.editing === null && input.kind === 'tag' && !input.tagId) return t('share.collection_need_tag')
  if (input.kind === 'manual' && input.editing === null) {
    if (!input.title.trim()) return t('share.collection_need_title')
    if (input.noteIds.length === 0) return t('share.collection_need_members')
  }
  if (input.noteIds.length > MAX_MANUAL_MEMBERS) {
    return t('share.collection_too_many_members', { max: MAX_MANUAL_MEMBERS })
  }
  if (input.passcode && input.passcode.length < LIMITS.sharePasscodeMinLength) return t('share.passcode_too_short')
  if (!input.permanent) {
    if (!input.expiryKey) return t('share.collection_need_expiry')
    if (endOfDay(parseDateKey(input.expiryKey)).getTime() <= Date.now()) return t('share.collection_expiry_past')
  }
  return null
}
