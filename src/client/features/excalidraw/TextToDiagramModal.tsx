import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlignLeft,
  Check,
  Clock,
  Copy,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { useUi } from '../../store/ui';
import {
  AIMessage,
  extractCodeBlock,
  streamChatCompletion,
  AIChatInput,
  ThinkingProcess,
  ToolChip,
} from '../../lib/ai';
import { useExcalidrawSettingsStore } from './excalidraw-settings-store';
import { convertMermaidToExcalidrawElements } from '../../lib/markdown/excalidraw/mermaid';
import { sanitizeSvg } from '../../lib/sanitize-svg';

export interface TextToDiagramModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInsert: (elements: any[]) => void;
  theme?: 'dark' | 'light';
  initialTab?: 'ai' | 'mermaid';
  initialMermaidCode?: string;
}

interface SavedChatSession {
  id: string;
  title: string;
  messages: AIMessage[];
  mermaidCode: string;
  updatedAt: number;
}

const STORAGE_KEY = 'inkstone-excalidraw-ttd-chats';
const DEFAULT_MERMAID = `graph TD\n    A[Start] --> B(Work)\n    B --> C{Done?}\n    C -->|Yes| D[End]\n    C -->|No| B`;

let mermaidApi: any = null;
let renderSeq = 0;

async function getMermaidInstance(isDark: boolean) {
  if (!mermaidApi) {
    const mod = await import('mermaid');
    mermaidApi = mod.default;
  }
  mermaidApi.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    securityLevel: 'strict',
    suppressErrorRendering: true,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    themeVariables: {
      fontSize: '13px',
      background: 'transparent',
    },
  });
  return mermaidApi;
}

async function renderSvgSafe(code: string, isDark: boolean): Promise<string> {
  if (!code.trim() || typeof document === 'undefined') return '';
  const m = await getMermaidInstance(isDark);
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.top = '-9999px';
  host.style.left = '-9999px';
  host.style.visibility = 'hidden';
  host.style.pointerEvents = 'none';
  document.body.appendChild(host);
  try {
    const { svg } = await m.render(`ink-ttd-mermaid-${++renderSeq}`, code.trim(), host);
    return svg;
  } finally {
    host.remove();
  }
}

export const TextToDiagramModal: React.FC<TextToDiagramModalProps> = ({
  isOpen,
  onClose,
  onInsert,
  theme = 'dark',
  initialTab = 'ai',
  initialMermaidCode = '',
}) => {
  const toast = useUi((s) => s.toast);
  const isDark = theme === 'dark';

  const [activeTab, setActiveTab] = useState<'ai' | 'mermaid'>(initialTab);
  const [mermaidCode, setMermaidCode] = useState(initialMermaidCode || DEFAULT_MERMAID);
  const [previewSvg, setPreviewSvg] = useState<string>('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);

  const [inputPrompt, setInputPrompt] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentReasoning, setCurrentReasoning] = useState('');
  const [isThinkingActive, setIsThinkingActive] = useState(false);
  const abortCtrlRef = useRef<AbortController | null>(null);

  const [chats, setChats] = useState<SavedChatSession[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // A chat list an earlier session left behind is a convenience: a store this browser will not
      // hand back — private mode, or a blob JSON no longer parses — still opens the dialog on the
      // default session built below, which is the state it starts from when there was never one.
    }
    return [
      {
        id: `chat_${Date.now()}`,
        title: 'New Chat',
        messages: [],
        mermaidCode: initialMermaidCode || DEFAULT_MERMAID,
        updatedAt: Date.now(),
      },
    ];
  });
  const [currentChatId, setCurrentChatId] = useState<string>(() => chats[0]?.id || `chat_${Date.now()}`);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const [copied, setCopied] = useState(false);

  const currentChat = chats.find((c) => c.id === currentChatId) || chats[0];

  // The diagram is markup this app did not write, so it goes through the shared SVG pass before it
  // is handed to `dangerouslySetInnerHTML`; the memo keeps a pan or a zoom from re-sanitising it.
  const safePreviewSvg = useMemo(() => sanitizeSvg(previewSvg), [previewSvg]);

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
    if (initialMermaidCode) setMermaidCode(initialMermaidCode);
  }, [initialTab, initialMermaidCode, isOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
    } catch {
      // History is written beside the state rather than instead of it: the dialog already holds the
      // chats it shows, so a store that refuses the write (a quota, private mode) costs only the next
      // reload, never the conversation on screen.
    }
  }, [chats]);

  const updateMermaidPreview = useCallback(
    async (code: string) => {
      if (!code.trim()) {
        setPreviewSvg('');
        setPreviewError(null);
        return;
      }
      setIsRendering(true);
      try {
        const svg = await renderSvgSafe(code, isDark);
        setPreviewSvg(svg);
        setPreviewError(null);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setPreviewError(msg);
      } finally {
        setIsRendering(false);
      }
    },
    [isDark],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void updateMermaidPreview(mermaidCode);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [mermaidCode, updateMermaidPreview]);

  const handleNewChat = () => {
    const newChat: SavedChatSession = {
      id: `chat_${Date.now()}`,
      title: `Chat ${chats.length + 1}`,
      messages: [],
      mermaidCode: DEFAULT_MERMAID,
      updatedAt: Date.now(),
    };
    setChats((prev) => [newChat, ...prev]);
    setCurrentChatId(newChat.id);
    setMermaidCode(DEFAULT_MERMAID);
    setInputPrompt('');
    setCurrentReasoning('');
    setIsThinkingActive(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setIsHistoryOpen(false);
  };

  const handleSelectChat = (chat: SavedChatSession) => {
    setCurrentChatId(chat.id);
    setMermaidCode(chat.mermaidCode || DEFAULT_MERMAID);
    setInputPrompt('');
    setCurrentReasoning('');
    setIsThinkingActive(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setIsHistoryOpen(false);
  };

  const handleDeleteChat = (e: React.MouseEvent, chatId: string) => {
    e.stopPropagation();
    const remaining = chats.filter((c) => c.id !== chatId);
    if (remaining.length === 0) {
      handleNewChat();
    } else {
      setChats(remaining);
      if (currentChatId === chatId) {
        handleSelectChat(remaining[0]);
      }
    }
  };

  const handleSendPrompt = async (overridePrompt?: string) => {
    const promptToSend = (overridePrompt ?? inputPrompt).trim();
    if (!promptToSend || isStreaming) return;

    const userMessage: AIMessage = {
      id: `msg_u_${Date.now()}`,
      role: 'user',
      content: promptToSend,
      timestamp: Date.now(),
    };

    const nextMessages = [...(currentChat?.messages || []), userMessage];
    setChats((prev) =>
      prev.map((c) => (c.id === currentChatId ? { ...c, messages: nextMessages, updatedAt: Date.now() } : c)),
    );
    setInputPrompt('');
    setIsStreaming(true);
    setIsThinkingActive(true);
    setCurrentReasoning('');

    const abortCtrl = new AbortController();
    abortCtrlRef.current = abortCtrl;

    const settings = useExcalidrawSettingsStore.getState();
    const config = settings.aiProviders[settings.aiDefaultProvider] || {
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: '***REMOVED***',
    };

    const systemPrompt =
      'You are an expert software architect and diagram designer. Generate or update a mermaid diagram according to the prompt. Return ONLY a single mermaid codeblock (```mermaid ... ```). Avoid using parentheses in node labels and edge labels. Maintain valid mermaid syntax.';

    const contextContent = mermaidCode.trim() && mermaidCode !== DEFAULT_MERMAID
      ? `Current diagram:\n\`\`\`mermaid\n${mermaidCode.trim()}\n\`\`\`\n\nUser request: ${promptToSend}`
      : promptToSend;

    const apiMessages: AIMessage[] = [
      ...currentChat.messages.slice(-4),
      { id: userMessage.id, role: 'user', content: contextContent },
    ];

    try {
      await streamChatCompletion(apiMessages, config, {
        systemPrompt,
        model: settings.aiDefaultTextModel || 'deepseek-flash',
        maxTokens: settings.aiMaxResponseTokens || 4096,
        signal: abortCtrl.signal,
        onReasoningChunk: (_chunk, fullReasoning) => {
          setCurrentReasoning(fullReasoning);
        },
        onChunk: (_chunk, fullContent) => {
          setIsThinkingActive(false);
          const extracted = extractCodeBlock(fullContent);
          if (extracted) {
            setMermaidCode(extracted);
          }
        },
        onFinish: ({ content, reasoning }) => {
          setIsThinkingActive(false);
          if (reasoning) {
            setCurrentReasoning(reasoning);
          }
          const extracted = extractCodeBlock(content);
          const finalDiagram = extracted || mermaidCode;
          if (extracted) {
            setMermaidCode(extracted);
          }

          const assistantMsg: AIMessage = {
            id: `msg_a_${Date.now()}`,
            role: 'assistant',
            content,
            reasoningContent: reasoning || currentReasoning,
            timestamp: Date.now(),
          };

          setChats((prev) =>
            prev.map((c) =>
              c.id === currentChatId
                ? {
                    ...c,
                    mermaidCode: finalDiagram,
                    messages: [...nextMessages, assistantMsg],
                    updatedAt: Date.now(),
                  }
                : c,
            ),
          );
        },
        onError: (err) => {
          if (abortCtrl.signal.aborted) return;
          setIsThinkingActive(false);
          toast({
            title: t('settings.excalidraw_ai_test_failed'),
            description: err.message,
            tone: 'danger',
          });
        },
      });
    } catch {
      // `streamChatCompletion` reports every failure through `onError` — the toast above — before it
      // rethrows, and a pressed Stop rethrows its AbortError through the same door, so nothing that
      // reaches here is news to the reader; the `finally` still ends the streaming state.
    } finally {
      setIsStreaming(false);
      setIsThinkingActive(false);
      abortCtrlRef.current = null;
    }
  };

  const handleStopGeneration = () => {
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
      abortCtrlRef.current = null;
    }
    setIsStreaming(false);
    setIsThinkingActive(false);
  };

  const handleInsertDiagram = () => {
    try {
      const elements = convertMermaidToExcalidrawElements(mermaidCode);
      if (elements && elements.length > 0) {
        onInsert(elements);
        toast({ title: t('excalidraw.inserted_to_canvas'), tone: 'success' });
        onClose();
      } else {
        toast({
          title: t('excalidraw.syntax_error'),
          description: t('excalidraw.no_elements_warning'),
          tone: 'warning',
        });
      }
    } catch (err: unknown) {
      toast({
        title: t('excalidraw.syntax_error'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'danger',
      });
    }
  };

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(mermaidCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      toast({ title: t('excalidraw.copied'), tone: 'success' });
    } catch {
    }
  };

  const handleFormatCode = () => {
    const formatted = mermaidCode
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
      .join('\n');
    setMermaidCode(formatted);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom((z) => Math.min(Math.max(z * factor, 0.3), 3));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 anim-fade">
      <div
        className="flex h-[92vh] w-full max-w-6xl flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ttd-dialog-title"
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4 bg-[var(--bg-raised)]/70">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveTab('ai')}
              className={cn(
                'flex items-center gap-2 rounded-xl px-3.5 py-1.5 text-xs font-medium transition-all',
                activeTab === 'ai'
                  ? 'bg-[var(--accent)] text-white shadow-xs font-semibold'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              <Sparkles size={14} />
              <span>{t('excalidraw.text_to_diagram')}</span>
              <span className="rounded-md bg-white/20 px-1.5 py-0.2 text-[10px] font-semibold tracking-wide">
                {t('excalidraw.ai_beta')}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('mermaid')}
              className={cn(
                'flex items-center gap-2 rounded-xl px-3.5 py-1.5 text-xs font-medium transition-all',
                activeTab === 'mermaid'
                  ? 'bg-[var(--accent)] text-white shadow-xs font-semibold'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              <Workflow size={14} />
              <span>{t('excalidraw.mermaid')}</span>
            </button>
          </div>

          <div className="flex items-center gap-2 relative">
            <button
              type="button"
              onClick={handleNewChat}
              className="flex items-center gap-1.5 rounded-xl bg-[#8b5cf6] px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 transition-all shadow-xs"
            >
              <Plus size={13} />
              <span>{t('excalidraw.new_chat')}</span>
            </button>

            <button
              type="button"
              onClick={() => setIsHistoryOpen((o) => !o)}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs',
                isHistoryOpen && 'bg-[var(--bg-hover)] text-[var(--text-primary)]',
              )}
              title={t('excalidraw.chat_history')}
              aria-label={t('excalidraw.chat_history')}
            >
              <Clock size={15} />
            </button>

            {isHistoryOpen && (
              <div className="absolute right-10 top-10 z-50 w-64 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 shadow-xl anim-pop">
                <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                  {t('excalidraw.chat_history')}
                </div>
                <div className="max-h-60 overflow-y-auto space-y-1">
                  {chats.map((c) => (
                    <div
                      key={c.id}
                      className={cn(
                        'flex items-center justify-between rounded-lg text-xs transition-colors',
                        c.id === currentChatId
                          ? 'bg-[var(--accent-soft)]'
                          : 'hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => handleSelectChat(c)}
                        className={cn(
                          'flex-1 text-left px-2.5 py-1.5 truncate rounded-l-lg transition-colors',
                          c.id === currentChatId
                            ? 'text-[var(--accent)] font-medium'
                            : 'text-[var(--text-primary)]',
                        )}
                      >
                        {c.title || 'Chat'}
                      </button>
                      <button
                        type="button"
                        aria-label={t('common.delete')}
                        title={t('common.delete')}
                        onClick={(e) => handleDeleteChat(e, c.id)}
                        className="p-1.5 text-[var(--text-quaternary)] hover:text-[var(--danger)] rounded-r-lg transition-colors"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
              aria-label={t('common.close')}
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
          <div className="flex flex-1 min-h-0 divide-x divide-[var(--border-subtle)]">
            <div className="flex flex-1 flex-col min-w-0 bg-[var(--bg-surface)]">
              {activeTab === 'mermaid' && (
                <div className="flex h-10 items-center justify-between border-b border-[var(--border-subtle)] px-3 bg-[var(--bg-raised)]/40 text-xs shrink-0">
                  <span className="font-mono text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
                    {t('excalidraw.mermaid_editor')}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <ToolChip
                      label={t('excalidraw.template_flowchart')}
                      onClick={() =>
                        setMermaidCode(
                          'graph TD\n    A[Client] --> B(API Gateway)\n    B --> C[Auth Service]\n    B --> D[Data Service]',
                        )
                      }
                    />
                    <ToolChip
                      label={t('excalidraw.template_sequence')}
                      onClick={() =>
                        setMermaidCode(
                          'sequenceDiagram\n    Alice->>Bob: Hello Bob!\n    Bob-->>Alice: Hi Alice!',
                        )
                      }
                    />
                    <ToolChip
                      label={t('excalidraw.template_class')}
                      onClick={() =>
                        setMermaidCode(
                          'classDiagram\n    Animal <|-- Duck\n    Animal : +int age\n    Animal : +String gender\n    Duck : +swim()',
                        )
                      }
                    />
                  </div>
                </div>
              )}

              {activeTab === 'ai' && (currentReasoning || isThinkingActive) && (
                <div className="p-3 border-b border-[var(--border-subtle)] bg-[var(--bg-raised)]/30 shrink-0">
                  <ThinkingProcess
                    reasoning={currentReasoning}
                    isThinking={isThinkingActive}
                    defaultExpanded={true}
                  />
                </div>
              )}

              <div className="relative flex-1 min-h-0 p-3">
                <textarea
                  value={mermaidCode}
                  onChange={(e) => setMermaidCode(e.target.value)}
                  className="h-full w-full resize-none rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3.5 font-mono text-xs leading-relaxed text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none transition-colors"
                  spellCheck={false}
                />
              </div>

              <div className="flex h-9 items-center justify-between border-t border-[var(--border-subtle)] px-3 bg-[var(--bg-raised)]/30 text-xs shrink-0">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={handleFormatCode}
                    className="p-1 rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                    title={t('excalidraw.collapse')}
                  >
                    <AlignLeft size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyCode}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                    <span>{copied ? t('excalidraw.copied') : t('common.copy')}</span>
                  </button>
                </div>
                <div className="text-[11px] text-[var(--text-quaternary)] font-mono">
                  {mermaidCode.split('\n').length}
                </div>
              </div>
            </div>

            <div className="flex flex-1 flex-col min-w-0 bg-[#23272e] dark:bg-[#1e2227]">
              <div className="flex h-10 items-center justify-between border-b border-black/20 px-3 bg-black/20 text-xs shrink-0">
                <span className="font-medium text-slate-300 flex items-center gap-1.5">
                  <Workflow size={13} className="text-[#8b5cf6]" />
                  {t('excalidraw.live_preview')}
                  {isRendering && <RefreshCw size={11} className="animate-spin text-[#8b5cf6]" />}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setZoom((z) => Math.min(z + 0.2, 3))}
                    className="p-1.5 rounded-lg text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
                    title={t('excalidraw.zoom_in')}
                  >
                    <ZoomIn size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoom((z) => Math.max(z - 0.2, 0.3))}
                    className="p-1.5 rounded-lg text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
                    title={t('excalidraw.zoom_out')}
                  >
                    <ZoomOut size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setZoom(1);
                      setPan({ x: 0, y: 0 });
                    }}
                    className="p-1.5 rounded-lg text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
                    title={t('excalidraw.zoom_reset')}
                  >
                    <RefreshCw size={13} />
                  </button>
                </div>
              </div>

              <div
                className="relative flex-1 overflow-hidden select-none cursor-grab active:cursor-grabbing flex items-center justify-center p-4 bg-[#23272e] dark:bg-[#1e2227]"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onWheel={handleWheel}
              >
                {previewError ? (
                  <div className="max-w-md rounded-xl border border-rose-500/30 bg-rose-950/40 p-3 text-xs text-rose-300 shadow-sm">
                    <div className="flex items-center gap-1.5 font-semibold mb-1 text-rose-400">
                      <AlertCircle size={14} />
                      <span>{t('excalidraw.syntax_error')}</span>
                    </div>
                    <pre className="font-mono text-[11px] whitespace-pre-wrap">{previewError}</pre>
                  </div>
                ) : previewSvg ? (
                  <div
                    style={{
                      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                      transformOrigin: 'center center',
                      transition: isDragging ? 'none' : 'transform 0.05s ease-out',
                    }}
                    className="max-h-full max-w-full flex items-center justify-center pointer-events-none [&_svg]:max-h-full [&_svg]:max-w-full"
                    dangerouslySetInnerHTML={{ __html: safePreviewSvg }}
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center text-center text-slate-500">
                    <Workflow size={32} className="mb-2 opacity-50" />
                    <p className="text-xs">{t('excalidraw.no_diagram_preview')}</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {activeTab === 'ai' && (
            <div className="p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-raised)]/40 shrink-0">
              <AIChatInput
                value={inputPrompt}
                onChange={setInputPrompt}
                onSubmit={() => void handleSendPrompt()}
                onStop={handleStopGeneration}
                isStreaming={isStreaming}
                placeholder={t('excalidraw.ai_prompt_placeholder')}
              />
            </div>
          )}
        </div>

        <footer className="flex h-14 shrink-0 items-center justify-between border-t border-[var(--border-subtle)] px-4 bg-[var(--bg-raised)]/70">
          <div>
            {activeTab === 'ai' ? (
              <button
                type="button"
                onClick={() => setActiveTab('mermaid')}
                className="flex items-center gap-1 text-xs font-semibold text-[#8b5cf6] hover:underline"
              >
                <span>{t('excalidraw.view_as_mermaid')}</span>
                <span>→</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setActiveTab('ai')}
                className="flex items-center gap-1 text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <span>←</span>
                <span>{t('excalidraw.text_to_diagram')}</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-xs"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={handleInsertDiagram}
              disabled={!mermaidCode.trim() || Boolean(previewError)}
              className={cn(
                'flex items-center gap-1.5 rounded-xl px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition-all',
                mermaidCode.trim() && !previewError
                  ? 'bg-[#8b5cf6] hover:brightness-110 active:scale-95'
                  : 'bg-[var(--bg-hover)] text-[var(--text-quaternary)] cursor-not-allowed',
              )}
            >
              <span>{t('excalidraw.insert_into_canvas')}</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};
