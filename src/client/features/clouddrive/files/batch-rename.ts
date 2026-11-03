import { cloudDriveNameProblem, foldedName, type CloudDriveEntry } from '@shared/clouddrive/model'
import { splitExtension } from './format'

export type BatchRenameMode = 'prefix' | 'suffix' | 'replace' | 'number'

export interface BatchRenameOptions {
  mode: BatchRenameMode
  /** The text for `prefix`, `suffix` and `number`; the replacement for `replace`. */
  value: string
  /** Only for `replace`. */
  find: string
  /** Only for `number`: the first index. */
  start: number
}

export interface BatchRenameItem {
  id: string
  from: string
  name: string
  problem: 'invalid' | 'duplicate' | null
}

/**
 * The name one rule produces. Only the part before a short extension is rewritten, so `photo.jpg`
 * with the suffix `-v2` lands as `photo-v2.jpg` and never as `photo.jpg-v2`; a folder has no
 * extension to protect.
 */
function renamed(entry: CloudDriveEntry, options: BatchRenameOptions, index: number): string {
  const [base, extension] = entry.kind === 'folder' ? [entry.name, ''] : splitExtension(entry.name)
  switch (options.mode) {
    case 'prefix': return `${options.value}${base}${extension}`
    case 'suffix': return `${base}${options.value}${extension}`
    case 'replace': return `${options.find ? base.replaceAll(options.find, options.value) : base}${extension}`
    case 'number': return `${options.value}${options.start + index}${extension}`
  }
}

/**
 * Every proposed name, each judged against the same two rules the server applies to the rename: the
 * name itself has to be one CloudDrive stores, and it has to be free among the rows staying put.
 */
export function planBatchRename(
  selected: readonly CloudDriveEntry[],
  staying: readonly CloudDriveEntry[],
  options: BatchRenameOptions,
): BatchRenameItem[] {
  const taken = new Map<string, string>(staying.map((entry) => [foldedName(entry.name), entry.id]))
  const planned = selected.map((entry, index) => ({ entry, name: renamed(entry, options, index) }))
  return planned.map(({ entry, name }) => {
    const fold = foldedName(name)
    const clash = taken.get(fold)
    const duplicated = clash !== undefined && clash !== entry.id
    taken.set(fold, entry.id)
    return {
      id: entry.id,
      from: entry.name,
      name,
      problem: cloudDriveNameProblem(name) ? 'invalid' : duplicated ? 'duplicate' : null,
    }
  })
}
