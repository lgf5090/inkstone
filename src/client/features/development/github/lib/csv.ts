import type { GithubTag, SavedGithubRepo } from '@shared/development/github/types'

export const REPO_CSV_HEADER = [
  'fullName',
  'url',
  'description',
  'language',
  'stars',
  'forks',
  'openIssues',
  'topics',
  'license',
  'archived',
  'updatedAt',
  'tags',
  'pinned',
  'favorited',
  'notes',
] as const

function cell(value: string | number | boolean): string {
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function buildRepoCsv(
  repos: readonly SavedGithubRepo[],
  tags: readonly GithubTag[],
): string {
  const tagNames = new Map(tags.map((tag) => [tag.id, tag.name]))
  const lines = [REPO_CSV_HEADER.join(',')]
  for (const repo of repos) {
    const data = repo.data
    lines.push([
      repo.fullName,
      repo.url,
      data.description ?? '',
      data.language ?? '',
      data.stargazersCount,
      data.forksCount,
      data.openIssuesCount,
      data.topics.join(' '),
      data.license ?? '',
      data.isArchived ? 'true' : 'false',
      data.updatedAt,
      repo.tagIds.map((id) => tagNames.get(id) ?? id).join(' | '),
      repo.pinned ? 'true' : 'false',
      repo.favorited ? 'true' : 'false',
      repo.notes,
    ].map(cell).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}
