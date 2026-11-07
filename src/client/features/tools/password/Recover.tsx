import { useState } from 'react'
import { KeyRound, ShieldAlert, Trash2 } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { Button } from '../../../components/primitives'
import { Modal, confirm } from '../../../components/overlay'
import { usePasswordVaultStore } from './store'
import { passwordApi } from './api'
import { ReauthDialog } from './ReauthDialog'

export interface RecoverProps {
  open?: boolean
  onClose?: () => void
}

/**
 * The honest version of "forgot the master password".
 *
 * The vault key exists only as a function of the master password, and the server keeps a one-way
 * digest, so there is nothing to hand back. The old screen printed the first three characters as a
 * "hint", which showed half a six-character secret and let anyone finish the guess in 10^3 tries;
 * it is gone. What is left is what the design actually allows: change it if you still know it, or
 * throw the unreadable rows away and start over.
 */
export function Recover({ open, onClose }: RecoverProps) {
  const storeOpen = usePasswordVaultStore((s) => s.isRecoverOpen)
  const storeClose = usePasswordVaultStore((s) => s.closeRecover)
  const openReset = usePasswordVaultStore((s) => s.openReset)
  const openSetting = usePasswordVaultStore((s) => s.openSetting)
  const clearVaultState = usePasswordVaultStore((s) => s.clearVaultState)

  const isModalOpen = open !== undefined ? open : storeOpen
  const handleClose = onClose || storeClose

  const [wiping, setWiping] = useState(false)
  const [reauthOpen, setReauthOpen] = useState(false)

  const handleOpenReset = () => {
    handleClose()
    openReset()
  }

  const handleWipe = async () => {
    const ok = await confirm({
      title: t('tools.password.recover.wipe'),
      description: t('tools.password.recover.wipe_confirm'),
      tone: 'danger',
      confirmLabel: t('tools.password.recover.wipe'),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return

    // The confirmation dialog says what will happen; the master password proves who is asking.
    setReauthOpen(true)
  }

  const performWipe = async (confirmToken: string) => {
    setReauthOpen(false)
    setWiping(true)
    try {
      await passwordApi.wipeVault(confirmToken)
      clearVaultState()
      handleClose()
      openSetting()
      useUi.getState().toast({
        title: t('tools.password.recover.wipe_done'),
        tone: 'success',
      })
    } catch (err) {
      useUi.getState().toast({
        title: err instanceof Error ? err.message : t('tools.password.recover.wipe_failed'),
        tone: 'danger',
      })
    } finally {
      setWiping(false)
    }
  }

  return (
    <>
      <Modal
        open={isModalOpen}
      onClose={handleClose}
      title={t('tools.password.recover.title')}
      width={480}
    >
      <div className="flex flex-col gap-4 text-[var(--text-primary)]">
        <div className="flex items-start gap-3 rounded-[var(--r-md)] bg-[var(--warning-softer)] p-3">
          <ShieldAlert size={20} className="mt-0.5 shrink-0 text-[var(--warning)]" aria-hidden="true" />
          <p
            data-testid="password-recover-body"
            className="text-[length:var(--text-13)] leading-relaxed text-[var(--text-secondary)]"
          >
            {t('tools.password.recover.body')}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Button
            data-testid="password-recover-open-reset"
            variant="secondary"
            icon={<KeyRound size={14} />}
            onClick={handleOpenReset}
            disabled={wiping}
          >
            {t('tools.password.recover.open_reset')}
          </Button>
          <Button
            data-testid="password-recover-wipe"
            variant="danger"
            icon={<Trash2 size={14} />}
            onClick={() => void handleWipe()}
            loading={wiping}
          >
            {t('tools.password.recover.wipe')}
          </Button>
        </div>

        <div className="flex items-center justify-end border-t border-[var(--border-subtle)] pt-2">
          <Button variant="ghost" onClick={handleClose} disabled={wiping}>
            {t('common.cancel')}
          </Button>
        </div>
        </div>
      </Modal>

      <ReauthDialog
        open={reauthOpen}
        onClose={() => setReauthOpen(false)}
        onAuthorized={(token) => void performWipe(token)}
        description={t('tools.password.recover.wipe_confirm')}
      />
    </>
  )
}
