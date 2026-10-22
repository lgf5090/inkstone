import { useEffect, useRef, useState } from 'react';
import { LIMITS } from '@shared/constants';
import type { ShareFolder, ShareTag } from '@shared/share-hub';
import { sharePasscodeProblem } from '@shared/share-passcode';
import type { ShareInfo } from '@shared/types';
import { confirm } from '../../../components/overlay';
import { api, ApiError } from '../../../lib/api';
import { shareHubApi } from '../../../lib/api-share-hub';
import { copyText } from '../../../lib/clipboard';
import { t } from '../../../lib/i18n';
import { COPY_RESET_MS } from '../../../lib/motion';
import { useUi } from '../../../store/ui';
import { expiresInForSelection, KEEP_CURRENT_EXPIRY, needsNewSharePasscode } from '../share-form';

/** What the server last agreed to for this link, so a save writes only what the reader changed. */
interface AppliedState {
  folderId: string | null;
  tags: string[];
  enabled: boolean;
}

const EMPTY_APPLIED: AppliedState = { folderId: null, tags: [], enabled: true };

/** Tag order is not a property of a filing, so two lists match when they hold the same names. */
export function sameShareTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((tag, index) => tag === sorted[index]);
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

export interface ShareEditModalOptions {
  noteId: string;
  onSaved?: () => void;
  onClose: () => void;
}

/**
 * The per-link editor's state and its writes.
 *
 * The link is fetched by `noteId` rather than read out of a list the hub may not have finished: the
 * ported version opened only for a note whose row had already arrived, so asking to edit a link while
 * the list was still loading dropped the request without a word.
 *
 * Every write is guarded by two epochs plus the note it was made for. `loadEpoch` is bumped by a
 * mutation so a read still in flight cannot land on top of the answer that mutation just returned,
 * and `noteIdRef` discards either one once the editor has moved to a different note.
 */
export function useShareEditModal({ noteId, onSaved, onClose }: ShareEditModalOptions) {
  const toast = useUi((s) => s.toast);
  const [share, setShare] = useState<ShareInfo | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [folders, setFolders] = useState<ShareFolder[]>([]);
  const [tagRegistry, setTagRegistry] = useState<ShareTag[]>([]);
  const [organizerError, setOrganizerError] = useState<string | null>(null);
  const [usePasscode, setUsePasscode] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [expiry, setExpiry] = useState('0');
  const [enabled, setEnabled] = useState(true);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [busy, setBusy] = useState<'save' | 'revoke' | null>(null);
  const [copied, setCopied] = useState(false);
  const [isQrOpen, setIsQrOpen] = useState(false);
  const copiedTimer = useRef(0);
  const busyRef = useRef<'save' | 'revoke' | null>(null);
  const loadEpoch = useRef(0);
  const mutationEpoch = useRef(0);
  const noteIdRef = useRef(noteId);
  const applied = useRef<AppliedState>(EMPTY_APPLIED);
  noteIdRef.current = noteId;

  useEffect(() => {
    const epoch = ++loadEpoch.current;
    mutationEpoch.current++;
    busyRef.current = null;
    setBusy(null);
    const controller = new AbortController();
    let cancelled = false;
    const isStale = () => cancelled || loadEpoch.current !== epoch || noteIdRef.current !== noteId;
    setShare(undefined);
    setLoadError(null);
    setOrganizerError(null);
    setUsePasscode(false);
    setPasscode('');
    setExpiry('0');
    setEnabled(true);
    setFolderId(null);
    setSelectedTags([]);
    setNewTag('');
    setCopied(false);
    setIsQrOpen(false);
    applied.current = EMPTY_APPLIED;
    window.clearTimeout(copiedTimer.current);
    void api.share.get(noteId, controller.signal).then((res) => {
      if (isStale()) return;
      const next = res.share;
      setShare(next);
      setUsePasscode(Boolean(next?.hasPassword));
      setExpiry(next?.expiresAt ? KEEP_CURRENT_EXPIRY : '0');
      setEnabled(next?.isEnabled ?? true);
      setFolderId(next?.folderId ?? null);
      setSelectedTags(next?.tags ?? []);
      applied.current = {
        folderId: next?.folderId ?? null,
        tags: next?.tags ?? [],
        enabled: next?.isEnabled ?? true,
      };
    }).catch((err) => {
      if (!isStale()) setLoadError(errorText(err));
    });
    // Folders and tags are reads the pickers want and the link itself does not depend on: a failure
    // leaves the access controls usable and names the half that is missing, instead of refusing to
    // open the editor at all.
    void Promise.all([
      shareHubApi.folders.list(controller.signal),
      shareHubApi.tags.list(controller.signal),
    ]).then(([foldersRes, tagsRes]) => {
      if (isStale()) return;
      setFolders(foldersRes.folders);
      setTagRegistry(tagsRes.tags);
    }).catch((err) => {
      if (!isStale()) setOrganizerError(errorText(err));
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [noteId, reload]);

  useEffect(() => () => {
    noteIdRef.current = '';
    loadEpoch.current++;
    mutationEpoch.current++;
    busyRef.current = null;
    window.clearTimeout(copiedTimer.current);
  }, []);

  async function copy() {
    if (!share) return;
    const targetNote = noteIdRef.current;
    if (!(await copyText(share.url))) {
      toast({ title: t('preview.could_not_copy'), tone: 'danger' });
      return;
    }
    // The clipboard is slower than a reader who switches notes, and a tick marking the new note's
    // link as copied says something false about the one they are no longer looking at.
    if (noteIdRef.current !== targetNote) return;
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), COPY_RESET_MS);
  }

  /** The registry's names, plus any this link already carries, so a selection is never invisible. */
  const tagOptions = (() => {
    const names = tagRegistry.map((tag) => tag.name);
    return [...names, ...selectedTags.filter((tag) => !names.includes(tag))];
  })();

  function appendTag(name: string) {
    if (selectedTags.includes(name)) return;
    if (selectedTags.length >= LIMITS.shareTagsMaxPerShare) {
      toast({ title: t('share.editor_tag_limit', { max: LIMITS.shareTagsMaxPerShare }), tone: 'danger' });
      return;
    }
    setSelectedTags([...selectedTags, name]);
  }

  function toggleTag(name: string, checked: boolean) {
    if (checked) appendTag(name);
    else setSelectedTags(selectedTags.filter((tag) => tag !== name));
  }

  function addTag() {
    const name = newTag.trim().slice(0, LIMITS.tagNameMaxLength);
    if (!name) return;
    appendTag(name);
    setNewTag('');
  }

  function removeTag(name: string) {
    setSelectedTags(selectedTags.filter((tag) => tag !== name));
  }

  /** The client-side half of the passcode ladder, answered by the same rule the worker uses. */
  function passcodeRefusal(): { title: string; description?: string } | null {
    if (!usePasscode) return null;
    if (passcode.length > 0 && sharePasscodeProblem(passcode) !== null) {
      return {
        title: t('share.passcode_too_short'),
        description: t('share.editor_passcode_min', { min: LIMITS.sharePasscodeMinLength }),
      };
    }
    if (needsNewSharePasscode(true, Boolean(share?.hasPassword), passcode)) {
      return { title: t('share.enter_a_passcode') };
    }
    return null;
  }

  async function save() {
    if (busyRef.current || share === undefined || loadError) return;
    const refusal = passcodeRefusal();
    if (refusal) {
      toast({ ...refusal, tone: 'danger' });
      return;
    }
    if (selectedTags.length > LIMITS.shareTagsMaxPerShare) {
      toast({ title: t('share.editor_tag_limit', { max: LIMITS.shareTagsMaxPerShare }), tone: 'danger' });
      return;
    }
    const targetNote = noteId;
    const epoch = ++mutationEpoch.current;
    loadEpoch.current++;
    const wasShared = Boolean(share);
    const filingChanged = applied.current.folderId !== folderId
      || !sameShareTags(applied.current.tags, selectedTags)
      || applied.current.enabled !== enabled;
    busyRef.current = 'save';
    setBusy('save');
    const isStale = () => mutationEpoch.current !== epoch || noteIdRef.current !== targetNote;
    const notSaved: string[] = [];
    try {
      const res = await shareHubApi.create(targetNote, {
        password: usePasscode ? passcode || undefined : null,
        expiresIn: expiresInForSelection(expiry),
      });
      if (isStale()) return;
      const next = res.share;
      setShare(next);
      setUsePasscode(Boolean(next.hasPassword));
      setPasscode('');
      setExpiry(next.expiresAt ? KEEP_CURRENT_EXPIRY : '0');
      applied.current = { ...applied.current, enabled: next.isEnabled };
      if (filingChanged) {
        // Filing and status are writes the API keeps separate; a failure says which half did not land
        // instead of reporting the whole save as one undifferentiated no.
        try {
          if (applied.current.folderId !== folderId || !sameShareTags(applied.current.tags, selectedTags)) {
            const filed = await shareHubApi.organize(targetNote, { folderId, tags: selectedTags });
            if (isStale()) return;
            applied.current = { ...applied.current, folderId: filed.filing.folderId, tags: filed.filing.tags };
          }
        }
        catch (err) {
          notSaved.push(`${t('share.editor_filing_not_saved')} ${errorText(err)}`);
        }
        try {
          if (applied.current.enabled !== enabled) {
            const moved = await shareHubApi.batch.setEnabled([targetNote], enabled);
            if (isStale()) return;
            // The count is the server's own report of what moved: one id asked for, one applied. Any
            // other answer is repeated as it came rather than rounded up into a success.
            if (moved.count !== 1) notSaved.push(`${t('share.editor_status_not_saved')} ${t('share.editor_status_count', { count: moved.count })}`);
            else applied.current = { ...applied.current, enabled };
          }
        }
        catch (err) {
          notSaved.push(`${t('share.editor_status_not_saved')} ${errorText(err)}`);
        }
      }
      if (notSaved.length > 0) {
        // Stay open: what failed is on screen and can be tried again, and closing would say the save
        // was finished while half of it was not.
        toast({ title: t('share.editor_partial_save'), description: notSaved.join(' '), tone: 'danger' });
        onSaved?.();
        return;
      }
      toast({
        title: wasShared ? t('share.sharing_settings_updated') : t('share.public_link_created'),
        tone: 'success',
      });
      onSaved?.();
      onClose();
    }
    catch (err) {
      if (isStale()) return;
      toast({ title: t('common.action_failed'), description: errorText(err), tone: 'danger' });
    }
    finally {
      if (!isStale()) {
        busyRef.current = null;
        setBusy(null);
      }
    }
  }

  async function revoke() {
    if (busyRef.current) return;
    const targetNote = noteId;
    const epoch = ++mutationEpoch.current;
    loadEpoch.current++;
    busyRef.current = 'revoke';
    setBusy('revoke');
    const isStale = () => mutationEpoch.current !== epoch || noteIdRef.current !== targetNote;
    try {
      const ok = await confirm({
        title: t('share.revoke_this_public_link'),
        description: t('share.anyone_who_gets_the_link_will_immediately_lose_access'),
        confirmLabel: t('share.revoke_link'),
        tone: 'danger',
      });
      if (isStale() || !ok) return;
      await shareHubApi.remove(targetNote);
      if (isStale()) return;
      setShare(null);
      applied.current = EMPTY_APPLIED;
      setUsePasscode(false);
      setPasscode('');
      setExpiry('0');
      setEnabled(true);
      setFolderId(null);
      setSelectedTags([]);
      toast({ title: t('share.link_revoked') });
      onSaved?.();
      onClose();
    }
    catch (err) {
      if (isStale()) return;
      toast({ title: t('common.action_failed'), description: errorText(err), tone: 'danger' });
    }
    finally {
      if (!isStale()) {
        busyRef.current = null;
        setBusy(null);
      }
    }
  }

  return {
    share,
    loadError,
    retryLoad: () => setReload((value) => value + 1),
    organizerError,
    folders,
    tagOptions,
    selectedTags,
    newTag,
    setNewTag,
    addTag,
    toggleTag,
    removeTag,
    usePasscode,
    setUsePasscode,
    passcode,
    setPasscode,
    expiry,
    setExpiry,
    enabled,
    setEnabled,
    folderId,
    setFolderId,
    busy,
    copied,
    copy,
    isQrOpen,
    setIsQrOpen,
    save,
    revoke,
    passcodeMinLength: LIMITS.sharePasscodeMinLength,
    tagMaxPerShare: LIMITS.shareTagsMaxPerShare,
  };
}

export type ShareEditController = ReturnType<typeof useShareEditModal>;
