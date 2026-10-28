import { TagManagerDialog } from './TagManagerDialog'
import { useApiTesterStore } from '../store'

export function TagManagerHost({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tags = useApiTesterStore((s) => s.state.tags)
  const addTag = useApiTesterStore((s) => s.addTag)
  const updateTag = useApiTesterStore((s) => s.updateTag)
  const deleteTag = useApiTesterStore((s) => s.deleteTag)
  return (
    <TagManagerDialog
      open={open}
      onClose={onClose}
      tags={tags}
      onAdd={(name, color, parentId) => addTag(name, color, parentId)}
      onUpdate={(id, patch) => updateTag(id, patch)}
      onDelete={(id) => deleteTag(id)}
    />
  )
}
