import { useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Hash, Palette, Pin, X } from 'lucide-react';
import type { Tag } from '@shared/types';
import { cn } from '../../lib/cn';
import { splitByRanges } from '../../lib/fuzzy';
import { compileQuery, queryMatches, type Query } from '../../lib/query-match';
import { FilterInput } from '../../components/FilterInput';
import { buildTagTree, flattenTagTree, renameTagSegment } from '../../lib/tag-tree';
import { Menu, Modal } from '../../components/overlay';
import { commitOnEnter } from '../../components/form';
import { useNotes } from '../../store/notes';
import { t } from '../../lib/i18n';
import { deleteTag, renameTag, setTagColor, setTagPinned } from './tagMutations';
import { TagColorMenu } from './TagAppearanceMenus';
import { usePinyinVersion } from '../../lib/pinyin'

export function ManageTagsModal({ open, onClose }: {
    open: boolean;
    onClose: () => void;
}) {
    const tags = useNotes((s) => s.tags);
    const [query, setQuery] = useState('');
    const [merging, setMerging] = useState<Tag | null>(null);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [colorFor, setColorFor] = useState<string | null>(null);
    const colorAnchor = useRef<HTMLSpanElement>(null);
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
    const pinyinVersion = usePinyinVersion()
    const filter = useMemo(() => compileQuery(query), [query]);
    const visible = useMemo(
        () => rows.filter((node) => queryMatches(filter, node.fullPath)),
        [rows, filter, pinyinVersion],
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
          <FilterInput value={query} onChange={setQuery} query={filter} label={t('tags.filter')} placeholder={t('tags.filter_placeholder')} size="panel"/>
          <p className="px-1 text-[11px] tabular text-[var(--text-quaternary)]">{t('tags.match_count', { value0: visible.filter((node) => !node.isVirtual).length })}</p>
          <div className="max-h-[52vh] overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
            {!visible.length && <p className="px-3 py-6 text-center text-[12px] text-[var(--text-quaternary)]">{t('tags.no_match')}</p>}
            {visible.map((node) => (<div key={node.fullPath} className="relative flex h-11 items-center gap-2 border-b border-[var(--border-subtle)] px-2 last:border-b-0" style={{ paddingLeft: 8 + node.depth * 13 }}>
                {colorFor === node.tag.id && <span ref={colorAnchor} aria-hidden="true" className="absolute top-0 right-8 size-px"/>}
                <Hash size={13} className="shrink-0" style={{ color: node.tag.color ?? 'var(--text-quaternary)' }}/>
                {node.isPinned && <Pin size={10} className="shrink-0 text-[var(--text-quaternary)]"/>}
                {renamingId === node.tag.id ? (<TagRenameInput initial={node.name} onCancel={() => setRenamingId(null)} onCommit={(value) => {
                            setRenamingId(null);
                            void renameTag(node.tag, renameTagSegment(node.fullPath, value));
                        }}/>) : (<button type="button" onClick={() => {
                            if (merging) {
                                if (!node.isVirtual)
                                    pickMergeTarget(node.tag);
                                return;
                            }
                            if (!node.isVirtual)
                                setRenamingId(node.tag.id);
                        }} className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium text-[var(--text-primary)] hover:text-[var(--accent)]">
                      <ManagedTagName name={node.name} query={filter}/>
                    </button>)}
                <span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)]">{node.children.length ? node.totalCount : node.count || ''}</span>
                {!node.isVirtual && !merging && (<div className="flex shrink-0 items-center gap-px">
                    <button type="button" aria-label={t('tags.pin')} aria-pressed={Boolean(node.tag.isPinned)} onClick={() => void setTagPinned(node.tag, !node.tag.isPinned)} className={cn('flex size-7 items-center justify-center rounded text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)]', node.tag.isPinned && 'text-[var(--accent)]')}>
                      <Pin size={12}/>
                    </button>
                    <button type="button" aria-label={t('tags.color')} aria-expanded={colorFor === node.tag.id} onClick={(event) => {
                        event.stopPropagation();
                        setColorFor(colorFor === node.tag.id ? null : node.tag.id);
                    }} className="flex size-7 items-center justify-center rounded text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)]">
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
      <Menu anchor={colorAnchor} open={colorTag !== null} onClose={() => setColorFor(null)} items={[{
            id: 'color', label: t('tags.color'), submenu: (<TagColorMenu color={colorTag?.color} onSelectColor={(color) => {
                if (colorTag)
                    void setTagColor(colorTag, color);
                setColorFor(null);
            }}/>),
        }]}/>
    </>);
}
function ManagedTagName({ name, query }: {
    name: string;
    query: Query;
}) {
    const match = queryMatches(query, name);
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
            commitOnEnter(event, commit);
            if (event.key === 'Escape') {
                done.current = true;
                onCancel();
            }
            event.stopPropagation();
        }} className="min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-px text-[12.5px] outline-none"/>);
}
