import React, { useRef, useEffect } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { cn } from '../../cn';
import { t } from '../../i18n';
import { isImeComposing } from '../../ime';

export interface AIChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export const AIChatInput: React.FC<AIChatInputProps> = ({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming = false,
  disabled = false,
  placeholder,
  className,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isStreaming && value.trim() && !disabled) {
        onSubmit();
      }
    }
  };

  return (
    <div
      className={cn(
        'relative flex items-center rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2 shadow-sm transition-all focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent)]/20',
        className,
      )}
    >
      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder || t('excalidraw.ai_prompt_placeholder')}
        disabled={disabled}
        className="flex-1 max-h-32 resize-none bg-transparent text-xs leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] focus:outline-none"
      />

      <div className="ml-2 flex shrink-0 items-center">
        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--danger)] text-[var(--danger-contrast)] shadow-md hover:opacity-90 transition-opacity"
            title={t('excalidraw.stop_generating')}
            aria-label={t('excalidraw.stop_generating')}
          >
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            disabled={!value.trim() || disabled}
            onClick={onSubmit}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full transition-all shadow-md',
              value.trim() && !disabled
                ? 'bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] active:scale-95'
                : 'bg-[var(--bg-hover)] text-[var(--text-quaternary)] cursor-not-allowed',
            )}
            title={t('excalidraw.send')}
            aria-label={t('excalidraw.send')}
          >
            <ArrowUp size={15} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
};
