import { ExternalLink, GitFork } from 'lucide-react'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUpdate } from '../../store/update'

export function UpdateDialog() {
  const role = useSession((state) => state.user?.role)
  const open = useUpdate((state) => state.dialogOpen)
  const info = useUpdate((state) => state.info)
  const ignoreCurrentVersion = useUpdate((state) => state.ignoreCurrentVersion)
  const remindLater = useUpdate((state) => state.remindLater)
  const openUpdatePage = useUpdate((state) => state.openUpdatePage)

  if (role !== 'owner' || !info?.latestVersion) return null

  return (
    <Modal
      open={open}
      onClose={remindLater}
      title={t('settings.update_dialog_title')}
      description={t('settings.update_dialog_description', {
        version: info.latestVersion,
      })}
      width={500}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={ignoreCurrentVersion}>
            {t('settings.do_not_remind_this_version')}
          </Button>
          <Button size="sm" variant="secondary" data-autofocus onClick={remindLater}>
            {t('settings.remind_me_next_time')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<ExternalLink size={13} />}
            onClick={openUpdatePage}
          >
            {t('settings.go_to_update')}
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
        <GitFork size={17} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">
          {t('settings.update_manual_fork_hint')}
        </p>
      </div>
    </Modal>
  )
}
