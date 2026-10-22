import type { EmailFolder } from './model'

export const EMAIL_FOLDER_DEPTH_MAX = 5

export interface EmailFolderLike {
  id: string
  name: string
  parentId: string | null
  sortOrder: number
}

export interface EmailFolderNode<T extends EmailFolderLike = EmailFolder> {
  folder: T
  depth: number
  children: EmailFolderNode<T>[]
}

function childrenOf<T extends EmailFolderLike>(folders: readonly T[]): Map<string, T[]> {
  const children = new Map<string, T[]>()
  for (const folder of folders) {
    if (!folder.parentId) continue
    const list = children.get(folder.parentId) ?? []
    list.push(folder)
    children.set(folder.parentId, list)
  }
  return children
}

function compareNodes<T extends EmailFolderLike>(a: EmailFolderNode<T>, b: EmailFolderNode<T>): number {
  return a.folder.sortOrder - b.folder.sortOrder
}

export function emailFolderDepth(folders: readonly EmailFolderLike[], id: string): number {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  let current = byId.get(id)
  if (!current) return 0
  let depth = 1
  const seen = new Set<string>([current.id])
  while (current.parentId) {
    const parentId = current.parentId
    if (seen.has(parentId)) return 0
    const parent = byId.get(parentId)
    if (!parent) return 0
    seen.add(parent.id)
    depth++
    current = parent
  }
  return depth
}

export function emailFolderDescendantIds(folders: readonly EmailFolderLike[], id: string): string[] {
  const children = childrenOf(folders)
  const seen = new Set<string>([id])
  const queue = [...children.get(id) ?? []]
  const out: string[] = []
  while (queue.length) {
    const folder = queue.shift()!
    if (seen.has(folder.id)) continue
    seen.add(folder.id)
    out.push(folder.id)
    queue.push(...children.get(folder.id) ?? [])
  }
  return out
}

export function emailFolderSubtreeHeight(folders: readonly EmailFolderLike[], id: string): number {
  if (!folders.some((folder) => folder.id === id)) return 0
  const children = childrenOf(folders)
  const seen = new Set<string>()
  const stack = [{ id, depth: 1 }]
  let height = 0
  while (stack.length) {
    const current = stack.pop()!
    if (seen.has(current.id)) continue
    seen.add(current.id)
    height = Math.max(height, current.depth)
    for (const child of children.get(current.id) ?? []) {
      stack.push({ id: child.id, depth: current.depth + 1 })
    }
  }
  return height
}

export function emailFolderDepthAllowed(
  folders: readonly EmailFolderLike[],
  parentId: string | null,
  subtreeHeight = 1,
): boolean {
  const parentDepth = parentId ? emailFolderDepth(folders, parentId) : 0
  if (parentId && parentDepth === 0) return false
  return parentDepth + Math.max(1, subtreeHeight) <= EMAIL_FOLDER_DEPTH_MAX
}

export function emailFolderWouldCycle(
  folders: readonly EmailFolderLike[],
  id: string,
  parentId: string | null,
): boolean {
  if (!parentId) return false
  if (parentId === id) return true
  return emailFolderDescendantIds(folders, id).includes(parentId)
}

export function emailFolderMoveAllowed(
  folders: readonly EmailFolderLike[],
  id: string,
  parentId: string | null,
): boolean {
  if (emailFolderWouldCycle(folders, id, parentId)) return false
  return emailFolderDepthAllowed(folders, parentId, emailFolderSubtreeHeight(folders, id))
}

export function emailFolderNameTaken(
  folders: readonly EmailFolderLike[],
  parentId: string | null,
  name: string,
  exceptId?: string,
): boolean {
  const key = name.trim().toLowerCase()
  if (!key) return false
  return folders.some((folder) =>
    folder.id !== exceptId &&
    (folder.parentId ?? null) === (parentId ?? null) &&
    folder.name.trim().toLowerCase() === key
  )
}

export function emailFolderTree<T extends EmailFolderLike = EmailFolder>(
  folders: readonly T[],
): EmailFolderNode<T>[] {
  const nodes = new Map<string, EmailFolderNode<T>>()
  for (const folder of folders) nodes.set(folder.id, { folder, depth: 0, children: [] })
  const roots: EmailFolderNode<T>[] = []
  for (const folder of folders) {
    const node = nodes.get(folder.id)!
    const parent = folder.parentId ? nodes.get(folder.parentId) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  const visited = new Set<string>()
  const walk = (node: EmailFolderNode<T>, depth: number): void => {
    if (visited.has(node.folder.id)) return
    visited.add(node.folder.id)
    node.depth = depth
    node.children.sort(compareNodes)
    for (const child of node.children) walk(child, depth + 1)
  }
  roots.sort(compareNodes)
  for (const root of roots) walk(root, 0)
  for (const node of nodes.values()) {
    if (visited.has(node.folder.id)) continue
    roots.push(node)
    walk(node, 0)
  }
  roots.sort(compareNodes)
  return roots
}

export function flattenEmailFolderTree<T extends EmailFolderLike>(
  nodes: readonly EmailFolderNode<T>[],
  expanded: ReadonlySet<string>,
): EmailFolderNode<T>[] {
  const out: EmailFolderNode<T>[] = []
  const seen = new Set<string>()
  const walk = (list: readonly EmailFolderNode<T>[]): void => {
    for (const node of list) {
      if (seen.has(node.folder.id)) continue
      seen.add(node.folder.id)
      out.push(node)
      if (node.children.length && expanded.has(node.folder.id)) walk(node.children)
    }
  }
  walk(nodes)
  return out
}
