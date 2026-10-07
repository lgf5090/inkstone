import { useRef, useState } from 'react';
import { lazy, Suspense } from 'react';
import type { CSSProperties } from 'react';
import { ChevronDown, Eye, EyeOff, ImagePlus, Palette, Plus, Sparkles, X } from 'lucide-react';
import { deleteFrontMatterValue, renameFrontMatterValue, replaceTagInContent, setFrontMatterValue } from '@shared/markdown-utils';
import type { FrontMatterValue } from '@shared/markdown-utils';
import type { MenuItem } from '../../components/overlay';
import { Menu, Tooltip } from '../../components/overlay';
import { commitOnEnter } from '../../components/form';
import type { PropertySettings } from '@shared/types';
import type { ResolvedProperty } from '@shared/property-style';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { encodeDataValue } from '../../lib/markdown/data-attr';
import { renderInlineProperty } from '../../lib/markdown/renderer';
import { usePropertySettings, usePropertyView } from '../../lib/property-view';
import { requestPropertyDecoration } from '../../lib/property-commands';
import type { PropertyDecorationKind } from '../../lib/property-commands';
import { withName } from '../../lib/property-prefs';
import { useNotes } from '../../store/notes';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { TagContextMenuAt, type TagMenuRequest } from '../tags/TagContextMenuAt';
import { beginTagDrag, endTagDrag } from '../tags/tagDrag';
import { openTagPageByName, wantsTagPage } from '../tags/tagMutations';
import { propertyColorCss, propertyPillCss } from './property-colors';
import { buildPillMenu, buildPropertyMenu, type PropertyMenuHandlers } from './property-menus';
import { NoteBanner, NoteCover, NoteIcon } from './PropertyDecorations';
import type { DecorationActions } from './PropertyDecorations';

interface AnchoredMenu {
    items: MenuItem[];
    x: number;
    y: number;
    label: string;
    width?: number;
}

export function NoteProperties({ noteId, onLightbox }: {
    noteId: string | null;
    onLightbox?: (src: string, alt: string) => void;
}) {
    const [collapsed, setCollapsed] = useState(false);
    const [adding, setAdding] = useState(false);
    const [menu, setMenu] = useState<AnchoredMenu | null>(null);
    const decorateRef = useRef<HTMLButtonElement>(null);
    const [decorateOpen, setDecorateOpen] = useState(false);
    const [glyphRequest, setGlyphRequest] = useState<{ property: string; x: number; y: number } | null>(null);
    // Read the live buffer rather than taking the rendered text as a prop: a debounced or
    // cached copy here would silently overwrite whatever was typed in the last few frames.
    const content = useNotes(state => (noteId ? state.contents[noteId] ?? '' : ''));
    const editContent = useNotes(state => state.editContent);
    const settings = usePropertySettings();
    const patchSettings = useSession(state => state.updateSettings);
    const openSearchList = useUi(state => state.openSearchList);
    const view = usePropertyView(content);
    const readOnly = view.errors.length > 0 || noteId === null;
    // One interaction can write several properties (removing a cover drops its shape and position
    // too), and each write has to build on the last instead of on the content this render read —
    // the store only settles between the two, so a second write off `content` would undo the first.
    const draft = useRef({ source: '', text: '' });
    const write = (next: string) => {
        if (noteId && next !== content)
            editContent(noteId, next);
    };
    const setProperty = (name: string, value: string | number | null) => {
        if (!name)
            return;
        if (draft.current.source !== content)
            draft.current = { source: content, text: content };
        const base = draft.current.text;
        const next = value === null ? deleteFrontMatterValue(base, name) : setFrontMatterValue(base, name, value);
        draft.current = { source: content, text: next };
        write(next);
    };
    const isHidden = (name: string) => settings.hidden.some(item => item.toLocaleLowerCase() === name.toLocaleLowerCase());
    const nameForKind = (kind: PropertyDecorationKind): string => {
        if (kind === 'banner')
            return settings.bannerProperty;
        if (kind === 'icon')
            return settings.iconProperty;
        return settings.coverProperties.find(Boolean) ?? '';
    };
    const hideProperty = (name: string) => patchSettings({ properties: { hidden: withName(settings.hidden, name, !isHidden(name)) } });
    const actions: DecorationActions = {
        setProperty,
        hideProperty,
        isHidden,
        pickImage: (_property, kind) => {
            if (noteId)
                requestPropertyDecoration(kind, noteId);
        },
        pickIcon: (property, anchor) => setGlyphRequest({ property, x: anchor.x, y: anchor.y }),
        setSettings: patch => patchSettings({ properties: patch }),
    };
    const handlers: PropertyMenuHandlers = {
        settings,
        patch: patch => patchSettings({ properties: patch }),
        numericProperties: Object.keys(view.data).filter(key => typeof view.data[key] === 'number'),
        onSearch: value => openSearchList(value),
        onRename: () => {},
        onDelete: () => {},
    };
    const rows = view.rows;
    const decorateItems: MenuItem[] = [
        { id: 'decorate-cover', label: t('properties.set_cover'), icon: <ImagePlus size={14}/>, onSelect: () => { if (noteId && nameForKind('cover')) requestPropertyDecoration('cover', noteId); } },
        { id: 'decorate-banner', label: t('properties.set_banner'), icon: <ImagePlus size={14}/>, onSelect: () => { if (noteId && nameForKind('banner')) requestPropertyDecoration('banner', noteId); } },
        { id: 'decorate-icon', label: t('properties.set_icon'), icon: <ImagePlus size={14}/>, onSelect: () => { if (noteId && nameForKind('icon')) requestPropertyDecoration('icon', noteId); } },
    ];
    const hiddenCount = rows.filter(row => row.hidden).length;
    const shown = settings.revealHidden ? rows : rows.filter(row => !row.hidden);
    const hideWholeBlock = settings.hideWholeBlockWhenEmpty && shown.length === 0 && !readOnly && !adding;
    const headerless = settings.hideHeader;
    const open = !collapsed || headerless;
    return (<section data-note-properties className={cn('pp-shell mb-4 overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]', hideWholeBlock && 'pp-shell-quiet')}>
      <NoteBanner banner={view.decorations.banner} settings={settings} actions={actions}/>
      {!hideWholeBlock && (<div className="pp-layout" data-cover-position={view.decorations.cover?.position ?? 'left'}>
          <NoteCover cover={view.decorations.cover} settings={settings} actions={actions} onLightbox={onLightbox}/>
          <div className="pp-column min-w-0 flex-1">
            {view.decorations.icon && !settings.iconInline && (<div className="pp-icon-row"><NoteIcon icon={view.decorations.icon} settings={settings} actions={actions} inline={false}/></div>)}
            {!headerless && (<header className="flex h-9 items-center gap-2 border-b border-[var(--border-subtle)] px-2.5">
              <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] font-semibold text-[var(--text-secondary)]">
                {view.decorations.icon && settings.iconInline && (<NoteIcon icon={view.decorations.icon} settings={settings} actions={actions} inline={true}/>)}
                <ChevronDown size={13} className={cn('shrink-0 transition-transform duration-[var(--dur-fast)]', collapsed && '-rotate-90')}/>
                <span className="truncate">{t('markdown.properties')}</span>
                <span className="shrink-0 tabular text-[var(--text-quaternary)]">{shown.filter(row => !row.hidden).length}</span>
              </button>
              {hiddenCount > 0 && (<button type="button" onClick={() => handlers.patch({ revealHidden: !settings.revealHidden })} aria-pressed={settings.revealHidden} className="flex min-w-0 items-center gap-1 rounded px-1.5 py-1 text-[11.5px] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]">
                  {settings.revealHidden ? <Eye size={12}/> : <EyeOff size={12}/>}
                  <span className="truncate">{t('properties.hidden_count', { value0: hiddenCount })}</span>
                </button>)}
              {!collapsed && !readOnly && settings.enabled && (<Tooltip label={t('properties.decorate')} side="left">
                  <button ref={decorateRef} type="button" aria-label={t('properties.decorate')} aria-expanded={decorateOpen} onClick={() => setDecorateOpen(value => !value)} className="flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]">
                    <Sparkles size={13}/>
                  </button>
                </Tooltip>)}
              {!collapsed && !readOnly && !settings.hideAddButton && (<button type="button" onClick={() => setAdding(true)} aria-label={t('properties.add')} className="flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]">
                  <Plus size={13}/>
                </button>)}
            </header>)}
            {open && (<div className="divide-y divide-[var(--border-subtle)]">
                {view.errors.length > 0 && <p className="px-3 py-2.5 text-[11.5px] text-[var(--danger)]">{t('properties.invalid')}</p>}
                {!rows.length && !view.errors.length && <p className="px-3 py-2.5 text-[11.5px] text-[var(--text-quaternary)]">{t('properties.empty')}</p>}
                {rows.length > 0 && !shown.length && !view.errors.length && <p className="px-3 py-2.5 text-[11.5px] text-[var(--text-quaternary)]">{t('properties.all_hidden')}</p>}
                {shown.map(row => (<PropertyRow key={row.key} row={row} readOnly={readOnly} settings={settings} handlers={handlers} onOpenMenu={(items, label, event) => setMenu({
                        items,
                        label,
                        x: event.clientX,
                        y: event.clientY,
                        width: 210,
                    })} onValue={(next) => write(setFrontMatterValue(content, row.key, next))} onRename={(to) => write(renameFrontMatterValue(content, row.key, to))} onDelete={() => write(deleteFrontMatterValue(content, row.key))} onTagRemove={(name) => write(replaceTagInContent(content, name, null))} onToggleHidden={() => hideProperty(row.key)}/>))}
                {adding && !readOnly && (<AddPropertyRow used={new Set(rows.map(row => row.key))} onCancel={() => setAdding(false)} onCommit={(key, value) => {
                        setAdding(false);
                        write(setFrontMatterValue(content, key, value));
                    }}/>)}
                {headerless && !readOnly && !settings.hideAddButton && !adding && (<button type="button" onClick={() => setAdding(true)} aria-label={t('properties.add')} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11.5px] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)]">
                    <Plus size={12}/>
                    <span>{t('properties.add')}</span>
                  </button>)}
              </div>)}
          </div>
        </div>)}
      {menu && (<Menu anchor={{ x: menu.x, y: menu.y }} open onClose={() => setMenu(null)} items={menu.items} width={menu.width} label={menu.label}/>)}
      <Menu anchor={decorateRef} open={decorateOpen} onClose={() => setDecorateOpen(false)} items={decorateItems} width={200} label={t('properties.decorate')}/>
      <GlyphMenu request={glyphRequest} onClose={() => setGlyphRequest(null)} onPick={(property, glyph) => setProperty(property, glyph)}/>
    </section>);
}

function PropertyRow({ row, readOnly, settings, handlers, onValue, onRename, onDelete, onTagRemove, onToggleHidden, onOpenMenu }: {
    row: ResolvedProperty;
    readOnly: boolean;
    settings: PropertySettings;
    handlers: PropertyMenuHandlers;
    onValue: (next: FrontMatterValue) => void;
    onRename: (to: string) => void;
    onDelete: () => void;
    onTagRemove: (name: string) => void;
    onToggleHidden: () => void;
    onOpenMenu: (items: MenuItem[], label: string, event: { clientX: number; clientY: number }) => void;
}) {
    const [renaming, setRenaming] = useState(false);
    const openRowMenu = (event: { clientX: number; clientY: number }) => onOpenMenu(buildPropertyMenu({
        ...row,
    }, {
        ...handlers,
        onRename: () => setRenaming(true),
        onDelete,
    }), t('properties.menu'), event);
    return (<div className={cn('group/row flex items-start gap-2 px-2.5 py-1.5', row.hidden && 'pp-row-hidden')} data-property-key={row.key} data-property-hidden={row.hidden ? 'true' : undefined} onContextMenu={readOnly ? undefined : event => {
            event.preventDefault();
            event.stopPropagation();
            openRowMenu(event);
        }}>
      <div className="flex min-w-0 flex-1 items-start gap-1.5">
        <KindGlyph row={row}/>
        {renaming
            ? <InlineInput aria-label={t('properties.rename')} initial={row.key} onCommit={(next) => {
                    setRenaming(false);
                    if (next.trim() && next.trim() !== row.key)
                        onRename(next.trim());
                }} onCancel={() => setRenaming(false)} className="min-w-0 flex-1"/>
            : <button type="button" disabled={readOnly} onClick={() => setRenaming(true)} title={t('properties.rename')} className="shrink-0 rounded px-0.5 text-left text-[12px] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] disabled:hover:bg-transparent">
                {row.key}
              </button>}
        {row.hiddenReason && !readOnly && (<Tooltip label={row.hiddenReason === 'empty' ? t('properties.hide_when_empty') : t('properties.unhide')} side="top">
            <button type="button" onClick={onToggleHidden} aria-label={t('properties.unhide')} className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]">
              <Eye size={11}/>
            </button>
          </Tooltip>)}
      </div>
      <div className="flex min-w-0 max-w-[62%] flex-1 items-center justify-end gap-1">
        <ValueArea row={row} readOnly={readOnly} settings={settings} handlers={handlers} onValue={onValue} onTagRemove={onTagRemove} onOpenMenu={onOpenMenu}/>
        {!readOnly && row.kind !== 'object' ? (<button type="button" aria-label={t('properties.delete')} onClick={onDelete} className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] opacity-0 transition-opacity hover:text-[var(--danger)] focus-visible:opacity-100 group-hover/row:opacity-100">
            <X size={11}/>
          </button>) : null}
      </div>
    </div>);
}

function ValueArea({ row, readOnly, settings, handlers, onValue, onTagRemove, onOpenMenu }: {
    row: ResolvedProperty;
    readOnly: boolean;
    settings: PropertySettings;
    handlers: PropertyMenuHandlers;
    onValue: (next: FrontMatterValue) => void;
    onTagRemove: (name: string) => void;
    onOpenMenu: (items: MenuItem[], label: string, event: { clientX: number; clientY: number }) => void;
}) {
    const [editing, setEditing] = useState(false);
    if (row.kind === 'boolean')
        return <BooleanValue row={row} readOnly={readOnly} onValue={onValue}/>;
    if (row.kind === 'tags' || row.kind === 'array')
        return (<TagValues names={row.items.map(item => item.raw)} resolved={row} asTags={row.kind === 'tags'} readOnly={readOnly} handlers={handlers} onRemove={onTagRemove} onAdd={(name) => onValue([...row.items.map(item => item.raw), name])} onOpenMenu={onOpenMenu}/>);
    if (row.kind === 'object')
        return (<span className="min-w-0 truncate text-right text-[12px] text-[var(--text-tertiary)]">{row.display}</span>);
    if (editing)
        return (<InlineInput aria-label={row.key} initial={row.items[0]?.raw ?? ''} onCommit={(text) => {
                setEditing(false);
                onValue(coerce(row.kind, text));
            }} onCancel={() => setEditing(false)} className="min-w-0 flex-1"/>);
    const progress = row.progress;
    return (<div className="flex min-w-0 items-center justify-end gap-1.5">
        {progress && (<ProgressCell row={row} label={`${row.items[0]?.raw ?? ''} / ${progress.max}`}/>)}
        <ScalarValue row={row} readOnly={readOnly} settings={settings} handlers={handlers} onValue={onValue} onEdit={() => setEditing(true)} onOpenMenu={onOpenMenu}/>
      </div>);
}

function coerce(kind: ResolvedProperty['kind'], text: string): FrontMatterValue {
    const trimmed = text.trim();
    if (kind === 'number') {
        const asNumber = Number(trimmed);
        if (trimmed && Number.isFinite(asNumber))
            return asNumber;
    }
    return trimmed;
}

function BooleanValue({ row, readOnly, onValue }: {
    row: ResolvedProperty;
    readOnly: boolean;
    onValue: (next: FrontMatterValue) => void;
}) {
    const on = Boolean(row.value);
    return (<button type="button" role="switch" aria-label={row.key} aria-checked={on} disabled={readOnly} onClick={() => onValue(!on)} className={cn('relative h-4 w-8 shrink-0 rounded-full transition-colors', on ? 'bg-[var(--accent)]' : 'bg-[var(--bg-inset)] ring-1 ring-[var(--border-default)]')}>
        <span className={cn('absolute top-0.5 size-3 rounded-full bg-white shadow transition-all', on ? 'left-4' : 'left-0.5')}/>
      </button>);
}

function ScalarValue({ row, readOnly, settings, handlers, onValue, onEdit, onOpenMenu }: {
    row: ResolvedProperty;
    readOnly: boolean;
    settings: PropertySettings;
    handlers: PropertyMenuHandlers;
    onValue: (next: FrontMatterValue) => void;
    onEdit: () => void;
    onOpenMenu: (items: MenuItem[], label: string, event: { clientX: number; clientY: number }) => void;
}) {
    const openSearchList = useUi(state => state.openSearchList);
    const item = row.items[0];
    const value = item?.raw ?? '';
    const formatted = item && item.display !== item.raw;
    const markdown = row.markdown;
    const style: CSSProperties = {};
    if (item?.pillSlot === 'color' && item.pill)
        style.backgroundColor = propertyPillCss(item.pill);
    else if (item?.pillSlot === 'transparent')
        style.backgroundColor = 'transparent';
    if (item?.textSlot === 'color' && item.textColor)
        style.color = propertyColorCss(item.textColor);
    const options = row.options;
    const onClick = (event: React.MouseEvent) => {
        if (wantsQuickSearch(event, settings.quickSearchKey)) {
            event.preventDefault();
            openSearchList(value);
            return;
        }
        if (options.length) {
            event.preventDefault();
            onOpenMenu(options.map(name => ({
                id: `option-${name}`,
                label: name || t('properties.empty_value'),
                checked: name === value,
                onSelect: () => onValue(name),
            })), t('properties.options_title', { name: row.key }), event);
            return;
        }
        if (!readOnly)
            onEdit();
    };
    return (<>
        {markdown
            ? (<button type="button" data-property-value={value} data-property-format="markdown" disabled={readOnly} onClick={onClick} title={value} className="pp-markdown min-w-0 truncate rounded px-1 py-0.5 text-right text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]" dangerouslySetInnerHTML={{ __html: renderInlineProperty(value, settings.enabled) }}/>)
            : (<button type="button" data-property-value={value} data-property-format={formatted ? 'template' : undefined} disabled={readOnly} onClick={onClick} title={formatted ? value : undefined} style={style} className="min-w-0 truncate rounded px-1 py-0.5 text-right text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:hover:bg-transparent">
                {item?.display || t('properties.empty_value')}
              </button>)}
        {!readOnly && value && (<Tooltip label={t('properties.pill_color')} side="top">
            <button type="button" aria-label={t('properties.pill_color')} onClick={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenMenu(buildPillMenu(row.key, value, handlers), t('properties.menu'), event);
                }} className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] opacity-0 transition-opacity hover:text-[var(--text-secondary)] focus-visible:opacity-100 group-hover/row:opacity-100">
                <Palette size={11}/>
              </button>
        </Tooltip>)}
      </>);
}

function wantsQuickSearch(event: React.MouseEvent, key: PropertySettings['quickSearchKey']): boolean {
    if (key === 'off')
        return false;
    const only = (wanted: boolean, others: boolean) => wanted && !others;
    if (key === 'ctrl')
        return only(event.ctrlKey || event.metaKey, event.altKey);
    if (key === 'alt')
        return only(event.altKey, event.ctrlKey || event.metaKey);
    return only(event.metaKey, event.ctrlKey);
}

function ProgressCell({ row, label }: {
    row: ResolvedProperty;
    label: string;
}) {
    const progress = row.progress;
    if (!progress)
        return null;
    if (progress.variant === 'circle')
        return (<span className="pp-progress-circle" role="img" aria-label={`${label} · ${progress.percent}%`} style={{ '--pp-percent': `${progress.percent}%` } as CSSProperties}/>);
    return (<progress className="pp-progress" max={progress.max} value={progress.value} aria-label={`${label} · ${progress.percent}%`} title={`${progress.percent}%`}/>);
}

function TagValues({ names, resolved, asTags, readOnly, handlers, onRemove, onAdd, onOpenMenu }: {
    names: string[];
    resolved: ResolvedProperty;
    asTags: boolean;
    readOnly: boolean;
    handlers: PropertyMenuHandlers;
    onRemove: (name: string) => void;
    onAdd: (name: string) => void;
    onOpenMenu: (items: MenuItem[], label: string, event: { clientX: number; clientY: number }) => void;
}) {
    const [adding, setAdding] = useState(false);
    const [tagMenu, setTagMenu] = useState<TagMenuRequest | null>(null);
    const openView = useUi(state => state.openView);
    const pills = (<span className="flex min-w-0 flex-wrap items-center justify-end gap-1">
      {resolved.items.map((item, index) => {
        const name = names[index] ?? item.raw;
        const background = item.pillSlot === 'color' && item.pill ? propertyPillCss(item.pill) : item.pillSlot === 'transparent' ? 'transparent' : null;
        const color = item.textSlot === 'color' && item.textColor ? propertyColorCss(item.textColor) : null;
        return (<span key={`${name}-${index}`} className="flex max-w-full items-center overflow-hidden rounded-[var(--r-sm)]" style={background ? { backgroundColor: background } : undefined}>
            {asTags
              ? (<button type="button" draggable onDragStart={(event) => beginTagDrag(name, event.dataTransfer)} onDragEnd={endTagDrag} data-tag={encodeDataValue(name)} data-property-pill-value={name} onClick={(event) => {
                        if (wantsTagPage(event)) {
                            void openTagPageByName(name);
                            return;
                        }
                        openView('tag', { tag: name });
                    }} title={t('tags.drag_hint')} onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setTagMenu({ name, x: event.clientX, y: event.clientY });
                    }} className={cn('min-w-0 truncate py-0.5 pl-1.5 text-[11.5px] text-[var(--text-primary)] hover:underline', !background && 'bg-[var(--accent-soft)]')}>
                    <span className="text-[var(--text-quaternary)]">#</span>
                    <span style={color ? { color } : undefined}>{name}</span>
                  </button>)
              : (<span className={cn('min-w-0 truncate py-0.5 pl-1.5 text-[11.5px]', !background && 'bg-[var(--accent-soft)]')} style={color ? { color } : undefined}>{item.display}</span>)}
            {!readOnly && asTags && (<button type="button" aria-label={t('properties.remove_tag_value0', { value0: name })} onClick={() => onRemove(name)} className="flex size-5 items-center justify-center text-[var(--text-quaternary)] hover:text-[var(--danger)]">
                <X size={10}/>
              </button>)}
            {!readOnly && (<button type="button" aria-label={t('properties.pill_color')} onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onOpenMenu(buildPillMenu(resolved.key, name, handlers), t('properties.menu'), event);
                    }} className="flex size-5 items-center justify-center text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]">
                <Palette size={10}/>
              </button>)}
          </span>);
      })}
      {!readOnly && (adding
            ? (<InlineInput aria-label={t('tags.new_placeholder')} initial="" placeholder={t('tags.new_placeholder')} onCommit={(text) => {
                    setAdding(false);
                    const name = text.trim().replace(/^#/, '');
                    if (name && !names.includes(name))
                        onAdd(name);
                }} onCancel={() => setAdding(false)} className="w-24"/>)
            : (<Tooltip label={t('tags.new')} side="top">
                <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-0.5 rounded-[var(--r-sm)] px-1.5 py-0.5 text-[11.5px] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]">
                  <Plus size={10}/>{t('properties.add_tag')}
                </button>
              </Tooltip>))}
    </span>);
    if (!asTags)
        return pills;
    return (<>
      {pills}
      <TagContextMenuAt request={tagMenu} onClose={() => setTagMenu(null)}/>
    </>);
}

function AddPropertyRow({ used, onCommit, onCancel }: {
    used: ReadonlySet<string>;
    onCommit: (key: string, value: FrontMatterValue) => void;
    onCancel: () => void;
}) {
    const [key, setKey] = useState('');
    return (<div className="flex items-center gap-2 px-2.5 py-1.5">
      <Plus size={12} className="shrink-0 text-[var(--text-quaternary)]"/>
      <input autoFocus aria-label={t('properties.new_key')} value={key} placeholder={t('properties.new_key')} onChange={event => setKey(event.target.value)} onKeyDown={(event) => {
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
    return (<input aria-label={ariaLabel} autoFocus defaultValue={value} placeholder={placeholder} onChange={event => setValue(event.target.value)} onBlur={commit} onKeyDown={(event) => {
            commitOnEnter(event, commit);
            if (event.key === 'Escape') {
                done.current = true;
                onCancel();
            }
            event.stopPropagation();
        }} className={cn('rounded-[var(--r-xs)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 py-0.5 text-[12px] text-[var(--text-primary)] outline-none', className)}/>);
}

function KindGlyph({ row }: {
    row: ResolvedProperty;
}) {
    const glyph = row.kind === 'boolean' ? '✓' : row.kind === 'tags' || row.kind === 'array' ? '#' : row.kind === 'number' ? '1' : row.dateShape ? 'D' : 'T';
    return <span aria-hidden="true" className="mt-0.5 w-3 shrink-0 text-center text-[10.5px] text-[var(--text-quaternary)]">{glyph}</span>;
}

function GlyphMenu({ request, onClose, onPick }: {
    request: { property: string; x: number; y: number } | null;
    onClose: () => void;
    onPick: (property: string, glyph: string) => void;
}) {
    if (!request)
        return null;
    const panel = (<Suspense fallback={<div className="p-3 text-[12px] text-[var(--text-quaternary)]">{t('properties.icon_loading')}</div>}>
        <EmojiPickerPanel onPick={(glyph) => {
            onPick(request.property, glyph);
            onClose();
        }}/>
      </Suspense>);
    return (<Menu anchor={{ x: request.x, y: request.y }} open onClose={onClose} items={[]} width={340} label={t('properties.icon_glyph')} headerHeight={360} header={panel}/>);
}

const EmojiPickerPanel = lazy(() => import('./property-glyph-panel'));
