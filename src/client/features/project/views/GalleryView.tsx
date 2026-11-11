/**
 * The gallery: cards as tiles, cover first.
 *
 * A tile with no image still gets a plate tinted by the card's own colour rather than a grey box, so a
 * board of text-only cards reads as a set of things instead of a set of placeholders. Subtasks fold
 * under their parent tile: listing them beside it made a three-step task read as four unrelated cards.
 */
import { useState, type MouseEvent, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, CornerDownRight, LayoutGrid, ListTodo, SquareKanban } from 'lucide-react'
import type { ProjectCard, ProjectGallerySize, ProjectProperty, ProjectViewFields } from '@shared/project/model'
import type { ProjectCardBadges } from '@shared/project/badges'
import { projectCardColor } from '@shared/project/option-color'
import { groupProjectCards, projectOptionLabel, projectPropertyDisplayText } from '@shared/project/view-eval'
import { t } from '../../../lib/i18n'
import { CardBadges, OptionChip } from '../CardBadges'
import { QuickAdd, Seg, ViewHead, ViewShell } from './shell'

const TILE_WIDTH: Record<ProjectGallerySize, string> = { small: '160px', medium: '220px', large: '300px' }
const COVER_HEIGHT: Record<ProjectGallerySize, string> = { small: '84px', medium: '120px', large: '168px' }

export interface GalleryProps {
  cards: ProjectCard[]
  properties: ProjectProperty[]
  chipProperties: ProjectProperty[]
  fields: ProjectViewFields
  badgesFor: (cardId: string) => ProjectCardBadges
  coverFor?: (cardId: string) => string | null
  canEdit: boolean
  onOpenCard: (id: string) => void
  onCardContextMenu: (event: MouseEvent, card: ProjectCard) => void
  onPatchFields: (fields: Partial<ProjectViewFields>) => void
  onAddCard: (title: string, optionId: string) => Promise<void>
}

export function GalleryView(props: GalleryProps): ReactElement {
  const { cards, properties, fields, canEdit } = props
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const size = fields.galleryCardSize ?? 'medium'
  const ids = new Set(cards.map((card) => card.id))
  const children = new Map<string, ProjectCard[]>()
  for (const card of cards) {
    if (!card.parentId || !ids.has(card.parentId)) continue
    const list = children.get(card.parentId)
    if (list) list.push(card)
    else children.set(card.parentId, [card])
  }
  const roots = cards.filter((card) => !card.parentId || !ids.has(card.parentId))
  const groupProperty = properties.find((property) => property.id === fields.groupById)
  const groups = groupProjectCards(roots, fields.groupById, properties)
  const entries: [string, ProjectCard[]][] = groupProperty
    ? [...groupProperty.options.map((option) => option.id), ''].map((key) => [key, groups.get(key) ?? []])
    : [...groups.entries()]
  const colorOf = (card: ProjectCard): string => projectCardColor(card, properties)

  return (
    <ViewShell data-view="gallery">
      <ViewHead icon={<LayoutGrid size={15} aria-hidden="true" />} title={t('project.view.gallery')} count={roots.length}>
        <Seg
          value={size}
          label={t('project.view.gallery_size')}
          onChange={(next) => props.onPatchFields({ galleryCardSize: next })}
          options={[
            { value: 'small', label: t('project.view.gallery_small') },
            { value: 'medium', label: t('project.view.gallery_medium') },
            { value: 'large', label: t('project.view.gallery_large') },
          ]}
        />
      </ViewHead>
      <div className="pv-gallery pv-scroll">
        {entries.map(([key, groupCards]) => {
          const collapsed = fields.collapsedOptionIds.includes(key)
          const label = key === '' ? t('project.view.no_value') : projectOptionLabel(groupProperty!, key)
          return (
            <section key={key || 'empty'} aria-label={label} data-gallery-group={key} className="mb-5">
              {fields.groupById && (
                <button
                  type="button"
                  className="pv-group-head"
                  aria-expanded={!collapsed}
                  onClick={() => props.onPatchFields({
                    collapsedOptionIds: collapsed ? fields.collapsedOptionIds.filter((entry) => entry !== key) : [...fields.collapsedOptionIds, key],
                  })}
                >
                  {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  {groupProperty && key !== '' ? <OptionChip property={groupProperty} value={key} /> : <span>{label}</span>}
                  <span className="pv-head-count">{groupCards.length}</span>
                </button>
              )}
              {!collapsed && (
                <div className="pv-gallery-grid" style={{ '--pv-tile-w': TILE_WIDTH[size], '--pv-cover-h': COVER_HEIGHT[size] } as React.CSSProperties}>
                  {groupCards.map((card) => (
                    <GalleryTile
                      key={card.id}
                      card={card}
                      color={colorOf(card)}
                      cover={props.coverFor?.(card.id) ?? null}
                      chipProperties={props.chipProperties}
                      showTitle={fields.galleryShowTitle !== false}
                      showBadges={fields.galleryShowBadges !== false}
                      badges={props.badgesFor(card.id)}
                      subtasks={children.get(card.id) ?? []}
                      expanded={expanded.has(card.id)}
                      onToggle={() => setExpanded((current) => {
                        const next = new Set(current)
                        if (next.has(card.id)) next.delete(card.id)
                        else next.add(card.id)
                        return next
                      })}
                      childCover={(id) => props.coverFor?.(id) ?? null}
                      onOpenCard={props.onOpenCard}
                      onCardContextMenu={props.onCardContextMenu}
                    />
                  ))}
                  {canEdit && (
                    <div className="pv-tile-add">
                      <QuickAdd label={t('project.board.new_card')} onAdd={(title) => props.onAddCard(title, key)} className="w-full px-3" />
                    </div>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </ViewShell>
  )
}
function GalleryTile({ card, color, cover, chipProperties, showTitle, showBadges, badges, subtasks, expanded, onToggle, childCover, onOpenCard, onCardContextMenu }: {
  card: ProjectCard
  color: string
  cover: string | null
  chipProperties: readonly ProjectProperty[]
  showTitle: boolean
  showBadges: boolean
  badges: ProjectCardBadges
  subtasks: readonly ProjectCard[]
  expanded: boolean
  onToggle: () => void
  childCover: (id: string) => string | null
  onOpenCard: (id: string) => void
  onCardContextMenu: (event: MouseEvent, card: ProjectCard) => void
}): ReactElement {
  return (
    <article className="pv-tile" data-gallery-tile={card.id} style={{ '--pv-card-color': color } as React.CSSProperties}>
      <button
        type="button"
        data-project-card={card.id}
        aria-label={card.title || t('project.board.untitled_card')}
        className="flex flex-col text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        onClick={() => onOpenCard(card.id)}
        onContextMenu={(event) => onCardContextMenu(event, card)}
      >
        {cover
          ? <img src={cover} alt="" className="pv-tile-cover" loading="lazy" />
          : (
            <span className="pv-tile-placeholder" aria-hidden="true">
              {card.icon || <SquareKanban size={26} className="text-[var(--text-quaternary)]" />}
            </span>
          )}
        <span className="pv-tile-body">
          {showTitle && <span className="pv-tile-title">{card.title || t('project.board.untitled_card')}</span>}
          {chipProperties.slice(0, 3).map((property) => (
            <span key={property.id} className="min-w-0 max-w-full truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {property.type === 'select' && card.values[property.id]
                ? <OptionChip property={property} value={card.values[property.id]!} />
                : projectPropertyDisplayText(card, property)}
            </span>
          ))}
          {showBadges && <CardBadges badges={badges} />}
        </span>
      </button>
      {subtasks.length > 0 && (
        <div className="px-2.5 pb-2.5">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? t('project.card.collapse_subtasks') : t('project.card.expand_subtasks')}
            className="flex items-center gap-1 rounded-[var(--r-full)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            onClick={onToggle}
          >
            <ListTodo size={11} aria-hidden="true" />
            <span>{subtasks.length}</span>
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
          {expanded && (
            <div className="mt-2 space-y-1 border-l-2 border-[var(--border-subtle)] pl-2" data-gallery-children={card.id}>
              {subtasks.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  data-project-card={child.id}
                  className="flex w-full items-center gap-1 rounded-[var(--r-xs)] bg-[var(--bg-sunken)] px-1.5 py-1 text-left text-[length:var(--text-12)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  onClick={() => onOpenCard(child.id)}
                  onContextMenu={(event) => onCardContextMenu(event, child)}
                >
                  <CornerDownRight size={11} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
                  <span className="min-w-0 truncate">{child.title || t('project.board.untitled_card')}</span>
                  {childCover(child.id) && <img src={childCover(child.id)!} alt="" className="ml-auto size-6 shrink-0 rounded-[var(--r-xs)] object-cover" />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  )
}
