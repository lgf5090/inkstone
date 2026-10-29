/** The tab's address, read from the browser and answered with the same parser the tests use. */
import { useMemo } from 'react'
import { parseYouTubeAddress, type YouTubeAddress } from '@shared/youtube/model'
import { usePathname, useSearch } from '../../lib/app-history'
import { useYoutubeStore } from './store'

export function useYouTubeAddress(): YouTubeAddress {
  const pathname = usePathname()
  const search = useSearch()
  const sort = useYoutubeStore((state) => state.sort)
  const range = useYoutubeStore((state) => state.range)
  return useMemo(
    () => parseYouTubeAddress(pathname, search, { sort, range }),
    [pathname, search, sort, range],
  )
}
