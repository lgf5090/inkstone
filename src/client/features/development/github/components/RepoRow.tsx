import { memo, useMemo } from 'react'
import { Archive, BookmarkX, Calendar, CircleDot, Copy, ExternalLink, GitFork, Globe, Pin, Scale, Star } from 'lucide-react'
import type { GithubRepo, GithubTag, SavedGithubRepo } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { copyText } from '../../../../lib/clipboard'
import { useUi } from '../../../../store/ui'
import { IconButton } from '../../../../components/primitives'
import { formatNumber, formatDate } from '../lib/format'
import { getLanguageColor } from '../lib/languages'
import { AssignedTagChips, TagAssign } from './TagAssign'
import { GithubAvatar } from './GithubAvatar'

const VISIBLE_TOPICS = 5

export interface RepoRowProps {
  repo: GithubRepo
  rank: number
  saved?: SavedGithubRepo
  tags: GithubTag[]
  selected: boolean
  mirrorUrl: string
  onSelect: (repo: GithubRepo) => void
  onTogglePin: (repo: GithubRepo) => void
  onToggleFav: (repo: GithubRepo) => void
  onToggleTag: (repo: GithubRepo, tagId: string) => void
  onRemove: (repo: GithubRepo) => void
}

export const RepoRow = memo(function RepoRow({
  repo,
  rank,
  saved,
  tags,
  selected,
  mirrorUrl,
  onSelect,
  onTogglePin,
  onToggleFav,
  onToggleTag,
  onRemove,
}: RepoRowProps) {
  const toast = useUi((state) => state.toast)
  const assigned = useMemo(() => tags.filter((tag) => (saved?.tagIds ?? []).includes(tag.id)), [tags, saved])
  const copy = async (text: string, message: string) => {
    if (await copyText(text)) toast({ title: message, tone: 'success' })
    else toast({ title: t('development.github.common.copy_failed'), tone: 'danger' })
  }
  return (
    <li
      data-slot="github-repo-row"
      onClick={() => onSelect(repo)}
      className={cn(
        'group cursor-pointer border-l-2 px-3 py-3 transition-colors hover:bg-[var(--bg-hover)]',
        selected ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-transparent',
      )}
    >
      <div className="flex gap-2">
        <div className="w-7 shrink-0 pt-0.5 text-right text-[length:var(--text-12)] font-semibold tabular-nums text-[var(--text-quaternary)]">
          {rank <= 3 ? <span className="text-[var(--warning)]">#{rank}</span> : `#${rank}`}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <GithubAvatar src={repo.owner.avatarUrl} name={repo.owner.login} size={24} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <button type="button" onClick={(event) => { event.stopPropagation(); onSelect(repo) }} aria-current={selected ? 'true' : undefined} className="min-w-0 truncate bg-transparent text-left text-[length:var(--text-13)] font-semibold text-[var(--text-primary)] hover:text-[var(--accent)] hover:underline focus-visible:underline focus-visible:outline-none" title={repo.fullName}>
                  {repo.owner.login}/<span className="text-[var(--accent)]">{repo.name}</span>
                </button>
                {repo.isArchived && <span className="inline-flex shrink-0 items-center gap-1 rounded bg-[color-mix(in_oklab,var(--warning)_14%,transparent)] px-1.5 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--warning)]"><Archive size={10} /> {t('development.github.repos.archived')}</span>}
                <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                  <a href={repo.url} target="_blank" rel="noopener noreferrer" aria-label={t('development.github.repos.open_on_github')} title={t('development.github.repos.open_on_github')} onClick={(event) => event.stopPropagation()} className="inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-6"><ExternalLink size={13} /></a>
                  <IconButton label={saved?.pinned ? t('development.github.repos.unpin') : t('development.github.repos.pin')} size="sm" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onTogglePin(repo) }}><Pin size={13} className={cn(saved?.pinned && 'fill-current text-[var(--warning)]')} /></IconButton>
                  <IconButton label={saved?.favorited ? t('development.github.repos.unfavorite') : t('development.github.repos.favorite')} size="sm" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onToggleFav(repo) }}><Star size={13} className={cn(saved?.favorited && 'fill-current text-[var(--warning)]')} /></IconButton>
                  <IconButton label={t('development.github.repos.copy_url')} size="sm" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void copy(repo.url, t('development.github.repos.url_copied')) }}><Copy size={13} /></IconButton>
                  <IconButton label={t('development.github.repos.copy_mirror_url')} size="sm" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void copy(mirrorUrl, t('development.github.repos.mirror_url_copied')) }}><Globe size={13} /></IconButton>
                  <TagAssign assignedTags={assigned} allTags={tags} onToggle={(tagId) => onToggleTag(repo, tagId)} />
                  {saved && <IconButton label={t('development.github.repos.remove_saved')} size="sm" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onRemove(repo) }}><BookmarkX size={13} /></IconButton>}
                </div>
              </div>
              {repo.description && <p className="mt-1 line-clamp-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{repo.description}</p>}
              {repo.topics.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {repo.topics.slice(0, VISIBLE_TOPICS).map((topic) => <span key={topic} className="rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--accent-on-soft)]">{topic}</span>)}
                  {repo.topics.length > VISIBLE_TOPICS && <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">+{repo.topics.length - VISIBLE_TOPICS}</span>}
                </div>
              )}
              {assigned.length > 0 && <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <AssignedTagChips tags={assigned} />
              </div>}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {repo.language && <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full" style={{ backgroundColor: getLanguageColor(repo.language) }} />{repo.language}</span>}
                <span className="inline-flex items-center gap-1" title={t('development.github.repos.stars')}><Star size={10} />{formatNumber(repo.stargazersCount)}</span>
                <span className="inline-flex items-center gap-1" title={t('development.github.repos.forks')}><GitFork size={10} />{formatNumber(repo.forksCount)}</span>
                <span className="inline-flex items-center gap-1" title={t('development.github.repos.issues')}><CircleDot size={10} />{formatNumber(repo.openIssuesCount)}</span>
                {repo.license && <span className="inline-flex items-center gap-1" title={t('development.github.repos.license')}><Scale size={10} />{repo.license}</span>}
                <span className="inline-flex items-center gap-1" title={t('development.github.repos.updated')}><Calendar size={10} />{formatDate(repo.updatedAt)}</span>
                {repo.homepage && <a href={repo.homepage} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()} className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline" title={t('development.github.repos.homepage')}><ExternalLink size={10} />{t('development.github.repos.homepage')}</a>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </li>
  )
})
