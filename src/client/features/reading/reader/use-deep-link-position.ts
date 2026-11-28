import { useState } from 'react'
import { decodePosition, type BookPosition } from '../position'

export function useDeepLinkPosition(): BookPosition | null {
  const [position] = useState<BookPosition | null>(() => {
    const linked = decodePosition(new URLSearchParams(window.location.search).get('p'))
    if (linked) window.history.replaceState(null, '', window.location.pathname)
    return linked
  })
  return position
}
