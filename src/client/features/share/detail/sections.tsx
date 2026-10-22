import { useId, type ReactNode } from 'react';
import { Check, Copy, ExternalLink, FolderClosed, Hash, Link2, Lock, Pause, Play, QrCode, Trash2 } from 'lucide-react';
import { LIMITS } from '@shared/constants';
import type { ShareFolder } from '@shared/share-hub';
import { Badge, Button } from '../../../components/primitives';
import { Checkbox, Field, Input, Segmented, Switch } from '../../../components/form';
import { SelectMenu } from '../../../components/select-menu';
import { Tooltip } from '../../../components/overlay';
import { t } from '../../../lib/i18n';
import { KEEP_CURRENT_EXPIRY } from '../share-form';

/** Four weeks past the last read, the shortest window the hub calls quiet. */
const DAY_MS = 24 * 3600000;

const EXPIRY_OPTIONS: ReadonlyArray<{ value: string; labelKey: Parameters<typeof t>[0] }> = [
  { value: '0', labelKey: 'share.never_expires' },
  { value: String(DAY_MS), labelKey: 'share.1_day' },
  { value: String(7 * DAY_MS), labelKey: 'share.7_days' },
  { value: String(30 * DAY_MS), labelKey: 'share.30_days' },
];

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
      {children}
    </div>
  );
}

export function CardTitle({ icon, id, children }: { icon: ReactNode; id?: string; children: ReactNode }) {
  return (
    <div id={id} className="flex items-center gap-1.5 text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
      <span className="text-[var(--text-tertiary)]">{icon}</span>
      {children}
    </div>
  );
}

export function LinkSection(props: {
  url: string;
  copied: boolean;
  onCopy: () => void;
  onOpenQr: () => void;
  isPaused: boolean;
  isExpired: boolean;
}) {
  const { url, copied, onCopy, onOpenQr, isPaused, isExpired } = props;
  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
      <div className="flex items-center gap-2">
        <Link2 size={13} className="shrink-0 text-[var(--accent)]"/>
        {/* Read-only by design: the address is handed out, never edited, and a press selects all of it. */}
        <Input
          readOnly
          value={url}
          aria-label={t('share.public_link')}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 font-mono text-[length:var(--text-11-5)]"
        />
        <Button
          size="sm"
          variant={copied ? 'ghost' : 'secondary'}
          icon={copied ? <Check size={12} className="text-[var(--success)]"/> : <Copy size={12}/>}
          onClick={() => void onCopy()}
        >
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
        <Tooltip label={t('share.open_link')} side="left">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label={t('share.open_link')}
            className="inline-flex size-9 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-7"
          >
            <ExternalLink size={13}/>
          </a>
        </Tooltip>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-2.5">
        <Button size="sm" variant="secondary" icon={<QrCode size={12}/>} onClick={onOpenQr}>
          {t('share.qr_title')}
        </Button>
        {isPaused && <Badge tone="warning">{t('share.editor_paused_badge')}</Badge>}
        {isExpired && <Badge tone="danger">{t('share.expired')}</Badge>}
      </div>
    </div>
  );
}

/**
 * The pause control.
 *
 * It is a pending change like every other field here: the switch marks what Save will ask for, and
 * the copy says what the link means in that state rather than claiming it already is.
 */
export function StatusSection(props: {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const { enabled, disabled, onChange } = props;
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <CardTitle icon={enabled ? <Play size={12}/> : <Pause size={12}/>}>
            {t('share.editor_link_status')}
          </CardTitle>
          <p className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
            {enabled ? t('share.editor_status_active_desc') : t('share.editor_status_paused_desc')}
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={disabled}
          onChange={onChange}
          label={t('share.editor_link_status')}
        />
      </div>
    </Card>
  );
}

export function FolderSection(props: {
  folders: ShareFolder[];
  folderId: string | null;
  disabled: boolean;
  onChange: (folderId: string | null) => void;
}) {
  const { folders, folderId, disabled, onChange } = props;
  const label = t('share.editor_folder');
  return (
    <Card>
      <div className="pb-2">
        <CardTitle icon={<FolderClosed size={12}/>}>
          {label}
        </CardTitle>
      </div>
      <SelectMenu
        label={label}
        value={folderId ?? ''}
        disabled={disabled}
        width={280}
        onChange={(value) => onChange(value || null)}
        options={[
          { value: '', label: t('navigation.unfiled') },
          ...folders.map((folder) => ({ value: folder.id, label: folder.name })),
        ]}
      />
    </Card>
  );
}

export function TagSection(props: {
  options: string[];
  selected: string[];
  newTag: string;
  disabled: boolean;
  tagMax: number;
  onNewTagChange: (value: string) => void;
  onAddTag: () => void;
  onToggle: (name: string, checked: boolean) => void;
}) {
  const { options, selected, newTag, disabled, tagMax, onNewTagChange, onAddTag, onToggle } = props;
  const headingId = useId();
  const hintId = useId();
  return (
    <Card>
      <div className="pb-2">
        <CardTitle icon={<Hash size={12}/>} id={headingId}>
          {t('share.editor_tags')}
        </CardTitle>
      </div>
      {/* A list of real checkboxes: the selection reads as a set of answered states, every row is
          reached with Tab, and toggling one never leaves the list. */}
      <div
        role="group"
        aria-labelledby={headingId}
        aria-describedby={hintId}
        className="max-h-40 space-y-1 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2"
      >
        {options.length === 0
          ? <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('share.editor_no_tags')}</p>
          : options.map((name) => (
            <Checkbox
              key={name}
              checked={selected.includes(name)}
              disabled={disabled}
              onChange={(checked) => onToggle(name, checked)}
              label={name}
              className="w-full"
            />
          ))}
      </div>
      <p id={hintId} className="pt-1.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
        {t('share.editor_tags_hint', { max: tagMax })}
      </p>
      <div className="flex items-center gap-2 pt-2">
        <Input
          type="text"
          value={newTag}
          disabled={disabled}
          maxLength={LIMITS.tagNameMaxLength}
          aria-label={t('share.editor_new_tag')}
          placeholder={t('share.editor_new_tag')}
          onChange={(event) => onNewTagChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onAddTag();
            }
          }}
        />
        <Button size="sm" variant="secondary" disabled={disabled || !newTag.trim()} onClick={onAddTag}>
          {t('share.editor_add_tag')}
        </Button>
      </div>
    </Card>
  );
}

export function PasscodeSection(props: {
  usePasscode: boolean;
  alreadyProtected: boolean;
  passcode: string;
  disabled: boolean;
  minLength: number;
  onToggle: (usePasscode: boolean) => void;
  onChange: (passcode: string) => void;
}) {
  const { usePasscode, alreadyProtected, passcode, disabled, minLength, onToggle, onChange } = props;
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <CardTitle icon={<Lock size={12}/>}>
            {t('common.access_passcode')}
          </CardTitle>
          <p className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
            {t('share.require_a_passcode_to_view_this_note')}
          </p>
        </div>
        <Switch
          checked={usePasscode}
          disabled={disabled}
          onChange={onToggle}
          label={t('common.access_passcode')}
        />
      </div>
      {usePasscode && (
        <div className="pt-3">
          <Field
            label={t('share.passcode')}
            // The hint states the same number the client pre-check and the worker both enforce, so a
            // reader is never told one minimum and refused at another.
            hint={[
              t('share.editor_passcode_min', { min: minLength }),
              alreadyProtected ? t('share.leave_blank_to_keep_the_current_passcode') : '',
            ].filter(Boolean).join(' ')}
          >
            <Input
              type="password"
              value={passcode}
              disabled={disabled}
              maxLength={LIMITS.passwordMaxLength}
              autoComplete="new-password"
              placeholder={alreadyProtected ? t('share.unchanged') : t('share.set_a_passcode')}
              onChange={(event) => onChange(event.target.value)}
            />
          </Field>
        </div>
      )}
    </Card>
  );
}

export function ExpirySection(props: {
  expiry: string;
  hasExpiry: boolean;
  disabled: boolean;
  onChange: (expiry: string) => void;
}) {
  const { expiry, hasExpiry, disabled, onChange } = props;
  return (
    <Field label={t('share.expiration')}>
      <Segmented
        value={expiry}
        disabled={disabled}
        onChange={onChange}
        className="flex-wrap"
        options={[
          ...(hasExpiry ? [{ value: KEEP_CURRENT_EXPIRY, label: t('share.keep_current_expiration') }] : []),
          ...EXPIRY_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) })),
        ]}
      />
    </Field>
  );
}

export function EditFooter(props: {
  hasShare: boolean;
  busy: 'save' | 'revoke' | null;
  onSave: () => void;
  onRevoke: () => void;
  onClose: () => void;
}) {
  const { hasShare, busy, onSave, onRevoke, onClose } = props;
  if (!hasShare) {
    return (
      <>
        <Button variant="ghost" disabled={busy !== null} onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          loading={busy === 'save'}
          disabled={busy !== null}
          onClick={onSave}
        >
          {t('share.generate_public_link')}
        </Button>
      </>
    );
  }
  return (
    <>
      <Button
        variant="ghost"
        className="mr-auto text-[var(--danger)]"
        icon={<Trash2 size={13}/>}
        loading={busy === 'revoke'}
        disabled={busy === 'save'}
        onClick={onRevoke}
      >
        {t('share.revoke_link')}
      </Button>
      <Button variant="secondary" disabled={busy !== null} onClick={onClose}>{t('share.done')}</Button>
      <Button variant="primary" loading={busy === 'save'} disabled={busy === 'revoke'} onClick={onSave}>
        {t('share.update_settings')}
      </Button>
    </>
  );
}
