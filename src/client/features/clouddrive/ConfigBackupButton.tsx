import { useState } from 'react'
import { Download } from 'lucide-react'
import { Button } from '../../components/primitives'
import { useUi } from '../../store/ui'
import { downloadCloudDriveConfigBackup } from './config-backup'

export interface ConfigBackupButtonProps {
  label: string
  busyLabel: string
  successLabel: string
  errorLabel: string
}

export function ConfigBackupButton({ label, busyLabel, successLabel, errorLabel }: ConfigBackupButtonProps) {
  const toast = useUi((state) => state.toast)
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="secondary"
      icon={<Download size={14} />}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        toast({ title: busyLabel })
        try {
          await downloadCloudDriveConfigBackup()
          toast({ title: successLabel })
        } catch (error) {
          toast({
            title: errorLabel,
            description: error instanceof Error ? error.message : String(error),
            tone: 'danger',
          })
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? busyLabel : label}
    </Button>
  )
}
