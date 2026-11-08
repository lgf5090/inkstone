import type { CollectionNode } from '@shared/development/api-tester/types'

/** Every uploaded file a request points at, across its body and multipart fields. */
export function fileIdsOfNode(node: CollectionNode): string[] {
  const ids: string[] = []
  if (node.request?.bodyFileId) ids.push(node.request.bodyFileId)
  for (const field of node.request?.formFields ?? []) {
    if (field.isFile && field.fileId) ids.push(field.fileId)
  }
  return ids
}

export function fileIdReferencedByOtherNodes(
  nodes: readonly CollectionNode[],
  fileId: string,
  exceptNodeId?: string,
): boolean {
  return nodes.some((node) => node.id !== exceptNodeId && fileIdsOfNode(node).includes(fileId))
}
