import { Copy, ExternalLink, FileText, Image, Mail, Phone, Link as LinkIcon } from 'lucide-react';
import { t } from '../../../lib/i18n';
import { useNotes } from '../../../store/notes';
import { useUi } from '../../../store/ui';
import type { MessageKey } from '../../../lib/i18n';
import type { LinkPreview, LinkPreviewKind } from '../../../types/hover-card';

const KIND_LABEL_KEYS: Record<LinkPreviewKind, MessageKey> = {
  web: 'preview.link_kind_web',
  image: 'preview.link_kind_image',
  mail: 'preview.link_kind_mail',
  phone: 'preview.link_kind_phone',
  file: 'preview.link_kind_file',
  other: 'preview.link_kind_other',
};

const KIND_ICONS: Record<LinkPreviewKind, typeof LinkIcon> = {
  web: LinkIcon,
  image: Image,
  mail: Mail,
  phone: Phone,
  file: FileText,
  other: LinkIcon,
};

function copyAddress(preview: LinkPreview): void {
  const clipboard = navigator.clipboard;
  const toast = useUi.getState().toast;
  if (!clipboard?.writeText) {
    toast({ title: t('preview.could_not_copy'), tone: 'danger' });
    return;
  }
  void clipboard.writeText(preview.href)
    .then(() => toast({ title: t('preview.link_address_copied'), tone: 'success' }))
    .catch(() => toast({ title: t('preview.could_not_copy'), tone: 'danger' }));
}

/**
 * Only the schemes a browser can follow reach this, and a destination too long to print whole is never
 * offered for opening either: the card would be launching bytes the reader cannot see.
 */
function openAddress(preview: LinkPreview): void {
  if (!preview.openable || preview.truncated) return;
  if (preview.kind === 'mail' || preview.kind === 'phone') {
    window.location.href = preview.href;
    return;
  }
  window.open(preview.href, '_blank', 'noopener,noreferrer');
}

function ActionButton({ label, icon, onClick }: { label: string, icon: React.ReactNode, onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex min-w-0 max-w-full items-center gap-1.5 rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-12)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

export function LinkPreviewBody({ preview, onClose }: { preview: LinkPreview, onClose: () => void }) {
  const openNote = useNotes((s) => s.openNote);
  const KindIcon = KIND_ICONS[preview.kind];
  const canOpen = preview.openable && !preview.truncated;
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        <span className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-1.5 py-0.5">
          <KindIcon size={11}/>
          {t(KIND_LABEL_KEYS[preview.kind])}
        </span>
        {preview.host && <span className="min-w-0 truncate" title={preview.host}>{preview.host}</span>}
      </div>
      <p className="mt-2 max-h-32 overflow-y-auto overscroll-contain break-all font-mono text-[length:var(--text-11)] leading-relaxed text-[var(--text-secondary)] select-text">
        {preview.href}
      </p>
      {preview.noteTitle && (
        <p className="mt-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('preview.link_own_note', { value0: preview.noteTitle })}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-[var(--border-subtle)] pt-1.5">
        {canOpen && (
          <ActionButton
            label={t(preview.kind === 'mail' || preview.kind === 'phone' ? 'common.open' : 'preview.link_open_new_tab')}
            icon={<ExternalLink size={12}/>}
            onClick={() => openAddress(preview)}
          />
        )}
        {!preview.truncated && (
          <ActionButton label={t('preview.link_copy_address')} icon={<Copy size={12}/>} onClick={() => copyAddress(preview)}/>
        )}
        {preview.noteId && (
          <ActionButton
            label={t('preview.link_open_note')}
            icon={<FileText size={12}/>}
            onClick={() => {
              void openNote(preview.noteId!);
              onClose();
            }}
          />
        )}
      </div>
      {preview.truncated && (
        <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('preview.link_too_long')}</p>
      )}
    </div>
  );
}
