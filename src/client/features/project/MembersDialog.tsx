/**
 * Who is on this board, and what they may do.
 *
 * The role model, the person properties and the mention notifications all key on membership, so
 * without this screen a "shared" board is a board of one. The server owns the two refusals that
 * matter — the last admin cannot be demoted or removed, and the roster is capped — so the dialog
 * reports what the server said rather than guessing at either rule.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Trash2, UserPlus } from 'lucide-react'
import type { ProjectBoardMember, ProjectMinimumRole, ProjectPeople, ProjectRole } from '@shared/project/model'
import { PROJECT_ROLES, projectPersonLabel } from '@shared/project/model'
import { PROJECT_LIMITS } from '@shared/project/limits'
import { PROJECT_NOTIFICATION_LEVELS, type ProjectNotificationLevel } from '@shared/constants'
import { t } from '../../lib/i18n'
import { Avatar, Button, IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { confirm, Modal } from '../../components/overlay'
import { LoadingBlock } from '../../components/feedback'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { addBoardMember, fetchBoardMembers, removeBoardMember, setBoardMemberRole } from './api'

const roleOptions = () => PROJECT_ROLES.map((role) => ({ value: role, label: t(`project.role.${role}` as Parameters<typeof t>[0]) }))
const MINIMUM_ROLE_OPTIONS = () => [
  { value: '', label: t('project.board.minimum_none') },
  ...roleOptions(),
]

export function MembersDialog({ boardId, minimumRole, boardType, canManageVisibility, onClose, onBoardPatched }: {
  boardId: string
  minimumRole: ProjectMinimumRole
  boardType: 'O' | 'P'
  canManageVisibility: boolean
  onClose: () => void
  onBoardPatched: (patch: { type?: 'O' | 'P', minimumRole?: ProjectMinimumRole }) => Promise<void>
}): ReactElement {
  const [members, setMembers] = useState<ProjectBoardMember[] | null>(null)
  const [people, setPeople] = useState<ProjectPeople>({})
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<ProjectRole>('editor')
  const [busy, setBusy] = useState(false)
  const toast = useUi((state) => state.toast)
  const notificationLevel = useSession((state) => state.settings.project.notifications[boardId] ?? 'all')

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchBoardMembers(boardId, signal)
    setMembers(result.members)
    setPeople(result.people)
  }, [boardId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
      setMembers([])
    })
    return () => controller.abort()
  }, [load, toast])

  const guard = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
      await load()
    } catch (reason) {
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const adminCount = (members ?? []).filter((member) => member.role === 'admin').length
  const full = (members?.length ?? 0) >= PROJECT_LIMITS.boardMembers

  return (
    <Modal open onClose={onClose} title={t('project.members.title')} width={520}>
      <div className="space-y-4" data-board-members={boardId}>
        <section aria-label={t('project.notify.title')} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('project.notify.title')}</span>
            <SelectMenu
              className="min-w-0 flex-1"
              value={notificationLevel}
              label={t('project.notify.title')}
              onChange={(value) => { void useSession.getState().updateSettings({ project: { notifications: { [boardId]: value as ProjectNotificationLevel } } }) }}
              options={PROJECT_NOTIFICATION_LEVELS.map((level) => ({ value: level, label: t(`project.notify.${level}` as Parameters<typeof t>[0]) }))}
            />
          </div>
        </section>
        {canManageVisibility && <section aria-label={t('project.board.visibility')} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('project.board.visibility')}</span>
            <SelectMenu
              className="min-w-0 flex-1"
              value={boardType}
              label={t('project.board.visibility')}
              onChange={(value) => { void guard(() => onBoardPatched({ type: value as 'O' | 'P' })) }}
              options={[{ value: 'P', label: t('project.board.private') }, { value: 'O', label: t('project.board.open') }]}
            />
          </div>
          {boardType === 'O' && (
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('project.board.minimum_role')}</span>
              <SelectMenu
                className="min-w-0 flex-1"
                value={minimumRole}
                label={t('project.board.minimum_role')}
                onChange={(value) => { void guard(() => onBoardPatched({ minimumRole: value as ProjectMinimumRole })) }}
                options={MINIMUM_ROLE_OPTIONS()}
              />
            </div>
          )}
        </section>}
        <section aria-label={t('project.members.title')} className="space-y-2">
          <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
            {t('project.members.count', { count: members?.length ?? 0, max: PROJECT_LIMITS.boardMembers })}
          </h3>
          {members === null
            ? <LoadingBlock />
            : (
              <ul className="space-y-1">
                {members.map((member) => {
                  const name = projectPersonLabel(people, member.userId)
                  return (
                    <li key={member.userId} className="flex items-center gap-2" data-board-member={member.userId}>
                      <Avatar src={people[member.userId]?.avatarUrl} name={name} size={24} />
                      <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{name}</span>
                      <SelectMenu
                        className="w-32"
                        size="sm"
                        value={member.role}
                        label={`${t('project.members.role')}: ${name}`}
                        disabled={busy || (member.role === 'admin' && adminCount <= 1)}
                        onChange={(value) => { void guard(() => setBoardMemberRole(boardId, member.userId, value as ProjectRole).then(() => undefined)) }}
                        options={roleOptions()}
                      />
                      <IconButton
                        label={`${t('project.members.remove')}: ${name}`}
                        size="sm"
                        disabled={busy || (member.role === 'admin' && adminCount <= 1)}
                        onClick={() => {
                          void guard(async () => {
                            const ok = await confirm({ title: `${t('project.members.remove')}: ${name}`, tone: 'danger', confirmLabel: t('project.members.remove') })
                            if (ok) await removeBoardMember(boardId, member.userId)
                          })
                        }}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </li>
                  )
                })}
              </ul>
            )}
        </section>
        <form
          className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-3"
          onSubmit={(event) => {
            event.preventDefault()
            const trimmed = username.trim()
            if (!trimmed) return
            void guard(async () => { await addBoardMember(boardId, trimmed, role); setUsername('') })
          }}
        >
          <Input className="min-w-0 flex-1" value={username} aria-label={t('project.members.username')} placeholder={t('project.members.username')} onChange={(event) => setUsername(event.target.value)} />
          <SelectMenu className="w-32" value={role} label={t('project.members.role')} onChange={(value) => setRole(value as ProjectRole)} options={roleOptions()} />
          <Button type="submit" size="sm" variant="primary" icon={<UserPlus size={14} />} disabled={busy || !username.trim() || full}>
            {t('project.members.add')}
          </Button>
        </form>
        {full && <p role="status" className="text-[length:var(--text-12)] text-[var(--danger)]">{t('project.members.full', { max: PROJECT_LIMITS.boardMembers })}</p>}
      </div>
    </Modal>
  )
}