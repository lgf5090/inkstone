/**
 * The saved addresses, managed in the dialog the reference panel used for the same job.
 *
 * A same-origin path is the address a deployment can offer without touching its security policy; an
 * absolute URL is accepted because a deployment that has widened `connect-src` itself can use one, and
 * the hint says so rather than pretending every address will answer.
 */
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, IconButton } from '../../../../components/primitives'
import { Modal, Tooltip, confirm } from '../../../../components/overlay'
import { Field, Input } from '../../../../components/form'
import { NETWORK_PANEL_LIMITS } from '@shared/tools/network-panel/types'
import { parseNodeUrl } from '@shared/tools/network-panel/engine'
import { t } from '../../../../lib/i18n'
import { useNetworkPanelStore } from '../store'

export function NodeManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nodes = useNetworkPanelStore((s) => s.nodes)
  const selectedId = useNetworkPanelStore((s) => s.settings.nodeId)
  const addNode = useNetworkPanelStore((s) => s.addNode)
  const removeNode = useNetworkPanelStore((s) => s.removeNode)
  const selectNode = useNetworkPanelStore((s) => s.selectNode)
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const atLimit = nodes.length >= NETWORK_PANEL_LIMITS.maxNodes

  const submit = async () => {
    if (adding || atLimit) return
    const parsed = parseNodeUrl(url)
    if (!label.trim()) {
      setError(t('tools.network_panel.nodes.label_required'))
      return
    }
    if (!parsed.ok) {
      setError(t('tools.network_panel.nodes.invalid_url'))
      return
    }
    setError(null)
    setAdding(true)
    const created = await addNode(label, parsed.url)
    setAdding(false)
    if (created) {
      setLabel('')
      setUrl('')
    }
  }

  const remove = async (id: string, nodeLabel: string) => {
    const answer = await confirm({
      title: t('tools.network_panel.nodes.delete_confirm', { label: nodeLabel }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      tone: 'danger',
    })
    if (answer) await removeNode(id)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('tools.network_panel.nodes.title')}
      description={t('tools.network_panel.nodes.desc')}
      width={560}
      footer={<Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-3">
        {nodes.length === 0 ? (
          <p className="rounded-[var(--r-md)] border border-dashed border-[var(--border-default)] bg-[var(--bg-sunken)] p-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('tools.network_panel.nodes.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)]">
            {nodes.map((node) => (
              <li key={node.id} className="flex items-center gap-2 p-2">
                <button
                  type="button"
                  aria-current={node.id === selectedId ? 'true' : undefined}
                  onClick={() => selectNode(node.id)}
                  className="min-w-0 flex-1 rounded-[var(--r-sm)] px-2 py-1 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-ring-focus)]"
                >
                  <span className="block truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                    {node.label}
                  </span>
                  <span className="block truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]" title={node.url}>
                    {node.url}
                  </span>
                </button>
                <Tooltip label={t('tools.network_panel.nodes.delete')} side="left">
                  <IconButton
                    label={t('tools.network_panel.nodes.delete')}
                    size="sm"
                    onClick={() => { void remove(node.id, node.label) }}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}

        <form
          className="space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={t('tools.network_panel.nodes.name')}>
              <Input
                value={label}
                maxLength={NETWORK_PANEL_LIMITS.maxLabel}
                onChange={(event) => setLabel(event.target.value)}
                disabled={atLimit}
                autoComplete="off"
              />
            </Field>
            <Field
              label={t('tools.network_panel.nodes.url')}
              hint={error ?? t('tools.network_panel.nodes.url_hint')}
            >
              <Input
                value={url}
                maxLength={NETWORK_PANEL_LIMITS.maxUrl}
                onChange={(event) => { setUrl(event.target.value); setError(null) }}
                disabled={atLimit}
                invalid={Boolean(error)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
              {atLimit
                ? t('tools.network_panel.nodes.limit', { max: NETWORK_PANEL_LIMITS.maxNodes })
                : t('tools.network_panel.nodes.count', { count: nodes.length, max: NETWORK_PANEL_LIMITS.maxNodes })}
            </span>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              icon={<Plus size={13} />}
              loading={adding}
              disabled={atLimit}
            >
              {t('tools.network_panel.nodes.add')}
            </Button>
          </div>
          <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
            {t('tools.network_panel.nodes.legal')}
          </p>
        </form>
      </div>
    </Modal>
  )
}
