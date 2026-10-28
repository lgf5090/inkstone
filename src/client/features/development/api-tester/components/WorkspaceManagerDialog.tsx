import { useEffect, useState } from 'react'
import { Check, Layers, Pencil, Plus, Trash2 } from 'lucide-react'
import { WORKSPACE_COLORS } from '@shared/development/api-tester/keywords'
import type { Workspace } from '@shared/development/api-tester/types'
import { Modal, confirm } from '../../../../components/overlay'
import { Button, IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { isImeComposing } from '../../../../lib/ime'
import { tagColorValue } from '../lib/tag-colors'
import { useApiTesterStore } from '../store'

export function WorkspaceManagerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const workspaces = useApiTesterStore((s) => s.workspaces)
  const activeId = useApiTesterStore((s) => s.activeWorkspaceId)
  const createWorkspace = useApiTesterStore((s) => s.createWorkspace)
  const renameWorkspace = useApiTesterStore((s) => s.renameWorkspace)
  const setWorkspaceColor = useApiTesterStore((s) => s.setWorkspaceColor)
  const deleteWorkspace = useApiTesterStore((s) => s.deleteWorkspace)
  const switchWorkspace = useApiTesterStore((s) => s.switchWorkspace)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>('blue')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  useEffect(() => {
    if (!open) return
    setName('')
    setColor('blue')
    setEditingId(null)
  }, [open])

  const create = () => {
    if (!name.trim()) return
    void createWorkspace(name.trim(), color)
    setName('')
    setColor('blue')
  }

  const remove = async (workspace: Workspace) => {
    const ok = await confirm({
      title: t('development.apitester.delete_workspace_title'),
      description: t('development.apitester.delete_workspace_confirm', { name: workspace.name }),
      tone: 'danger',
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    })
    if (ok) void deleteWorkspace(workspace.id)
  }

  return (
    <Modal open={open} onClose={onClose} title={t('development.apitester.workspace_title')} description={t('development.apitester.workspace_desc')} width={620}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return
              if (event.key === 'Enter') create()
            }}
            placeholder={t('development.apitester.workspace_name_placeholder')}
            aria-label={t('development.apitester.workspace_name_placeholder')}
            className="h-8 min-w-[160px] flex-1 text-[length:var(--text-12)]"
          />
          <div className="flex shrink-0 items-center gap-1">
            {WORKSPACE_COLORS.map((value) => (
              <button
                key={value}
                type="button"
                aria-label={value}
                onClick={() => setColor(value)}
                className={cn('flex size-6 items-center justify-center rounded-full', color === value && 'ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-[var(--bg-base)]')}
              >
                <span className="size-3.5 rounded-full" style={{ backgroundColor: tagColorValue(value) ?? undefined }} />
              </button>
            ))}
          </div>
          <Button size="sm" className="gap-1" disabled={!name.trim()} onClick={create}>
            <Plus size={14} /> {t('development.apitester.new_workspace')}
          </Button>
        </div>

        <div className="space-y-1">
          {workspaces.map((workspace) => (
            <div key={workspace.id} className={cn('flex items-center gap-2 rounded-[var(--r-md)] border px-2 py-1.5', workspace.id === activeId ? 'border-[var(--accent)]/40 bg-[var(--accent-softer)]' : 'border-[var(--border-subtle)]')}>
              <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: tagColorValue(workspace.color) ?? undefined }} />
              {editingId === workspace.id ? (
                <Input
                  value={editName}
                  onChange={(event) => setEditName(event.target.value)}
                  onKeyDown={(event) => {
                    if (isImeComposing(event)) return
                    if (event.key === 'Enter' && editName.trim()) {
                      void renameWorkspace(workspace.id, editName.trim())
                      setEditingId(null)
                    }
                    if (event.key === 'Escape') setEditingId(null)
                  }}
                  onBlur={() => setEditingId(null)}
                  autoFocus
                  className="h-7 min-w-0 flex-1 text-[length:var(--text-12)]"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => void switchWorkspace(workspace.id)}
                  className="min-w-0 flex-1 truncate text-left text-[length:var(--text-12)] text-[var(--text-primary)]"
                  title={t('development.apitester.switch_workspace')}
                >
                  {workspace.name}
                </button>
              )}
              {workspace.id === activeId && <span className="shrink-0 text-[length:var(--text-10)] text-[var(--accent)]"><Check size={12} /></span>}
              <select
                aria-label={t('development.apitester.workspace_color')}
                value={workspace.color}
                onChange={(event) => void setWorkspaceColor(workspace.id, event.target.value)}
                className="h-6 max-w-[72px] shrink-0 rounded border border-[var(--border-subtle)] bg-transparent text-[length:var(--text-10)] text-[var(--text-secondary)]"
              >
                {WORKSPACE_COLORS.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <IconButton
                label={t('development.apitester.rename')}
                size="sm"
                onClick={() => { setEditingId(workspace.id); setEditName(workspace.name) }}
              >
                <Pencil size={13} />
              </IconButton>
              {workspaces.length > 1 && (
                <IconButton label={t('development.apitester.delete')} size="sm" onClick={() => void remove(workspace)} className="text-[var(--text-tertiary)] hover:text-[var(--danger)]">
                  <Trash2 size={13} />
                </IconButton>
              )}
            </div>
          ))}
          {workspaces.length === 0 && <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.apitester.no_workspaces')}</p>}
        </div>
        <p className="flex items-center gap-1.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]"><Layers size={12} /> {t('development.apitester.default_workspace')}</p>
      </div>
    </Modal>
  )
}
