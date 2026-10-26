import { useEffect } from 'react'
import { useToolsStore } from '../store'
import { usePasswordVaultStore } from './store'
import { Door } from './Door'
import { Setting } from './Setting'
import { Reset } from './Reset'
import { Recover } from './Recover'
import { useAutoLock } from './useAutoLock'
import { AccountArea } from './AccountArea'
import { FavoriteAccounts } from './FavoriteAccounts'
import { RandomPasswordView } from './RandomPasswordView'
import { PasswordGeneratorModal } from './PasswordGeneratorModal'
import { QuickAddModal } from './QuickAddModal'
import { BatchOperationsModal } from './BatchOperationsModal'
import { ExportModal } from './ExportModal'
import { ImportModal } from './ImportModal'
import { BackupSettingsModal } from './BackupSettingsModal'

export function PasswordApp() {
  const activePasswordView = useToolsStore((s) => s.activePasswordView)
  const isUnlocked = usePasswordVaultStore((s) => s.isUnlocked)
  const vaultState = usePasswordVaultStore((s) => s.vaultState)
  const checkVaultAndAutoUnlock = usePasswordVaultStore((s) => s.checkVaultAndAutoUnlock)

  // Store modal states
  const isGeneratorModalOpen = usePasswordVaultStore((s) => s.isGeneratorModalOpen)
  const closeGeneratorModal = usePasswordVaultStore((s) => s.closeGeneratorModal)
  const isQuickAddModalOpen = usePasswordVaultStore((s) => s.isQuickAddModalOpen)
  const closeQuickAddModal = usePasswordVaultStore((s) => s.closeQuickAddModal)
  const isBatchOperationsOpen = usePasswordVaultStore((s) => s.isBatchOperationsOpen)
  const closeBatchOperations = usePasswordVaultStore((s) => s.closeBatchOperations)
  const isExportModalOpen = usePasswordVaultStore((s) => s.isExportModalOpen)
  const closeExportModal = usePasswordVaultStore((s) => s.closeExportModal)
  const isImportModalOpen = usePasswordVaultStore((s) => s.isImportModalOpen)
  const closeImportModal = usePasswordVaultStore((s) => s.closeImportModal)
  const isBackupSettingsOpen = usePasswordVaultStore((s) => s.isBackupSettingsOpen)
  const closeBackupSettings = usePasswordVaultStore((s) => s.closeBackupSettings)
  const targetGroup = usePasswordVaultStore((s) => s.targetGroupForExportImport)

  useAutoLock()

  useEffect(() => {
    if (!isUnlocked && vaultState === null) {
      void checkVaultAndAutoUnlock()
    }
  }, [isUnlocked, vaultState, checkVaultAndAutoUnlock])

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
      {activePasswordView !== 'favorites' && activePasswordView !== 'generator' && <AccountArea />}

      {/* Auxiliary Modals */}
      <Setting />
      <Reset />
      <Recover />
      <PasswordGeneratorModal open={isGeneratorModalOpen} onClose={closeGeneratorModal} />
      <QuickAddModal open={isQuickAddModalOpen} onClose={closeQuickAddModal} />
      <BatchOperationsModal open={isBatchOperationsOpen} onClose={handleCloseBatchOperations} />
      <ExportModal open={isExportModalOpen} onClose={closeExportModal} group={targetGroup ?? undefined} />
      <ImportModal open={isImportModalOpen} onClose={closeImportModal} group={targetGroup ?? undefined} />
      <BackupSettingsModal open={isBackupSettingsOpen} onClose={handleCloseBackupSettings} />
    </div>
  )
}
