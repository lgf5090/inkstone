/**
 * The MCP tab: the third parties the assistant may ask to act.
 *
 * Every server is a row with its mode on it — off, ask each time, or run directly — because that choice
 * is the reason the tab exists, and a mode hidden one press away is a permission the reader cannot see.
 */
import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Input, Segmented, Switch } from '../../components/form'
import { useAssistant } from './assistant-store'
import { Group } from './assistant-settings-shared'

const MCP_MODES = ['off', 'ask', 'auto'] as const

const MCP_MODE_KEYS: Record<string, 'assistant.mcp.mode.off' | 'assistant.mcp.mode.ask' | 'assistant.mcp.mode.auto'> = {
  off: 'assistant.mcp.mode.off',
  ask: 'assistant.mcp.mode.ask',
  auto: 'assistant.mcp.mode.auto',
}

/**
 * The reader's own MCP servers.
 *
 * Each row is a third party that can be asked to act, so the mode is stated on the row rather than hidden
 * in a menu: "ask each time" puts an Approve card in the thread for every call, "run directly" lets the
 * model use it without one, and "off" keeps its tools away from the request entirely.
 */
export function McpTab() {
  const servers = useAssistant((state) => state.mcpServers)
  const problems = useAssistant((state) => state.mcpProblems)
  const tools = useAssistant((state) => state.mcpTools)
  const loadMcp = useAssistant((state) => state.loadMcp)
  const addMcpServer = useAssistant((state) => state.addMcpServer)
  const patchMcpServer = useAssistant((state) => state.patchMcpServer)
  const removeMcpServer = useAssistant((state) => state.removeMcpServer)
  const testMcpServer = useAssistant((state) => state.testMcpServer)
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [testing, setTesting] = useState<Record<string, string>>({})

  useEffect(() => {
    void loadMcp()
  }, [loadMcp])

  const add = async () => {
    if (!label.trim() || !url.trim()) return
    setBusy('add')
    const created = await addMcpServer({ label: label.trim(), url: url.trim(), token: token.trim() || undefined })
    setBusy(null)
    if (created) {
      setLabel('')
      setUrl('')
      setToken('')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Group title={t('assistant.settings.tab.mcp')}>
        <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{t('assistant.mcp.hint')}</p>
        <div className="flex flex-col gap-2">
          <Input aria-label={t('assistant.mcp.label')} value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t('assistant.mcp.label_placeholder')} />
          <Input aria-label={t('assistant.mcp.url')} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…/mcp" inputMode="url" />
          <Input aria-label={t('assistant.mcp.token')} value={token} onChange={(event) => setToken(event.target.value)} placeholder={t('assistant.mcp.token_placeholder')} type="password" autoComplete="off" />
          <Button size="sm" variant="primary" loading={busy === 'add'} disabled={!label.trim() || !url.trim()} onClick={() => void add()} className="self-start">
            {t('assistant.mcp.add')}
          </Button>
        </div>
      </Group>

      {servers.length === 0 ? (
        <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('assistant.mcp.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {servers.map((server) => (
            <li key={server.id} className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{server.label}</span>
                <Switch
                  label={t('assistant.mcp.enabled')}
                  checked={server.enabled}
                  onChange={(next) => void patchMcpServer(server.id, { enabled: next })}
                />
                <IconButton label={t('assistant.mcp.remove')} size="xs" onClick={() => void removeMcpServer(server.id)}>
                  <Trash2 size={12} />
                </IconButton>
              </div>
              <p className="truncate font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)]" title={server.url}>{server.url}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  size="sm"
                  label={t('assistant.mcp.mode')}
                  value={server.toolMode}
                  options={MCP_MODES.map((mode) => ({ value: mode, label: t(MCP_MODE_KEYS[mode]) }))}
                  onChange={(mode) => void patchMcpServer(server.id, { toolMode: mode })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === server.id}
                  onClick={() => {
                    setBusy(server.id)
                    void testMcpServer(server.id).then((result) => {
                      setBusy(null)
                      setTesting((current) => ({ ...current, [server.id]: result.ok ? t('assistant.mcp.tools_count', { count: result.count }) : result.error }))
                    })
                  }}
                >
                  {t('assistant.mcp.test')}
                </Button>
              </div>
              {testing[server.id] && (
                <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                  {testing[server.id]}
                </p>
              )}
              {problems.find((entry) => entry.serverId === server.id) && (
                <p className="text-[length:var(--text-11-5)] text-[var(--warning)]">{problems.find((entry) => entry.serverId === server.id)?.error}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {tools.length > 0 && (
        <Group title={t('assistant.mcp.offered')}>
          <ul className="flex flex-col gap-1">
            {tools.map((tool) => (
              <li key={tool.name} className="flex min-w-0 items-baseline gap-2 text-[length:var(--text-11-5)]">
                <span className="shrink-0 font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{tool.name}</span>
                <span className="min-w-0 flex-1 truncate text-[var(--text-tertiary)]">{tool.description}</span>
              </li>
            ))}
          </ul>
        </Group>
      )}
    </div>
  )
}
