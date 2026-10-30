import { renderMarkdown } from '../../lib/markdown/renderer'
import { getLocale } from '../../lib/i18n'
import { useSession } from '../../store/session'
import type { BlogRenderSnapshot } from '@shared/blog/model'

const RENDERER_VERSION = 'inkstone-blog-v1'

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashBlogContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  return hex(await crypto.subtle.digest('SHA-256', bytes))
}

/**
 * Build the public reading snapshot from the same markdown pipeline Preview uses. The snapshot is
 * plain renderer output; rich blocks that need the live enhancement pass stay visible to the runtime
 * through `features`, while the static HTML remains readable without it.
 */
export async function captureBlogSnapshot(noteId: string, content: string): Promise<BlogRenderSnapshot> {
  const emojiShortcodes = useSession.getState().settings.preview.emojiShortcodes
  const rendered = renderMarkdown(content, { hideFrontMatter: true, emojiShortcodes })
  const features: string[] = []
  if (rendered.hasMermaid) features.push('mermaid')
  if (rendered.hasMath) features.push('math')
  if (rendered.fences.kanban.length > 0) features.push('kanban')
  if (rendered.fences.excalidraw.length > 0) features.push('excalidraw')
  for (const [needle, feature] of [
    ['data-chart', 'chart'],
    ['data-mindmap', 'mindmap'],
    ['data-json', 'json'],
    ['data-dataview', 'dataview'],
  ] as const) {
    if (rendered.html.includes(needle)) features.push(feature)
  }
  return {
    version: 1,
    rendererVersion: RENDERER_VERSION,
    noteId,
    contentHash: await hashBlogContent(content),
    html: rendered.html,
    headings: rendered.headings.map((heading) => ({
      depth: heading.level,
      slug: heading.slug,
      text: heading.text,
    })),
    fences: {
      kanban: [...rendered.fences.kanban],
      excalidraw: [...rendered.fences.excalidraw],
    },
    features,
    assets: [],
    wikiLinks: [],
    settings: { locale: getLocale(), emojiShortcodes },
    generatedAt: Date.now(),
    warnings: [],
  }
}
