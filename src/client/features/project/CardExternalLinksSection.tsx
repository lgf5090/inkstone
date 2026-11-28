import { useEffect, useState, type ReactElement } from 'react'
import { ExternalLink, GitPullRequest } from 'lucide-react'
import type { ProjectExternalLink, ProjectIntegration } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { LoadingBlock } from '../../components/feedback'
import { useUi } from '../../store/ui'
import { createProjectExternalIssue, fetchProjectExternalLinks, fetchProjectIntegrations } from './api'

export function CardExternalLinksSection({ boardId, cardId, canEdit }: {
  boardId: string
  cardId: string
  canEdit: boolean
}): ReactElement {
  const toast = useUi((state) => state.toast)
  const [links, setLinks] = useState<ProjectExternalLink[] | null>(null)
  const [integrations, setIntegrations] = useState<ProjectIntegration[]>([])
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setFailed(false)
    Promise.all([fetchProjectExternalLinks(cardId, controller.signal), fetchProjectIntegrations(boardId, controller.signal)])
      .then(([externalLinks, configured]) => {
        if (controller.signal.aborted) return
        setLinks(externalLinks)
        setIntegrations(configured.filter((entry) => entry.enabled && entry.provider !== 'slack'))
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [boardId, cardId, attempt])

  const create = async (provider: 'github' | 'jira'): Promise<void> => {
    setBusy(provider)
    try {
      await createProjectExternalIssue(cardId, provider)
      setAttempt((current) => current + 1)
    } catch (cause: unknown) {
      toast({ title: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-label={t('project.card.external_links')} className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]"><ExternalLink size={13} aria-hidden="true" />{t('project.card.external_links')}</h3>
        {canEdit && links !== null && integrations.filter((integration) => !links.some((link) => link.provider === integration.provider)).map((integration) => (
          <Button key={integration.id} size="sm" variant="ghost" loading={busy === integration.provider} onClick={() => void create(integration.provider as 'github' | 'jira')}>
            {integration.provider === 'github' ? <GitPullRequest size={12} aria-hidden="true" /> : <ExternalLink size={12} aria-hidden="true" />}
            {integration.provider === 'github' ? t('project.card.create_github_issue') : t('project.card.create_jira_issue')}
          </Button>
        ))}
      </div>
      {failed
        ? <Button size="sm" variant="ghost" onClick={() => setAttempt((current) => current + 1)}>{t('common.retry')}</Button>
        : links === null
          ? <LoadingBlock />
          : links.length === 0
            ? <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.card.external_links_empty')}</p>
            : (
                <ul className="space-y-1">
                  {links.map((link) => (
                    <li key={link.id} className="flex items-center gap-2 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1.5">
                      {link.provider === 'github' ? <GitPullRequest size={13} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" /> : <ExternalLink size={13} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />}
                      <a href={link.externalUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--accent)] hover:underline">{link.title || link.externalId}</a>
                      <span className="shrink-0 text-[length:var(--text-10)] uppercase text-[var(--text-tertiary)]">{link.provider}</span>
                    </li>
                  ))}
                </ul>
              )}
    </section>
  )
}
