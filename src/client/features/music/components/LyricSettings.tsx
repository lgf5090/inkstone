/**
 * Lyric appearance, edited where the lyric is read.
 *
 * Every control writes straight to the device-local lyric preferences; there is no draft and no save
 * button, because a font size is judged by looking at the line it changes. The same panel is mounted
 * by the side panel and the full-screen layer, so a reader can tune the type in either place.
 */
import { useId, type ReactElement } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '../../../components/primitives'
import { Segmented, SettingRow, Slider, Switch } from '../../../components/form'
import { cn } from '../../../lib/cn'
import {
  DEFAULT_LYRIC_PREFERENCES,
  LYRIC_FONT_SIZE_RANGE,
  LYRIC_LINE_HEIGHT_RANGE,
  useMusicSettings,
} from '../store/settings'
import { musicText } from './labels'

export interface LyricSettingsProps {
  className?: string
}

export function LyricSettings({ className }: LyricSettingsProps): ReactElement {
  const preferences = useMusicSettings((state) => state.local.lyrics)
  const setLyrics = useMusicSettings((state) => state.setLyrics)
  const sizeId = useId()
  const heightId = useId()

  return (
    <section
      aria-label={musicText('music.lyrics.settings')}
      className={cn('flex flex-col px-3 py-1', className)}
    >
      <SettingRow title={musicText('music.lyrics.font_size')} controlId={sizeId}>
        <Slider
          id={sizeId}
          label={musicText('music.lyrics.font_size')}
          value={preferences.fontSize}
          min={LYRIC_FONT_SIZE_RANGE.min}
          max={LYRIC_FONT_SIZE_RANGE.max}
          step={1}
          suffix="px"
          onChange={(value) => setLyrics({ fontSize: value })}
        />
      </SettingRow>

      <SettingRow title={musicText('music.lyrics.line_height')} controlId={heightId}>
        <Slider
          id={heightId}
          label={musicText('music.lyrics.line_height')}
          value={preferences.lineHeight}
          min={LYRIC_LINE_HEIGHT_RANGE.min}
          max={LYRIC_LINE_HEIGHT_RANGE.max}
          step={0.1}
          onChange={(value) => setLyrics({ lineHeight: Math.round(value * 10) / 10 })}
        />
      </SettingRow>

      <SettingRow title={musicText('music.lyrics.align')}>
        <Segmented
          value={preferences.align}
          label={musicText('music.lyrics.align')}
          options={[
            { value: 'left', label: musicText('music.lyrics.align_left') },
            { value: 'center', label: musicText('music.lyrics.align_center') },
          ]}
          onChange={(align) => setLyrics({ align })}
        />
      </SettingRow>

      <SettingRow title={musicText('music.lyrics.translation')}>
        <Switch
          checked={preferences.showTranslation}
          label={musicText('music.lyrics.translation')}
          onChange={(showTranslation) => setLyrics({ showTranslation })}
        />
      </SettingRow>

      <SettingRow title={musicText('music.lyrics.word_by_word')}>
        <Switch
          checked={preferences.wordByWord}
          label={musicText('music.lyrics.word_by_word')}
          onChange={(wordByWord) => setLyrics({ wordByWord })}
        />
      </SettingRow>

      <SettingRow title={musicText('music.lyrics.blur_background')}>
        <Switch
          checked={preferences.blurBackground}
          label={musicText('music.lyrics.blur_background')}
          onChange={(blurBackground) => setLyrics({ blurBackground })}
        />
      </SettingRow>

      <div className="flex justify-end py-2">
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCcw size={13} />}
          onClick={() => setLyrics(DEFAULT_LYRIC_PREFERENCES)}
        >
          {musicText('music.lyrics.reset')}
        </Button>
      </div>
    </section>
  )
}
