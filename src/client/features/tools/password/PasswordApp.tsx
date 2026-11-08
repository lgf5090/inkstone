import { useEffect } from 'react'
import { useToolsStore } from '../store'
import { usePasswordVaultStore } from './store'
import { Door } from './Door'
import { Setting } from './Setting'
import { Reset } from './Reset'
import { Recover } from './Recover'
import { useAutoLock } from './useAutoLock'
import { AccountArea } from './AccountArea'
import { PasswordHealthView } from './PasswordHealthView'
import { FavoriteAccounts } from './FavoriteAccounts'
import { RandomPasswordView } from './RandomPasswordView'
import { PasswordGeneratorModal } from './PasswordGeneratorModal'
import { BatchOperationsModal } from './BatchOperationsModal'
import { ExportModal } from './ExportModal'
import { ImportModal } from './ImportModal'
import { BackupSettingsModal } from './BackupSettingsModal'
import { clearClipboardSecret } from './utils/clipboard'

export function PasswordApp() {
  const activePasswordView = useToolsStore((s) => s.activePasswordView)
  const isUnlocked = usePasswordVaultStore((s) => s.isUnlocked)
  const vaultState = usePasswordVaultStore((s) => s.vaultState)
  const checkVaultAndAutoUnlock = usePasswordVaultStore((s) => s.checkVaultAndAutoUnlock)

  // Store modal states
  const isGeneratorModalOpen = usePasswordVaultStore((s) => s.isGeneratorModalOpen)
  const closeGeneratorModal = usePasswordVaultStore((s) => s.closeGeneratorModal)
  const isBatchOperationsOpen = usePasswordVaultStore((s) => s.isBatchOperationsOpen)
  const closeBatchOperations = usePasswordVaultStore((s) => s.closeBatchOperations)
  const isExportModalOpen = usePasswordVaultStore((s) => s.isExportModalOpen)
  const closeExportModal = usePasswordVaultStore((s) => s.closeExportModal)
  const isImportModalOpen = usePasswordVaultStore((s) => s.isImportModalOpen)
  const closeImportModal = usePasswordVaultStore((s) => s.closeImportModal)
  const isBackupSettingsOpen = usePasswordVaultStore((s) => s.isBackupSettingsOpen)
  const closeBackupSettings = usePasswordVaultStore((s) => s.closeBackupSettings)
  const targetGroup = usePasswordVaultStore((s) => s.targetGroupForExportImport)
  const autoLockMinutes = usePasswordVaultStore((s) => s.settings?.autoLockMinutes)

  // The configured time, not a constant: the setting existed in the database with nothing reading it.
  useAutoLock(autoLockMinutes ? autoLockMinutes * 60 * 1000 : undefined)

  useEffect(() => {
    if (!isUnlocked && vaultState === null) {
      void checkVaultAndAutoUnlock()
    }
  }, [isUnlocked, vaultState, checkVaultAndAutoUnlock])

  useEffect(() => {
    // Sign-out clears the whole session cache; the vault must not survive it in memory.
    const forget = () => usePasswordVaultStore.getState().forgetSession()
    window.addEventListener('inkstone:session-cleared', forget)
    return () => window.removeEventListener('inkstone:session-cleared', forget)
  }, [])

  useEffect(() => {
    // A closed tab is as good a reason as a lock to stop leaving a password on the clipboard.
    const clear = () => clearClipboardSecret()
    window.addEventListener('pagehide', clear)
    return () => window.removeEventListener('pagehide', clear)
  }, [])

  useEffect(() => {
    if (activePasswordView === 'backup_settings') {
      usePasswordVaultStore.getState().openBackupSettings()
    } else if (activePasswordView === 'batch_operations') {
      usePasswordVaultStore.getState().openBatchOperations()
    }
  }, [activePasswordView])

  const handleCloseBackupSettings = () => {
    closeBackupSettings()
    if (activePasswordView === 'backup_settings') {
      useToolsStore.getState().setActivePasswordView('all')
    }
  }

  const handleCloseBatchOperations = () => {
    closeBatchOperations()
    if (activePasswordView === 'batch_operations') {
      useToolsStore.getState().setActivePasswordView('all')
    }
  }

  if (!isUnlocked) {
    if (vaultState && !vaultState.hasVault) {
      return (
        <div
          data-testid="password-app-root"
          className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg-base)]"
        >
          <Setting />
        </div>
      )
    }

    return (
      <div
        data-testid="password-app-root"
        className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg-base)]"
      >
        <Door />
        <Setting />
        <Reset />
        <Recover />
      </div>
    )
  }

  return (
    <div
      data-testid="password-app-root"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      {activePasswordView === 'favorites' && <FavoriteAccounts />}
      {activePasswordView === 'generator' && (
        <div data-testid="password-generator-view" className="flex-1 min-h-0 flex flex-col">
          <RandomPasswordView />
        </div>
      )}
      {activePasswordView === 'health' && <PasswordHealthView />}
      {activePasswordView !== 'favorites' &&
        activePasswordView !== 'generator' &&
        activePasswordView !== 'health' && <AccountArea />}

      {/* Auxiliary Modals */}
      <Setting />
      <Reset />
      <Recover />
      <PasswordGeneratorModal open={isGeneratorModalOpen} onClose={closeGeneratorModal} />
      <BatchOperationsModal open={isBatchOperationsOpen} onClose={handleCloseBatchOperations} />
      <ExportModal open={isExportModalOpen} onClose={closeExportModal} group={targetGroup ?? undefined} />
      <ImportModal open={isImportModalOpen} onClose={closeImportModal} group={targetGroup ?? undefined} />
      <BackupSettingsModal open={isBackupSettingsOpen} onClose={handleCloseBackupSettings} />
    </div>
  )
}
