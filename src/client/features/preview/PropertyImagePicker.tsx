import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Loader2, Upload } from 'lucide-react';
import type { AttachmentWithUsage } from '@shared/types';
import { parsePropertyImage } from '@shared/property-decorations';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fuzzyFilter } from '../../lib/fuzzy';
import { t } from '../../lib/i18n';
import { usePinyinVersion } from '../../lib/pinyin';
import { forgetPropertyImages } from '../../lib/property-images';
import { Input, commitOnEnter } from '../../components/form';
import { Modal } from '../../components/overlay';
import { useUi } from '../../store/ui';

const RESULT_LIMIT = 120;

export interface ImagePickerRequest {
    property: string;
    kind: 'cover' | 'banner' | 'icon';
}

export function PropertyImagePicker({ request, noteId, onClose, onPick }: {
    request: ImagePickerRequest | null;
    noteId: string | null;
    onClose: () => void;
    onPick: (property: string, value: string) => void;
}) {
    const toast = useUi(state => state.toast);
    const pinyinVersion = usePinyinVersion();
    const [files, setFiles] = useState<AttachmentWithUsage[] | null>(null);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [link, setLink] = useState('');
    const [linkRejected, setLinkRejected] = useState(false);
    const [busy, setBusy] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const epoch = useRef(0);
    const loadPage = useCallback(async (cursor: string | undefined, stamp: number) => {
        try {
            const result = await api.files.list(cursor);
            if (stamp !== epoch.current)
                return;
            setFiles(previous => {
                if (!cursor)
                    return result.files;
                const seen = new Set((previous ?? []).map(file => file.id));
                return [...(previous ?? []), ...result.files.filter(file => !seen.has(file.id))];
            });
            setNextCursor(result.nextCursor ?? null);
        }
        catch {
            if (stamp === epoch.current)
                setFiles(current => current ?? []);
        }
    }, []);
    useEffect(() => {
        if (!request) {
            epoch.current += 1;
            setFiles(null);
            setQuery('');
            setLink('');
            setLinkRejected(false);
            return;
        }
        const stamp = ++epoch.current;
        void loadPage(undefined, stamp);
    }, [request, loadPage]);
    const images = useMemo(() => (files ?? []).filter(file => file.mime.startsWith('image/')), [files]);
    const shown = useMemo(() => {
        const trimmed = query.trim();
        if (!trimmed)
            return images.slice(0, RESULT_LIMIT);
        return fuzzyFilter(images, trimmed, file => file.filename, RESULT_LIMIT).map(entry => entry.item);
    }, [images, query, pinyinVersion]);
    const choose = (value: string) => {
        if (!request)
            return;
        onPick(request.property, value);
        onClose();
    };
    const upload = async (file: File) => {
        setBusy(true);
        try {
            const saved = await api.files.upload(file, noteId ?? undefined);
            forgetPropertyImages();
            choose(`[[${saved.filename}]]`);
        }
        catch (error) {
            toast({
                title: t('attachments.upload_failed'),
                description: error instanceof Error ? error.message : String(error),
                tone: 'danger',
            });
        }
        finally {
            setBusy(false);
        }
    };
    const offerLink = () => {
        const value = link.trim();
        if (!value || !parsePropertyImage(value)) {
            setLinkRejected(true);
            return;
        }
        setLinkRejected(false);
        choose(value);
    };
    return (<Modal open={request !== null} onClose={onClose} title={t('properties.image_title')} description={t('properties.image_hint')} width={620}>
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex items-center gap-2">
          <Input aria-label={t('properties.image_search')} value={query} placeholder={t('properties.image_search')} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1"/>
          <button type="button" onClick={() => fileInput.current?.click()} disabled={busy} className="flex shrink-0 items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50">
            {busy ? <Loader2 size={13} className="animate-spin"/> : <Upload size={13}/>}
            <span>{t('properties.image_upload')}</span>
          </button>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file)
                    void upload(file);
            }}/>
        </div>
        {files === null
            ? <p className="py-6 text-center text-[12.5px] text-[var(--text-quaternary)]">{t('properties.image_loading')}</p>
            : images.length === 0
                ? <p className="py-6 text-center text-[12.5px] text-[var(--text-quaternary)]">{t('properties.image_none')}</p>
                : shown.length === 0
                    ? <p className="py-6 text-center text-[12.5px] text-[var(--text-quaternary)]">{t('properties.image_no_match')}</p>
                    : (<div role="group" aria-label={t('properties.image_library')} className="grid max-h-64 grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2 overflow-y-auto p-0.5">
                        {shown.map(file => (<button key={file.id} type="button" title={file.filename} aria-label={file.filename} onClick={() => choose(`[[${file.filename}]]`)} className={cn('flex aspect-3/2 min-w-0 flex-col overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] transition-shadow hover:ring-2 hover:ring-[var(--accent-ring)]')}>
                              <img src={file.url} alt="" loading="lazy" decoding="async" className="size-full object-contain"/>
                              <span className="truncate px-1 pb-1 text-[10.5px] text-[var(--text-tertiary)]">{file.filename}</span>
                            </button>))}
                      </div>)}
        {nextCursor && files !== null && (<button type="button" onClick={() => void loadPage(nextCursor ?? undefined, epoch.current)} className="self-start rounded-[var(--r-sm)] px-2 py-1 text-[12px] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]">
            {t('properties.image_more')}
          </button>)}
        <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
          <Link2 size={13} className="shrink-0 text-[var(--text-quaternary)]"/>
          <Input aria-label={t('properties.image_link')} value={link} placeholder={t('properties.image_link_placeholder')} onChange={(event) => {
                setLink(event.target.value);
                setLinkRejected(false);
            }} onKeyDown={event => commitOnEnter(event, offerLink)} className={cn('min-w-0 flex-1', linkRejected && 'border-[var(--danger)]')}/>
          <button type="button" onClick={offerLink} className="shrink-0 rounded-[var(--r-sm)] bg-[var(--accent)] px-2.5 py-1.5 text-[12.5px] font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)]">
            {t('properties.image_use_link')}
          </button>
        </div>
        <p className={cn('text-[11.5px]', linkRejected ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]')}>
          {linkRejected ? t('properties.image_link_invalid') : t('properties.image_link_hint')}
        </p>
      </div>
    </Modal>);
}
