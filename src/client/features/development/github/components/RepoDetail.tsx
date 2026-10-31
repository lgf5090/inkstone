import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Calendar, Code2, Copy, Download, ExternalLink, FileText, GitBranch, History, Package, Scale, Star, Tag as TagIcon } from 'lucide-react'
import type { GithubMirrorSource, GithubRelease, GithubReleaseAsset, GithubRepo } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { copyText } from '../../../../lib/clipboard'
import { Button, IconButton, Spinner } from '../../../../components/primitives'
import { Empty } from '../../../../components/feedback'
import { Menu, type MenuItem } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { useRepoDetail } from '../cache'
import { buildMirrorDownloadUrl, formatNumber, formatDate, formatFileSize } from '../lib/format'
import { getLanguageColor } from '../lib/languages'
import { renderGithubReadme } from '../lib/readme'
import { GithubAvatar } from './GithubAvatar'

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 py-1.5">
      <span className="shrink-0 text-[var(--text-tertiary)]">{icon}</span>
      <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{label}</span>
      <span className="ml-auto min-w-0 truncate text-[length:var(--text-11)] font-medium" title={value}>{value}</span>
    </div>
  )
}

function ReleaseMenu({ releases, index, onChange }: { releases: GithubRelease[]; index: number; onChange: (index: number) => void }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const current = releases[index]
  const items: MenuItem[] = releases.map((release, releaseIndex) => ({
    id: String(release.id),
    label: `${release.tagName}${release.isLatest ? ` · ${t('development.github.repos.latest')}` : ''}${release.isPrerelease ? ` · ${t('development.github.repos.prerelease')}` : ''}`,
    checked: releaseIndex === index,
    onSelect: () => onChange(releaseIndex),
  }))
  return (
    <>
      <Button ref={anchor} variant="secondary" size="sm" className="w-full justify-between" onClick={() => setOpen(true)}>
        <span className="truncate">{current ? current.tagName : t('development.github.repos.no_release')}</span>
        {current && <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.github.repos.asset_count', { count: current.assets.length })}</span>}
      </Button>
      <Menu anchor={anchor} open={open} onClose={() => setOpen(false)} items={items} align="start" width={260} label={t('development.github.repos.release_select')} />
    </>
  )
}

function AssetPicker({ assets, value, onChange, mirrorBase }: { assets: GithubReleaseAsset[]; value: string; onChange: (value: string) => void; mirrorBase: string }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const toast = useUi((state) => state.toast)
  const current = assets.find((asset) => asset.name === value) ?? null
  const mirrorUrl = current ? buildMirrorDownloadUrl(mirrorBase, current.downloadUrl) : ''
  const items: MenuItem[] = assets.map((asset) => ({
    id: String(asset.id),
    label: `${asset.name} · ${formatFileSize(asset.size)}`,
    checked: asset.name === value,
    onSelect: () => onChange(asset.name),
  }))
  const copy = async () => {
    if (!mirrorUrl) return
    if (await copyText(mirrorUrl)) toast({ title: t('development.github.repos.mirror_url_copied'), tone: 'success' })
    else toast({ title: t('development.github.common.copy_failed'), tone: 'danger' })
  }
  return (
    <div className="space-y-1.5">
      <Button ref={anchor} variant="secondary" size="sm" className="w-full justify-between" onClick={() => setOpen(true)}>
        <span className="truncate">{value || t('development.github.repos.asset_placeholder')}</span>
        <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{assets.length}</span>
      </Button>
      <Menu anchor={anchor} open={open} onClose={() => setOpen(false)} items={items} searchable align="start" width={320} label={t('development.github.repos.asset_select')} />
      {current && (
        <>
          <div className="flex items-center gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => void copy()}><Copy size={12} />{t('development.github.repos.copy_mirror_url')}</Button>
            <a href={mirrorUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2 text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><Download size={12} />{t('development.github.repos.download_via_mirror')}</a>
          </div>
          <div className="truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]" title={mirrorUrl}>{t('development.github.repos.mirror_url')}: {mirrorUrl}</div>
        </>
      )}
    </div>
  )
}

export function RepoDetail({ repo, mirror }: { repo: GithubRepo | null; mirror: GithubMirrorSource | undefined }) {
  const { data, loading, error, refetch } = useRepoDetail(repo?.fullName ?? null, repo?.defaultBranch)
  const [releaseIndex, setReleaseIndex] = useState(0)
  const [assetName, setAssetName] = useState('')
  const toast = useUi((state) => state.toast)

  useEffect(() => {
    setReleaseIndex(0)
    setAssetName('')
  }, [repo?.id])

  const detail = data
  useEffect(() => {
    if (!detail) return
    if (releaseIndex >= detail.releases.length) setReleaseIndex(0)
  }, [detail, releaseIndex])

  const readmeHtml = useMemo(
    () => detail?.readme ? renderGithubReadme(detail.readme, { fullName: detail.fullName, defaultBranch: detail.defaultBranch }, '') : '',
    [detail?.readme, detail?.fullName, detail?.defaultBranch],
  )

  if (!repo) return <Empty art="select" title={t('development.github.repos.select_hint')} />
  if (loading) return <div className="flex h-full items-center justify-center gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]"><Spinner size={15} />{t('development.github.common.loading')}</div>
  if (error || !detail) return <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"><AlertCircle size={24} className="text-[var(--danger)]" /><p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{error instanceof Error ? error.message : t('development.github.common.load_failed')}</p><Button variant="secondary" size="sm" onClick={() => void refetch()}>{t('development.github.common.retry')}</Button></div>

  const release = detail.releases[releaseIndex]
  const currentAsset = release?.assets.find((asset) => asset.name === assetName) ?? release?.assets[0]
  const mirrorBase = mirror?.url ?? ''
  const readmeFailed = detail.warnings.some((warning) => warning.source === 'readme')

  return (
    <div className="h-full min-w-0 overflow-y-auto overscroll-contain" data-slot="repo-detail">
      {detail.rateLimited && <div className="flex items-start gap-2 border-b border-[color-mix(in_oklab,var(--warning)_35%,transparent)] bg-[color-mix(in_oklab,var(--warning)_10%,transparent)] p-3 text-[length:var(--text-11)] text-[var(--warning)]"><AlertCircle size={14} className="mt-0.5 shrink-0" /><div><p className="font-medium">{t('development.github.repos.rate_limited_title')}</p><p className="mt-0.5">{t('development.github.repos.rate_limited_hint')}</p></div></div>}
      {!detail.rateLimited && detail.warnings.length > 0 && <div className="flex items-start gap-2 border-b border-[color-mix(in_oklab,var(--warning)_30%,transparent)] p-3 text-[length:var(--text-11)] text-[var(--warning)]"><AlertCircle size={14} className="mt-0.5 shrink-0" /><div><p className="font-medium">{t('development.github.repos.partial_failed')}</p><ul className="mt-0.5 list-inside list-disc">{detail.warnings.map((warning, index) => <li key={`${warning.source}-${index}`}>{warning.source}: {warning.message}</li>)}</ul></div></div>}

      <div className="border-b border-[var(--border-subtle)] p-4">
        <div className="flex items-start gap-3">
          <GithubAvatar src={repo.owner.avatarUrl} name={repo.owner.login} size={40} />
          <div className="min-w-0 flex-1">
            <a href={repo.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-[length:var(--text-15)] font-semibold hover:text-[var(--accent)] hover:underline">{repo.owner.login}/<span className="text-[var(--accent)]">{repo.name}</span></a>
            {repo.description && <p className="mt-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)]">{repo.description}</p>}
            {repo.homepage && <a href={repo.homepage} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-[length:var(--text-11)] text-[var(--accent)] hover:underline"><ExternalLink size={11} />{repo.homepage}</a>}
          </div>
        </div>
        {repo.topics.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{repo.topics.map((topic) => <span key={topic} className="inline-flex items-center gap-0.5 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--accent-on-soft)]"><TagIcon size={9} />{topic}</span>)}</div>}
        <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          <Stat icon={<Star size={12} className="text-[var(--warning)]" />} label={t('development.github.repos.stars')} value={formatNumber(repo.stargazersCount)} />
          <Stat icon={<GitBranch size={12} />} label={t('development.github.repos.forks')} value={formatNumber(repo.forksCount)} />
          <Stat icon={<AlertCircle size={12} />} label={t('development.github.repos.issues')} value={formatNumber(repo.openIssuesCount)} />
          <Stat icon={<GitBranch size={12} />} label={t('development.github.repos.branches')} value={detail.branchesTruncated ? t('development.github.repos.branches_truncated', { count: detail.branchesCount }) : String(detail.branchesCount)} />
          <Stat icon={<TagIcon size={12} />} label={t('development.github.tags.section')} value={detail.tagsTruncated ? t('development.github.repos.tags_truncated', { count: detail.tagsCount }) : String(detail.tagsCount)} />
          <Stat icon={<GitBranch size={12} />} label={t('development.github.repos.default_branch')} value={detail.defaultBranch} />
          {repo.license && <Stat icon={<Scale size={12} />} label={t('development.github.repos.license')} value={repo.license} />}
          <Stat icon={<Code2 size={12} />} label={t('development.github.repos.size')} value={`${formatNumber(repo.size)} KB`} />
          <Stat icon={<Calendar size={12} />} label={t('development.github.repos.created_at_label')} value={formatDate(repo.createdAt)} />
          <Stat icon={<History size={12} />} label={t('development.github.repos.updated_at_label')} value={formatDate(repo.updatedAt)} />
          <Stat icon={<Package size={12} />} label={t('development.github.repos.releases_title')} value={detail.releasesTruncated ? t('development.github.repos.releases_truncated', { count: detail.releases.length }) : String(detail.releases.length)} />
          {repo.language && <Stat icon={<span className="size-2.5 rounded-full" style={{ backgroundColor: getLanguageColor(repo.language) }} />} label={t('development.github.repos.language')} value={repo.language} />}
        </div>
        {detail.languages.length > 0 && <div className="mt-3"><div className="mb-1 text-[length:var(--text-11)] font-medium tracking-wide text-[var(--text-quaternary)] uppercase">{t('development.github.repos.language_dist')}</div><div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--bg-inset)]">{detail.languages.map((language) => <div key={language.name} className="h-full" style={{ width: `${language.percentage}%`, backgroundColor: getLanguageColor(language.name) }} title={`${language.name} ${language.percentage}%`} />)}</div><div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">{detail.languages.slice(0, 6).map((language) => <span key={language.name} className="inline-flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]"><span className="size-2 rounded-full" style={{ backgroundColor: getLanguageColor(language.name) }} />{language.name}<span className="font-medium text-[var(--text-secondary)]">{language.percentage}%</span></span>)}</div></div>}
      </div>

      <div className="border-b border-[var(--border-subtle)] p-4">
        <div className="mb-2 flex items-center gap-2"><Package size={15} className="text-[var(--text-tertiary)]" /><h3 className="text-[length:var(--text-13)] font-semibold">{t('development.github.repos.releases_title')}</h3><span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.github.repos.releases_count', { count: detail.releases.length })} · {t('development.github.mirrors.current', { name: mirror?.name ?? '' })}</span></div>
        {detail.releases.length === 0 ? <p className="rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] p-4 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{detail.warnings.some((warning) => warning.source === 'releases') ? t('development.github.repos.releases_failed') : t('development.github.repos.no_releases')}</p> : (
          <div className="space-y-2">
            <ReleaseMenu releases={detail.releases} index={releaseIndex} onChange={(index) => { setReleaseIndex(index); setAssetName(detail.releases[index]?.assets[0]?.name ?? '') }} />
            {release && <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2.5"><div className="flex items-center gap-2 text-[length:var(--text-11)]"><a href={release.htmlUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-[var(--accent)] hover:underline">{release.name || release.tagName}</a><span className="text-[var(--text-tertiary)]">{t('development.github.repos.published_at', { date: formatDate(release.publishedAt) })}</span></div>{release.body && <pre className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-[length:var(--text-11)] text-[var(--text-tertiary)]">{release.body.length > 400 ? `${release.body.slice(0, 400)}...` : release.body}</pre>}</div>}
            {release && release.assets.length > 0 ? <AssetPicker assets={release.assets} value={currentAsset?.name ?? ''} onChange={setAssetName} mirrorBase={mirrorBase} /> : <p className="rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] p-3 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.github.repos.no_assets')}</p>}
            {release && release.assets.length > 0 && <div className="text-[length:var(--text-11)] font-medium tracking-wide text-[var(--text-quaternary)] uppercase">{t('development.github.repos.all_assets', { count: release.assets.length })}</div>}
            {release && release.assets.length > 0 && <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)]">{release.assets.map((asset) => { const url = buildMirrorDownloadUrl(mirrorBase, asset.downloadUrl); return <li key={asset.id} className="flex items-center gap-2 px-2.5 py-1.5 text-[length:var(--text-11)]"><FileText size={11} className="shrink-0 text-[var(--text-tertiary)]" /><button type="button" onClick={() => setAssetName(asset.name)} className="min-w-0 flex-1 truncate text-left hover:text-[var(--accent)]" title={asset.name}>{asset.name}</button><span className="shrink-0 text-[var(--text-quaternary)]">{formatFileSize(asset.size)}</span><IconButton label={t('development.github.repos.copy_mirror_url')} size="sm" onClick={() => void copyText(url).then((ok) => toast({ title: ok ? t('development.github.repos.mirror_url_copied') : t('development.github.common.copy_failed'), tone: ok ? 'success' : 'danger' }))}><Copy size={11} /></IconButton><a href={url} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]" title={t('development.github.repos.download_via_mirror')}><Download size={11} /></a></li> })}</ul>}
          </div>
        )}
      </div>

      <div className="p-4">
        <div className="mb-2 flex items-center gap-2"><FileText size={15} className="text-[var(--text-tertiary)]" /><h3 className="text-[length:var(--text-13)] font-semibold">{t('development.github.repos.readme')}</h3>{detail.readmeHtmlUrl && <a href={detail.readmeHtmlUrl} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-[length:var(--text-11)] text-[var(--accent)] hover:underline"><ExternalLink size={11} />{t('development.github.repos.view_on_github')}</a>}</div>
        {readmeHtml ? <div className={cn('github-readme ink-prose max-w-none', 'overflow-x-auto')} dangerouslySetInnerHTML={{ __html: readmeHtml }} /> : <p className="rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] p-4 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{readmeFailed ? t('development.github.repos.readme_failed') : t('development.github.repos.no_readme')}</p>}
      </div>
    </div>
  )
}
