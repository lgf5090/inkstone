/**
 * The folder shape a move picker reads: a name, its children, and how many things sit directly in it.
 *
 * It is the contract between a tree some feature owns and a picker another feature draws, so it lives
 * in neither feature — the notes folders and the stencil library both hand the same picker a tree of
 * exactly this shape, and a second copy of that picker (flywheel positioning, arrow-key walking and
 * all) would be the worse outcome. Stated structurally rather than as the notes store's `FolderNode`,
 * which satisfies it as it is.
 */
export interface MoveMenuFolder {
  id: string
  name: string
  children: MoveMenuFolder[]
  directNotes: number
  icon?: string | null
  color?: string | null
}
