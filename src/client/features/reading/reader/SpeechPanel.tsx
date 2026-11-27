import { Button, IconButton } from '../../../components/primitives'
import { Slider } from '../../../components/form'
import { t } from '../../../lib/i18n'

export interface SpeechPanelProps {
  playing: boolean
  paused: boolean
  sentence: string
  index: number
  total: number
  rate: number
  sleepMinutes: number
  onRate: (value: number) => void
  onSleep: (value: number) => void
  onPlayPause: () => void
  onStop: () => void
}

export function SpeechPanel({ playing, paused, sentence, index, total, rate, sleepMinutes, onRate, onSleep, onPlayPause, onStop }: SpeechPanelProps) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onPlayPause}>{playing && !paused ? t('reading.speech_pause') : t('reading.speech_play')}</Button>
        <IconButton label={t('reading.speech_stop')} size="sm" onClick={onStop}><span aria-hidden="true">■</span></IconButton>
        <span className="ms-auto text-[length:var(--text-11)] tabular text-[var(--text-tertiary)]">{index + 1} / {total}</span>
      </div>
      <p className="min-h-20 whitespace-pre-wrap rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-3 text-[length:var(--text-13)] leading-relaxed text-[var(--text-primary)]">
        {sentence || t('reading.speech_idle')}
      </p>
      <Slider label={t('reading.speech_rate')} value={rate} min={0.5} max={2} step={0.1} onChange={onRate} suffix="×" />
      <Slider label={t('reading.speech_sleep')} value={sleepMinutes} min={0} max={120} step={5} onChange={onSleep} />
    </div>
  )
}
