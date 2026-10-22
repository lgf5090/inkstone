import { Globe } from 'lucide-react';
import { Modal } from '../../../components/overlay';
import { Button } from '../../../components/primitives';
import { Empty, LoadingBlock } from '../../../components/feedback';
import { t } from '../../../lib/i18n';
import { useShareEditModal } from './use-edit-modal';
import { ShareQrModal } from './qr-modal';
import {
  EditFooter,
  ExpirySection,
  FolderSection,
  LinkSection,
  PasscodeSection,
  StatusSection,
  TagSection,
} from './sections';

const MODAL_WIDTH = 520;

export interface ShareEditModalProps {
  noteId: string;
  noteTitle: string;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * One public link, edited: its address, whether it answers readers, who may open it, until when, and
 * where it is filed in the hub.
 *
 * It is the single-note panel's behaviour widened to the hub's filing fields, and it reads and writes
 * the link through the note id it was handed. The shell that opens it does not have to know whether
 * the hub's list had arrived yet.
 */
export function ShareEditModal({ noteId, noteTitle, onClose, onSaved }: ShareEditModalProps) {
  const b = useShareEditModal({ noteId, onSaved, onClose });
  const hasShare = Boolean(b.share);
  return (
    <>
      <Modal
        open
        onClose={onClose}
        // A save in flight is not a dismissal away from being lost: Escape, the backdrop and the close
        // button stand down until the writes answer.
        dismissible={b.busy === null}
        title={(
          <span className="flex items-center gap-1.5">
            <Globe size={15} className="text-[var(--accent)]"/>
            {hasShare ? t('share.editor_title') : t('share.share_note')}
          </span>
        )}
        description={noteTitle || t('common.untitled_note')}
        width={MODAL_WIDTH}
        footer={(
          <EditFooter
            hasShare={hasShare}
            busy={b.busy}
            onSave={() => void b.save()}
            onRevoke={() => void b.revoke()}
            onClose={onClose}
          />
        )}
      >
        {b.loadError ? (
          <Empty
            art="notes"
            compact
            title={t('share.could_not_load_sharing_status')}
            description={b.loadError}
            action={(
              <Button size="sm" variant="secondary" onClick={b.retryLoad}>
                {t('common.retry')}
              </Button>
            )}
          />
        ) : b.share === undefined ? (
          <LoadingBlock label={t('share.loading_share_status')}/>
        ) : (
          <div className="space-y-3.5 py-1">
            {b.share && (
              <LinkSection
                url={b.share.url}
                copied={b.copied}
                isPaused={b.share.isEnabled === false}
                isExpired={Boolean(b.share.expiresAt && b.share.expiresAt < Date.now())}
                onCopy={() => void b.copy()}
                onOpenQr={() => b.setIsQrOpen(true)}
              />
            )}
            {b.share && (
              <StatusSection
                enabled={b.enabled}
                disabled={b.busy !== null}
                onChange={b.setEnabled}
              />
            )}
            {b.organizerError && (
              <div className="flex items-center justify-between gap-3 rounded-[var(--r-md)] bg-[var(--danger-soft)] px-3 py-2 text-[length:var(--text-11-5)] text-[var(--danger)]">
                {/* Names the two pickers that came up empty rather than the save as a whole: their
                    lists are what is missing, and the access controls beside them still work. */}
                <span>{t('share.editor_organizers_failed')} {b.organizerError}</span>
                <Button size="sm" variant="secondary" onClick={b.retryLoad}>
                  {t('common.retry')}
                </Button>
              </div>
            )}
            <FolderSection
              folders={b.folders}
              folderId={b.folderId}
              disabled={b.busy !== null}
              onChange={b.setFolderId}
            />
            <TagSection
              options={b.tagOptions}
              selected={b.selectedTags}
              newTag={b.newTag}
              disabled={b.busy !== null}
              tagMax={b.tagMaxPerShare}
              onNewTagChange={b.setNewTag}
              onAddTag={b.addTag}
              onToggle={b.toggleTag}
            />
            <PasscodeSection
              usePasscode={b.usePasscode}
              alreadyProtected={Boolean(b.share?.hasPassword)}
              passcode={b.passcode}
              disabled={b.busy !== null}
              minLength={b.passcodeMinLength}
              onToggle={b.setUsePasscode}
              onChange={b.setPasscode}
            />
            <ExpirySection
              expiry={b.expiry}
              hasExpiry={Boolean(b.share?.expiresAt)}
              disabled={b.busy !== null}
              onChange={b.setExpiry}
            />
            <p className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-3 py-2.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
              {t('share.public_links_are_read_only_visitors_can_see_only_the_latest_version_of_t')}
            </p>
          </div>
        )}
      </Modal>

      {b.isQrOpen && b.share && (
        <ShareQrModal url={b.share.url} title={noteTitle} onClose={() => b.setIsQrOpen(false)}/>
      )}
    </>
  );
}
