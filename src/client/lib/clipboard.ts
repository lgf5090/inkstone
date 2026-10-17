/**
 * Copying text, with a fallback for the places the modern API is not allowed.
 *
 * `navigator.clipboard` only exists in a secure context and only when the browser decides the document
 * is focused, so an app served over plain http — which a self-hosted one often is — would silently do
 * nothing on every copy press. The legacy `execCommand('copy')` path still works there, and the answer
 * is a boolean so the caller can say it failed rather than pretend it worked.
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Refused (insecure context, no permission, document not focused): the legacy path may still work.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    // Off-screen rather than hidden: a `display:none` field cannot be selected, and the selection is
    // what the legacy command copies.
    area.className = 'sr-only'
    document.body.appendChild(area)
    area.select()
    const copied = typeof document.execCommand === 'function' && document.execCommand('copy')
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}
