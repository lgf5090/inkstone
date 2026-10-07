import { useState } from 'react';
import { Crop, ImageOff, ImageIcon, LayoutGrid, Palette, Pencil, Smile } from 'lucide-react';
import type { MenuItem } from '../../components/overlay';
import { Menu, Tooltip, prompt } from '../../components/overlay';
import { COVER_POSITIONS, COVER_SHAPES } from '@shared/property-decorations';
import type { NoteBannerDecoration, NoteCoverDecoration, NoteIconDecoration } from '@shared/property-decorations';
import type { PropertySettings } from '@shared/types';
import { t, type MessageKey } from '../../lib/i18n';
import { cn } from '../../lib/cn';
import { usePropertyImage } from '../../lib/property-images';

const SHAPE_LABEL_KEYS: Record<string, MessageKey> = {
    initial: 'properties.shape_initial',
    'initial-2': 'properties.shape_initial_2',
    'initial-3': 'properties.shape_initial_3',
    'vertical-cover': 'properties.shape_vertical_cover',
    'vertical-contain': 'properties.shape_vertical_contain',
    'horizontal-cover': 'properties.shape_horizontal_cover',
    'horizontal-contain': 'properties.shape_horizontal_contain',
    square: 'properties.shape_square',
    circle: 'properties.shape_circle',
};

const POSITION_LABEL_KEYS: Record<string, MessageKey> = {
    left: 'properties.position_left',
    right: 'properties.position_right',
    top: 'properties.position_top',
    bottom: 'properties.position_bottom',
};

export function shapeLabel(shape: string): string {
    return t(SHAPE_LABEL_KEYS[shape] ?? 'properties.shape_initial');
}

export function positionLabel(position: string): string {
    return t(POSITION_LABEL_KEYS[position] ?? 'properties.position_left');
}

export function coverWidthFor(settings: PropertySettings, shape: string): number {
    if (shape === 'initial-2' || shape === 'square' || shape === 'circle')
        return settings.coverWidth2;
    if (shape === 'initial-3' || shape === 'horizontal-cover' || shape === 'horizontal-contain')
        return settings.coverWidth3;
    return settings.coverWidth;
}

export interface DecorationActions {
    setProperty: (name: string, value: string | number | null) => void;
    hideProperty: (name: string) => void;
    isHidden: (name: string) => boolean;
    pickImage: (property: string, kind: 'cover' | 'banner' | 'icon') => void;
    pickIcon: (property: string, anchor: { x: number, y: number }) => void;
    setSettings: (patch: Partial<PropertySettings>) => void;
}

interface MenuState {
    items: MenuItem[];
    x: number;
    y: number;
}

function useDecorationMenu() {
    const [menu, setMenu] = useState<MenuState | null>(null);
    const open = (items: MenuItem[], event: { clientX: number; clientY: number; preventDefault: () => void }) => {
        event.preventDefault();
        setMenu({ items, x: event.clientX, y: event.clientY });
    };
    const node = menu ? (<Menu anchor={{ x: menu.x, y: menu.y }} open onClose={() => setMenu(null)} items={menu.items} width={200} label={t('properties.menu')}/>) : null;
    return { open, node };
}

export function coverMenuItems(cover: NoteCoverDecoration, settings: PropertySettings, actions: DecorationActions): MenuItem[] {
    return [
        {
            id: 'cover-change',
            label: t('properties.cover_change'),
            icon: <ImageIcon size={14}/>,
            onSelect: () => actions.pickImage(cover.property, 'cover'),
        },
        {
            id: 'cover-shape',
            label: t('properties.cover_shape'),
            icon: <Crop size={14}/>,
            subItems: COVER_SHAPES.map(item => ({
                id: `shape-${item}`,
                label: shapeLabel(item),
                checked: item === cover.shape,
                onSelect: () => actions.setProperty(settings.coverShapeProperty, item),
            })),
            submenu: () => COVER_SHAPES.map(item => (<ChoiceRow key={item} label={shapeLabel(item)} active={item === cover.shape} onPick={() => actions.setProperty(settings.coverShapeProperty, item)}>
                    <span aria-hidden="true" className={cn('shrink-0 border border-[var(--border-default)] bg-[var(--bg-inset)]', item === 'circle'
                        ? 'size-3.5 rounded-full'
                        : item === 'square'
                            ? 'size-3.5 rounded-[2px]'
                            : item.startsWith('vertical')
                                ? 'h-4 w-2.5 rounded-[2px]'
                                : item.startsWith('horizontal')
                                    ? 'h-2.5 w-4 rounded-[2px]'
                                    : 'h-3 w-4 rounded-[2px]')}/>
                  </ChoiceRow>)),
        },
        {
            id: 'cover-position',
            label: t('properties.cover_position'),
            icon: <LayoutGrid size={14}/>,
            subItems: COVER_POSITIONS.map(item => ({
                id: `position-${item}`,
                label: positionLabel(item),
                checked: item === cover.position,
                onSelect: () => actions.setProperty(settings.coverPositionProperty, item),
            })),
            submenu: () => COVER_POSITIONS.map(item => (<ChoiceRow key={item} label={positionLabel(item)} active={item === cover.position} onPick={() => actions.setProperty(settings.coverPositionProperty, item)}>
                    <span aria-hidden="true" className="flex h-3.5 w-4 shrink-0 items-center gap-px">
                      <span className={cn('h-full rounded-[1px]', item === 'left' ? 'w-1.5 bg-[var(--accent)]' : 'w-0')}/>
                      <span className={cn('h-1.5 flex-1 rounded-[1px] bg-[var(--bg-inset)] ring-1 ring-[var(--border-subtle)]', item === 'top' ? 'self-start' : item === 'bottom' ? 'self-end' : '')}/>
                      <span className={cn('h-full rounded-[1px]', item === 'right' ? 'w-1.5 bg-[var(--accent)]' : 'w-0')}/>
                    </span>
                  </ChoiceRow>)),
        },
        {
            id: 'cover-hide',
            label: actions.isHidden(cover.property) ? t('properties.unhide') : t('properties.hide'),
            icon: <Palette size={14}/>,
            separatorBefore: true,
            onSelect: () => actions.hideProperty(cover.property),
        },
        {
            id: 'cover-remove',
            label: t('properties.cover_remove'),
            icon: <ImageOff size={14}/>,
            tone: 'danger',
            onSelect: () => {
                actions.setProperty(cover.property, null);
                actions.setProperty(settings.coverShapeProperty, null);
                actions.setProperty(settings.coverPositionProperty, null);
            },
        },
    ];
}

function ChoiceRow({ label, active, onPick, children }: {
    label: string;
    active: boolean;
    onPick: () => void;
    children: React.ReactNode;
}) {
    return (<button type="button" role="menuitemradio" aria-checked={active} onClick={onPick} className={cn('flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]', active && 'bg-[var(--bg-hover)]')}>
        {children}
        <span className="truncate">{label}</span>
      </button>);
}

export function bannerMenuItems(banner: NoteBannerDecoration, settings: PropertySettings, actions: DecorationActions): MenuItem[] {
    return [
        {
            id: 'banner-change',
            label: t('properties.banner_change'),
            icon: <ImageIcon size={14}/>,
            onSelect: () => actions.pickImage(banner.property, 'banner'),
        },
        {
            id: 'banner-position',
            label: t('properties.banner_position'),
            icon: <LayoutGrid size={14}/>,
            onSelect: async () => {
                const answer = await prompt({
                    title: t('properties.banner_position'),
                    description: t('properties.banner_position_hint'),
                    defaultValue: String(banner.positionPercent),
                });
                if (answer === null)
                    return;
                const parsed = Number(answer.replace('%', '').trim());
                if (!Number.isFinite(parsed))
                    return;
                actions.setProperty(settings.bannerPositionProperty, Math.min(100, Math.max(0, Math.round(parsed))));
            },
        },
        {
            id: 'banner-hide',
            label: actions.isHidden(banner.property) ? t('properties.unhide') : t('properties.hide'),
            icon: <Palette size={14}/>,
            separatorBefore: true,
            onSelect: () => actions.hideProperty(banner.property),
        },
        {
            id: 'banner-remove',
            label: t('properties.banner_remove'),
            icon: <ImageOff size={14}/>,
            tone: 'danger',
            onSelect: () => {
                actions.setProperty(banner.property, null);
                actions.setProperty(settings.bannerPositionProperty, null);
            },
        },
    ];
}

export function iconMenuItems(settings: PropertySettings, actions: DecorationActions, anchor: { x: number, y: number }): MenuItem[] {
    return [
        {
            id: 'icon-image',
            label: t('properties.icon_image'),
            icon: <ImageIcon size={14}/>,
            onSelect: () => actions.pickImage(settings.iconProperty, 'icon'),
        },
        {
            id: 'icon-glyph',
            label: t('properties.icon_glyph'),
            icon: <Smile size={14}/>,
            onSelect: () => actions.pickIcon(settings.iconProperty, anchor),
        },
        {
            id: 'icon-place',
            label: settings.iconInline ? t('properties.icon_move_top') : t('properties.icon_move_inline'),
            icon: <Pencil size={14}/>,
            separatorBefore: true,
            onSelect: () => actions.setSettings({ iconInline: !settings.iconInline }),
        },
    ];
}

export function NoteBanner({ banner, settings, actions }: {
    banner: NoteBannerDecoration | null;
    settings: PropertySettings;
    actions: DecorationActions;
}) {
    const menu = useDecorationMenu();
    const url = usePropertyImage(banner?.image.source ?? null);
    if (!banner || !settings.enabled || !settings.showBanner)
        return null;
    return (<>
      <div className="pp-banner" style={{ height: `${settings.bannerHeight}px` }} onContextMenu={event => menu.open(bannerMenuItems(banner, settings, actions), event)}>
        {url
            ? <img className="pp-banner-image" src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" style={{ objectPosition: `center ${banner.positionPercent}%` }}/>
            : <span className="pp-banner-empty">{t('properties.image_missing')}</span>}
        {settings.bannerFade && <span aria-hidden="true" className="pp-banner-fade"/>}
      </div>
      {menu.node}
    </>);
}

export function NoteCover({ cover, settings, actions, onLightbox }: {
    cover: NoteCoverDecoration | null;
    settings: PropertySettings;
    actions: DecorationActions;
    onLightbox?: (src: string, alt: string) => void;
}) {
    const menu = useDecorationMenu();
    const url = usePropertyImage(cover?.image.source ?? null);
    if (!cover || !settings.enabled || !settings.showCover)
        return null;
    const width = coverWidthFor(settings, cover.shape);
    return (<>
      <div className={cn('pp-cover', `is-${cover.position}`, `is-${cover.shape}`)} style={{ '--pp-cover-width': `${width}px`, maxHeight: `${settings.coverMaxHeight}px` } as React.CSSProperties} onContextMenu={event => menu.open(coverMenuItems(cover, settings, actions), event)}>
        <button type="button" aria-label={cover.image.alt || t('properties.cover')} className="pp-cover-hit" onClick={() => {
                if (url)
                    onLightbox?.(url, cover.image.alt);
            }}>
              {url
                ? <img className="pp-cover-image" src={url} alt={cover.image.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"/>
                : (<span className="pp-cover-empty">
                    <ImageIcon size={20}/>
                    <span>{t('properties.image_missing')}</span>
                  </span>)}
            </button>
      </div>
      {menu.node}
    </>);
}

export function NoteIcon({ icon, settings, actions, inline }: {
    icon: NoteIconDecoration | null;
    settings: PropertySettings;
    actions: DecorationActions;
    inline: boolean;
}) {
    const menu = useDecorationMenu();
    const url = usePropertyImage(icon?.icon.kind === 'image' ? icon.icon.image.source : null);
    if (!icon || !settings.enabled || !settings.showIcon)
        return null;
    const glyph = icon.icon.kind === 'glyph' ? icon.icon.text : null;
    return (<>
      <Tooltip label={t('properties.icon_hint')} side="bottom">
        <button type="button" aria-label={t('properties.icon')} className={cn('pp-icon', inline ? 'is-inline' : 'is-block')} style={{ '--pp-icon-size': `${Math.min(settings.iconSize, inline ? 40 : settings.iconSize)}px` } as React.CSSProperties} onContextMenu={event => menu.open(iconMenuItems(settings, actions, { x: event.clientX, y: event.clientY }), event)}>
          {url
            ? <img className="pp-icon-image" src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"/>
            : glyph
                ? <span className="pp-icon-glyph">{glyph}</span>
                : <ImageIcon size={16} className="pp-icon-missing"/>}
        </button>
      </Tooltip>
      {menu.node}
    </>);
}
