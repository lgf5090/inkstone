import type { HubAttachmentWithUsage } from '@shared/attachment-hub'

/**
 * The Markdown the attachment centre writes into a note when the reader picks a file.
 *
 * Its own module because the host that offers the action lives above the container switch and must
 * not drag the whole centre — and its tree, filters and QR renderer — into the boot chunk just to
 * know how to spell one link.
 */

/** A link label or alt text is Markdown, so its own brackets have to survive as text. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/[[\]]/g, '\\$&')
}

export function attachmentInsertMarkdown(file: HubAttachmentWithUsage): string {
  const link = `[${escapeLabel(file.filename)}](${file.url})`
  // The filename becomes the label rather than an empty `![]()`: a note has to stay readable in a
  // plain text editor, and an image with no alt text is a mystery to anyone reading the source.
  // Non-images get their own line so a link cannot end up glued to the end of a sentence.
  return file.mime.startsWith('image/') ? `!${link}` : `\n${link}\n`
}
