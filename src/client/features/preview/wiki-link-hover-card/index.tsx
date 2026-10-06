import { memo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Layers, Loader2, PanelLeftOpen, PanelRightOpen, Pin, X } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { Menu } from '../../../components/overlay'
import { PINNED_MENU_Z, hoverCardStyle, useWikiLinkHoverCard, type WikiLinkHoverCardBundle, type WikiLinkHoverCardProps } from './use-wiki-link-hover-card'
import { CardBacklinks } from './backlinks'

const STACK_MENU_WIDTH = 220

export type { PinnedNoteCardState, WikiLinkHoverCardState } from '../../../types/hover-card'

function CardHeaderButton({ label, onClick, children }: { label: string, onClick: () => void, children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    >
      {children}
    </button>
  )
}

function CardHeader({ b }: { b: WikiLinkHoverCardBundle }) {
  const { card, pinned, stackCount = 1, stackFront = false, setIsStackMenuOpen, stackButtonRef, openInCurrentPane, openInSidePane, handlePin, onClose, beginDrag } = b
  return (
    <div
      className={cn('flex items-start gap-1 border-b border-[var(--border-subtle)] px-3 py-2', pinned && 'cursor-move select-none touch-none')}
      onPointerDown={pinned ? beginDrag : undefined}
    >
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[length:var(--text-12)] leading-snug font-semibold text-[var(--text-primary)]',
          card.missing && 'text-[var(--text-tertiary)]',
        )}
        title={card.title}
      >
        {card.title || t('preview.untitled')}
      </span>
      {pinned && stackCount > 1 && stackFront && (
        <button
          ref={stackButtonRef}
          type="button"
          aria-label={t('preview.pinned_windows')}
          title={t('preview.pinned_windows')}
          onClick={() => setIsStackMenuOpen((value) => !value)}
          className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Layers size={13}/>
          <span className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--accent)] px-0.5 text-[length:var(--text-9)] font-semibold text-[var(--bg-overlay)]">
            {stackCount}
          </span>
        </button>
      )}
      {pinned && card.noteId && (
        <>
          <CardHeaderButton label={t('preview.open_in_current_pane')} onClick={openInCurrentPane}><PanelLeftOpen size={13}/></CardHeaderButton>
          <CardHeaderButton label={t('preview.open_in_side_pane')} onClick={openInSidePane}><PanelRightOpen size={13}/></CardHeaderButton>
        </>
      )}
      {pinned ? (
        <CardHeaderButton label={t('common.close')} onClick={onClose}>
          <X size={13}/>
        </CardHeaderButton>
      ) : (
        <CardHeaderButton label={t('preview.pin_card')} onClick={handlePin}>
          <Pin size={13}/>
        </CardHeaderButton>
      )}
    </div>
  )
}

function CardBody({ b }: { b: WikiLinkHoverCardBundle }) {
  const { status, htmlObj, isTruncated, pinned, pinnedRect, backlinks, openBacklink } = b
  if (status === 'loading') {
    return (
      <div className="flex h-24 items-center justify-center text-[var(--text-quaternary)]">
        <Loader2 size={18} className="animate-spin"/>
      </div>
    )
  }
  if (status === 'missing') {
    return (
      <div className="px-3 py-2.5 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
        {t('preview.note_does_not_exist')}
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="px-3 py-2.5 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
        {t('preview.could_not_load_note')}
      </div>
    )
  }
  return (
    <>
      <div
        className={cn(
          'wiki-hover-body min-h-0 overflow-y-auto overscroll-contain px-3 py-2.5',
          pinned && pinnedRect.height ? 'flex-1' : 'max-h-75',
        )}
      >
        <div className="ink-prose" dangerouslySetInnerHTML={htmlObj}/>
      </div>
      {isTruncated && (
        <div className="border-t border-[var(--border-subtle)] px-3 py-1.5 text-center text-[length:var(--text-11)] tracking-widest text-[var(--text-quaternary)]">
          ···
        </div>
      )}
      {backlinks && backlinks.length > 0 && <CardBacklinks links={backlinks} onOpen={openBacklink}/>}
    </>
  )
}

function StackMenu({ b }: { b: WikiLinkHoverCardBundle }) {
  const { stackButtonRef, isStackMenuOpen, setIsStackMenuOpen, stackItems } = b
  return (
    <Menu
      anchor={stackButtonRef}
      open={isStackMenuOpen}
      onClose={() => setIsStackMenuOpen(false)}
      items={stackItems ?? []}
      align="end"
      width={STACK_MENU_WIDTH}
      zIndex={PINNED_MENU_Z}
      label={t('preview.pinned_windows')}
    />
  )
}

function ResizeHandle({ onPointerDown }: { onPointerDown: (event: React.PointerEvent<HTMLElement>) => void }) {
  return (
    <div
      aria-label={t('preview.resize_card')}
      title={t('preview.resize_card')}
      onPointerDown={onPointerDown}
      className="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize touch-none"
    >
      <div className="absolute right-1 bottom-1 h-2 w-2 rounded-sm border-r-2 border-b-2 border-[var(--border-strong)]"/>
    </div>
  )
}

export const WikiLinkHoverCard = memo(function WikiLinkHoverCard(props: WikiLinkHoverCardProps) {
  const b = useWikiLinkHoverCard(props)
  const { card, pinned, position, pinnedRect, pinnedInit, cardRef, describedBy, machine, nested, depth, path, dark, onEnter, onLeave, onPin, flash, onCardKeyDown, stop, beginResize } = b

  return createPortal(
    <div
      ref={cardRef}
      id={describedBy}
      role={pinned ? 'dialog' : 'tooltip'}
      aria-label={pinned ? card.title : undefined}
      tabIndex={-1}
      data-hover-card
      onMouseEnter={() => {
        machine.clearPendingHide()
        if (!pinned) onEnter()
      }}
      onMouseLeave={() => {
        machine.armHide()
        if (!pinned) onLeave()
      }}
      onMouseMove={machine.handleMouseMove}
      onClick={pinned ? undefined : stop}
      onKeyDown={onCardKeyDown}
      className={cn(
        'anim-pop fixed flex min-w-0 flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-pop)]',
        pinned ? '' : 'z-[var(--z-hover-card)] w-85 max-w-[calc(100vw-24px)]',
        pinned && flash && 'pinned-window-flash',
      )}
      style={hoverCardStyle(pinned, pinnedRect, position, pinnedInit)}
    >
      <CardHeader b={b}/>
      <CardBody b={b}/>
      {pinned && <ResizeHandle onPointerDown={beginResize}/>}
      {nested && (
        <WikiLinkHoverCard
          card={nested}
          path={nested.noteId ? [...path, nested.noteId] : path}
          depth={depth + 1}
          dark={dark}
          onClose={machine.hideNow}
          onEnter={machine.clearPendingHide}
          onLeave={machine.armHide}
          onPin={onPin}
        />
      )}
      {pinned && <StackMenu b={b}/>}
    </div>,
    document.body,
  )
})
