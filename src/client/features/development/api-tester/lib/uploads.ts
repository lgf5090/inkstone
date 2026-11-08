import { deleteFile } from '../api'
import { useApiTesterStore } from '../store'
import { fileIdReferencedByOtherNodes } from './files'

/**
 * Deletes a server-side upload only when no remaining request still points at it.
 *
 * Duplicating a binary/multipart request copies the file id, so deleting the file from one copy
 * would otherwise break the other.
 */
export function deleteUploadedFile(fileId: string, exceptNodeId?: string): void {
  const nodes = useApiTesterStore.getState().state.nodes
  if (fileIdReferencedByOtherNodes(nodes, fileId, exceptNodeId)) return
  void deleteFile(fileId).catch((error) => {
    console.warn('[inkstone] API Tester file could not be deleted', error)
  })
}
