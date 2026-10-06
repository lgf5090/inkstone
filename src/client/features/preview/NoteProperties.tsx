import { useRef, useState } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import { deleteFrontMatterValue, parseFrontMatter, renameFrontMatterValue, replaceTagInContent, setFrontMatterValue } from '@shared/markdown-utils';
import type { FrontMatterValue } from '@shared/markdown-utils';
import { cn } from '../../lib/cn';
import { Tooltip } from '../../components/overlay';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { TagContextMenuAt, type TagMenuRequest } from '../tags/TagContextMenuAt';
import { t } from '../../lib/i18n';

export function NoteProperties({ noteId }: {
    noteId: string | null;
}) {
    const [collapsed, setCollapsed] = useState(false);
    const [adding, setAdding] = useState(false);
    // Read the live buffer rather than taking the rendered text as a prop: a debounced or
    // cached copy here would silently overwrite whatever was typed in the last few frames.
    const content = useNotes((s) => (noteId ? s.contents[noteId] ?? '' : ''));
    const parsed = parseFrontMatter(content);
    const editContent = useNotes((s) => s.editContent);
    const entries = Object.entries(parsed.data);
    const readOnly = parsed.errors.length > 0 || noteId === null;
    const write = (next: string) => {
        if (noteId && next !== content)
            editContent(noteId, next);
    };
    return (<section data-note-properties className="mb-4 overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <header className="flex h-9 items-center gap-2 border-b border-[var(--border-subtle)] px-2.5">
        <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] font-semibold text-[var(--text-secondary)]">
          <ChevronDown size={13} className={cn('shrink-0 transition-transform duration-[var(--dur-fast)]', collapsed && '-rotate-90')}/>
          <span className="truncate">{t('markdown.properties')}</span>
          <span className="shrink-0 tabular text-[var(--text-quaternary)]">{entries.length}</span>
        </button>
        {!collapsed && !readOnly && (<button type="button" onClick={() => setAdding(true)} aria-label={t('properties.add')} className="flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]">
            <Plus size={13}/>
          </button>)}
      </header>
      {!collapsed && (<div className="divide-y divide-[var(--border-subtle)]">
          {parsed.errors.length > 0 && <p className="px-3 py-2.5 text-[11.5px] text-[var(--danger)]">{t('properties.invalid')}</p>}
          {!entries.length && noteId !== null && !parsed.errors.length && <p className="px-3 py-2.5 text-[11.5px] text-[var(--text-quaternary)]">{t('properties.empty')}</p>}
          {entries.map(([key, value]) => (<PropertyRow key={key} propertyKey={key} value={value} readOnly={readOnly} onValue={(next) => write(setFrontMatterValue(content, key, next))} onRename={(to) => write(renameFrontMatterValue(content, key, to))} onDelete={() => write(deleteFrontMatterValue(content, key))} onTagRemove={(name) => write(replaceTagInContent(content, name, null))}/>))}
          {adding && !readOnly && (<AddPropertyRow used={new Set(entries.map(([entry]) => entry))} onCancel={() => setAdding(false)} onCommit={(key, value) => {
                    setAdding(false);
                    write(setFrontMatterValue(content, key, value));
                }}/>)}
        </div>)}
    </section>);
}
function PropertyRow({ propertyKey, value, readOnly, onValue, onRename, onDelete, onTagRemove, }: {
    propertyKey: string;
    value: unknown;
    readOnly: boolean;
    onValue: (next: FrontMatterValue) => void;
    onRename: (to: string) => void;
    onDelete: () => void;
    onTagRemove: (name: string) => void;
}) {
    const [renaming, setRenaming] = useState(false);
    const [editing, setEditing] = useState(false);
    const kind = describeValue(value, propertyKey);
    const names = kind === 'tags' || kind === 'array' ? (value as unknown[]).map((item) => String(item)) : [];
    return (<div className="group/row flex items-start gap-2 px-2.5 py-1.5">
      <div className="flex min-w-0 flex-1 items-start gap-1.5">
        <KindGlyph kind={kind}/>
        {renaming ? (<InlineInput aria-label={t('properties.rename')} initial={propertyKey} onCommit={(next) => {
                    setRenaming(false);
                    if (next.trim() && next.trim() !== propertyKey)
                        onRename(next.trim());
                }} onCancel={() => setRenaming(false)} className="min-w-0 flex-1"/>) : (<button type="button" disabled={readOnly} onClick={() => setRenaming(true)} className="shrink-0 rounded px-0.5 text-left text-[12px] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] disabled:hover:bg-transparent">
              {propertyKey}
            </button>)}
      </div>
      <div className="flex min-w-0 max-w-[62%] flex-1 items-center justify-end gap-1">
        {kind === 'other' ? (<span className="min-w-0 truncate text-right text-[12px] text-[var(--text-tertiary)]">{formatScalar(value)}</span>) : kind === 'boolean' ? (<button type="button" role="switch" aria-checked={Boolean(value)} disabled={readOnly} onClick={() => onValue(!value)} className={cn('relative h-4 w-8 shrink-0 rounded-full transition-colors', value ? 'bg-[var(--accent)]' : 'bg-[var(--bg-inset)] ring-1 ring-[var(--border-default)]')}>
              <span className={cn('absolute top-0.5 size-3 rounded-full bg-white shadow transition-all', value ? 'left-4' : 'left-0.5')}/>
            </button>) : kind === 'tags' || kind === 'array' ? (<TagValues names={names} asTags={kind === 'tags'} readOnly={readOnly} onRemove={onTagRemove} onAdd={(name) => onValue([...names, name])}/>) : editing ? (<InlineInput aria-label={propertyKey} initial={formatScalar(value)} onCommit={(text) => {
                setEditing(false);
                onValue(coerce(kind, text));
            }} onCancel={() => setEditing(false)} className="min-w-0 flex-1"/>) : (<button type="button" disabled={readOnly} onClick={() => setEditing(true)} className="min-w-0 truncate rounded px-1 py-0.5 text-right text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:hover:bg-transparent">
              {formatScalar(value) || t('properties.empty_value')}
            </button>)}
        {!readOnly && !editing && kind !== 'other' ? (<button type="button" aria-label={t('properties.delete')} onClick={onDelete} className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] opacity-0 transition-opacity hover:text-[var(--danger)] focus-visible:opacity-100 group-hover/row:opacity-100">
            <X size={11}/>
          </button>) : null}
      </div>
    </div>);
}
function TagValues({ names, asTags, readOnly, onRemove, onAdd }: {
    names: string[];
    asTags: boolean;
    readOnly: boolean;
    onRemove: (name: string) => void;
    onAdd: (name: string) => void;
}) {
    const [adding, setAdding] = useState(false);
    const [tagMenu, setTagMenu] = useState<TagMenuRequest | null>(null);
    const tags = useNotes((s) => s.tags);
    const openView = useUi((s) => s.openView);
    const colors = new Map(tags.map((tag) => [tag.name.toLocaleLowerCase(), tag.color]));
    const pills = (<span className="flex min-w-0 flex-wrap items-center justify-end gap-1">
      {names.map((name) => (<span key={name} className="flex max-w-full items-center rounded-[var(--r-sm)] bg-[var(--accent-soft)] text-[11.5px] text-[var(--text-primary)]">
            {asTags ? (<button type="button" onClick={() => openView('tag', { tag: name })} onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setTagMenu({ name, x: event.clientX, y: event.clientY });
              }} className="min-w-0 truncate py-0.5 pl-1.5 hover:underline">
                <span className="text-[var(--text-quaternary)]">#</span>
                <span style={{ color: colors.get(name.toLocaleLowerCase()) ?? undefined }}>{name}</span>
              </button>) : <span className="min-w-0 truncate py-0.5 pl-1.5">{name}</span>}
            {!readOnly && (<button type="button" aria-label={t('properties.remove_tag_value0', { value0: name })} onClick={() => onRemove(name)} className="flex size-5 items-center justify-center text-[var(--text-quaternary)] hover:text-[var(--danger)]">
                <X size={10}/>
              </button>)}
          </span>))}
      {!readOnly && (adding ? (<InlineInput aria-label={t('tags.new_placeholder')} initial="" placeholder={t('tags.new_placeholder')} onCommit={(text) => {
                setAdding(false);
                const name = text.trim().replace(/^#/, '');
                if (name && !names.includes(name))
                    onAdd(name);
            }} onCancel={() => setAdding(false)} className="w-24"/>) : (<Tooltip label={t('tags.new')} side="top">
            <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-0.5 rounded-[var(--r-sm)] px-1.5 py-0.5 text-[11.5px] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]">
              <Plus size={10}/>{t('properties.add_tag')}
            </button>
          </Tooltip>))}
    </span>)
    if (!asTags)
        return pills;
    return (<>
      {pills}
      <TagContextMenuAt request={tagMenu} onClose={() => setTagMenu(null)}/>
    </>)
}
function AddPropertyRow({ used, onCommit, onCancel }: {
    used: ReadonlySet<string>;
    onCommit: (key: string, value: FrontMatterValue) => void;
    onCancel: () => void;
}) {
    const [key, setKey] = useState('');
    return (<div className="flex items-center gap-2 px-2.5 py-1.5">
      <Plus size={12} className="shrink-0 text-[var(--text-quaternary)]"/>
      <input autoFocus aria-label={t('properties.new_key')} value={key} placeholder={t('properties.new_key')} onChange={(event) => setKey(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Escape')
                onCancel();
            event.stopPropagation();
        }} className="min-w-0 flex-1 rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[12px] outline-none"/>
      <InlineInput aria-label={t('properties.new_value')} initial="" placeholder={t('properties.new_value')} onCommit={(text) => {
            const name = key.trim();
            const value = text.trim();
            if (name && !used.has(name) && value)
                onCommit(name, value);
            else
                onCancel();
        }} onCancel={onCancel} className="min-w-0 flex-1"/>
    </div>);
}
function InlineInput({ 'aria-label': ariaLabel, initial, placeholder, className, onCommit, onCancel }: {
    'aria-label': string;
    initial: string;
    placeholder?: string;
    className?: string;
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
    return (<input aria-label={ariaLabel} autoFocus defaultValue={value} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} onBlur={commit} onKeyDown={(event) => {
            if (event.key === 'Enter')
                commit();
            if (event.key === 'Escape') {
                done.current = true;
                onCancel();
            }
            event.stopPropagation();
        }} className={cn('rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-0.5 text-[12px] text-[var(--text-primary)] outline-none', className)}/>);
}
type PropertyKind = 'text' | 'number' | 'boolean' | 'tags' | 'array' | 'other';
function describeValue(value: unknown, key: string): PropertyKind {
    if (typeof value === 'boolean')
        return 'boolean';
    if (typeof value === 'number')
        return 'number';
    if (Array.isArray(value))
        return key === 'tags' || key === 'tag' ? 'tags' : 'array';
    if (value === null || value === undefined || typeof value === 'string')
        return 'text';
    return 'other';
}
function coerce(kind: PropertyKind, text: string): FrontMatterValue {
    const trimmed = text.trim();
    if (kind === 'number') {
        const asNumber = Number(trimmed);
        if (trimmed && Number.isFinite(asNumber))
            return asNumber;
    }
    return trimmed;
}
function formatScalar(value: unknown): string {
    if (value === null || value === undefined)
        return '';
    if (typeof value === 'object')
        return JSON.stringify(value);
    return String(value);
}
function KindGlyph({ kind }: {
    kind: PropertyKind;
}) {
    return <span aria-hidden="true" className="mt-0.5 w-3 shrink-0 text-center text-[10.5px] text-[var(--text-quaternary)]">{kind === 'boolean' ? '✓' : kind === 'tags' || kind === 'array' ? '#' : kind === 'number' ? '1' : 'T'}</span>;
}
