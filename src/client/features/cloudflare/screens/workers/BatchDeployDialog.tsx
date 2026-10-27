/**
 * The screen-level deploy entry: no target worker, so the dialog starts empty and the reader picks
 * the accounts the deployment goes to.
 */
import type { CloudflareAccount } from '@shared/cloudflare/model'
import { DeployDialog } from './DeployDialog'

export function BatchDeployDialog({
  open,
  onClose,
  accounts,
  onDeployed,
}: {
  open: boolean
  onClose: () => void
  accounts: CloudflareAccount[]
  onDeployed: () => void
}) {
  return (
    <DeployDialog
      open={open}
      onClose={onClose}
      redeploy={null}
      accounts={accounts}
      onDeployed={onDeployed}
    />
  )
}
