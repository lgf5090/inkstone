import { useEffect, useRef, type RefObject } from 'react'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { copyText } from '../../../../lib/clipboard'
import { useUi } from '../../../../store/ui'
import { decorateCodeBlocks } from '../../../../lib/markdown/code-blocks'

export function ReadmeBody({
  html,
  className,
  contentRef,
}: {
  html: string
  className?: string
  contentRef?: RefObject<HTMLDivElement | null>
}) {
  const localRef = useRef<HTMLDivElement>(null)
  const ref = contentRef ?? localRef
  const setLightbox = useUi((state) => state.setLightbox)
  const copyLabel = t('common.copy')
  const plainTextLabel = t('development.github.repos.readme_text')
  const expandLabel = t('development.github.common.expand')
  const collapseLabel = t('common.collapse')

  useEffect(() => {
    const node = ref.current
    if (!node) return
    decorateCodeBlocks(node, {
      copy: copyLabel,
      plainText: plainTextLabel,
      expand: expandLabel,
      collapse: collapseLabel,
    })
  }, [html, copyLabel, plainTextLabel, expandLabel, collapseLabel, ref])

  return (
    <div
      ref={ref}
      className={cn('github-readme max-w-none overflow-x-auto', className)}
      onClick={(event) => {
        const target = event.target as HTMLElement
        const button = target.closest<HTMLButtonElement>('[data-copy-code]')
        if (button) {
          const code = button.closest('.gh-code')?.querySelector('code')
          if (!code) return
          void copyText(code.textContent ?? '').then((ok) => {
            if (!ok) return
            button.textContent = t('common.copied')
            window.setTimeout(() => { button.textContent = copyLabel }, 1_500)
          })
          return
        }
        const expandButton = target.closest<HTMLButtonElement>('[data-expand-code]')
        if (expandButton) {
          const block = expandButton.closest('.gh-code')
          if (!block) return
          const expanded = block.classList.toggle('is-expanded')
          block.classList.toggle('is-collapsed', !expanded)
          expandButton.setAttribute('aria-expanded', String(expanded))
          expandButton.textContent = (expanded
            ? expandButton.dataset.collapseLabel
            : expandButton.dataset.expandLabel) ?? ''
          return
        }
        const image = target.closest('img')
        if (!image || image.closest('a')) return
        const src = image.getAttribute('src')
        if (!src) return
        event.preventDefault()
        setLightbox({ src, alt: image.getAttribute('alt') ?? '' })
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
