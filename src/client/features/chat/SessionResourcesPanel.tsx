/**
 * The conversation's resources, in one panel.
 *
 * A thread accumulates more than its words: files the reader attached, links it mentioned, notes the
 * tools opened, the tools and MCP servers that answered, the drafts it produced, and the pages a search
 * cited. The transcript shows each beside the turn it belongs to; this panel answers the other question —
 * "what is in this conversation?" — without scrolling.
 *
 * The whole thread is read when the panel opens, not only the page on screen, because a monitor that
 * quietly omitted older turns would be trusted and wrong. The live turn is merged from the store until
 * its row lands, with tool ids deduplicating the two views.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ExternalLink, FileText, Globe, Image as ImageIcon, Library, Link2, ListTree, Loader2, NotebookPen,
  Package, RefreshCw, Server, Share2, Wrench, X,
} from 'lucide-react'
import type { AssistantMcpServer, ChatAttachment } from '@shared/assistant'
import { ASSISTANT_TOOL_BY_NAME, formatTokenStep, mcpToolOrigin } from '@shared/assistant'
import { api } from '../../lib/api'
import { useMediaQuery } from '../../lib/hooks'
import { t } from '../../lib/i18n'
import { formatBytes, relativeTime } from '../../lib/time'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Drawer } from '../../components/overlay'
import { DEFAULT_LAYOUT, PANEL_WIDTHS, useUi } from '../../store/ui'
import { Resizer } from '../shell/Resizer'
import { useNotes } from '../../store/notes'
import { ConversationSharePanel } from '../share/ConversationSharePanel'
import { useAssistant } from './assistant-store'
import { conversationResources } from './conversation-resources'
import { openNote } from './note-links'
import { fetchWholeConversation, type WholeConversation } from './thread-fetch'

const DOCK_QUERY = '(min-width: 768px)'
const DRAWER_WIDTH = 380
const LIST_CAP = 10

export function SessionResourcesPanel({
  conversationId,
  title,
  ephemeral,
  onClose,
  onOpenArtifact,
}: {
  conversationId: string
  title: string
  ephemeral: boolean
  onClose: () => void
  onOpenArtifact: (id: string) => void
}) {
  const docked = useMediaQuery(DOCK_QUERY)
  const resourcesWidth = useUi((state) => state.chatResourcesWidth)
  const setLayout = useUi((state) => state.setLayout)
  const [data, setData] = useState<WholeConversation | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [sharing, setSharing] = useState(false)
  const storeMessages = useAssistant((state) => state.messages)
  const liveTurn = useAssistant((state) => state.turn)
  const fileIndex = useAssistant((state) => state.fileIndex)
  const artifacts = useAssistant((state) => state.artifacts)
  const skills = useAssistant((state) => state.skills)
  const loadSkills = useAssistant((state) => state.loadSkills)
  const loadArtifacts = useAssistant((state) => state.loadArtifacts)
  const mcpServers = useAssistant((state) => state.mcpServers)
  const notes = useNotes((state) => state.notes)
  const label = t('assistant.resources.title')

  useEffect(() => {
    let cancelled = false
    // A refresh of the same thread keeps the old list on screen; a different thread must not, or the
    // monitor would name the previous conversation's files for as long as the read takes.
    setData((current) => current?.conversation.id === conversationId ? current : null)
    setLoading(true)
    setFailed(false)
    void fetchWholeConversation(conversationId)
      .then((result) => {
        if (cancelled) return
        setData(result)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setFailed(true)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [conversationId, reload])

  useEffect(() => {
    void loadSkills()
    void loadArtifacts()
  }, [loadSkills, loadArtifacts])

  const messages = useMemo(() => {
    const byId = new Map((data?.messages ?? []).map((message) => [message.id, message]))
    // The store follows the active thread, and a switch can land here a beat before its own load clears
    // the rows: only this conversation's messages may join the fetched thread.
    for (const message of storeMessages) {
      if (message.conversationId === conversationId) byId.set(message.id, message)
    }
    return [...byId.values()].sort((left, right) => left.createdAt - right.createdAt)
  }, [data, storeMessages, conversationId])
  const conversationArtifacts = useMemo(
    () => artifacts.filter((artifact) => artifact.conversationId === conversationId),
    [artifacts, conversationId],
  )
  const live = liveTurn?.conversationId === conversationId ? liveTurn : null
  const attachments = useMemo(() => {
    const byId = new Map((data?.attachments ?? []).map((attachment) => [attachment.id, attachment]))
    for (const message of messages) {
      for (const id of message.attachments ?? []) {
        const attachment = fileIndex[id]
        if (attachment) byId.set(id, attachment)
      }
    }
    for (const id of live?.attachments ?? []) {
      const attachment = fileIndex[id]
      if (attachment) byId.set(id, attachment)
    }
    return [...byId.values()]
  }, [data, messages, fileIndex, live?.attachments])
  const index = useMemo(
    () => conversationResources(messages, attachments, live?.tools ?? [], live?.attachments ?? []),
    [messages, attachments, live?.tools, live?.attachments],
  )
  const liveNoteIds = useMemo(() => {
    const ids: string[] = []
    if (data?.conversation.noteId) ids.push(data.conversation.noteId)
    for (const artifact of conversationArtifacts) if (artifact.noteId) ids.push(artifact.noteId)
    for (const note of index.notes) ids.push(note.id)
    return [...new Set(ids)]
  }, [data?.conversation.noteId, conversationArtifacts, index.notes])
  const noteRows = liveNoteIds.map((id) => ({
    id,
    title: notes[id]?.title
      ?? index.notes.find((note) => note.id === id)?.title
      ?? conversationArtifacts.find((artifact) => artifact.noteId === id)?.title
      ?? t('assistant.resources.untitled_note'),
  }))
  const mcpRows = useMemo(() => {
    const used = new Map<string, number>()
    for (const tool of index.tools) {
      if (!tool.name.startsWith('mcp_')) continue
      const origin = mcpToolOrigin(tool.name, mcpServers)
      if (origin) used.set(origin.serverId, (used.get(origin.serverId) ?? 0) + tool.count)
    }
    return mcpServers.map((server) => ({ server, calls: used.get(server.id) ?? 0 }))
  }, [index.tools, mcpServers])
  const turnCount = messages.filter((message) => message.role === 'user').length
  const tokenTotal = index.tokens.input + index.tokens.output
  const activeModel = useAssistant((state) => state.models.find((model) => model.id === state.settings?.activeModelId)?.label ?? '')
  const models = index.models.length ? index.models : activeModel ? [activeModel] : []

  const body = (
    <>
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[length:var(--text-10-5)] font-medium uppercase tracking-wide text-[var(--text-quaternary)]">
            <ListTree size={12} />
            {label}
          </div>
          <p className="mt-0.5 truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]" title={title}>
            {title || t('assistant.chat.untitled')}
            {ephemeral && (
              <span className="ml-1.5 rounded-full border border-[var(--border-subtle)] px-1.5 py-px text-[length:var(--text-10)] font-normal text-[var(--text-quaternary)]">
                {t('assistant.resources.ephemeral')}
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-quaternary)]">
            {t('assistant.resources.hint')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label={t('assistant.resources.refresh')} size="sm" onClick={() => setReload((value) => value + 1)} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
          </IconButton>
          <IconButton label={t('common.close')} size="sm" onClick={onClose}>
            <X size={13} />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {loading && !data ? (
          <div role="status" className="flex justify-center py-14">
            <Spinner />
            <span className="sr-only">{t('assistant.resources.loading')}</span>
          </div>
        ) : failed && !data ? (
          <div className="flex flex-col items-center gap-2 py-14 text-center">
            <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('assistant.resources.failed')}</p>
            <Button size="sm" variant="secondary" onClick={() => setReload((value) => value + 1)}>{t('assistant.resources.retry')}</Button>
          </div>
        ) : (
          <>
            <section className="flex flex-col gap-1 py-3">
              <div className="flex flex-wrap items-center gap-1.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                <span>{t('assistant.resources.turns', { count: turnCount })}</span>
                {tokenTotal > 0 && <span>· {t('assistant.resources.tokens', { count: formatTokenStep(tokenTotal) })}</span>}
                {live && !live.done && (
                  <span className="flex items-center gap-1 text-[var(--accent)]">
                    <Loader2 size={10} className="animate-spin" />
                    {t('assistant.resources.live')}
                  </span>
                )}
              </div>
              {models.length > 0 && (
                <p className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]" title={models.join(' · ')}>
                  {models.join(' · ')}
                </p>
              )}
              <div className="mt-1 flex flex-wrap gap-1.5">
                {!ephemeral && (
                  <Button size="sm" variant="secondary" icon={<Share2 size={12} />} onClick={() => setSharing(true)}>
                    {t('assistant.resources.share')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => { onClose(); useAssistant.getState().setView('settings') }}>
                  {t('assistant.resources.manage_models')}
                </Button>
              </div>
            </section>

            {index.images.length > 0 && (
              <ResourceSection title={t('assistant.resources.images')} count={index.images.length} icon={<ImageIcon size={12} />}>
                <div className="grid grid-cols-4 gap-1.5">
                  {index.images.slice(0, 12).map((image) => (
                    <button
                      key={image.id}
                      type="button"
                      title={image.filename}
                      aria-label={image.filename}
                      onClick={() => useUi.getState().setLightbox({ src: api.assistant.chatFileUrl(image.id), alt: image.filename })}
                      className="aspect-square overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] transition-colors duration-[var(--dur-fast)] hover:border-[var(--border-strong)]"
                    >
                      <img src={api.assistant.chatFileUrl(image.id)} alt="" loading="lazy" className="size-full object-cover" />
                    </button>
                  ))}
                </div>
                <More count={index.images.length - 12} />
              </ResourceSection>
            )}

            {index.documents.length > 0 && (
              <ResourceSection title={t('assistant.resources.documents')} count={index.documents.length} icon={<FileText size={12} />}>
                <Rows items={index.documents} render={(document) => <FileRow key={document.id} attachment={document} />} />
              </ResourceSection>
            )}

            {index.links.length > 0 && (
              <ResourceSection title={t('assistant.resources.links')} count={index.links.length} icon={<Link2 size={12} />}>
                <Rows
                  items={index.links}
                  render={(link) => (
                    <li key={link.url}>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={link.url}
                        className="flex min-w-0 items-center gap-1.5 rounded-[var(--r-sm)] px-1 py-1 text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      >
                        <Link2 size={11} className="shrink-0 text-[var(--text-quaternary)]" />
                        <span className="min-w-0 flex-1 truncate">{link.url.replace(/^https?:\/\//i, '')}</span>
                        <ExternalLink size={10} className="shrink-0 text-[var(--text-quaternary)]" />
                      </a>
                    </li>
                  )}
                />
              </ResourceSection>
            )}

            {noteRows.length > 0 && (
              <ResourceSection title={t('assistant.resources.notes')} count={noteRows.length} icon={<NotebookPen size={12} />}>
                <Rows
                  items={noteRows}
                  render={(note) => (
                    <li key={note.id}>
                      <button
                        type="button"
                        onClick={() => { onClose(); openNote(note.id) }}
                        className="flex w-full min-w-0 items-center gap-1.5 rounded-[var(--r-sm)] px-1 py-1 text-left text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      >
                        <NotebookPen size={11} className="shrink-0 text-[var(--text-quaternary)]" />
                        <span className="min-w-0 flex-1 truncate">{note.title}</span>
                      </button>
                    </li>
                  )}
                />
              </ResourceSection>
            )}

            {skills.length > 0 && (
              <ResourceSection
                title={t('assistant.resources.skills')}
                count={skills.length}
                icon={<Library size={12} />}
                action={<SectionLink onClick={() => { onClose(); useAssistant.getState().setView('skills') }}>{t('assistant.resources.manage_skills')}</SectionLink>}
              >
                <Rows
                  items={skills}
                  render={(skill) => (
                    <li key={skill.id}>
                      <button
                        type="button"
                        onClick={() => { onClose(); useAssistant.getState().setView('skills') }}
                        className="flex w-full min-w-0 items-center gap-1.5 rounded-[var(--r-sm)] px-1 py-1 text-left text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      >
                        <span aria-hidden className="w-3.5 shrink-0 text-center">{skill.icon || '✦'}</span>
                        <span className="min-w-0 flex-1 truncate">{skill.title}</span>
                      </button>
                    </li>
                  )}
                />
              </ResourceSection>
            )}

            {mcpRows.length > 0 && (
              <ResourceSection
                title={t('assistant.resources.mcp')}
                count={mcpRows.length}
                icon={<Server size={12} />}
                action={<SectionLink onClick={() => { onClose(); useAssistant.getState().setView('settings') }}>{t('assistant.resources.manage_mcp')}</SectionLink>}
              >
                <Rows
                  items={mcpRows}
                  render={({ server, calls }) => (
                    <li key={server.id} className="flex min-w-0 items-center gap-1.5 px-1 py-1 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                      <Server size={11} className="shrink-0 text-[var(--text-quaternary)]" />
                      <span className="min-w-0 flex-1 truncate">{server.label}</span>
                      <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
                        {calls > 0 ? t('assistant.resources.calls', { count: calls }) : t('assistant.resources.unused')}
                      </span>
                    </li>
                  )}
                />
              </ResourceSection>
            )}

            {index.tools.length > 0 && (
              <ResourceSection title={t('assistant.resources.tools')} count={index.tools.reduce((sum, tool) => sum + tool.count, 0)} icon={<Wrench size={12} />}>
                <Rows
                  items={index.tools}
                  render={(tool) => (
                    <li key={tool.name} className="flex min-w-0 items-center gap-1.5 px-1 py-1 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                      <Wrench size={11} className="shrink-0 text-[var(--text-quaternary)]" />
                      <span className="min-w-0 flex-1 truncate">{toolLabel(tool.name, mcpServers)}</span>
                      {tool.errors > 0 && <span className="shrink-0 text-[length:var(--text-10)] text-[var(--danger)]">×{tool.errors}</span>}
                      {tool.running > 0 && <Loader2 size={10} className="shrink-0 animate-spin text-[var(--accent)]" />}
                      <span className="shrink-0 tabular-nums text-[length:var(--text-10)] text-[var(--text-quaternary)]">{tool.count}</span>
                    </li>
                  )}
                />
              </ResourceSection>
            )}

            {conversationArtifacts.length > 0 && (
              <ResourceSection title={t('assistant.resources.outputs')} count={conversationArtifacts.length} icon={<Package size={12} />}>
                <Rows
                  items={conversationArtifacts}
                  render={(artifact) => (
                    <li key={artifact.id}>
                      <button
                        type="button"
                        onClick={() => onOpenArtifact(artifact.id)}
                        className="flex w-full min-w-0 items-center gap-1.5 rounded-[var(--r-sm)] px-1 py-1 text-left text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      >
                        <Package size={11} className="shrink-0 text-[var(--text-quaternary)]" />
                        <span className="min-w-0 flex-1 truncate">{artifact.title || t('assistant.canvas.untitled')}</span>
                        <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t('assistant.resources.version', { version: artifact.version })} · {relativeTime(artifact.updatedAt)}</span>
                      </button>
                    </li>
                  )}
                />
              </ResourceSection>
            )}

            {index.sources.length > 0 && (
              <ResourceSection title={t('assistant.resources.sources')} count={index.sources.length} icon={<Globe size={12} />}>
                <Rows
                  items={index.sources}
                  render={(source) => (
                    <li key={source.url}>
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={source.url}
                        className="flex min-w-0 flex-col gap-0.5 rounded-[var(--r-sm)] px-1 py-1 hover:bg-[var(--bg-hover)]"
                      >
                        <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                          <Globe size={11} className="shrink-0 text-[var(--text-quaternary)]" />
                          <span className="min-w-0 flex-1 truncate">{source.title || source.url}</span>
                        </span>
                        {source.cited && <span className="line-clamp-2 pl-[17px] text-[length:var(--text-10)] leading-snug text-[var(--text-quaternary)]">{source.cited}</span>}
                      </a>
                    </li>
                  )}
                />
              </ResourceSection>
            )}

            {index.links.length === 0 && index.images.length === 0 && index.documents.length === 0
              && noteRows.length === 0 && skills.length === 0 && mcpRows.length === 0
              && index.tools.length === 0 && conversationArtifacts.length === 0 && index.sources.length === 0 && (
              <p className="py-10 text-center text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
                {t('assistant.resources.empty')}
              </p>
            )}
          </>
        )}
      </div>
      {sharing && (
        <ConversationSharePanel conversationId={conversationId} title={title} onClose={() => setSharing(false)} />
      )}
    </>
  )

  if (!docked) {
    return (
      <Drawer open onClose={onClose} side="right" width={DRAWER_WIDTH} ariaLabel={label}>
        <div className="flex h-full min-h-0 flex-1 flex-col">{body}</div>
      </Drawer>
    )
  }
  return (
    <>
      <Resizer
        label={t('assistant.resources.resize')}
        value={resourcesWidth}
        min={PANEL_WIDTHS.chatResources.min}
        max={PANEL_WIDTHS.chatResources.max}
        invert
        onChange={(chatResourcesWidth) => setLayout({ chatResourcesWidth })}
        onReset={() => setLayout({ chatResourcesWidth: DEFAULT_LAYOUT.chatResourcesWidth })}
      />
      <aside
        aria-label={label}
        data-resources-dock="1"
        style={{ width: resourcesWidth }}
        className="flex h-full shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
      >
        {body}
      </aside>
    </>
  )
}

function ResourceSection({ title, count, icon, action, children }: {
  title: string
  count: number
  icon: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="border-t border-[var(--border-subtle)] py-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
        <span aria-hidden className="text-[var(--text-quaternary)]">{icon}</span>
        <h3 className="min-w-0 flex-1 truncate">{title}</h3>
        <span className="shrink-0 tabular-nums text-[length:var(--text-10)] font-normal text-[var(--text-quaternary)]">{count}</span>
        {action}
      </div>
      {children}
    </section>
  )
}

function Rows<T>({ items, render }: { items: readonly T[], render: (item: T) => ReactNode }) {
  return (
    <>
      <ul className="flex flex-col">{items.slice(0, LIST_CAP).map(render)}</ul>
      <More count={items.length - LIST_CAP} />
    </>
  )
}

function FileRow({ attachment }: { attachment: ChatAttachment }) {
  return (
    <li>
      <a
        href={api.assistant.chatFileUrl(attachment.id)}
        target="_blank"
        rel="noreferrer noopener"
        title={attachment.filename}
        className="flex min-w-0 items-center gap-1.5 rounded-[var(--r-sm)] px-1 py-1 text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      >
        <FileText size={11} className="shrink-0 text-[var(--text-quaternary)]" />
        <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
        <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{formatBytes(attachment.size)}</span>
      </a>
    </li>
  )
}

function More({ count }: { count: number }) {
  if (count <= 0) return null
  return <p className="px-1 pt-1 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t('assistant.resources.more', { count })}</p>
}

function SectionLink({ onClick, children }: { onClick: () => void, children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 text-[length:var(--text-10)] font-normal text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]">
      {children}
    </button>
  )
}

function toolLabel(name: string, servers: readonly AssistantMcpServer[]): string {
  if (name.startsWith('mcp_')) {
    const origin = mcpToolOrigin(name, servers)
    return origin ? `${origin.serverLabel} · ${origin.remoteName}` : name
  }
  const spec = ASSISTANT_TOOL_BY_NAME.get(name)
  return spec ? t(spec.labelKey) : name
}
