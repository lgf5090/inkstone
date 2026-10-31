import {
  MAX_GIST_FILES,
  MAX_GIST_FILENAME,
  MAX_GIST_FILE_BYTES,
  MAX_GIST_TOTAL_CONTENT_BYTES,
} from '@shared/development/github/limits'
import type { MessageKey } from '@shared/locales/en-US'
import type { GistFile } from '@shared/development/github/types'
import { utf8ByteLength } from '@shared/text-utils'
import { inferLanguage } from './format'

export type GistFileIssue =
  | 'empty_files'
  | 'too_many_files'
  | 'empty_filename'
  | 'duplicate_filename'
  | 'filename_too_long'
  | 'file_too_large'
  | 'total_too_large'

export function gistFileIssueKey(issue: GistFileIssue): MessageKey {
  switch (issue) {
    case 'empty_files':
      return 'development.github.gists.filename_required'
    case 'too_many_files':
      return 'development.github.gists.files_too_many'
    case 'empty_filename':
      return 'development.github.gists.filename_required'
    case 'duplicate_filename':
      return 'development.github.gists.filename_duplicate'
    case 'filename_too_long':
      return 'development.github.gists.filename_too_long'
    case 'file_too_large':
      return 'development.github.gists.file_too_large'
    case 'total_too_large':
      return 'development.github.gists.content_too_large'
  }
}

export class GistFileError extends Error {
  constructor(
    readonly issue: GistFileIssue,
    readonly index: number,
  ) {
    super(issue)
    this.name = 'GistFileError'
  }
}

export function inferGistLanguage(filename: string): string {
  return inferLanguage(filename)
}

export function normalizeGistFiles(files: readonly GistFile[]): GistFile[] {
  if (files.length === 0) throw new GistFileError('empty_files', 0)
  if (files.length > MAX_GIST_FILES) throw new GistFileError('too_many_files', MAX_GIST_FILES)
  const seen = new Set<string>()
  let total = 0
  const normalized = files.map((file, index) => {
    const filename = file.filename.trim()
    if (!filename) throw new GistFileError('empty_filename', index)
    if (filename.length > MAX_GIST_FILENAME) throw new GistFileError('filename_too_long', index)
    if (seen.has(filename)) throw new GistFileError('duplicate_filename', index)
    seen.add(filename)
    const size = utf8ByteLength(file.content)
    if (size > MAX_GIST_FILE_BYTES) throw new GistFileError('file_too_large', index)
    total += size
    if (total > MAX_GIST_TOTAL_CONTENT_BYTES) throw new GistFileError('total_too_large', index)
    return {
      filename,
      language: file.language?.trim() || inferGistLanguage(filename),
      content: file.content,
      size,
    }
  })
  return normalized
}

function availableFilename(files: readonly GistFile[], baseName: string): string {
  const names = new Set(files.map((file) => file.filename))
  if (!names.has(baseName)) return baseName
  const dot = baseName.lastIndexOf('.')
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName
  const extension = dot > 0 ? baseName.slice(dot) : ''
  let suffix = 2
  while (names.has(`${stem}-${suffix}${extension}`)) suffix += 1
  return `${stem}-${suffix}${extension}`
}

export function addGistFile(files: readonly GistFile[], baseName = 'file.txt'): GistFile[] {
  if (files.length >= MAX_GIST_FILES) throw new GistFileError('too_many_files', files.length)
  const filename = availableFilename(files, baseName.trim() || 'file.txt')
  return [...files, { filename, language: inferGistLanguage(filename), content: '', size: 0 }]
}

export function removeGistFile(files: readonly GistFile[], index: number): GistFile[] {
  if (files.length <= 1 || index < 0 || index >= files.length) return [...files]
  return files.filter((_, position) => position !== index)
}

export function updateGistFile(
  files: readonly GistFile[],
  index: number,
  patch: Partial<Pick<GistFile, 'filename' | 'content'>>,
): GistFile[] {
  if (index < 0 || index >= files.length) return [...files]
  return files.map((file, position) => {
    if (position !== index) return file
    const filename = patch.filename ?? file.filename
    const content = patch.content ?? file.content
    return {
      ...file,
      filename,
      language: patch.filename === undefined
        ? file.language
        : filename.trim()
          ? inferGistLanguage(filename)
          : null,
      content,
      size: utf8ByteLength(content),
    }
  })
}

export function chooseFence(content: string): string {
  const runs = content.match(/`+/g) ?? []
  const longest = runs.reduce((length, run) => Math.max(length, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}
