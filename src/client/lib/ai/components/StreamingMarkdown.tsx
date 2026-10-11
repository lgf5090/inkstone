import React from 'react';
import { cn } from '../../cn';
import { CodeBlock } from './CodeBlock';

export interface StreamingMarkdownProps {
  content: string;
  className?: string;
  onApplyCode?: (code: string) => void;
}

export const StreamingMarkdown: React.FC<StreamingMarkdownProps> = ({
  content,
  className,
  onApplyCode,
}) => {
  const parts: Array<{ type: 'text' | 'code'; text: string; language?: string }> = [];
  const regex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        text: content.slice(lastIndex, match.index),
      });
    }
    parts.push({
      type: 'code',
      language: match[1] || 'mermaid',
      text: match[2],
    });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < content.length) {
    parts.push({
      type: 'text',
      text: content.slice(lastIndex),
    });
  }

  return (
    <div className={cn('text-xs leading-relaxed text-[var(--text-primary)] space-y-2', className)}>
      {parts.map((p, idx) => {
        if (p.type === 'code') {
          return (
            <CodeBlock
              key={idx}
              code={p.text}
              language={p.language}
              onApply={onApplyCode ? () => onApplyCode(p.text) : undefined}
            />
          );
        }
        return (
          <div key={idx} className="whitespace-pre-wrap">
            {p.text}
          </div>
        );
      })}
    </div>
  );
};
