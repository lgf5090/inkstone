import { ChevronRight } from 'lucide-react'
import type { YouTubeTagNode } from '@shared/youtube/model'
import { youtubeViewPath } from '@shared/youtube/model'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { IconButton } from '../../../components/primitives'
import { SidebarLink } from './SidebarLink'

const TAG_INDENT_BASE = 8
const TAG_INDENT_STEP = 12

export function TagTree({
  nodes,
  expandedTags,
  activeTagId,
  countFor,
  onToggle,
  onSelect,
}: {
  nodes: YouTubeTagNode[]
  expandedTags: ReadonlySet<string>
  activeTagId: string | null
  countFor: (tagId: string) => number
  onToggle: (tagId: string) => void
  onSelect: (tagId: string) => void
}) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => (
        <TagNodeRow
          key={node.id}
          node={node}
          depth={0}
          expandedTags={expandedTags}
          activeTagId={activeTagId}
          countFor={countFor}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

function TagNodeRow({
  node,
  depth,
  expandedTags,
  activeTagId,
  countFor,
  onToggle,
  onSelect,
}: {
  node: YouTubeTagNode
  depth: number
  expandedTags: ReadonlySet<string>
  activeTagId: string | null
  countFor: (tagId: string) => number
  onToggle: (tagId: string) => void
  onSelect: (tagId: string) => void
}) {
  const expanded = expandedTags.has(node.id)
  const hasChildren = node.children.length > 0
  return (
    <div>
      <div
        data-tag-depth={depth}
        className="flex min-w-0 items-center"
        style={{ paddingLeft: TAG_INDENT_BASE + depth * TAG_INDENT_STEP }}
      >
        {hasChildren ? (
          <IconButton
            label={expanded ? t('youtube.sidebar.collapse') : t('youtube.sidebar.expand')}
            size="xs"
            aria-expanded={expanded}
            onClick={() => onToggle(node.id)}
          >
            <ChevronRight
              size={12}
              className={cn('transition-transform duration-[var(--dur-fast)]', expanded && 'rotate-90')}
            />
          </IconButton>
        ) : (
          <span className="size-6 shrink-0" aria-hidden="true" />
        )}
        <SidebarLink
          href={youtubeViewPath({ kind: 'tag', tagId: node.id })}
          label={node.name}
          icon={
            <span
              className="size-2 rounded-[var(--r-full)]"
              style={{ backgroundColor: node.color }}
            />
          }
          count={countFor(node.id)}
          active={activeTagId === node.id}
          onActivate={() => onSelect(node.id)}
        />
      </div>
      {hasChildren && expanded && (
        <div className="space-y-0.5">
          {node.children.map((child) => (
            <TagNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expandedTags={expandedTags}
              activeTagId={activeTagId}
              countFor={countFor}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}
