import React, { useState } from 'react';
import { Brain, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { cn } from '../../cn';
import { t } from '../../i18n';

export interface ThinkingProcessProps {
  reasoning: string;
  isThinking?: boolean;
  className?: string;
  defaultExpanded?: boolean;
}

export const ThinkingProcess: React.FC<ThinkingProcessProps> = ({
  reasoning,
  isThinking = false,
  className,
  defaultExpanded = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded || isThinking);

  if (!reasoning && !isThinking) return null;

  return (
    <div
      className={cn(
        'my-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)]/60 text-xs overflow-hidden transition-all',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          {isThinking ? (
            <Sparkles size={14} className="text-[var(--accent)] animate-spin" />
          ) : (
            <Brain size={14} className="text-[var(--text-tertiary)]" />
          )}
          <span className="font-medium">
            {isThinking
              ? t('excalidraw.thinking')
              : t('excalidraw.thought_completed')}
          </span>
          {isThinking && (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] animate-ping" />
          )}
        </div>
        <div className="flex items-center gap-1 text-[var(--text-tertiary)]">
          <span className="text-[11px]">
            {expanded ? t('excalidraw.collapse') : t('excalidraw.expand')}
          </span>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-[var(--border-subtle)]/50 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-[var(--text-tertiary)] max-h-60 overflow-y-auto whitespace-pre-wrap select-text">
          {reasoning || (isThinking ? t('excalidraw.analyzing_diagram') : '')}
        </div>
      )}
    </div>
  );
};
