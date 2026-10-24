import { MarkdownBody } from '../preview/MarkdownBody'
import { prepareShareMarkup } from '../share/share-markdown'

export function EmailMarkdownBody({ source }: { source: string }) {
  return (
    <MarkdownBody
      source={source}
      className="email-markdown-prose"
      transformHtml={prepareShareMarkup}
    />
  )
}
