import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Badge, Button } from '../../../../components/primitives'
import { Drawer } from '../../../../components/overlay'
import { MarkdownBody } from '../../components/MarkdownBody'
import { cfErrorText } from '../../api/client'
import { storeApi, type TemplateItem } from '../../api/store'
import { useCfT } from '../../i18n'
import { templateTypeLabelKey } from './helpers'

type ReadmeState = 'idle' | 'loading' | 'ready' | 'error'

export function TemplateDetailDrawer({
  item,
  onClose,
  onDeploy,
}: {
  item: TemplateItem
  onClose: () => void
  onDeploy: (item: TemplateItem) => void
}) {
  const t = useCfT()
  const template = item.template
  const readmeUrl = template.readmeUrl
  const [readme, setReadme] = useState('')
  const [state, setState] = useState<ReadmeState>('idle')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!readmeUrl) {
      setReadme('')
      setState('idle')
      setError('')
      return
    }
    const controller = new AbortController()
    setState('loading')
    setError('')
    setReadme('')
    void storeApi.readme(readmeUrl)
      .then((text) => {
        if (controller.signal.aborted) return
        setReadme(text)
        setState('ready')
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setError(cfErrorText(failure))
        setState('error')
      })
    return () => controller.abort()
  }, [readmeUrl, attempt])

  return (
    <Drawer open onClose={onClose} title={template.name} width={560} bodyClassName="flex flex-col">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="accent">{t(templateTypeLabelKey(template.type))}</Badge>
            <Badge>{template.version}</Badge>
            {item.sourceCount > 1 ? (
              <Badge>{t('cloudflare.store.multi_source', { count: item.sourceCount })}</Badge>
            ) : null}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[length:var(--text-12)]">
            <dt className="text-[var(--text-tertiary)]">{t('cloudflare.store.author')}</dt>
            <dd className="min-w-0 text-[var(--text-primary)]">
              {template.author?.url ? (
                <a
                  href={template.author.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-[var(--accent)] hover:underline"
                >
                  {template.author.name}
                </a>
              ) : (
                template.author?.name ?? t('cloudflare.store_card.unknown')
              )}
            </dd>
            <dt className="text-[var(--text-tertiary)]">{t('cloudflare.store.source')}</dt>
            <dd className="min-w-0 break-words text-[var(--text-primary)]">{item.sourceName}</dd>
            {template.homepage ? (
              <>
                <dt className="text-[var(--text-tertiary)]">{t('cloudflare.store.homepage')}</dt>
                <dd className="min-w-0">
                  <a
                    href={template.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex max-w-full items-center gap-1 break-all text-[var(--accent)] hover:underline"
                  >
                    <ExternalLink size={12} className="shrink-0" aria-hidden="true" />
                    {template.homepage}
                  </a>
                </dd>
              </>
            ) : null}
          </dl>
          {template.tags && template.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {template.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}
            </div>
          ) : null}
        </div>

        <section aria-label={t('cloudflare.store.detail')} className="min-h-32">
          {state === 'loading' ? (
            <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('cloudflare.store.loading_readme')}
            </p>
          ) : state === 'error' && readmeUrl ? (
            <div role="alert" className="space-y-2 rounded-[var(--r-md)] border border-[var(--danger)]/45 p-3">
              <p className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>
              <a
                href={readmeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block break-all text-[length:var(--text-11-5)] text-[var(--accent)] hover:underline"
              >
                {readmeUrl}
              </a>
              <Button size="sm" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
                {t('common.retry')}
              </Button>
            </div>
          ) : readme ? (
            <MarkdownBody source={readme} empty={t('cloudflare.store.no_readme')} />
          ) : (
            <MarkdownBody
              source={template.description ?? ''}
              empty={t('cloudflare.store.no_readme')}
            />
          )}
        </section>

        {template.bindings && template.bindings.length > 0 ? (
          <section className="space-y-1.5">
            <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
              {t('cloudflare.store.bindings')}
            </h2>
            <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)]">
              {template.bindings.map((binding) => (
                <div
                  key={`${binding.type}:${binding.name}`}
                  className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-1.5 text-[length:var(--text-12)] last:border-b-0"
                >
                  <Badge>{binding.type}</Badge>
                  <span className="font-mono text-[var(--text-primary)]">{binding.name}</span>
                  {binding.title ? (
                    <span className="text-[var(--text-tertiary)]">→ {binding.title}</span>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {template.env && Object.keys(template.env).length > 0 ? (
          <section className="space-y-1.5">
            <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
              {t('cloudflare.store.env_vars')}
            </h2>
            <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)]">
              {Object.entries(template.env).map(([key, value]) => (
                <div
                  key={key}
                  className="border-b border-[var(--border-subtle)] px-2.5 py-1.5 font-mono text-[length:var(--text-11-5)] last:border-b-0"
                >
                  {key} = <span className="text-[var(--text-tertiary)]">{value}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <div className="sticky bottom-0 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <Button block variant="primary" onClick={() => onDeploy(item)}>
          {t('cloudflare.store.deploy_template')}
        </Button>
      </div>
    </Drawer>
  )
}
