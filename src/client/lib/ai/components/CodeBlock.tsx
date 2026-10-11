import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../cn';
import { t } from '../../i18n';

export interface CodeBlockProps {
  code: string;
  language?: string;
  className?: string;
  onApply?: () => void;
  applyLabel?: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({
  code,
  language = 'mermaid',
  className,
  onApply,
  applyLabel,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
    }
  };

  return (
    <div
      className={cn(
        'group relative my-2 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-inset)] font-mono text-xs',
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]/60 px-3 py-1.5 text-[11px] text-[var(--text-tertiary)]">
        <span className="font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
          {language}
        </span>
        <div className="flex items-center gap-1.5">
          {onApply && (
            <button
              type="button"
              onClick={onApply}
              className="rounded-md bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white transition-colors"
            >
              {applyLabel || t('excalidraw.apply')}
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            title={t('common.copy')}
            aria-label={t('common.copy')}
          >
            {copied ? (
              <>
                <Check size={12} className="text-[var(--accent)]" />
                <span className="text-[10px] text-[var(--accent)]">
                  {t('excalidraw.copied')}
                </span>
              </>
            ) : (
              <>
                <Copy size={12} />
                <span className="text-[10px]">{t('common.copy')}</span>
              </>
            )}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto p-3 text-[12px] leading-relaxed text-[var(--text-primary)]">
        <code>{code}</code>
      </pre>
    </div>
  );
};
