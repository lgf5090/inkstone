import { useState } from 'react'
import { Package, Star } from 'lucide-react'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { useFavorite } from '../../lib/favorites'
import { useCfT } from '../../i18n'
import type { TemplateItem } from '../../api/store'
import { templateKey, templateTypeLabelKey } from './helpers'

const TAG_LIMIT = 4

function TemplateIcon({ icon }: { icon?: string }) {
  const [failed, setFailed] = useState(false)
  const url = icon && /^(https?:|data:)/.test(icon) ? icon : ''
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        onError={() => setFailed(true)}
        className="size-8 shrink-0 rounded-[var(--r-sm)] object-cover"
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent-soft)] text-[length:var(--text-16)] text-[var(--accent-on-soft)]"
    >
      {url ? <Package size={16} /> : icon || <Package size={16} />}
    </span>
  )
}

export function StoreCard({
  item,
  onDetail,
  onDeploy,
}: {
  item: TemplateItem
  onDetail: (item: TemplateItem) => void
  onDeploy: (item: TemplateItem) => void
}) {
  const t = useCfT()
  const [favorite, toggleFavorite] = useFavorite(templateKey(item))
  const template = item.template
  const authorName = template.author?.name ?? t('cloudflare.store_card.unknown')
  const tags = (template.tags ?? []).slice(0, TAG_LIMIT)

  return (
    <article className="flex min-w-0 flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-raised)]">
      <div className="flex items-start gap-2.5 p-3">
        <TemplateIcon icon={template.icon} />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => onDetail(item)}
            className="block max-w-full truncate rounded-[var(--r-xs)] text-left text-[length:var(--text-13)] font-semibold text-[var(--text-primary)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            {template.name}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone="accent">{t(templateTypeLabelKey(template.type))}</Badge>
            <Badge>{template.version}</Badge>
            {item.sourceCount > 1 ? (
              <Badge>{t('cloudflare.store.multi_source', { count: item.sourceCount })}</Badge>
            ) : null}
          </div>
        </div>
        <IconButton
          label={favorite ? t('cloudflare.store_card.unfav') : t('cloudflare.store_card.fav')}
          size="sm"
          active={favorite}
          onClick={toggleFavorite}
          className={favorite ? 'text-[var(--warning)]' : undefined}
        >
          <Star size={14} className={favorite ? 'fill-current' : undefined} />
        </IconButton>
      </div>

      <p className="line-clamp-2 min-h-9 px-3 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
        {template.description || t('cloudflare.store_card.no_desc')}
      </p>

      {tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1 px-3">
          {tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}
        </div>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-2 px-3 pt-2.5 pb-3">
        <span className="min-w-0 truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {template.author?.url ? (
            <a
              href={template.author.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent)] hover:underline"
            >
              {t('cloudflare.store_card.by', { name: authorName })}
            </a>
          ) : (
            t('cloudflare.store_card.by', { name: authorName })
          )}
        </span>
        <Button size="sm" variant="primary" onClick={() => onDeploy(item)}>
          {t('cloudflare.store_card.deploy')}
        </Button>
      </div>
    </article>
  )
}
