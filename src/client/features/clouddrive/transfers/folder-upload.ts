/**
 * The folder side of an upload: a directory picked in the browser arrives as a flat file list whose
 * `webkitRelativePath` holds the shape, and the drive has to build that shape before any file lands.
 */

export interface FolderFile {
  name: string
  webkitRelativePath?: string
}

export interface FolderPlan {
  /** Directory segments to create, parents before children, relative to the picked root. */
  directories: string[]
  /** Each file with the folder it belongs in, relative to the picked root. */
  files: { file: FolderFile; directory: string; name: string }[]
}

function relativeOf(file: FolderFile): string {
  return (file.webkitRelativePath ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
}

/**
 * The plan for one picked directory. A file with no relative path (a plain multi-select, or a browser
 * that strips it) keeps going where it always went: the folder that is open.
 */
export function planFolderUpload(files: readonly FolderFile[]): FolderPlan {
  const directories = new Set<string>()
  const planned: FolderPlan['files'] = []
  for (const file of files) {
    const relative = relativeOf(file)
    if (!relative) {
      planned.push({ file, directory: '', name: file.name })
      continue
    }
    const segments = relative.split('/').filter(Boolean)
    const name = segments.pop() ?? file.name
    const directory = segments.join('/')
    // Every ancestor of a path has to exist, and `a/b` needs `a` before it.
    for (let depth = 1; depth <= segments.length; depth++) directories.add(segments.slice(0, depth).join('/'))
    planned.push({ file, directory, name })
  }
  const sorted = [...directories].sort((left, right) => {
    const depth = left.split('/').length - right.split('/').length
    return depth !== 0 ? depth : left.localeCompare(right)
  })
  return { directories: sorted, files: planned }
}

export interface FolderUploadApi {
  mkdir: (body: { mountId: string; parentPath: string; name: string; conflict?: 'reuse' }) => Promise<unknown>
}

/**
 * Creates the planned directories and returns the absolute parent path for each file. A segment is
 * reused rather than duplicated, so re-picking the same folder does not scatter `x (1)` copies.
 */
export async function createFolderTree(
  api: FolderUploadApi,
  mountId: string,
  rootPath: string,
  plan: FolderPlan,
  onError?: (path: string, error: unknown) => void,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>([['', rootPath]])
  for (const directory of plan.directories) {
    const segments = directory.split('/')
    const parent = resolved.get(segments.slice(0, -1).join('/')) ?? rootPath
    try {
      await api.mkdir({ mountId, parentPath: parent, name: segments[segments.length - 1], conflict: 'reuse' })
      resolved.set(directory, `${parent === '/' ? '' : parent}/${segments[segments.length - 1]}`)
    } catch (error) {
      // Without the folder there is nowhere to put its files; the caller reports what was skipped.
      onError?.(directory, error)
    }
  }
  return resolved
}
