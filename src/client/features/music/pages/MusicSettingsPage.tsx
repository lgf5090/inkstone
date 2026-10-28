/**
 * Music preferences: the account's server settings and this device's playback preferences.
 *
 * Controls write immediately (the store debounces server writes and rolls a failed one back), so
 * there is no save button that could disagree with what the player already applied.
 */
import { useEffect, useState, type ReactElement } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import { formatBytes } from '@shared/music/format'
import { MUSIC_STAGE_STYLES, type MusicQuality, type MusicSettings } from '@shared/music/model'
import { Button } from '../../../components/primitives'
import { Input, Segmented, SettingRow, Slider, Switch } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { navigateToPath } from '../../../lib/app-history'
import { t } from '../../../lib/i18n'
import { CloudSourceSettings } from '../components/CloudSourceSettings'
import { SectionHeader } from '../components/SectionHeader'
import {
  LYRIC_FONT_SIZE_RANGE,
  LYRIC_LINE_HEIGHT_RANGE,
  useMusicSettings,
} from '../store/settings'
import { useMusicUi } from '../store/ui'
import { useMusicQuery } from '../query'
import { musicApi } from '../api'

const QUALITY_OPTIONS: ReadonlyArray<{ value: MusicQuality; key: MessageKey }> = [
  { value: 'standard', key: 'music.quality.standard' },
  { value: 'higher', key: 'music.quality.higher' },
  { value: 'exhigh', key: 'music.quality.exhigh' },
  { value: 'lossless', key: 'music.quality.lossless' },
  { value: 'hires', key: 'music.quality.hires' },
  { value: 'jyeffect', key: 'music.quality.jyeffect' },
  { value: 'sky', key: 'music.quality.sky' },
  { value: 'jymaster', key: 'music.quality.jymaster' },
]

const DOWNLOAD_FORMATS: ReadonlyArray<{ value: MusicSettings['downloadFormat']; key: MessageKey | null; label?: string }> = [
  { value: 'auto', key: 'music.format.auto' },
  { value: 'mp3', key: null, label: 'MP3' },
  { value: 'flac', key: null, label: 'FLAC' },
  { value: 'm4a', key: null, label: 'M4A' },
]

const SINGLE_MODES: ReadonlyArray<{ value: 'replace' | 'append'; key: MessageKey }> = [
  { value: 'replace', key: 'music.settings.single_mode_replace' },
  { value: 'append', key: 'music.settings.single_mode_append' },
]

const ALIGN_MODES: ReadonlyArray<{ value: 'center' | 'left'; key: MessageKey }> = [
  { value: 'center', key: 'music.settings.lyrics_align_center' },
  { value: 'left', key: 'music.settings.lyrics_align_left' },
]

const METHOD_MODES = [
  { value: 'GET', label: 'GET' },
  { value: 'POST', label: 'POST' },
] as const

function Section({ title, children }: { title: string; children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4">
      <SectionHeader title={title} className="pt-4" />
      {children}
    </section>
  )
}

export function MusicSettingsPage(): ReactElement {
  const server = useMusicSettings((state) => state.server)
  const local = useMusicSettings((state) => state.local)
  const serverStatus = useMusicSettings((state) => state.serverStatus)
  const serverError = useMusicSettings((state) => state.serverError)
  const loadServer = useMusicSettings((state) => state.loadServer)
  const saveServer = useMusicSettings((state) => state.saveServer)
  const setLocal = useMusicSettings((state) => state.setLocal)
  const setEq = useMusicSettings((state) => state.setEq)
  const clearSearchHistory = useMusicUi((state) => state.clearSearchHistory)
  const [nameFormat, setNameFormat] = useState(server.downloadNameFormat)
  const [resolverUrl, setResolverUrl] = useState(server.customResolverUrl)
  const [resolverPath, setResolverPath] = useState(server.customResolverResponsePath)
  const account = useMusicQuery(() => musicApi.account(), [])

  useEffect(() => {
    void loadServer()
  }, [loadServer])

  useEffect(() => {
    setNameFormat(server.downloadNameFormat)
    setResolverUrl(server.customResolverUrl)
    setResolverPath(server.customResolverResponsePath)
  }, [server.downloadNameFormat, server.customResolverUrl, server.customResolverResponsePath])

  const save = (patch: Partial<MusicSettings>): void => saveServer(patch)
  const qualityOptions = QUALITY_OPTIONS.map((option) => ({ value: option.value, label: t(option.key) }))
  const downloadOptions = DOWNLOAD_FORMATS.map((option) => ({
    value: option.value,
    label: option.key ? t(option.key) : option.label ?? option.value,
  }))
  const singleModes = SINGLE_MODES.map((option) => ({ value: option.value, label: t(option.key) }))
  const alignModes = ALIGN_MODES.map((option) => ({ value: option.value, label: t(option.key) }))

  return (
    <div className="music-settings">
      <SectionHeader level={1} title={t('music.settings.title')} description={t('music.settings.description')} />
      {serverError && (
        <p role="alert" className="rounded-[var(--r-md)] border border-[var(--danger)]/30 bg-[var(--danger)]/8 px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]">
          {t(serverError as MessageKey)}
        </p>
      )}
      {serverStatus === 'loading' && <LoadingBlock label={t('common.loading')} />}

      <Section title={t('music.settings.account.title')}>
        <SettingRow
          title={t('music.settings.account.status')}
          description={t('music.settings.account.description')}
        >
          <div className="flex items-center gap-2">
            {account.status === 'ready' && account.data?.account ? (
              <span className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
                {account.data.account.nickname}
              </span>
            ) : (
              <span className="text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">
                {t('music.settings.account.disconnected')}
              </span>
            )}
            <Button size="sm" variant="secondary" onClick={() => navigateToPath('/music/login')}>
              {t(account.data?.account ? 'music.settings.account.manage' : 'music.settings.account.connect')}
            </Button>
          </div>
        </SettingRow>
      </Section>

      <CloudSourceSettings />

      <Section title={t('music.settings.playback.title')}>
        <SettingRow title={t('music.settings.quality.title')} description={t('music.settings.quality.description')}>
          <SelectMenu
            label={t('music.settings.quality.title')}
            value={server.quality}
            options={qualityOptions.filter((option) => option.value !== 'original')}
            onChange={(quality) => save({ quality: quality as MusicSettings['quality'] })}
          />
        </SettingRow>
        <SettingRow title={t('music.settings.autoplay.title')}>
          <Switch checked={server.autoPlay} onChange={(autoPlay) => save({ autoPlay })} label={t('music.settings.autoplay.title')} />
        </SettingRow>
        <SettingRow title={t('music.settings.pure_mode.title')} description={t('music.settings.pure_mode.description')}>
          <Switch checked={server.pureMode} onChange={(pureMode) => save({ pureMode })} label={t('music.settings.pure_mode.title')} />
        </SettingRow>
        <SettingRow title={t('music.eq.leveling')} description={t('music.eq.leveling_hint')}>
          <Switch
            checked={local.eq.leveling}
            onChange={(leveling) => setEq({ leveling })}
            label={t('music.eq.leveling')}
          />
        </SettingRow>
        <SettingRow title={t('music.settings.normalize')} description={t('music.settings.normalize_hint')}>
          <Switch
            checked={local.normalize}
            onChange={(normalize) => setLocal({ normalize })}
            label={t('music.settings.normalize')}
          />
        </SettingRow>
        <SettingRow title={t('music.stage.style')} description={t('music.stage.style_hint')}>
          <Segmented
            value={local.stageStyle}
            options={MUSIC_STAGE_STYLES.map((style) => ({
              value: style,
              label: t(`music.stage.style.${style}` as MessageKey),
            }))}
            onChange={(stageStyle) => setLocal({ stageStyle })}
            label={t('music.stage.style')}
          />
        </SettingRow>
        <SettingRow title={t('music.stage.sparks')} description={t('music.stage.sparks_hint')}>
          <Switch
            checked={local.stageSparks}
            onChange={(stageSparks) => setLocal({ stageSparks })}
            label={t('music.stage.sparks')}
          />
        </SettingRow>
        <SettingRow title={t('music.comments.hot')} description={t('music.comments.hot_hint')}>
          <Switch
            checked={local.hotComments}
            onChange={(hotComments) => setLocal({ hotComments })}
            label={t('music.comments.hot')}
          />
        </SettingRow>
        <SettingRow title={t('music.settings.single_mode.title')}>
          <Segmented
            value={server.singleTrackMode}
            options={singleModes}
            onChange={(singleTrackMode) => save({ singleTrackMode })}
            label={t('music.settings.single_mode.title')}
          />
        </SettingRow>
      </Section>

      <Section title={t('music.settings.download.title')}>
        <SettingRow title={t('music.settings.download_quality.title')}>
          <SelectMenu
            label={t('music.settings.download_quality.title')}
            value={server.downloadQuality}
            options={qualityOptions}
            onChange={(downloadQuality) => save({ downloadQuality: downloadQuality as MusicSettings['downloadQuality'] })}
          />
        </SettingRow>
        <SettingRow title={t('music.settings.download_format.title')}>
          <SelectMenu
            label={t('music.settings.download_format.title')}
            value={server.downloadFormat}
            options={downloadOptions}
            onChange={(downloadFormat) => save({ downloadFormat: downloadFormat as MusicSettings['downloadFormat'] })}
          />
        </SettingRow>
        <SettingRow
          title={t('music.settings.download_concurrency.title')}
          description={t('music.settings.download_concurrency.description')}
        >
          <Slider
            label={t('music.settings.download_concurrency.title')}
            value={server.downloadConcurrency}
            min={1}
            max={5}
            step={1}
            onChange={(downloadConcurrency) => save({ downloadConcurrency })}
            suffix={String(server.downloadConcurrency)}
          />
        </SettingRow>
        <SettingRow title={t('music.settings.download_name.title')} description={t('music.settings.download_name.description')}>
          <Input
            value={nameFormat}
            aria-label={t('music.settings.download_name.title')}
            onChange={(event) => setNameFormat(event.target.value)}
            onBlur={() => save({ downloadNameFormat: nameFormat })}
          />
        </SettingRow>
      </Section>

      <Section title={t('music.settings.lyrics.title')}>
        <SettingRow title={t('music.settings.lyrics_font.title')}>
          <Slider
            label={t('music.settings.lyrics_font.title')}
            value={local.lyrics.fontSize}
            min={LYRIC_FONT_SIZE_RANGE.min}
            max={LYRIC_FONT_SIZE_RANGE.max}
            step={1}
            onChange={(fontSize) => setLocal({ lyrics: { ...local.lyrics, fontSize } })}
            suffix={`${local.lyrics.fontSize}px`}
          />
        </SettingRow>
        <SettingRow title={t('music.settings.lyrics_line_height.title')}>
          <Slider
            label={t('music.settings.lyrics_line_height.title')}
            value={local.lyrics.lineHeight}
            min={LYRIC_LINE_HEIGHT_RANGE.min}
            max={LYRIC_LINE_HEIGHT_RANGE.max}
            step={0.1}
            onChange={(lineHeight) => setLocal({ lyrics: { ...local.lyrics, lineHeight } })}
            suffix={local.lyrics.lineHeight.toFixed(1)}
          />
        </SettingRow>
        <SettingRow title={t('music.settings.lyrics_translation.title')}>
          <Switch
            checked={local.lyrics.showTranslation}
            onChange={(showTranslation) => setLocal({ lyrics: { ...local.lyrics, showTranslation } })}
            label={t('music.settings.lyrics_translation.title')}
          />
        </SettingRow>
        <SettingRow title={t('music.settings.lyrics_word.title')}>
          <Switch
            checked={local.lyrics.wordByWord}
            onChange={(wordByWord) => setLocal({ lyrics: { ...local.lyrics, wordByWord } })}
            label={t('music.settings.lyrics_word.title')}
          />
        </SettingRow>
        <SettingRow title={t('music.settings.lyrics_blur.title')}>
          <Switch
            checked={local.lyrics.blurBackground}
            onChange={(blurBackground) => setLocal({ lyrics: { ...local.lyrics, blurBackground } })}
            label={t('music.settings.lyrics_blur.title')}
          />
        </SettingRow>
        <SettingRow title={t('music.settings.lyrics_align.title')}>
          <Segmented
            value={local.lyrics.align}
            options={alignModes}
            onChange={(align) => setLocal({ lyrics: { ...local.lyrics, align } })}
            label={t('music.settings.lyrics_align.title')}
          />
        </SettingRow>
      </Section>

      <Section title={t('music.settings.sources.title')}>
        <SettingRow title={t('music.settings.sources_enabled.title')} description={t('music.settings.sources_enabled.description')}>
          <Switch
            checked={server.customResolverEnabled}
            onChange={(customResolverEnabled) => save({ customResolverEnabled })}
            label={t('music.settings.sources_enabled.title')}
          />
        </SettingRow>
        <SettingRow title={t('music.settings.sources_url.title')} description={t('music.settings.sources_url.description')}>
          <Input
            value={resolverUrl}
            aria-label={t('music.settings.sources_url.title')}
            onChange={(event) => setResolverUrl(event.target.value)}
            onBlur={() => save({ customResolverUrl: resolverUrl })}
            placeholder="https://resolver.example.test/audio"
          />
        </SettingRow>
        <SettingRow title={t('music.settings.sources_method.title')}>
          <Segmented
            value={server.customResolverMethod}
            options={[...METHOD_MODES]}
            onChange={(customResolverMethod) => save({ customResolverMethod })}
            label={t('music.settings.sources_method.title')}
          />
        </SettingRow>
        <SettingRow title={t('music.settings.sources_path.title')} description={t('music.settings.sources_path.description')}>
          <Input
            value={resolverPath}
            aria-label={t('music.settings.sources_path.title')}
            onChange={(event) => setResolverPath(event.target.value)}
            onBlur={() => save({ customResolverResponsePath: resolverPath })}
            placeholder="data.url"
          />
        </SettingRow>
      </Section>

      <Section title={t('music.settings.storage.title')}>
        <SettingRow title={t('music.settings.storage_quota.title')} description={t('music.settings.storage_quota.description')}>
          <span className="text-[length:var(--text-12-5)] tabular-nums text-[var(--text-secondary)]">
            {formatBytes(server.storageQuotaBytes)}
          </span>
        </SettingRow>
        <SettingRow title={t('music.settings.storage_search.title')}>
          <Button size="sm" variant="secondary" onClick={clearSearchHistory}>
            {t('music.settings.storage_clear')}
          </Button>
        </SettingRow>
      </Section>

      {serverStatus === 'idle' && !server && (
        <Empty title={t('music.settings.empty')} description={t('music.settings.empty_hint')} compact />
      )}
    </div>
  )
}
