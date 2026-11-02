import type { CloudDrivePreviewRule, CloudDrivePreviewType } from '@shared/clouddrive/settings'
import type { FilePreviewPolicy } from '../file-preview'

type Choice = FilePreviewPolicy['byExtension'][string]

/**
 * What one rule type means for the viewer. `office` and `native` both hand the file back: a Word,
 * spreadsheet and slide deck each need a different renderer, and only the built-in map knows which.
 */
const TYPE_TO_CHOICE: Record<CloudDrivePreviewType, Choice> = {
  text: 'text',
  image: 'image',
  video: 'media',
  audio: 'media',
  pdf: 'pdf',
  office: 'native',
  archive: 'archive',
  ofd: 'ofd',
  native: 'native',
  none: null,
}

/**
 * The drive's preview rules as a per-extension answer for the viewer. `parsePreviewRules` hands them
 * back sorted by descending priority, so the first rule naming an extension wins; an extension no
 * rule mentions keeps the viewer's own answer.
 */
export function cloudDrivePreviewPolicy(rules: readonly CloudDrivePreviewRule[]): FilePreviewPolicy {
  const byExtension: FilePreviewPolicy['byExtension'] = {}
  const claimed = new Set<string>()
  for (const rule of rules) {
    for (const extension of rule.extensions) {
      if (claimed.has(extension)) continue
      claimed.add(extension)
      byExtension[extension] = TYPE_TO_CHOICE[rule.type]
    }
  }
  return { byExtension }
}
