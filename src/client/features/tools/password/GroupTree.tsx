import { useState, useMemo } from 'react'
import { FolderTree, Plus } from 'lucide-react'
import type { PasswordGroup } from '@shared/tools/password/types'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { IconButton } from '../../../components/primitives'
import { confirm, prompt, Tooltip } from '../../../components/overlay'
import { useToolsStore } from '../store'
import { usePasswordVaultStore } from './store'
import { GroupTreeNode, MAX_GROUP_TREE_DEPTH } from './GroupTreeNode'

function isDescendant(groups: PasswordGroup[], parentId: string, childId: string): boolean {
  if (parentId === childId) return true
  const groupMap = new Map<string, PasswordGroup>()
  for (const g of groups) groupMap.set(g.id, g)

  let current = groupMap.get(childId)
  while (current && current.parentId) {
    if (current.parentId === parentId) return true
    current = groupMap.get(current.parentId)
  }
  return false
}

function getGroupDepth(groups: PasswordGroup[], groupId: string): number {
  const groupMap = new Map<string, PasswordGroup>()
  for (const g of groups) groupMap.set(g.id, g)

  let depth = 1
  let current = groupMap.get(groupId)
  while (current && current.parentId) {
    depth++
    current = groupMap.get(current.parentId)
  }
  return depth
}

function findNode(nodes: PasswordGroup[], id: string): PasswordGroup | null {
  for (const node of nodes) {
    if (node.id === id) return node
    if (node.childs && node.childs.length > 0) {
      const found = findNode(node.childs, id)
      if (found) return found
    }
  }
  return null
}

function getSubtreeHeight(node: PasswordGroup): number {
  if (!node.childs || node.childs.length === 0) return 1
  return 1 + Math.max(...node.childs.map(getSubtreeHeight))
}

export function GroupTree() {
  const groupTree = usePasswordVaultStore((s) => s.groupTree)
  const groups = usePasswordVaultStore((s) => s.groups)
  const accounts = usePasswordVaultStore((s) => s.accounts)
  const selectedGroupId = usePasswordVaultStore((s) => s.selectedGroupId)
  const setSelectedGroupId = usePasswordVaultStore((s) => s.setSelectedGroupId)
  const createGroup = usePasswordVaultStore((s) => s.createGroup)
  const updateGroup = usePasswordVaultStore((s) => s.updateGroup)
  const deleteGroup = usePasswordVaultStore((s) => s.deleteGroup)
  const moveAccountToGroup = usePasswordVaultStore((s) => s.moveAccountToGroup)
  const openExportModal = usePasswordVaultStore((s) => s.openExportModal)
  const openImportModal = usePasswordVaultStore((s) => s.openImportModal)

  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    return new Set(groups.map((g) => g.id))
  })

  // Account count per group map
  const accountCountMap = useMemo(() => {
    const map: Record<string, number> = {}
    for (const acc of accounts) {
      map[acc.groupId] = (map[acc.groupId] || 0) + 1
    }
    return map
  }, [accounts])

  const handleToggleExpand = (groupId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }

  const handleSelectGroup = (group: PasswordGroup) => {
    setSelectedGroupId(group.id)
    useToolsStore.getState().setActivePasswordView('groups')
    useToolsStore.getState().setSelectedGroupId(group.id)
  }

  const handleNewRoot = async () => {
    const name = await prompt({
      title: t('tools.password.group.new_root'),
      placeholder: t('tools.password.group.name_placeholder'),
    })
    if (name && name.trim()) {
      try {
        const created = await createGroup(name.trim(), '')
        setExpandedIds((prev) => new Set(prev).add(created.id))
        useUi.getState().toast({
          title: t('tools.password.group.created_root'),
          tone: 'success',
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        useUi.getState().toast({ title: msg, tone: 'danger' })
      }
    }
  }

  const handleNewChild = async (parent: PasswordGroup) => {
    const depth = getGroupDepth(groups, parent.id)
    if (depth >= MAX_GROUP_TREE_DEPTH) {
      useUi.getState().toast({
        title: t('tools.password.group.max_depth'),
        tone: 'warning',
      })
      return
    }

    const name = await prompt({
      title: t('tools.password.group.new_child'),
      placeholder: t('tools.password.group.child_name_placeholder'),
    })
    if (name && name.trim()) {
      try {
        const created = await createGroup(name.trim(), parent.id)
        setExpandedIds((prev) => new Set(prev).add(parent.id).add(created.id))
        useUi.getState().toast({
          title: t('tools.password.group.created_child'),
          tone: 'success',
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        useUi.getState().toast({ title: msg, tone: 'danger' })
      }
    }
  }

  const handleRename = async (group: PasswordGroup) => {
    const name = await prompt({
      title: t('tools.password.group.rename'),
      defaultValue: group.name,
      placeholder: t('tools.password.group.new_name_placeholder'),
    })
    if (name && name.trim() && name.trim() !== group.name) {
      try {
        await updateGroup(group.id, name.trim())
        useUi.getState().toast({
          title: t('tools.password.group.renamed'),
          tone: 'success',
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        useUi.getState().toast({ title: msg, tone: 'danger' })
      }
    }
  }

  const handleDelete = async (group: PasswordGroup) => {
    if (group.childs && group.childs.length > 0) {
      useUi.getState().toast({
        title: t('tools.password.group.delete_has_children'),
        tone: 'warning',
      })
      return
    }

    if ((accountCountMap[group.id] || 0) > 0) {
      useUi.getState().toast({
        title: t('tools.password.group.delete_has_accounts'),
        tone: 'warning',
      })
      return
    }

    const confirmed = await confirm({
      title: t('tools.password.group.delete'),
      description: t('tools.password.group.delete_confirm', { name: group.name }),
      tone: 'danger',
    })

    if (confirmed) {
      try {
        await deleteGroup(group.id)
        useUi.getState().toast({
          title: t('tools.password.group.deleted'),
          tone: 'success',
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        useUi.getState().toast({ title: msg, tone: 'danger' })
      }
    }
  }

  const handleMoveGroup = async (draggedGroupId: string, targetParentId: string) => {
    if (draggedGroupId === targetParentId) return

    if (isDescendant(groups, draggedGroupId, targetParentId)) {
      useUi.getState().toast({
        title: t('tools.password.group.cannot_move_into_child'),
        tone: 'warning',
      })
      return
    }

    const targetDepth = getGroupDepth(groups, targetParentId)
    const draggedNode = findNode(groupTree, draggedGroupId)
    const subtreeHeight = draggedNode ? getSubtreeHeight(draggedNode) : 1

    if (targetDepth + subtreeHeight > MAX_GROUP_TREE_DEPTH) {
      useUi.getState().toast({
        title: t('tools.password.group.max_depth'),
        tone: 'warning',
      })
      return
    }

    try {
      await updateGroup(draggedGroupId, { parentId: targetParentId })
      setExpandedIds((prev) => new Set(prev).add(targetParentId))
      useUi.getState().toast({
        title: t('tools.password.group.reordered'),
        tone: 'success',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      useUi.getState().toast({ title: msg, tone: 'danger' })
    }
  }

  const handleMoveAccount = async (accountId: string, targetGroupId: string) => {
    try {
      await moveAccountToGroup(accountId, targetGroupId)
      useUi.getState().toast({
        title: t('tools.password.group.account_moved'),
        tone: 'success',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      useUi.getState().toast({ title: msg, tone: 'danger' })
    }
  }

  return (
    <div data-testid="password-group-tree" className="w-full">
      <div className="flex h-7 items-center justify-between px-2 text-[length:var(--text-12)] font-medium text-[var(--text-tertiary)]">
        <div className="flex items-center gap-1.5">
          <FolderTree size={13} />
          <span>{t('tools.password.nav.groups')}</span>
        </div>
        <Tooltip label={t('tools.password.group.new_root')} side="top">
          <IconButton
            data-testid="group-tree-add-root-btn"
            label={t('tools.password.group.new_root')}
            size="sm"
            onClick={() => void handleNewRoot()}
          >
            <Plus size={13} />
          </IconButton>
        </Tooltip>
      </div>

      <div className="mt-0.5 space-y-0.5">
        {groupTree.length === 0 ? (
          <div className="px-3 py-2 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('tools.password.group.empty')}
          </div>
        ) : (
          groupTree.map((group) => (
            <GroupTreeNode
              key={group.id}
              group={group}
              depth={1}
              selectedGroupId={selectedGroupId}
              expandedIds={expandedIds}
              accountCountMap={accountCountMap}
              onSelect={handleSelectGroup}
              onToggleExpand={handleToggleExpand}
              onNewChild={handleNewChild}
              onRename={handleRename}
              onDelete={handleDelete}
              onExport={openExportModal}
              onImport={openImportModal}
              onMoveGroup={handleMoveGroup}
              onMoveAccount={handleMoveAccount}
            />
          ))
        )}
      </div>
    </div>
  )
}
