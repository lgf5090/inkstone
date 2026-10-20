/**
 * The multi-model workspace: the reader's thread in the first pane, one forked model thread in each of
 * the others, all under one composer.
 *
 * The panes are deliberately not a second transcript: they never carry edit/retry/selection menus, because
 * those actions belong to the reader's own conversation. A side pane offers the two things a comparison
 * needs — read it, or take the pane away — and the shared composer is what asks every model the same
 * question at once.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ChevronDown, Columns2, Columns3, Copy, Grid2x2, Grid3x3, LayoutGrid, Maximize2, Minimize2,
  Square, X,
} from 'lucide-react'
import type { AssistantMessage, AssistantModel, AssistantProvider, ChatAttachment, ToolActivity, AssistantSource } from '@shared/assistant'
import { iconForModel } from '@shared/assistant-icons'
import { AssistantIcon } from './AssistantIcon'
import { AssistantBubble } from './MessageParts'
import { ControlChip } from './ComposerControls'
import { IconButton } from '../../components/primitives'
import { Menu, type MenuItem } from '../../components/overlay'
import { copyText } from '../../lib/clipboard'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { useUi } from '../../store/ui'
import { useAssistant, chatModels, modelLabelOf } from './assistant-store'
import { useMultiModel, type MultiModelLayout } from './multi-model-store'

const LAYOUT_ICONS: Record<MultiModelLayout, ReactNode> = {
  0: <Square size={13} />,
  2: <Columns2 size={13} />,
  3: <Columns3 size={13} />,
  4: <Grid2x2 size={13} />,
  6: <Grid3x3 size={13} />,
}

export function MultiModelMenu({ layout, disabled, hint }: {
  layout: MultiModelLayout
  disabled: boolean
  hint: string
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const setLayout = useMultiModel((state) => state.setLayout)
  const items: MenuItem[] = ([0, 2, 3, 4, 6] as const).map((count) => ({
    id: `layout-${count}`,
    label: count === 0 ? t('assistant.panes.off') : t('assistant.panes.columns', { count }),
    icon: LAYOUT_ICONS[count],
    checked: layout === count,
    onSelect: () => {
      setOpen(false)
      void setLayout(count)
    },
  }))
  return (
    <>
      <ControlChip
        refObject={anchor}
        label={t('assistant.panes.toggle')}
        value={layout > 1 ? t('assistant.panes.columns', { count: layout }) : t('assistant.panes.off')}
        icon={<LayoutGrid size={12} />}
        active={layout > 1}
        pressed={layout > 1}
        disabled={disabled}
        hint={hint}
        onClick={() => setOpen((current) => !current)}
      />
      <Menu
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        width={200}
        align="end"
        label={t('assistant.panes.toggle')}
      />
    </>
  )
}

function PaneModelMenu({ models, providers, value, disabled, onChange }: {
  models: AssistantModel[]
  providers: AssistantProvider[]
  value: string | null
  disabled?: boolean
  onChange: (id: string) => void
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const current = models.find((model) => model.id === value) ?? null
  const providerOf = (model: AssistantModel) => providers.find((provider) => provider.id === model.providerId) ?? null
  const items: MenuItem[] = models.map((model, index) => {
    const provider = providerOf(model)
    const previous = index > 0 ? providerOf(models[index - 1]!) : null
    return {
      id: model.id,
      label: modelLabelOf(model),
      icon: <AssistantIcon value={iconForModel(model, provider)} size={16} />,
      checked: model.id === value,
      separatorBefore: index > 0 && provider?.id !== previous?.id,
      onSelect: () => {
        setOpen(false)
        onChange(model.id)
      },
    }
  })
  return (
    <>
      <button
        ref={anchor}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'flex min-w-0 items-center gap-1.5 rounded-[var(--r-sm)] px-1 py-0.5 text-left text-[length:var(--text-12)] font-medium text-[var(--text-primary)]',
          'transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <AssistantIcon value={current ? iconForModel(current, providerOf(current)) : ''} size={16} />
        <span className="min-w-0 truncate">{current ? modelLabelOf(current) : t('assistant.panes.choose_model')}</span>
        <ChevronDown size={11} className="shrink-0 text-[var(--text-quaternary)]" />
      </button>
      <Menu
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        width={260}
        align="start"
        label={t('assistant.panes.choose_model')}
      />
    </>
  )
}

function UserLine({ text, attachments, files }: {
  text: string
  attachments: string[]
  files: Record<string, ChatAttachment>
}) {
  return (
    <div className="ml-auto max-w-[88%] rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-1.5 text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">
      <p className="whitespace-pre-wrap break-words">{text}</p>
      {attachments.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {attachments.map((id) => (
            <span key={id} className="max-w-full truncate rounded-[var(--r-xs)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
              {files[id]?.filename ?? t('assistant.panes.attachment')}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function AnswerLine({ text, reasoning, tools, sources, error, streaming, usage, modelLabel }: {
  text: string
  reasoning: string
  tools: ToolActivity[]
  sources: AssistantSource[]
  error: string | null
  streaming: boolean
  usage?: { inputTokens: number, outputTokens: number } | null
  modelLabel?: string
}) {
  return (
    <AssistantBubble
      text={text}
      reasoning={reasoning}
      tools={tools}
      error={error}
      streaming={streaming}
      stage={streaming ? 'generating' : undefined}
      sources={sources}
      usage={usage}
      modelLabel={modelLabel}
    />
  )
}

interface DisplayTurn {
  userText: string
  attachments: string[]
  text: string
  reasoning: string
  tools: ToolActivity[]
  sources: AssistantSource[]
  error: string | null
  done: boolean
  usage?: { inputTokens: number, outputTokens: number } | null
  modelLabel?: string
}

function PaneBody({ messages, live, files, loading, error, empty }: {
  messages: AssistantMessage[]
  live: DisplayTurn | null
  files: Record<string, ChatAttachment>
  loading: boolean
  error: string | null
  empty: string
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const lastText = live?.text ?? messages.at(-1)?.content ?? ''
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, lastText, live?.done])
  if (loading && !messages.length) {
    return <div className="flex flex-1 items-center justify-center text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.panes.loading')}</div>
  }
  if (error) {
    return <p className="px-2 py-5 text-[length:var(--text-11)] leading-relaxed text-[var(--danger)]">{error}</p>
  }
  if (!messages.length && !live) {
    return <p className="px-2 py-5 text-center text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">{empty}</p>
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2.5 py-3">
      {messages.map((message) => message.role === 'user' ? (
        <UserLine key={message.id} text={message.content} attachments={message.attachments ?? []} files={files} />
      ) : (
        <AnswerLine
          key={message.id}
          text={message.content}
          reasoning={message.reasoning ?? ''}
          tools={message.tools}
          sources={message.sources ?? []}
          error={message.error}
          streaming={false}
          usage={message.usage}
          modelLabel={message.modelLabel}
        />
      ))}
      {live && (
        <>
          <UserLine text={live.userText} attachments={live.attachments} files={files} />
          <AnswerLine
            text={live.text}
            reasoning={live.reasoning}
            tools={live.tools}
            sources={live.sources}
            error={live.error}
            streaming={!live.done}
            usage={live.usage}
            modelLabel={live.modelLabel}
          />
        </>
      )}
      <div ref={endRef} />
    </div>
  )
}

function PaneFrame({ paneId, children, header, expanded, onExpand, onCopy, onClose, onStop, streaming }: {
  paneId: string
  children: ReactNode
  header: ReactNode
  expanded: boolean
  onExpand: () => void
  onCopy: () => void
  onClose?: () => void
  onStop?: () => void
  streaming: boolean
}) {
  return (
    <section data-multi-pane={paneId} className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-1.5">
        {header}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {streaming && onStop && (
            <IconButton label={t('assistant.panes.stop')} size="xs" onClick={onStop}>
              <Square size={11} className="fill-current" />
            </IconButton>
          )}
          <IconButton label={expanded ? t('assistant.panes.collapse') : t('assistant.panes.expand')} size="xs" onClick={onExpand}>
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </IconButton>
          <IconButton label={t('assistant.panes.copy')} size="xs" onClick={onCopy}>
            <Copy size={12} />
          </IconButton>
          {onClose && (
            <IconButton label={t('assistant.panes.close')} size="xs" onClick={onClose}>
              <X size={12} />
            </IconButton>
          )}
        </div>
      </div>
      {children}
    </section>
  )
}

export function MultiModelView({ messages, live, fileIndex }: {
  messages: AssistantMessage[]
  live: DisplayTurn | null
  fileIndex: Record<string, ChatAttachment>
}) {
  const layout = useMultiModel((state) => state.layout)
  const panes = useMultiModel((state) => state.panes)
  const expanded = useMultiModel((state) => state.expanded)
  const turns = useMultiModel((state) => state.turns)
  const setExpanded = useMultiModel((state) => state.setExpanded)
  const setPaneModel = useMultiModel((state) => state.setPaneModel)
  const closePane = useMultiModel((state) => state.closePane)
  const stopPane = useMultiModel((state) => state.stopPane)
  const toast = useUi((state) => state.toast)
  const models = useAssistant((state) => state.models)
  const providers = useAssistant((state) => state.providers)
  const activeModelId = useAssistant((state) => state.settings?.activeModelId ?? null)
  const activateModel = useAssistant((state) => state.activateModel)
  const available = chatModels(models)
  const visible = panes.slice(0, Math.max(0, layout - 1))
  const sideStreaming = visible.some((pane) => {
    const current = turns[pane.id]
    return current && !current.done
  })
  const labelOf = (id: string | null | undefined) => modelLabelOf(available.find((model) => model.id === id))
  const mainLive = live ? { ...live, modelLabel: labelOf(activeModelId) } : null
  const copy = (text: string) => {
    void copyText(text).then((ok) => {
      toast({ title: ok ? t('assistant.panes.copied') : t('assistant.panes.copy_failed'), tone: ok ? 'default' : 'danger' })
    })
  }
  const mainCopyText = mainLive?.text || [...messages].reverse().find((message) => message.role === 'assistant')?.content || ''
  const gridClass = layout === 4
    ? 'md:grid-cols-2 md:grid-rows-2'
    : layout === 6
      ? 'md:grid-cols-3 md:grid-rows-2'
      : layout === 3
        ? 'md:grid-cols-3 md:grid-rows-1'
        : 'md:grid-cols-2 md:grid-rows-1'
  const allPanes = [
    <PaneFrame
      key="main"
      paneId="main"
      expanded={expanded === 'main'}
      onExpand={() => setExpanded(expanded === 'main' ? null : 'main')}
      onCopy={() => copy(mainCopyText)}
      onStop={() => useAssistant.getState().stop()}
      streaming={Boolean(mainLive && !mainLive.done)}
      header={
        <PaneModelMenu
          models={available}
          providers={providers}
          value={activeModelId}
          disabled={Boolean(mainLive && !mainLive.done)}
          onChange={(id) => void activateModel(id)}
        />
      }
    >
      <PaneBody
        messages={messages}
        live={mainLive}
        files={fileIndex}
        loading={false}
        error={null}
        empty={t('assistant.panes.main_empty')}
      />
    </PaneFrame>,
    ...visible.map((pane) => {
      const current = turns[pane.id] ?? null
      const paneCopy = current?.text || [...pane.messages].reverse().find((message) => message.role === 'assistant')?.content || ''
      return (
        <PaneFrame
          key={pane.id}
          paneId={pane.id}
          expanded={expanded === pane.id}
          onExpand={() => setExpanded(expanded === pane.id ? null : pane.id)}
          onCopy={() => copy(paneCopy)}
          onClose={() => void closePane(pane.id)}
          onStop={() => stopPane(pane.id)}
          streaming={Boolean(current && !current.done)}
          header={
            <PaneModelMenu
              models={available}
              providers={providers}
              value={pane.modelId}
              disabled={Boolean(current && !current.done)}
              onChange={(id) => setPaneModel(pane.id, id)}
            />
          }
        >
          <PaneBody
            messages={pane.messages}
            live={current ? { ...current, modelLabel: labelOf(pane.modelId) } : null}
            files={{ ...fileIndex, ...pane.files }}
            loading={pane.loading}
            error={pane.error}
            empty={t('assistant.panes.side_empty')}
          />
        </PaneFrame>
      )
    }),
  ]
  const shown = expanded
    ? allPanes.filter((pane) => pane.key === expanded)
    : allPanes
  return (
    <div className="h-full min-h-0 overflow-y-auto p-3" data-multi-layout={layout}>
      <div className={cn('grid h-full min-h-0 auto-rows-[minmax(360px,1fr)] gap-3', !expanded && gridClass, expanded && 'grid-cols-1')}>
        {shown}
      </div>
      {sideStreaming && <span className="sr-only" role="status">{t('assistant.panes.running')}</span>}
    </div>
  )
}

