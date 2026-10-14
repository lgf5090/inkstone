import React from 'react';
import { cn } from '../../cn';

export interface ToolChipProps {
  label: string;
  icon?: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}

export const ToolChip: React.FC<ToolChipProps> = ({
  label,
  icon,
  active,
  onClick,
  className,
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[length:var(--text-11)] font-medium transition-colors select-none',
        active
          ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)] border border-[var(--accent)]/30'
          : 'bg-[var(--bg-raised)] text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]',
        !onClick && 'cursor-default pointer-events-none',
        className,
      )}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span>{label}</span>
    </button>
  );
};
