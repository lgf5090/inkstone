import { useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Hash, Palette, Pin, Search, X } from 'lucide-react';
import { ORGANIZER_COLORS } from '@shared/organizer-colors';
import type { Tag } from '@shared/types';
import { cn } from '../../lib/cn';
import { fuzzyMatch, splitByRanges } from '../../lib/fuzzy';
import { buildTagTree, flattenTagTree } from '../../lib/tag-tree';
import { Modal } from '../../components/overlay';
import { useNotes } from '../../store/notes';
import { t } from '../../lib/i18n';
import { deleteTag, renameTag, setTagColor, setTagPinned } from './tagMutations';

export function ManageTagsModal({ open, onClose }: {
    open: boolean;
    onClose: () => void;
}) {
    const tags = useNotes((s) => s.tags);
    const [query, setQuery] = useState('');
    const [merging, setMerging] = useState<Tag | null>(null);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [colorFor, setColorFor] = useState<string | null>(null);
    const rows = useMemo(() => {
        const tree = buildTagTree(tags);
        const expanded = new Set<string>();
        for (const tag of tags) {
            const parts = tag.name.split('/');
            for (let depth = 1; depth < parts.length; depth++)
                expanded.add(parts.slice(0, depth).join('/'));
        }
        return flattenTagTree(tree, expanded);
    }, [tags]);
    const visible = useMemo(
        () => query.trim() ? rows.filter((node) => fuzzyMatch(node.fullPath, query)) : rows,
        [rows, query],
    );
    const colorTag: Tag | null = colorFor ? tags.find((tag) => tag.id === colorFor) ?? null : null;
    const pickMergeTarget = (node: Tag) => {
        if (!merging)
            return;
        void renameTag(merging, node.name);
        setMerging(null);
    };
    return (<>
      <Modal open={open} onClose={onClose} title={t('tags.manage')} width={620}>
        <div className="space-y-2 p-4">
          {merging && (<div className="flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--accent-soft)] px-3 py-2 text-[12px] text-[var(--text-primary)]">
              <ArrowLeftRight size={13} className="shrink-0"/>
              <span className="min-w-0 flex-1 truncate">{t('tags.merge_target_value0', { value0: merging.name })}</span>
              <button type="button" onClick={() => setMerging(null)} className="shrink-0 text-[var(--accent)] hover:underline">{t('common.cancel')}</button>
            </div>)}
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-quaternary)]"/>
            <input aria-label={t('tags.filter')} type="search" value={query} placeholder={t('tags.filter_placeholder')} onChange={(event) => setQuery(event.target.value)} className="h-9 w-full rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] pr-3 pl-8 text-[12.5px] outline-none focus:border-[var(--accent)]"/>
          </div>
          <p className="px-1 text-[11px] tabular text-[var(--text-quaternary)]">{t('tags.match_count', { value0: visible.filter((node) => !node.isVirtual).length })}</p>
          <div className="max-h-[52vh] overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
            {!visible.length && <p className="px-3 py-6 text-center text-[12px] text-[var(--text-quaternary)]">{t('tags.no_match')}</p>}
            {visible.map((node) => (<div key={node.fullPath} className="flex h-11 items-center gap-2 border-b border-[var(--border-subtle)] px-2 last:border-b-0" style={{ paddingLeft: 8 + node.depth * 13 }}>
                <Hash size={13} className="shrink-0" style={{ color: node.tag.color ?? 'var(--text-quaternary)' }}/>
                {node.isPinned && <Pin size={10} className="shrink-0 text-[var(--text-quaternary)]"/>}
                {renamingId === node.tag.id ? (<TagRenameInput initial={node.name} onCancel={() => setRenamingId(null)} onCommit={(value) => {
                            setRenamingId(null);
                            void renameTag(node.tag, value);
                        }}/>) : (<button type="button" onClick={() => {
                            if (merging) {
                                if (!node.isVirtual)
                                    pickMergeTarget(node.tag);
                                return;
                            }
                            if (!node.isVirtual)
                                setRenamingId(node.tag.id);
                        }} className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium text-[var(--text-primary)] hover:text-[var(--accent)]">
                      <ManagedTagName name={node.name} query={query}/>
                    </button>)}
                <span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)]">{node.children.length ? node.totalCount : node.count || ''}</span>
                {!node.isVirtual && !merging && (<div className="flex shrink-0 items-center gap-px">
                    <button type="button" aria-label={t('tags.pin')} aria-pressed={Boolean(node.tag.isPinned)} onClick={() => void setTagPinned(node.tag, !node.tag.isPinned)} className={cn('flex size-7 items-center justify-center rounded text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)]', node.tag.isPinned && 'text-[var(--accent)]')}>
                      <Pin size={12}/>
                    </button>
                    <button type="button" aria-label={t('tags.color')} onClick={() => setColorFor(node.tag.id)} className="flex size-7 items-center justify-center rounded text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)]">
                      <Palette size={12}/>
                    </button>
                    <button type="button" aria-label={t('tags.merge')} onClick={() => setMerging(node.tag)} className="flex size-7 items-center justify-center rounded text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)]">
                      <ArrowLeftRight size={12}/>
                    </button>
                    <button type="button" aria-label={t('tags.delete')} onClick={() => void deleteTag(node.tag)} className="flex size-7 items-center justify-center rounded text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]">
                      <X size={12}/>
                    </button>
                  </div>)}
              </div>))}
          </div>
          {merging && <p className="px-1 text-[11px] text-[var(--text-quaternary)]">{t('tags.merge_hint')}</p>}
        </div>
      </Modal>
      <Modal open={colorTag !== null} onClose={() => setColorFor(null)} title={t('tags.color')} width={340}>
        <div className="flex flex-wrap items-center gap-2 p-4">
          <button type="button" aria-label={t('tags.clear_color')} aria-pressed={!colorTag?.color} onClick={() => {
                if (colorTag)
                    void setTagColor(colorTag, null);
                setColorFor(null);
            }} className={cn('flex size-9 items-center justify-center rounded-full border bg-[var(--bg-base)] text-[var(--text-quaternary)]', !colorTag?.color ? 'border-[var(--accent)] ring-2 ring-[var(--accent-ring)]' : 'border-[var(--border-default)]')}>
            <Hash size={14}/>
          </button>
          {ORGANIZER_COLORS.map((color) => (<button key={color} type="button" aria-label={color} aria-pressed={colorTag?.color === color} onClick={() => {
                    if (colorTag)
                        void setTagColor(colorTag, color);
                    setColorFor(null);
                }} className={cn('size-9 rounded-full transition-transform hover:scale-105', colorTag?.color === color && 'ring-2 ring-[var(--accent-ring)] ring-offset-2 ring-offset-[var(--bg-surface)]')} style={{ backgroundColor: color }}/>))}
        </div>
      </Modal>
    </>);
}
function ManagedTagName({ name, query }: {
    name: string;
    query: string;
}) {
    const match = query.trim() ? fuzzyMatch(name, query) : null;
    if (!match)
        return name;
    return splitByRanges(name, match.ranges).map((part, index) => part.hit
        ? <span key={index} className="font-semibold text-[var(--accent)]">{part.text}</span>
        : <span key={index}>{part.text}</span>);
}
function TagRenameInput({ initial, onCommit, onCancel }: {
    initial: string;
    onCommit: (value: string) => void;
    onCancel: () => void;
}) {
    const [value, setValue] = useState(initial);
    const done = useRef(false);
    const commit = () => {
        if (done.current)
            return;
        done.current = true;
        onCommit(value);
    };
    return (<input aria-label={t('tags.rename')} autoFocus value={value} onChange={(event) => setValue(event.target.value)} onBlur={commit} onKeyDown={(event) => {
            if (event.key === 'Enter')
                commit();
            if (event.key === 'Escape') {
                done.current = true;
                onCancel();
            }
            event.stopPropagation();
        }} className="min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-px text-[12.5px] outline-none"/>);
}
