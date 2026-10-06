import { PINNED_WINDOW_PRESETS } from '@shared/constants'
import { useSession } from '../store/session'

export function pinnedWindowSize(): { width: number, height: number } {
  const preview = useSession.getState().settings.preview
  if (preview.pinnedWindowSize === 'custom')
    return { width: preview.pinnedWindowWidth, height: preview.pinnedWindowHeight }
  return PINNED_WINDOW_PRESETS[preview.pinnedWindowSize]
}

export function withPinnedWindowSize(rect: DOMRect): DOMRect {
  const { width, height } = pinnedWindowSize()
  return new DOMRect(rect.left, rect.top, width, height)
}
