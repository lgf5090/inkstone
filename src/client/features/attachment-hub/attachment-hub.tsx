import type { AttachmentHubScope, HubAttachmentWithUsage } from '@shared/attachment-hub'
import { HubScopeProvider } from './hub-scope'
import { AttachmentHubModal } from './attachment-hub-modal'

export interface AttachmentHubProps {
  open: boolean
  scope: AttachmentHubScope
  onClose: () => void
  /** Lets the host refresh its own attachment lists once the hub is put away. */
  onChanged?: () => void
  onInsertFile?: (file: HubAttachmentWithUsage) => void
}

/**
 * The hub is mounted by the app that wants it and keyed on its scope: folders, tags and the modal's
 * view state are all per-scope, so a remount is what clears one application's filters from the next.
 */
export function AttachmentHub(props: AttachmentHubProps) {
  const { open, scope, onClose, onChanged, onInsertFile } = props
  return (
    <HubScopeProvider scope={scope}>
      <AttachmentHubModal
        open={open}
        onClose={() => {
          onClose()
          onChanged?.()
        }}
        onInsertFile={onInsertFile}
      />
    </HubScopeProvider>
  )
}
