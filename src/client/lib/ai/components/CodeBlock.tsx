import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../cn';
import { t } from '../../i18n';

/**
 * How long this block keeps its "copied" mark before the button returns to "copy".
 *
 * `COPY_RESET_MS` in `lib/motion` is the dwell the copy affordances elsewhere share. This one is named
 * rather than folded into that value because naming a number is a different change from retiming one,
 * and a reader has no way to notice 2000 becoming 1500; it should join the shared constant the next
 * time the affordance itself is worked on.
 */
const CODE_COPY_RESET_MS = 2000;

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
      window.setTimeout(() => setCopied(false), CODE_COPY_RESET_MS);
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
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]/60 px-3 py-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        <span className="font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
          {language}
        </span>
        <div className="flex items-center gap-1.5">
          {onApply && (
            <button
              type="button"
              onClick={onApply}
              className="rounded-md bg-[var(--accent-soft)] px-2 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white transition-colors"
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
                <span className="text-[length:var(--text-10)] text-[var(--accent)]">
                  {t('excalidraw.copied')}
                </span>
              </>
            ) : (
              <>
                <Copy size={12} />
                <span className="text-[length:var(--text-10)]">{t('common.copy')}</span>
              </>
            )}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto p-3 text-[length:var(--text-12)] leading-relaxed text-[var(--text-primary)]">
        <code>{code}</code>
      </pre>
    </div>
  );
};
