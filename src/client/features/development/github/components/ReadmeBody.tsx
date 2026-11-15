import { useEffect, useRef, type RefObject } from 'react'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { copyText } from '../../../../lib/clipboard'
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
  const copyLabel = t('common.copy')
  const plainTextLabel = t('development.github.repos.readme_text')

  useEffect(() => {
    const node = ref.current
    if (!node) return
    decorateCodeBlocks(node, { copy: copyLabel, plainText: plainTextLabel })
  }, [html, copyLabel, plainTextLabel, ref])

  return (
    <div
      ref={ref}
      className={cn('github-readme ink-prose max-w-none overflow-x-auto', className)}
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]')
        if (!button) return
        const code = button.closest('.gh-code')?.querySelector('code')
        if (!code) return
        void copyText(code.textContent ?? '').then((ok) => {
          if (!ok) return
          button.textContent = t('common.copied')
          window.setTimeout(() => { button.textContent = copyLabel }, 1_500)
        })
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
