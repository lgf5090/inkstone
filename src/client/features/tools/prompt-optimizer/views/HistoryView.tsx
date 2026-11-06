/**
 * The history shelf: every optimization chain, its versions, and the way back into the workspace.
 */

import { useEffect, useState } from 'react'
import { Download, Search, Star, Trash2 } from 'lucide-react'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { confirm } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import { WORKSPACES } from '@shared/tools/prompt-optimizer/types'
import { usePromptOptimizerStore } from '../store'

function cacheText(input: number, cached: number): string {
  const miss = Math.max(0, input - cached)
  const pct = input > 0 ? Math.round((cached / input) * 100) : 0
  return t('tools.prompt_optimizer.usage.cache_stats')
    .replace('{hit}', String(cached))
    .replace('{miss}', String(miss))
    .replace('{pct}', String(pct))
}

export function HistoryView() {
  const history = usePromptOptimizerStore((s) => s.history)
  const search = usePromptOptimizerStore((s) => s.historySearch)
  const workspace = usePromptOptimizerStore((s) => s.historyWorkspace)
  const setSearch = usePromptOptimizerStore((s) => s.setHistorySearch)
  const setWorkspace = usePromptOptimizerStore((s) => s.setHistoryWorkspace)
  const deleteChain = usePromptOptimizerStore((s) => s.deleteChain)
  const clearHistory = usePromptOptimizerStore((s) => s.clearHistory)
  const refreshHistory = usePromptOptimizerStore((s) => s.refreshHistory)
  const loadChain = usePromptOptimizerStore((s) => s.loadChain)
  const saveFavorite = usePromptOptimizerStore((s) => s.saveFavorite)
  const [expanded, setExpanded] = useState<string | null>(null)

  const favoriteChain = async (chain: (typeof history)[number]) => {
    const record = chain.currentRecord
    await saveFavorite({
      title: `${record.workspace} · v${record.version}`,
      content: record.optimizedPrompt,
      description: '',
      functionMode: record.workspace.startsWith('image_') ? 'image' : record.workspace.startsWith('pro_') ? 'context' : 'basic',
      optimizationMode: record.workspace === 'basic_user' || record.workspace === 'pro_variable' ? 'user' : 'system',
      tags: [],
      metadata: {
        originalContent: record.originalPrompt,
        sourceHistoryId: chain.chainId,
        modelId: record.modelId,
        modelLabel: record.modelLabel,
        templateId: record.templateId,
        origin: 'history',
      },
    })
  }

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2">
        <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
          {t('tools.prompt_optimizer.history.title')}
        </h1>
        <div className="relative min-w-[200px] flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" aria-hidden="true" />
          <Input
            aria-label={t('tools.prompt_optimizer.history.search')}
            value={search}
            onChange={(event) => void setSearch(event.target.value)}
            placeholder={t('tools.prompt_optimizer.history.search')}
            className="pl-8"
          />
        </div>
        <SelectMenu
          label={t('tools.prompt_optimizer.history.workspace')}
          value={workspace}
          options={[
            { value: '', label: t('tools.prompt_optimizer.history.all_workspaces') },
            ...WORKSPACES.map((item) => ({
              value: item,
              label: t(`tools.prompt_optimizer.nav.${item}` as never),
            })),
          ]}
          onChange={(value) => void setWorkspace(value)}
          width={200}
          size="sm"
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void confirm({ title: t('tools.prompt_optimizer.history.clear_confirm'), tone: 'danger' })
            .then((ok) => { if (ok) void clearHistory() })}
        >
          <Trash2 size={13} />
          {t('tools.prompt_optimizer.history.clear')}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {history.length === 0 ? (
          <p className="py-16 text-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">
            {t('tools.prompt_optimizer.history.empty')}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {history.map((chain) => {
              const record = chain.currentRecord
              const label = t(`tools.prompt_optimizer.nav.${record.workspace}` as never) || record.workspace
              return (
                <article key={chain.chainId} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="accent">{label}</Badge>
                    <Badge tone="neutral">{t('tools.prompt_optimizer.history.chain').replace('{count}', String(chain.versions.length))}</Badge>
                    <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      {new Date(record.createdAt).toLocaleString()}
                    </span>
                    {record.modelLabel && <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{record.modelLabel}</span>}
                    {(() => {
                      const usage = record.metadata.usage as { inputTokens?: number; cachedInputTokens?: number } | undefined
                      if (!usage?.inputTokens) return null
                      return (
                        <Badge tone={(usage.cachedInputTokens ?? 0) > 0 ? 'success' : 'neutral'}>
                          {cacheText(usage.inputTokens, usage.cachedInputTokens ?? 0)}
                        </Badge>
                      )
                    })()}
                    <div className="ml-auto flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => loadChain(chain)}>
                        {t('tools.prompt_optimizer.history.open')}
                      </Button>
                      <IconButton
                        label={t('tools.prompt_optimizer.favorites.save_current')}
                        size="xs"
                        onClick={() => void favoriteChain(chain)}
                      >
                        <Star size={12} />
                      </IconButton>
                      <IconButton
                        label={t('tools.prompt_optimizer.common.delete')}
                        size="xs"
                        onClick={() => void confirm({ title: t('tools.prompt_optimizer.history.delete_confirm'), tone: 'danger' })
                          .then((ok) => { if (ok) void deleteChain(chain.chainId) })}
                      >
                        <Trash2 size={12} />
                      </IconButton>
                    </div>
                  </div>
                  <p className="mt-2 line-clamp-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
                    {chain.rootRecord.originalPrompt || '—'}
                  </p>
                  <button
                    type="button"
                    className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)] underline"
                    aria-expanded={expanded === chain.chainId}
                    onClick={() => setExpanded((current) => current === chain.chainId ? null : chain.chainId)}
                  >
                    {t('tools.prompt_optimizer.workspace.versions')}
                  </button>
                  {expanded === chain.chainId && (
                    <ul className="mt-2 flex flex-col gap-1">
                      {chain.versions.map((version) => (
                        <li key={version.id} className="rounded-[var(--r-sm)] bg-[var(--bg-raised)] p-2">
                          <div className="flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                            <span className="font-mono">{`v${version.version}`}</span>
                            <span>{new Date(version.createdAt).toLocaleString()}</span>
                            {version.iterationNote && <span className="truncate">{version.iterationNote}</span>}
                          </div>
                          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[length:var(--text-12)] text-[var(--text-secondary)]">
                            {version.optimizedPrompt}
                          </pre>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-3 py-2">
        <Button variant="ghost" size="sm" onClick={() => void usePromptOptimizerStore.getState().exportData('txt', 'history')}>
          <Download size={13} />
          {t('tools.prompt_optimizer.history.export')}
        </Button>
      </div>
    </div>
  )
}
