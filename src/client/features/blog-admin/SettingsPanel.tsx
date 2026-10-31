import { useEffect, useState, type ReactNode } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import type { BlogSettings } from '@shared/blog/settings'
import { BLOG_SETTING_KEYS, type BlogSettingKey } from '@shared/blog/settings'
import { Button } from '../../components/primitives'
import { Checkbox, Field, Input, Select, Textarea } from '../../components/form'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { PageHeader, TabBar } from './shared'

type SettingsTab = 'general' | 'reading' | 'discussion' | 'appearance' | 'seo' | 'advanced'

const TABS: { id: SettingsTab; label: MessageKey }[] = [
  { id: 'general', label: 'blog.admin.settings_general' },
  { id: 'reading', label: 'blog.admin.settings_reading' },
  { id: 'discussion', label: 'blog.admin.settings_discussion' },
  { id: 'appearance', label: 'blog.admin.settings_appearance' },
  { id: 'seo', label: 'blog.admin.settings_seo' },
  { id: 'advanced', label: 'blog.admin.settings_advanced' },
]

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'id', 'th', 'tr', 'vi']
const THEME_STYLES = ['tonalSpot', 'vibrant', 'expressive', 'fidelity', 'content', 'monochrome', 'neutral', 'rainbow', 'fruitSalad']

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function strList(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => String(item)).join(', ') : ''
}

export function SettingsPanel({ settings, onSaved }: { settings: BlogSettings | null; onSaved?: () => Promise<void> }) {
  const toast = useUi((state) => state.toast)
  const [tab, setTab] = useState<SettingsTab>('general')
  const [saving, setSaving] = useState(false)
  const [site, setSite] = useState<Record<string, unknown>>({})
  const [display, setDisplay] = useState<Record<string, unknown>>({})
  const [article, setArticle] = useState<Record<string, unknown>>({})
  const [discussion, setDiscussion] = useState<Record<string, unknown>>({})
  const [comment, setComment] = useState<Record<string, unknown>>({})
  const [announcement, setAnnouncement] = useState<Record<string, unknown>>({})
  const [footer, setFooter] = useState<Record<string, unknown>>({})
  const [license, setLicense] = useState<Record<string, unknown>>({})
  const [music, setMusic] = useState<Record<string, unknown>>({})
  const [musicTracksText, setMusicTracksText] = useState('[]')
  const [umami, setUmami] = useState<Record<string, unknown>>({})
  const [fab, setFab] = useState<Record<string, unknown>>({})
  const [contextMenu, setContextMenu] = useState<Record<string, unknown>>({})
  const [llms, setLlms] = useState<Record<string, unknown>>({})
  const [permalink, setPermalink] = useState<Record<string, unknown>>({})
  const [advancedDomain, setAdvancedDomain] = useState<BlogSettingKey>('nav')
  const [advancedJson, setAdvancedJson] = useState('{}')
  const [advancedError, setAdvancedError] = useState('')

  useEffect(() => {
    if (!settings) return
    setSite(settings.site)
    setDisplay(settings.display)
    setArticle(settings.article)
    setDiscussion(settings.discussion)
    setComment(settings.comment)
    setAnnouncement(settings.announcement)
    setFooter(settings.footer)
    setLicense(settings.license)
    setMusic(settings.music)
    setMusicTracksText(JSON.stringify(settings.music.tracks ?? [], null, 2))
    setUmami(settings.umami)
    setFab(settings.fab)
    setContextMenu(settings.contextMenu)
    setLlms(settings.llms)
    setPermalink(settings.permalink)
    setAdvancedJson(JSON.stringify(settings[advancedDomain], null, 2))
  }, [settings, advancedDomain])

  const saveDomain = async (key: BlogSettingKey, value: Record<string, unknown>) => {
    setSaving(true)
    try {
      await api.blog.settings.patch(key, value)
      toast({ title: t('blog.admin.saved'), tone: 'success' })
      await onSaved?.()
    } catch (error) {
      toast({ title: t('blog.admin.save_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  const saveMusic = async () => {
    let tracks: unknown
    try {
      tracks = JSON.parse(musicTracksText || '[]')
    } catch {
      toast({ title: t('blog.admin.music_tracks_invalid'), tone: 'danger' })
      return
    }
    if (!Array.isArray(tracks)) {
      toast({ title: t('blog.admin.music_tracks_invalid'), tone: 'danger' })
      return
    }
    const next = { ...music, tracks }
    setMusic(next)
    await saveDomain('music', next)
    await saveDomain('umami', umami)
  }

  const saveAdvanced = async () => {
    setAdvancedError('')
    setSaving(true)
    try {
      const parsed = JSON.parse(advancedJson) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('blog.admin.advanced_invalid'))
      await api.blog.settings.patch(advancedDomain, parsed)
      toast({ title: t('blog.admin.saved'), tone: 'success' })
      await onSaved?.()
    } catch (error) {
      setAdvancedError(error instanceof SyntaxError ? t('blog.admin.advanced_invalid') : error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  if (!settings) return null

  const themeColor = (site.themeColor ?? {}) as { hue?: unknown; style?: unknown; spec?: unknown }
  const banner = (site.banner ?? {}) as Record<string, unknown>
  const setBannerField = (key: string, value: string) => setSite({ ...site, banner: { ...banner, [key]: value } })

  return (
    <div className="mx-auto max-w-[980px]">
      <PageHeader title={t('blog.admin.settings')} description={t('blog.admin.settings_subtitle')} />
      <TabBar tabs={TABS.map((item) => ({ id: item.id, label: t(item.label) }))} value={tab} onChange={setTab} label={t('blog.admin.settings')} />

      <div className="mt-4 space-y-4">
        {tab === 'general' && (
          <Section title={t('blog.admin.site_section')} onSave={() => void saveDomain('site', site)} saving={saving}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('blog.admin.site_title')}><Input value={text(site.title)} onChange={(event) => setSite({ ...site, title: event.target.value })} /></Field>
              <Field label={t('blog.admin.site_subtitle')}><Input value={text(site.subtitle)} onChange={(event) => setSite({ ...site, subtitle: event.target.value })} /></Field>
            </div>
            <Field label={t('blog.admin.site_description')}><Textarea rows={3} value={text(site.description)} onChange={(event) => setSite({ ...site, description: event.target.value })} /></Field>
            <Field label={t('blog.admin.site_url')} hint={t('blog.admin.site_url_hint')}><Input value={text(site.url)} onChange={(event) => setSite({ ...site, url: event.target.value })} placeholder="https://" /></Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('blog.admin.site_locale')}>
                <Select value={text(site.locale) || 'en'} onChange={(event) => setSite({ ...site, locale: event.target.value })}>
                  {LOCALES.map((code) => <option key={code} value={code}>{code}</option>)}
                </Select>
              </Field>
              <Field label={t('blog.admin.site_timezone')}><Input value={text(site.timeZone) || 'UTC'} onChange={(event) => setSite({ ...site, timeZone: event.target.value })} /></Field>
              <Field label={t('blog.admin.theme_hue')}><Input type="number" min={0} max={360} value={num(themeColor.hue, 315)} onChange={(event) => setSite({ ...site, themeColor: { ...themeColor, hue: Number(event.target.value) } })} /></Field>
            </div>
            <Field label={t('blog.admin.theme_style')}>
              <Select value={text(themeColor.style) || 'tonalSpot'} onChange={(event) => setSite({ ...site, themeColor: { ...themeColor, style: event.target.value } })}>
                {THEME_STYLES.map((style) => <option key={style} value={style}>{style}</option>)}
              </Select>
            </Field>
            <Field label={t('blog.admin.theme_spec')}>
              <Select value={text(themeColor.spec) === '2021' ? '2021' : '2025'} onChange={(event) => setSite({ ...site, themeColor: { ...themeColor, spec: event.target.value } })}>
                <option value="2025">{t('blog.admin.theme_spec_2025')}</option>
                <option value="2021">{t('blog.admin.theme_spec_2021')}</option>
              </Select>
            </Field>
          </Section>
        )}

        {tab === 'reading' && (
          <>
            <Section title={t('blog.admin.settings_display')} onSave={() => void saveDomain('display', display)} saving={saving}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('blog.admin.post_list_mode')}>
                  <Select value={text(display.postListMode) || 'list'} onChange={(event) => setDisplay({ ...display, postListMode: event.target.value })}>
                    <option value="list">{t('blog.admin.post_list_list')}</option>
                    <option value="grid">{t('blog.admin.post_list_grid')}</option>
                    <option value="masonry">{t('blog.admin.post_list_masonry')}</option>
                  </Select>
                </Field>
                <Field label={t('blog.admin.post_list_page_size')}><Input type="number" min={1} max={100} value={num(display.postListPageSize, 10)} onChange={(event) => setDisplay({ ...display, postListPageSize: Number(event.target.value) })} /></Field>
                <Field label={t('blog.admin.toc_depth')}><Input type="number" min={1} max={6} value={num(display.tocDepth, 2)} onChange={(event) => setDisplay({ ...display, tocDepth: Number(event.target.value) })} /></Field>
                <Field label={t('blog.admin.progress_style')}>
                  <Select value={text(display.progressStyle) || 'dual'} onChange={(event) => setDisplay({ ...display, progressStyle: event.target.value })}>
                    <option value="dual">{t('blog.admin.progress_dual')}</option>
                    <option value="single">{t('blog.admin.progress_single')}</option>
                  </Select>
                </Field>
              </div>
            </Section>
            <Section title={t('blog.admin.settings_article')} onSave={() => void saveDomain('article', article)} saving={saving}>
              <div className="grid gap-1 sm:grid-cols-2">
                <Checkbox checked={bool(article.showLastUpdated, true)} onChange={(value) => setArticle({ ...article, showLastUpdated: value })} label={t('blog.admin.article_last_updated')} />
                <Checkbox checked={bool(article.share, true)} onChange={(value) => setArticle({ ...article, share: value })} label={t('blog.admin.article_share')} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('blog.admin.article_related_count')}><Input type="number" min={0} max={20} value={num(article.relatedCount, 3)} onChange={(event) => setArticle({ ...article, relatedCount: Number(event.target.value) })} /></Field>
                <Field label={t('blog.admin.article_random_count')}><Input type="number" min={0} max={20} value={num(article.randomCount, 2)} onChange={(event) => setArticle({ ...article, randomCount: Number(event.target.value) })} /></Field>
              </div>
              <Field label={t('blog.admin.article_last_updated_days')}>
                <Input type="number" min={0} max={3650} value={num(article.lastUpdatedDays, 90)} onChange={(event) => setArticle({ ...article, lastUpdatedDays: Number(event.target.value) })} />
              </Field>
            </Section>
          </>
        )}

        {tab === 'discussion' && (
          <>
            <Section title={t('blog.admin.discussion_section')} onSave={() => void saveDomain('discussion', discussion)} saving={saving}>
              <div className="grid gap-1 sm:grid-cols-2">
                <Checkbox checked={bool(discussion.enabled, true)} onChange={(value) => setDiscussion({ ...discussion, enabled: value })} label={t('blog.admin.discussion_enabled')} />
                <Checkbox checked={bool(discussion.requireNameEmail, true)} onChange={(value) => setDiscussion({ ...discussion, requireNameEmail: value })} label={t('blog.admin.discussion_require_name_email')} />
                <Checkbox checked={bool(discussion.requireApproval, true)} onChange={(value) => setDiscussion({ ...discussion, requireApproval: value })} label={t('blog.admin.discussion_require_approval')} />
                <Checkbox checked={bool(discussion.allowReplies, true)} onChange={(value) => setDiscussion({ ...discussion, allowReplies: value })} label={t('blog.admin.discussion_allow_replies')} />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t('blog.admin.discussion_max_length')}><Input type="number" min={200} max={10000} value={num(discussion.maxLength, 4000)} onChange={(event) => setDiscussion({ ...discussion, maxLength: Number(event.target.value) })} /></Field>
                <Field label={t('blog.admin.discussion_rate_limit')}><Input type="number" min={1} max={100} value={num(discussion.rateLimitPerHour, 5)} onChange={(event) => setDiscussion({ ...discussion, rateLimitPerHour: Number(event.target.value) })} /></Field>
                <Field label={t('blog.admin.discussion_auto_close')}><Input type="number" min={0} max={3650} value={num(discussion.autoCloseDays, 0)} onChange={(event) => setDiscussion({ ...discussion, autoCloseDays: Number(event.target.value) })} /></Field>
              </div>
            </Section>
            <Section title={t('blog.admin.comment_provider')} onSave={() => void saveDomain('comment', comment)} saving={saving}>
              <Field label={t('blog.admin.comment_provider')} hint={t('blog.admin.comment_provider_hint')}>
                <Select value={text(comment.provider) || 'none'} onChange={(event) => setComment({ ...comment, provider: event.target.value })}>
                  <option value="none">{t('blog.admin.comment_none')}</option>
                  <option value="local">{t('blog.admin.comment_local')}</option>
                  <option value="twikoo">{t('blog.admin.comment_provider_twikoo')}</option>
                  <option value="giscus">{t('blog.admin.comment_provider_giscus')}</option>
                  <option value="waline">{t('blog.admin.comment_provider_waline')}</option>
                </Select>
              </Field>
              {text(comment.provider) === 'twikoo' && <Field label={t('blog.admin.twikoo_env_id')}><Input value={text(comment.envId)} onChange={(event) => setComment({ ...comment, envId: event.target.value })} /></Field>}
              {text(comment.provider) === 'giscus' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('blog.admin.giscus_repo')}><Input value={text(comment.repo)} onChange={(event) => setComment({ ...comment, repo: event.target.value })} placeholder={t('blog.admin.giscus_repo_placeholder')} /></Field>
                  <Field label={t('blog.admin.giscus_repo_id')}><Input value={text(comment.repoId)} onChange={(event) => setComment({ ...comment, repoId: event.target.value })} /></Field>
                  <Field label={t('blog.admin.giscus_category')}><Input value={text(comment.category)} onChange={(event) => setComment({ ...comment, category: event.target.value })} /></Field>
                  <Field label={t('blog.admin.giscus_category_id')}><Input value={text(comment.categoryId)} onChange={(event) => setComment({ ...comment, categoryId: event.target.value })} /></Field>
                </div>
              )}
              {text(comment.provider) === 'waline' && <Field label={t('blog.admin.waline_server_url')}><Input value={text(comment.serverURL)} onChange={(event) => setComment({ ...comment, serverURL: event.target.value })} placeholder="https://" /></Field>}
            </Section>
          </>
        )}

        {tab === 'appearance' && (
          <>
            <Section title={t('blog.admin.settings_banner')} onSave={() => void saveDomain('site', site)} saving={saving}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('blog.admin.banner_desktop_light')}><Input value={text(banner.desktopLight)} onChange={(event) => setBannerField('desktopLight', event.target.value)} placeholder="https://" /></Field>
                <Field label={t('blog.admin.banner_desktop_dark')}><Input value={text(banner.desktopDark)} onChange={(event) => setBannerField('desktopDark', event.target.value)} placeholder="https://" /></Field>
                <Field label={t('blog.admin.banner_mobile_light')}><Input value={text(banner.mobileLight)} onChange={(event) => setBannerField('mobileLight', event.target.value)} placeholder="https://" /></Field>
                <Field label={t('blog.admin.banner_mobile_dark')}><Input value={text(banner.mobileDark)} onChange={(event) => setBannerField('mobileDark', event.target.value)} placeholder="https://" /></Field>
              </div>
            </Section>
            <Section title={t('blog.admin.settings_announcement')} onSave={() => void saveDomain('announcement', announcement)} saving={saving}>
              <Checkbox checked={bool(announcement.enable)} onChange={(value) => setAnnouncement({ ...announcement, enable: value })} label={t('blog.admin.enable')} />
              <Checkbox checked={bool(announcement.closable, true)} onChange={(value) => setAnnouncement({ ...announcement, closable: value })} label={t('blog.admin.announcement_closable')} />
              <Field label={t('blog.admin.announcement_text')}><Textarea rows={3} value={text(announcement.text)} onChange={(event) => setAnnouncement({ ...announcement, text: event.target.value })} /></Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('blog.admin.announcement_link_text')}><Input value={text(announcement.linkText)} onChange={(event) => setAnnouncement({ ...announcement, linkText: event.target.value })} /></Field>
                <Field label={t('blog.admin.announcement_link_url')}><Input value={text(announcement.linkUrl)} onChange={(event) => setAnnouncement({ ...announcement, linkUrl: event.target.value })} placeholder="https://" /></Field>
              </div>
            </Section>
            <Section title={t('blog.admin.settings_footer')} onSave={() => void saveDomain('footer', footer)} saving={saving}>
              <Checkbox checked={bool(footer.enable)} onChange={(value) => setFooter({ ...footer, enable: value })} label={t('blog.admin.enable')} />
              <Field label={t('blog.admin.footer_html')} hint={t('blog.admin.footer_html_hint')}>
                <Textarea rows={5} className="font-mono" value={text(footer.html)} onChange={(event) => setFooter({ ...footer, html: event.target.value })} />
              </Field>
            </Section>
            <Section title={t('blog.admin.settings_license')} onSave={() => void saveDomain('license', license)} saving={saving}>
              <Checkbox checked={bool(license.enable)} onChange={(value) => setLicense({ ...license, enable: value })} label={t('blog.admin.enable')} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('blog.admin.license_name')}><Input value={text(license.name)} onChange={(event) => setLicense({ ...license, name: event.target.value })} /></Field>
                <Field label={t('blog.admin.license_url')}><Input value={text(license.url)} onChange={(event) => setLicense({ ...license, url: event.target.value })} /></Field>
              </div>
            </Section>
            <Section title={t('blog.admin.settings_integrations')} onSave={() => void saveMusic()} saving={saving}>
              <Field label={t('blog.admin.music_provider')}>
                <Select value={text(music.provider) || 'none'} onChange={(event) => setMusic({ ...music, provider: event.target.value })}>
                  <option value="none">{t('blog.admin.comment_none')}</option>
                  <option value="local">{t('blog.admin.music_local')}</option>
                  <option value="custom">{t('blog.admin.music_custom')}</option>
                  <option value="meting">{t('blog.admin.music_meting')}</option>
                  <option value="mixed">{t('blog.admin.music_mixed')}</option>
                </Select>
              </Field>
              {text(music.provider) !== 'none' && (
                <>
                  <Field label={t('blog.admin.music_tracks')} hint={t('blog.admin.music_tracks_hint')}>
                    <Textarea rows={6} className="font-mono" value={musicTracksText} onChange={(event) => setMusicTracksText(event.target.value)} />
                  </Field>
                  {(text(music.provider) === 'meting' || text(music.provider) === 'mixed') && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label={t('blog.admin.music_meting_server')}>
                        <Select
                          value={text((music.meting as Record<string, unknown> | undefined)?.server) || 'netease'}
                          onChange={(event) => setMusic({ ...music, meting: { ...(music.meting as Record<string, unknown> ?? {}), server: event.target.value } })}
                        >
                          {['netease', 'tencent', 'kugou', 'xiami', 'baidu'].map((server) => <option key={server} value={server}>{server}</option>)}
                        </Select>
                      </Field>
                      <Field label={t('blog.admin.music_meting_type')}>
                        <Select
                          value={text((music.meting as Record<string, unknown> | undefined)?.type) || 'playlist'}
                          onChange={(event) => setMusic({ ...music, meting: { ...(music.meting as Record<string, unknown> ?? {}), type: event.target.value } })}
                        >
                          {['playlist', 'song', 'album', 'artist'].map((type) => <option key={type} value={type}>{t(`blog.admin.music_meting_type_${type}` as MessageKey)}</option>)}
                        </Select>
                      </Field>
                      <Field label={t('blog.admin.music_meting_id')}>
                        <Input value={text((music.meting as Record<string, unknown> | undefined)?.id)} onChange={(event) => setMusic({ ...music, meting: { ...(music.meting as Record<string, unknown> ?? {}), id: event.target.value } })} />
                      </Field>
                      <Field label={t('blog.admin.music_meting_api')} hint={t('blog.admin.music_meting_api_hint')}>
                        <Input value={text((music.meting as Record<string, unknown> | undefined)?.api)} onChange={(event) => setMusic({ ...music, meting: { ...(music.meting as Record<string, unknown> ?? {}), api: event.target.value } })} placeholder="https://…?server=:server&type=:type&id=:id&r=:r" />
                      </Field>
                    </div>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t('blog.admin.music_default_volume')}>
                      <Input type="number" min={0} max={1} step={0.05} value={num(music.defaultVolume, 0.7)} onChange={(event) => setMusic({ ...music, defaultVolume: Number(event.target.value) })} />
                    </Field>
                    <Field label={t('blog.admin.music_default_mode')}>
                      <Select value={text(music.defaultMode) || 'sequence'} onChange={(event) => setMusic({ ...music, defaultMode: event.target.value })}>
                        <option value="sequence">{t('blog.admin.music_mode_sequence')}</option>
                        <option value="repeat-one">{t('blog.admin.music_mode_repeat_one')}</option>
                        <option value="shuffle">{t('blog.admin.music_mode_shuffle')}</option>
                      </Select>
                    </Field>
                  </div>
                </>
              )}
              <Checkbox checked={bool(umami.enable)} onChange={(value) => setUmami({ ...umami, enable: value })} label={t('blog.admin.umami_enable')} />
              {bool(umami.enable) && <Field label={t('blog.admin.umami_website_id')}><Input value={text(umami.websiteId)} onChange={(event) => setUmami({ ...umami, websiteId: event.target.value })} /></Field>}
            </Section>
            <Section title={t('blog.admin.settings_fab')} onSave={() => void saveDomain('fab', fab)} saving={saving}>
              <Checkbox checked={bool(fab.enable)} onChange={(value) => setFab({ ...fab, enable: value })} label={t('blog.admin.enable')} />
              <Field label={t('blog.admin.fab_items')} hint={t('blog.admin.fab_items_hint')}>
                <Input value={strList(fab.items)} onChange={(event) => setFab({ ...fab, items: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} />
              </Field>
            </Section>
            <Section title={t('blog.admin.settings_context_menu')} onSave={() => void saveDomain('contextMenu', contextMenu)} saving={saving}>
              <Checkbox checked={bool(contextMenu.enable, true)} onChange={(value) => setContextMenu({ ...contextMenu, enable: value })} label={t('blog.admin.enable')} />
              {(['copySelection', 'copyLink', 'openImage', 'copyImage', 'backToTop'] as const).map((action) => {
                const actions = Array.isArray(contextMenu.actions)
                  ? contextMenu.actions.filter((item): item is string => typeof item === 'string')
                  : []
                return (
                  <Checkbox
                    key={action}
                    checked={actions.includes(action)}
                    onChange={(value) => setContextMenu({ ...contextMenu, actions: value ? [...new Set([...actions, action])] : actions.filter((item) => item !== action) })}
                    label={t(`blog.admin.context_${action === 'copySelection' ? 'copy_selection' : action === 'copyLink' ? 'copy_link' : action === 'openImage' ? 'open_image' : action === 'copyImage' ? 'copy_image' : 'back_top'}` as MessageKey)}
                  />
                )
              })}
            </Section>
          </>
        )}

        {tab === 'seo' && (
          <>
            <Section title={t('blog.admin.settings_llms')} onSave={() => void saveDomain('llms', llms)} saving={saving}>
              <Checkbox checked={bool(llms.enable, true)} onChange={(value) => setLlms({ ...llms, enable: value })} label={t('blog.admin.enable')} />
              <Field label={t('blog.admin.llms_exclude_tags')} hint={t('blog.admin.llms_exclude_tags_hint')}>
                <Input value={strList(llms.excludeTags)} onChange={(event) => setLlms({ ...llms, excludeTags: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} />
              </Field>
            </Section>
            <Section title={t('blog.admin.settings_permalink')} onSave={() => void saveDomain('permalink', permalink)} saving={saving}>
              <Checkbox checked={bool(permalink.enable)} onChange={(value) => setPermalink({ ...permalink, enable: value })} label={t('blog.admin.permalink_enable')} />
            </Section>
          </>
        )}

        {tab === 'advanced' && (
          <Section title={t('blog.admin.advanced_section')} onSave={() => void saveAdvanced()} saving={saving}>
            <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('blog.admin.advanced_hint')}</p>
            <Field label={t('blog.admin.advanced_domain')}>
              <Select value={advancedDomain} onChange={(event) => { const next = event.target.value as BlogSettingKey; setAdvancedDomain(next); setAdvancedJson(JSON.stringify(settings[next], null, 2)); setAdvancedError('') }}>
                {BLOG_SETTING_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}
              </Select>
            </Field>
            <Field label={t('blog.admin.advanced_json')}>
              <Textarea rows={16} className="font-mono" value={advancedJson} onChange={(event) => setAdvancedJson(event.target.value)} spellCheck={false} />
            </Field>
            {advancedError && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{advancedError}</p>}
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({
  title,
  children,
  onSave,
  saving,
}: {
  title: string
  children: ReactNode
  onSave: () => void
  saving: boolean
}) {
  return (
    <section className="space-y-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
      <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{title}</h2>
      {children}
      <div className="flex justify-end border-t border-[var(--border-subtle)] pt-3">
        <Button size="sm" loading={saving} onClick={onSave}>{t('blog.admin.save')}</Button>
      </div>
    </section>
  )
}
