import type { ResolvedNoteAttachment } from '../../store/note-locks'
import { privateAttachmentId } from '../../lib/private-attachment-url'

type ResolveAttachment = (attachmentId: string) => Promise<ResolvedNoteAttachment>

const ATTACHMENT_ATTRIBUTES = ['src', 'href', 'poster'] as const
const ATTACHMENT_SELECTOR = ATTACHMENT_ATTRIBUTES.map((attribute) => `[${attribute}]`).join(',')

export async function resolveEncryptedPreviewAttachments(
  root: HTMLElement,
  resolveAttachment: ResolveAttachment,
  failureMessage: string,
): Promise<void> {
  const targets: Array<{ element: Element; attribute: string; attachmentId: string }> = []
  for (const element of root.querySelectorAll(ATTACHMENT_SELECTOR)) {
    for (const attribute of ATTACHMENT_ATTRIBUTES) {
      if (!element.hasAttribute(attribute)) continue
      const attachmentId = privateAttachmentId(element.getAttribute(attribute))
      if (attachmentId) targets.push({ element, attribute, attachmentId })
    }
  }
  const loads = new Map<string, ReturnType<ResolveAttachment>>()
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const target = targets[next++]
      if (!target) break
      try {
        let load = loads.get(target.attachmentId)
        if (!load) {
          load = resolveAttachment(target.attachmentId)
          loads.set(target.attachmentId, load)
        }
        const resolved = await load
        target.element.setAttribute(target.attribute, resolved.url)
        if (target.attribute === 'href') {
          target.element.setAttribute('download', resolved.filename)
        }
      } catch (error) {
        console.warn('[inkstone] encrypted attachment could not be opened', target.attachmentId, error)
        target.element.removeAttribute(target.attribute)
        target.element.setAttribute('data-attachment-error', 'true')
        target.element.setAttribute('title', failureMessage)
        if (target.element.matches('img, video, audio, iframe')) {
          const message = document.createElement('span')
          message.className = 'attachment-decrypt-error'
          message.setAttribute('role', 'img')
          message.setAttribute('aria-label', failureMessage)
          message.textContent = failureMessage
          target.element.replaceWith(message)
        } else if (target.element.matches('a')) {
          target.element.setAttribute('aria-disabled', 'true')
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker))
}
