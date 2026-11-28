import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { ExternalLink, GitPullRequest, MessageSquare, Trash2 } from 'lucide-react'
import type { ProjectIntegration, ProjectIntegrationProvider } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Input } from '../../components/form'
import { LoadingBlock } from '../../components/feedback'
import { useUi } from '../../store/ui'
import { deleteProjectIntegration, fetchProjectIntegrations, patchProjectIntegration, saveProjectIntegration } from './api'

const PROVIDERS: ProjectIntegrationProvider[] = ['slack', 'github', 'jira']

function providerLabel(provider: ProjectIntegrationProvider): string {
  if (provider === 'slack') return t('project.integrations.provider.slack')
  if (provider === 'github') return t('project.integrations.provider.github')
  return t('project.integrations.provider.jira')
}

export function NativeIntegrations({ boardId }: { boardId: string }): ReactElement {
  const toast = useUi((state) => state.toast)
  const [integrations, setIntegrations] = useState<ProjectIntegration[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setFailed(false)
    fetchProjectIntegrations(boardId, controller.signal)
      .then(setIntegrations)
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [boardId, attempt])

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try { await action() } catch (cause: unknown) {
      toast({ title: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    } finally { setBusy(false) }
  }, [toast])

  const toggle = (integration: ProjectIntegration, enabled: boolean): void => {
    void run(async () => {
      const updated = await patchProjectIntegration(boardId, integration.id, enabled)
      setIntegrations((current) => current?.map((entry) => entry.id === integration.id ? updated : entry) ?? null)
    })
  }

  return (
    <section className="space-y-2">
      <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{t('project.integrations.native')}</h3>
      {failed
        ? <Button size="sm" variant="ghost" onClick={() => setAttempt((current) => current + 1)}>{t('common.retry')}</Button>
        : integrations === null
          ? <LoadingBlock />
          : PROVIDERS.map((provider) => {
              const integration = integrations.find((entry) => entry.provider === provider)
              return integration
                ? (
                    <div key={provider} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
                      <ProviderIcon provider={provider} />
                      <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{providerLabel(integration.provider)} · {integration.target}</span>
                      <Checkbox ariaLabel={t('project.integrations.enabled')} checked={integration.enabled} disabled={busy} onChange={(enabled) => toggle(integration, enabled)} />
                      <IconButton label={t('common.delete')} size="sm" disabled={busy} onClick={() => { void run(async () => { await deleteProjectIntegration(boardId, integration.id); setIntegrations((current) => current?.filter((entry) => entry.id !== integration.id) ?? null) }) }}><Trash2 size={14} /></IconButton>
                    </div>
                  )
                : <IntegrationForm key={provider} boardId={boardId} provider={provider} busy={busy} onSaved={(integration) => setIntegrations((current) => [...(current ?? []), integration])} run={run} />
            })}
    </section>
  )
}

function ProviderIcon({ provider }: { provider: ProjectIntegrationProvider }): ReactElement {
  if (provider === 'slack') return <MessageSquare size={14} aria-hidden="true" className="text-[var(--text-tertiary)]" />
  if (provider === 'github') return <GitPullRequest size={14} aria-hidden="true" className="text-[var(--text-tertiary)]" />
  return <ExternalLink size={14} aria-hidden="true" className="text-[var(--text-tertiary)]" />
}

function IntegrationForm({ boardId, provider, busy, onSaved, run }: {
  boardId: string
  provider: ProjectIntegrationProvider
  busy: boolean
  onSaved: (integration: ProjectIntegration) => void
  run: (action: () => Promise<void>) => Promise<void>
}): ReactElement {
  const [webhookUrl, setWebhookUrl] = useState('')
  const [token, setToken] = useState('')
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [email, setEmail] = useState('')
  const [projectKey, setProjectKey] = useState('')
  const valid = provider === 'slack'
    ? webhookUrl.trim().length > 0
    : provider === 'github'
      ? token.trim().length > 0 && owner.trim().length > 0 && repo.trim().length > 0
      : baseUrl.trim().length > 0 && email.trim().length > 0 && token.trim().length > 0 && projectKey.trim().length > 0
  const save = (): void => {
    void run(async () => {
      const integration = provider === 'slack'
        ? await saveProjectIntegration(boardId, { provider, config: { webhookUrl: webhookUrl.trim() } })
        : provider === 'github'
          ? await saveProjectIntegration(boardId, { provider, config: { token: token.trim(), owner: owner.trim(), repo: repo.trim() } })
          : await saveProjectIntegration(boardId, { provider, config: { baseUrl: baseUrl.trim(), email: email.trim(), token: token.trim(), projectKey: projectKey.trim() } })
      onSaved(integration)
      setWebhookUrl(''); setToken(''); setOwner(''); setRepo(''); setBaseUrl(''); setEmail(''); setProjectKey('')
    })
  }
  return (
    <div className="space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
      <div className="flex items-center gap-2"><ProviderIcon provider={provider} /><span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{providerLabel(provider)}</span></div>
      {provider === 'slack' && <Input className="w-full" value={webhookUrl} aria-label={t('project.integrations.slack_webhook')} placeholder={t('project.integrations.slack_webhook')} onChange={(event) => setWebhookUrl(event.target.value)} />}
      {provider === 'github' && <div className="grid gap-2 sm:grid-cols-3"><Input className="w-full" value={token} type="password" aria-label={t('project.integrations.token')} placeholder={t('project.integrations.token')} onChange={(event) => setToken(event.target.value)} /><Input className="w-full" value={owner} aria-label={t('project.integrations.github_owner')} placeholder={t('project.integrations.github_owner')} onChange={(event) => setOwner(event.target.value)} /><Input className="w-full" value={repo} aria-label={t('project.integrations.github_repo')} placeholder={t('project.integrations.github_repo')} onChange={(event) => setRepo(event.target.value)} /></div>}
      {provider === 'jira' && <div className="grid gap-2 sm:grid-cols-2"><Input className="w-full" value={baseUrl} aria-label={t('project.integrations.jira_url')} placeholder={t('project.integrations.jira_url')} onChange={(event) => setBaseUrl(event.target.value)} /><Input className="w-full" value={email} type="email" aria-label={t('project.integrations.jira_email')} placeholder={t('project.integrations.jira_email')} onChange={(event) => setEmail(event.target.value)} /><Input className="w-full" value={token} type="password" aria-label={t('project.integrations.token')} placeholder={t('project.integrations.token')} onChange={(event) => setToken(event.target.value)} /><Input className="w-full" value={projectKey} aria-label={t('project.integrations.jira_project')} placeholder={t('project.integrations.jira_project')} onChange={(event) => setProjectKey(event.target.value)} /></div>}
      <Button size="sm" variant="primary" loading={busy} disabled={!valid} onClick={save}>{t('common.save')}</Button>
    </div>
  )
}
