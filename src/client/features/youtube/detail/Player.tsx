/** The embedded player surface: one privacy-enhanced iframe, rebuilt whenever the video changes. */
import type { YouTubeVideo } from '@shared/youtube/model'

const EMBED_ORIGIN = 'https://www.youtube-nocookie.com'
const ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'

export function Player({ video }: { video: YouTubeVideo }) {
  return (
    <div className="shrink-0 bg-[var(--yt-player-bg,black)]">
      <div className="mx-auto aspect-video w-full max-w-[48rem]">
        <iframe
          key={video.id}
          src={`${EMBED_ORIGIN}/embed/${encodeURIComponent(video.id)}?rel=0`}
          title={video.title?.trim() || video.id}
          allow={ALLOW}
          allowFullScreen
          className="h-full w-full border-0"
        />
      </div>
    </div>
  )
}
