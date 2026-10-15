/**
 * The MCP tab: the third parties the assistant may ask to act, and which of their functions it may use.
 *
 * Every server is a card with its mode on it — off, ask each time, or run directly — because that choice is
 * the reason the page exists, and a mode hidden one press away is a permission the reader cannot see.
 *
 * Inside the card is the second, finer permission: a third party's tools are not equally trusted, and "the
 * whole server is on" was the only thing the card could say before. Each tool has its own switch, and a
 * switched-off tool is left out of the request entirely rather than refused after the model asks for it.
 *
 * A server arrives through a form rather than three boxes in a row: what it is for, which protocol it
 * speaks, how long to wait for it and the headers its endpoint wants are the questions a reader answers
 * once, and a card that keeps only a name and a URL answers none of them later. A config pasted from a
 * server's own README is the other way in, because that is what those pages publish.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, Pencil, Search, Trash2 } from 'lucide-react'
import {
  ASSISTANT_MCP_TOOL_MODES,
  ASSISTANT_MCP_TRANSPORTS,
  MAX_MCP_DESCRIPTION_CHARS,
  MAX_MCP_HEADERS,
  MAX_MCP_HEADER_VALUE_CHARS,
  MAX_MCP_LABEL_CHARS,
  MAX_MCP_SERVERS,
  MAX_MCP_TIMEOUT_SECONDS,
  MIN_MCP_TIMEOUT_SECONDS,
  parseMcpHeaderLines,
  parseMcpServerJson,
  type AssistantMcpServer,
} from '@shared/assistant'
import { cn } from '../../lib/cn'
import { matchesQuery } from '../../lib/fuzzy'
import { t } from '../../lib/i18n'
import { usePinyinVersion } from '../../lib/pinyin'
import { useUi } from '../../store/ui'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Field, Input, Select, Segmented, Switch, Textarea } from '../../components/form'
import { Menu, Modal, type MenuItem } from '../../components/overlay'
import { useAssistant } from './assistant-store'
import { Group } from './assistant-settings-shared'

const MCP_MODE_KEYS: Record<string, 'assistant.mcp.mode.off' | 'assistant.mcp.mode.ask' | 'assistant.mcp.mode.auto'> = {
  off: 'assistant.mcp.mode.off',
  ask: 'assistant.mcp.mode.ask',
  auto: 'assistant.mcp.mode.auto',
}

const TRANSPORT_KEYS: Record<string, 'assistant.mcp.type.streamable_http' | 'assistant.mcp.type.sse'> = {
  streamableHttp: 'assistant.mcp.type.streamable_http',
  sse: 'assistant.mcp.type.sse',
}

/**
 * What the chosen transport needs before it answers, said under the control that chooses it.
 *
 * The two are not interchangeable and a reader cannot tell them apart from the label alone: one is an
 * address that takes a POST, the other a connection that stays open. `stdio` is named in both because a
 * local command is the entry every client's config lists and this app serves it through one of these two.
 */
const TRANSPORT_HINTS: Record<string, 'assistant.mcp.type.hint.http' | 'assistant.mcp.type.hint.sse'> = {
  streamableHttp: 'assistant.mcp.type.hint.http',
  sse: 'assistant.mcp.type.hint.sse',
}

/** The draft the form edits, in the shape the two routes accept. */
interface ServerDraft {
  label: string
  url: string
  description: string
  transport: string
  timeoutSeconds: number
  /** The box's own text, because the form has to show what is stored without holding its values. */
  headerText: string
  clearHeaders: boolean
}

const emptyDraft = (): ServerDraft => ({
  label: '',
  url: '',
  description: '',
  transport: 'streamableHttp',
  timeoutSeconds: 30,
  headerText: '',
  clearHeaders: false,
})

export function McpTab() {
  const servers = useAssistant((state) => state.mcpServers)
  const problems = useAssistant((state) => state.mcpProblems)
  const catalog = useAssistant((state) => state.mcpCatalog)
  const loading = useAssistant((state) => state.mcpCatalogLoading)
  const loadMcp = useAssistant((state) => state.loadMcp)
  const removeMcpServer = useAssistant((state) => state.removeMcpServer)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [editing, setEditing] = useState<AssistantMcpServer | null>(null)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const addAnchor = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    void loadMcp()
  }, [loadMcp])

  const addItems: MenuItem[] = [
    { id: 'quick', label: t('assistant.mcp.add.quick'), onSelect: () => setCreating(true) },
    { id: 'json', label: t('assistant.mcp.add.json'), onSelect: () => setImporting(true) },
  ]

  return (
    <Group title={t('assistant.mcp.servers')}>
      <p className="py-2 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{t('assistant.mcp.hint')}</p>

      {servers.length === 0 && !creating && (
        <p className="py-2 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('assistant.mcp.none')}</p>
      )}

      {servers.map((server) => (
        <ServerCard
          key={server.id}
          server={server}
          tools={catalog.find((entry) => entry.serverId === server.id)?.tools ?? []}
          problem={problems.find((entry) => entry.serverId === server.id)?.error}
          loading={loading}
          expanded={Boolean(open[server.id])}
          onToggleExpanded={() => setOpen((current) => ({ ...current, [server.id]: !current[server.id] }))}
          onOpen={() => setOpen((current) => ({ ...current, [server.id]: true }))}
          onEdit={() => setEditing(server)}
          onRemove={() => void removeMcpServer(server.id)}
        />
      ))}

      <div className="flex justify-end py-2.5">
        <span ref={addAnchor} className="inline-flex">
          <Button
            size="sm"
            variant="secondary"
            disabled={servers.length >= MAX_MCP_SERVERS}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            {t('assistant.mcp.add')}
          </Button>
        </span>
      </div>
      <Menu anchor={addAnchor} open={menuOpen} onClose={() => setMenuOpen(false)} items={addItems} align="end" />

      <ServerDialog open={creating} server={null} onClose={() => setCreating(false)} />
      <ServerDialog open={Boolean(editing)} server={editing} onClose={() => setEditing(null)} />
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
    </Group>
  )
}

/**
 * The form a server is added or edited through.
 *
 * It is one dialog for both because they are the same four questions; what differs is where the answers
 * come from. The header box carries the names of what is stored rather than the values — the worker never
 * hands those back — so an untouched box means "keep them" and an emptied one means "forget them".
 */
function ServerDialog({ open, server, onClose }: {
  open: boolean
  server: AssistantMcpServer | null
  onClose: () => void
}) {
  const addMcpServer = useAssistant((state) => state.addMcpServer)
  const patchMcpServer = useAssistant((state) => state.patchMcpServer)
  const loadMcpServer = useAssistant((state) => state.loadMcpServer)
  const testMcpServer = useAssistant((state) => state.testMcpServer)
  const toast = useUi((state) => state.toast)
  const [draft, setDraft] = useState<ServerDraft>(emptyDraft)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [checked, setChecked] = useState('')
  const [storedNames, setStoredNames] = useState<string[]>([])
  const fieldId = useId()

  useEffect(() => {
    if (!open) return
    setChecked('')
    setAdvanced(false)
    setStoredNames([])
    if (!server) {
      setDraft(emptyDraft())
      return
    }
    setDraft({
      label: server.label,
      url: server.url,
      description: server.description,
      transport: server.transport,
      timeoutSeconds: server.timeoutSeconds,
      headerText: '',
      clearHeaders: false,
    })
    // The values are the worker's to keep, so what comes back is the names: the box is prefilled with them
    // and blank values, which the route reads as "leave these alone".
    void loadMcpServer(server.id).then((detail) => {
      if (!detail) return
      setStoredNames(detail.headerNames)
      setDraft((current) => ({
        ...current,
        headerText: detail.headerNames.map((name) => `${name}: `).join('\n'),
        clearHeaders: detail.headerNames.length === 0,
      }))
    })
  }, [open, server, loadMcpServer])

  const patch = (next: Partial<ServerDraft>) => setDraft((current) => ({ ...current, ...next }))
  const saved = (name: string) => toast({ title: t('assistant.mcp.saved', { name }) })

  const result = useMemo(() => parseMcpHeaderLines(draft.headerText), [draft.headerText])
  const ready = draft.label.trim().length > 0 && draft.url.trim().length > 0

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    // A name with an empty value is the placeholder the form wrote for a stored header, so it is dropped:
    // sending it back would overwrite a token with nothing.
    const headers = Object.fromEntries(
      Object.entries(result.headers).filter(([, value]) => value.trim().length > 0),
    )
    const body = {
      label: draft.label.trim(),
      url: draft.url.trim(),
      description: draft.description.trim(),
      transport: draft.transport,
      timeoutSeconds: draft.timeoutSeconds,
      ...(server
        ? (Object.keys(headers).length ? { headers } : draft.clearHeaders ? { headers: null } : {})
        : { headers }),
    }
    const ok = server
      ? await patchMcpServer(server.id, body).then(() => true).catch(() => false)
      : await addMcpServer(body)
    setBusy(false)
    if (ok) saved(draft.label.trim())
    onClose()
  }

  const runTest = async () => {
    if (!server) return
    setBusy(true)
    const headers = Object.fromEntries(Object.entries(result.headers).filter(([, value]) => value.trim().length > 0))
    const outcome = await testMcpServer(server.id, Object.keys(headers).length ? headers : undefined)
    setBusy(false)
    setChecked(outcome.ok ? t('assistant.mcp.test_ok', { count: outcome.count }) : outcome.error)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={server ? t('assistant.mcp.edit') : t('assistant.mcp.add.quick')}
      description={t('assistant.mcp.form_hint')}
      width={520}
      footer={(
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="sm" variant="primary" loading={busy} disabled={!ready} onClick={() => void submit()}>
            {server ? t('common.save') : t('assistant.mcp.add')}
          </Button>
        </div>
      )}
    >
      <div className="flex flex-col gap-3">
        <Field label={t('assistant.mcp.label')} required>
          <Input
            id={`${fieldId}-label`}
            value={draft.label}
            maxLength={MAX_MCP_LABEL_CHARS}
            placeholder={t('assistant.mcp.label_placeholder')}
            onChange={(event) => patch({ label: event.target.value })}
          />
        </Field>

        <Field label={t('assistant.mcp.type')} hint={t(TRANSPORT_HINTS[draft.transport] ?? 'assistant.mcp.type.hint.http')}>
          <Select
            aria-label={t('assistant.mcp.type')}
            value={draft.transport}
            onChange={(event) => patch({ transport: event.target.value })}
          >
            {ASSISTANT_MCP_TRANSPORTS.map((transport) => (
              <option key={transport} value={transport}>{t(TRANSPORT_KEYS[transport] ?? 'assistant.mcp.type.streamable_http')}</option>
            ))}
          </Select>
        </Field>

        <Field label={t('assistant.mcp.description')}>
          <Input
            value={draft.description}
            maxLength={MAX_MCP_DESCRIPTION_CHARS}
            placeholder={t('assistant.mcp.description_placeholder')}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </Field>

        <Field label={t('assistant.mcp.url')} required hint={t('assistant.mcp.url_hint')}>
          <Input
            value={draft.url}
            inputMode="url"
            placeholder="https://…/mcp"
            onChange={(event) => patch({ url: event.target.value })}
          />
        </Field>

        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((current) => !current)}
          className="flex items-center gap-1.5 self-start rounded-[var(--r-sm)] py-1 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] transition-colors duration-[var(--dur-fast)] hover:text-[var(--text-primary)]"
        >
          <ChevronDown size={13} className={cn('transition-transform duration-[var(--dur-fast)]', advanced && 'rotate-180')} />
          {t('assistant.mcp.advanced')}
        </button>

        {advanced && (
          <div className="flex flex-col gap-3">
            <Field
              label={t('assistant.mcp.headers')}
              hint={storedNames.length > 0 && !draft.clearHeaders
                ? t('assistant.mcp.headers_stored', { names: storedNames.join(', ') })
                : t('assistant.mcp.headers_hint')}
            >
              <Textarea
                rows={4}
                value={draft.headerText}
                placeholder={'Authorization: Bearer token\nCONTEXT7_API_KEY: ctx7sk-…'}
                onChange={(event) => patch({ headerText: event.target.value, clearHeaders: event.target.value.trim().length === 0 })}
                className="font-mono text-[length:var(--text-12)]"
              />
            </Field>
            {result.problems.length > 0 && (
              <p className="text-[length:var(--text-11-5)] text-[var(--danger)]">{t('assistant.mcp.bad_headers', { names: result.problems.join(', ') })}</p>
            )}
            <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
              {t('assistant.mcp.headers_limit', { max: MAX_MCP_HEADERS, chars: MAX_MCP_HEADER_VALUE_CHARS })}
            </p>

            <Field label={t('assistant.mcp.timeout')} hint={t('assistant.mcp.timeout_hint', { min: MIN_MCP_TIMEOUT_SECONDS, max: MAX_MCP_TIMEOUT_SECONDS })}>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={MIN_MCP_TIMEOUT_SECONDS}
                  max={MAX_MCP_TIMEOUT_SECONDS}
                  value={String(draft.timeoutSeconds)}
                  onChange={(event) => patch({ timeoutSeconds: Number(event.target.value) })}
                  className="w-28"
                />
                <span className="text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.mcp.seconds')}</span>
                {server && (
                  <Button size="sm" variant="ghost" loading={busy} onClick={() => void runTest()}>
                    {t('assistant.mcp.test')}
                  </Button>
                )}
              </div>
            </Field>
            {checked && <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{checked}</p>}
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * A config pasted from a server's own page.
 *
 * The block is the one every MCP client's README publishes, so a reader can copy it untouched. Entries
 * this app cannot run — a local command, an address that is not https — are named in the outcome rather
 * than failing the paste, because one unsupported line in a list of five must not hide the other four.
 */
function ImportDialog({ open, onClose }: { open: boolean, onClose: () => void }) {
  const addMcpServer = useAssistant((state) => state.addMcpServer)
  const toast = useUi((state) => state.toast)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  useEffect(() => {
    if (!open) return
    setText('')
    setProblem('')
  }, [open])

  const skippedLabel = (reason: string) => t(`assistant.mcp.import.reason.${reason}` as 'assistant.mcp.import.reason.command')

  const submit = async () => {
    let parsed: ReturnType<typeof parseMcpServerJson>
    try {
      parsed = parseMcpServerJson(text)
    } catch {
      setProblem(t('assistant.mcp.import.bad_json'))
      return
    }
    if (parsed.servers.length === 0) {
      setProblem(parsed.skipped.length ? t('assistant.mcp.import.all_skipped') : t('assistant.mcp.import.none'))
      return
    }
    setBusy(true)
    let added = 0
    for (const entry of parsed.servers) {
      const ok = await addMcpServer({
        label: entry.name,
        url: entry.url,
        transport: entry.transport,
        ...(entry.headers ? { headers: entry.headers } : {}),
      })
      if (ok) added += 1
    }
    setBusy(false)
    toast({
      title: t('assistant.mcp.import.done', { count: added }),
      ...(parsed.skipped.length
        ? { description: t('assistant.mcp.import.skipped', { names: parsed.skipped.map((entry) => `${entry.name} (${skippedLabel(entry.reason)})`).join(', ') }), tone: 'danger' as const }
        : {}),
    })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('assistant.mcp.add.json')}
      description={t('assistant.mcp.import.hint')}
      width={560}
      footer={(
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="sm" variant="primary" loading={busy} disabled={!text.trim()} onClick={() => void submit()}>
            {t('assistant.mcp.import.confirm')}
          </Button>
        </div>
      )}
    >
      <div className="flex flex-col gap-2">
        <Textarea
          rows={12}
          value={text}
          aria-label={t('assistant.mcp.import.hint')}
          placeholder={t('assistant.mcp.import.placeholder')}
          onChange={(event) => {
            setText(event.target.value)
            setProblem('')
          }}
          className="font-mono text-[length:var(--text-12)]"
        />
        {problem && <p className="text-[length:var(--text-11-5)] text-[var(--danger)]">{problem}</p>}
      </div>
    </Modal>
  )
}

/**
 * One server, and the switches inside it.
 *
 * The header states the three things a reader needs before trusting a third party: whether it answers, what
 * it is allowed to do, and how many of its functions are on. The tools themselves are one press away rather
 * than always drawn — a server can offer two dozen of them, and a settings page that opens as a wall of
 * switches is one nobody checks.
 */
function ServerCard({ server, tools, problem, loading, expanded, onToggleExpanded, onOpen, onEdit, onRemove }: {
  server: AssistantMcpServer
  tools: { name: string, remoteName: string, description: string, disabled: boolean }[]
  problem?: string
  loading: boolean
  expanded: boolean
  onToggleExpanded: () => void
  onOpen: () => void
  onEdit: () => void
  onRemove: () => void
}) {
  const patchMcpServer = useAssistant((state) => state.patchMcpServer)
  const setMcpToolsEnabled = useAssistant((state) => state.setMcpToolsEnabled)
  const testMcpServer = useAssistant((state) => state.testMcpServer)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState('')
  const pinyinVersion = usePinyinVersion()
  const off = useMemo(() => new Set(server.disabledTools), [server.disabledTools])
  const on = tools.filter((tool) => !off.has(tool.remoteName)).length
  const shown = useMemo(
    () => tools.filter((tool) => matchesQuery(`${tool.remoteName} ${tool.description}`, query)),
    // A Chinese name is matched through the dictionary, and a listing filtered before it lands is a
    // listing that goes on missing what the reader typed.
    [tools, query, pinyinVersion],
  )

  return (
    <div data-mcp-server={server.id} className={cn('flex flex-col gap-2 border-b border-[var(--border-subtle)] py-2.5 last:border-b-0', !server.enabled && 'opacity-70')}>
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn('size-1.5 shrink-0 rounded-full', problem ? 'bg-[var(--danger)]' : server.enabled ? 'bg-[var(--success)]' : 'bg-[var(--border-strong)]')}
        />
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{server.label}</span>
        <span className="shrink-0 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
          {t(TRANSPORT_KEYS[server.transport] ?? 'assistant.mcp.type.streamable_http')}
        </span>
        {tools.length > 0 && (
          <span className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">{on}/{tools.length}</span>
        )}
        <Switch label={t('assistant.mcp.enabled')} checked={server.enabled} onChange={(next) => void patchMcpServer(server.id, { enabled: next })} />
        <IconButton label={t('assistant.mcp.edit')} size="xs" onClick={onEdit}>
          <Pencil size={12} />
        </IconButton>
        <IconButton label={t('assistant.mcp.remove')} size="xs" onClick={onRemove}>
          <Trash2 size={12} />
        </IconButton>
      </div>

      {server.description && <p className="pl-3.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{server.description}</p>}
      <p className="truncate pl-3.5 font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)]" title={server.url}>{server.url}</p>

      <div className="flex flex-wrap items-center gap-2 pl-3.5">
        <Segmented
          size="sm"
          label={t('assistant.mcp.mode')}
          value={server.toolMode}
          options={ASSISTANT_MCP_TOOL_MODES.map((mode) => ({ value: mode, label: t(MCP_MODE_KEYS[mode]) }))}
          onChange={(mode) => void patchMcpServer(server.id, { toolMode: mode })}
        />
        {/* Listing is also what fills the switches below, so the press that checks a server is the press
            that shows what it offers. */}
        <Button
          size="sm"
          variant="ghost"
          loading={busy}
          onClick={() => {
            setBusy(true)
            void testMcpServer(server.id).then((result) => {
              setBusy(false)
              onOpen()
              setOutcome(result.ok ? '' : result.error)
            })
          }}
        >
          {t('assistant.mcp.test')}
        </Button>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggleExpanded}
          className="inline-flex items-center gap-1 rounded-[var(--r-sm)] px-1.5 py-0.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <ChevronDown size={12} className={cn('transition-transform duration-[var(--dur-fast)]', expanded && 'rotate-180')} />
          {t('assistant.mcp.tools')}
          {tools.length > 0 && <span className="tabular-nums text-[var(--text-quaternary)]">{tools.length}</span>}
        </button>
      </div>

      {(problem ?? outcome) && <p className="pl-3.5 text-[length:var(--text-11-5)] text-[var(--warning)]">{problem ?? outcome}</p>}

      {expanded && (
        <div className="ml-3.5 flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2">
          {loading && tools.length === 0 ? (
            <span className="flex justify-center py-2"><Spinner /></span>
          ) : tools.length === 0 ? (
            <p className="py-1 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('assistant.mcp.no_tools')}</p>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <Input
                  className="h-7"
                  aria-label={t('assistant.mcp.search_tools')}
                  placeholder={t('assistant.mcp.search_tools')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <span className="shrink-0 text-[var(--text-quaternary)]" aria-hidden>
                  <Search size={12} />
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={on === tools.length}
                  onClick={() => void setMcpToolsEnabled(server, tools.map((tool) => tool.remoteName), true)}
                >
                  {t('assistant.mcp.enable_all')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={on === 0}
                  onClick={() => void setMcpToolsEnabled(server, tools.map((tool) => tool.remoteName), false)}
                >
                  {t('assistant.mcp.disable_all')}
                </Button>
              </div>
              <ul className="flex flex-col divide-y divide-[var(--border-subtle)]">
                {shown.map((tool) => (
                  <li key={tool.remoteName} className="flex items-start gap-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{tool.remoteName}</p>
                      {tool.description && (
                        <p className="line-clamp-2 text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-quaternary)]">{tool.description}</p>
                      )}
                    </div>
                    <Switch
                      label={tool.remoteName}
                      checked={!off.has(tool.remoteName)}
                      onChange={(next) => void setMcpToolsEnabled(server, [tool.remoteName], next)}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
