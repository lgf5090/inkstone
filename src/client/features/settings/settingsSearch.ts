import { fuzzyMatch } from '../../lib/fuzzy'
import { getLocale, getLocaleResources, localizedTexts, t, type MessageKey } from '../../lib/i18n'
import { SECTION_LABEL_KEYS, type SettingsSection } from './sections'

export type SettingsSearchEntry = {
  section: SettingsSection
  titleKey: MessageKey
  detailKey?: MessageKey
  termKeys?: MessageKey[]
}

export type SettingsSearchHit = {
  entry: SettingsSearchEntry
  title: string
  detail: string
  score: number
  ranges: [number, number][]
}

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  { section: 'appearance', titleKey: 'settings.interface_language', termKeys: ['settings.simplified_chinese', 'settings.english'] },
  { section: 'appearance', titleKey: 'settings.theme', termKeys: ['settings.light', 'settings.dark', 'settings.system'] },
  { section: 'appearance', titleKey: 'settings.accent_color', termKeys: ['settings.accent.cinnabar', 'settings.accent.indigo', 'settings.accent.celadon', 'settings.accent.amber', 'settings.accent.terracotta', 'settings.accent.wisteria', 'settings.accent.graphite'] },
  { section: 'appearance', titleKey: 'settings.background_color', termKeys: ['settings.background_paper', 'settings.background_white'] },
  { section: 'appearance', titleKey: 'settings.interface_density', termKeys: ['settings.comfortable', 'settings.compact'] },
  { section: 'appearance', titleKey: 'settings.year_grid_columns', detailKey: 'settings.year_grid_columns_desc', termKeys: ['settings.year_grid_columns_auto', 'settings.year_grid_columns_three', 'settings.year_grid_columns_four'] },
  { section: 'appearance', titleKey: 'settings.body_font', termKeys: ['common.sans_serif', 'settings.serif'] },
  { section: 'appearance', titleKey: 'settings.body_text_size' },
  { section: 'appearance', titleKey: 'settings.line_height' },
  { section: 'appearance', titleKey: 'settings.content_width', termKeys: ['settings.narrow', 'settings.standard', 'settings.wide', 'settings.full'] },
  { section: 'appearance', titleKey: 'settings.preview_typography', termKeys: ['settings.body_font', 'settings.body_text_size', 'settings.line_height', 'settings.content_width'] },

  { section: 'editor', titleKey: 'settings.editor_font', termKeys: ['settings.monospace', 'common.sans_serif'] },
  { section: 'editor', titleKey: 'settings.editor_font_size' },
  { section: 'editor', titleKey: 'settings.show_line_numbers' },
  { section: 'editor', titleKey: 'settings.show_toolbar' },
  { section: 'editor', titleKey: 'settings.spellcheck' },
  { section: 'editor', titleKey: 'settings.typewriter_mode', detailKey: 'settings.keep_the_cursor_line_centered_on_screen' },
  { section: 'editor', titleKey: 'settings.focus_mode', detailKey: 'settings.fade_content_outside_the_current_paragraph' },
  { section: 'editor', titleKey: 'settings.scroll_sync', detailKey: 'settings.keep_the_editor_and_preview_scrolled_together' },
  { section: 'editor', titleKey: 'settings.math', detailKey: 'settings.render_and_using_katex' },
  { section: 'editor', titleKey: 'settings.diagram', detailKey: 'settings.render_mermaid_code_blocks_into_flowcharts' },
  { section: 'editor', titleKey: 'settings.collapse_long_code_blocks', detailKey: 'settings.collapse_long_code_blocks_description' },
  { section: 'editor', titleKey: 'settings.code_block_collapse_after', termKeys: ['settings.lines'] },
  { section: 'editor', titleKey: 'settings.show_outline_by_default' },
  { section: 'editor', titleKey: 'settings.autosave_delay', detailKey: 'settings.delay_before_uploading_after_you_stop_typing_shorter_makes_more_requests' },
  { section: 'editor', titleKey: 'settings.indent_width', termKeys: ['settings.lines'] },
  { section: 'editor', titleKey: 'settings.writing_mode', termKeys: ['settings.typewriter_mode', 'settings.focus_mode'] },

  { section: 'backup', titleKey: 'settings.frequency', detailKey: 'settings.runs_from_cloudflare_cron_the_page_does_not_need_to_stay_open', termKeys: ['settings.manual', 'settings.hourly', 'settings.every_6_hours', 'settings.daily', 'settings.weekly', 'settings.monthly', 'settings.yearly'] },
  { section: 'backup', titleKey: 'settings.backup_retention', detailKey: 'settings.backup_retention_description', termKeys: ['settings.keep_all_backups', 'settings.keep_latest_backups'] },
  { section: 'backup', titleKey: 'settings.backup_target', termKeys: ['settings.add_backup_target', 'settings.webdav_backup', 'settings.s3_backup', 'settings.test_connection', 'settings.enabled'] },
  { section: 'backup', titleKey: 'settings.back_up_now' },
  { section: 'backup', titleKey: 'settings.latest_backups' },

  { section: 'sync', titleKey: 'settings.realtime_sync', detailKey: 'settings.receive_changes_from_other_devices_quickly' },
  { section: 'sync', titleKey: 'settings.polling_interval' },

  { section: 'mcp', titleKey: 'settings.mcp_enable', detailKey: 'settings.mcp_enable_desc' },
  { section: 'mcp', titleKey: 'settings.mcp_write_access', detailKey: 'settings.mcp_write_access_desc' },
  { section: 'mcp', titleKey: 'settings.mcp_trash_access', detailKey: 'settings.mcp_trash_access_desc' },
  { section: 'mcp', titleKey: 'settings.mcp_ai_search', detailKey: 'settings.mcp_ai_search_desc', termKeys: ['settings.mcp_ai_search_reindex', 'settings.mcp_ai_search_clear'] },
  { section: 'mcp', titleKey: 'settings.mcp_api_keys', detailKey: 'settings.mcp_api_keys_desc', termKeys: ['settings.mcp_api_key_create', 'settings.mcp_api_key_revoke'] },
  { section: 'mcp', titleKey: 'settings.mcp_endpoint', detailKey: 'settings.mcp_endpoint_desc' },
  { section: 'mcp', titleKey: 'settings.mcp_transport' },
  { section: 'mcp', titleKey: 'settings.mcp_permissions' },
  { section: 'mcp', titleKey: 'settings.mcp_privacy', detailKey: 'settings.mcp_privacy_desc' },
  { section: 'mcp', titleKey: 'settings.mcp_connect_clients', detailKey: 'settings.mcp_connect_desc' },

  { section: 'account', titleKey: 'settings.personal_profile', termKeys: ['settings.display_name', 'settings.change_avatar', 'settings.username_is_sign_in_id'] },
  { section: 'account', titleKey: 'settings.login_password', detailKey: 'settings.username_value0_changing_the_password_signs_out_other_devices', termKeys: ['settings.change_password', 'settings.current_password', 'settings.new_password'] },
  { section: 'account', titleKey: 'settings.sign_in_security', termKeys: ['settings.totp_enable', 'settings.totp_disable'] },
  { section: 'account', titleKey: 'settings.totp_title', termKeys: ['settings.totp_authenticator_code', 'settings.current_password'] },
  { section: 'account', titleKey: 'common.open_registration', termKeys: ['settings.registration_open', 'settings.registration_closed'] },
  { section: 'account', titleKey: 'common.exit', termKeys: ['common.log_out', 'sidebar.log_out'] },

  { section: 'data', titleKey: 'settings.overview', termKeys: ['settings.total_words', 'settings.version_history'] },
  { section: 'data', titleKey: 'attachments.manage', detailKey: 'attachments.manage_description' },
  { section: 'data', titleKey: 'settings.export_to_zip', detailKey: 'settings.includes_every_note_folder_tag_and_attachment_for_a_complete_restore_plu' },
  { section: 'data', titleKey: 'settings.export_to_json', detailKey: 'settings.structured_note_data_without_attachment_binaries_download_zip_for_a_comp' },
  { section: 'data', titleKey: 'settings.restore_backup_folder', detailKey: 'settings.restore_backup_folder_description' },
  { section: 'data', titleKey: 'settings.import_file', detailKey: 'settings.supports_md_txt_zip_and_inkstone_json_exports_for_matching_ids_the_newer' },
  { section: 'data', titleKey: 'settings.rebuild_search_index', detailKey: 'settings.try_this_when_your_search_results_don_t_look_right' },
  { section: 'data', titleKey: 'settings.rebuild_summaries', detailKey: 'settings.rebuild_summaries_desc' },
  { section: 'data', titleKey: 'settings.clean_unreferenced_attachments', detailKey: 'settings.delete_pictures_and_files_that_no_longer_appear_in_any_notes' },
  { section: 'data', titleKey: 'settings.empty_trash', detailKey: 'settings.permanently_delete_every_note_in_trash' },
  { section: 'data', titleKey: 'settings.maintenance', termKeys: ['settings.attachment_storage', 'settings.clean_up'] },

  { section: 'shares', titleKey: 'share.shared_notes', termKeys: ['share.active'] },

  { section: 'about', titleKey: 'settings.version', termKeys: ['settings.recheck_updates'] },
  { section: 'about', titleKey: 'settings.current_version' },
  { section: 'about', titleKey: 'settings.latest_version' },
  { section: 'about', titleKey: 'settings.registration_status', detailKey: 'settings.new_accounts_can_currently_register_with_a_username_and_password' },
  { section: 'about', titleKey: 'settings.deployment_updates', termKeys: ['settings.recheck_updates', 'settings.up_to_date'] },
  { section: 'about', titleKey: 'pwa.app_installation', termKeys: ['pwa.installed'] },
  { section: 'about', titleKey: 'pwa.install_inkstone', detailKey: 'pwa.install_description', termKeys: ['pwa.install'] },
  { section: 'about', titleKey: 'pwa.complete_offline_access' },
  { section: 'about', titleKey: 'common.github', termKeys: ['settings.open_github_repository', 'settings.open_official_repository'] },
  { section: 'about', titleKey: 'common.exit', termKeys: ['common.log_out', 'sidebar.log_out'] },
]

const MAX_HITS = 80
const TIER_SECTION = 1
const TIER_TERM = 2
const TIER_TITLE = 3

type PreparedEntry = {
  entry: SettingsSearchEntry
  title: string
  detail: string
  titles: string[]
  extras: string[]
  sectionText: string[]
}

let prepared: PreparedEntry[] | null = null
let preparedKey = ''

function lowerVariants(key: MessageKey): string[] {
  return localizedTexts(key).map((value) => value.toLowerCase())
}

function bestTier(term: string, titles: string[], extras: string[], sectionText: string[]): number {
  if (titles.some((value) => value.includes(term)))
    return TIER_TITLE
  if (extras.some((value) => value.includes(term)))
    return TIER_TERM
  return sectionText.some((value) => value.includes(term)) ? TIER_SECTION : 0
}

function prepareIndex(): PreparedEntry[] {
  const key = `${getLocale()}:${getLocaleResources()}`
  if (prepared && preparedKey === key)
    return prepared
  preparedKey = key
  const sectionTexts = new Map<SettingsSection, string[]>()
  prepared = SETTINGS_SEARCH_INDEX.map((entry) => {
    let sectionText = sectionTexts.get(entry.section)
    if (!sectionText) {
      sectionText = lowerVariants(SECTION_LABEL_KEYS[entry.section])
      sectionTexts.set(entry.section, sectionText)
    }
    return {
      entry,
      title: t(entry.titleKey),
      detail: entry.detailKey ? t(entry.detailKey) : '',
      titles: lowerVariants(entry.titleKey),
      extras: [
        ...(entry.detailKey ? lowerVariants(entry.detailKey) : []),
        ...(entry.termKeys ?? []).flatMap(lowerVariants),
      ],
      sectionText,
    }
  })
  return prepared
}

export function searchSettings(query: string): SettingsSearchHit[] {
  const terms = query.trim().toLowerCase().replace(/\s+/g, ' ').split(' ').filter(Boolean)
  if (!terms.length)
    return []
  const needle = terms.join(' ')
  const hits: SettingsSearchHit[] = []
  for (const item of prepareIndex()) {
    let tier = TIER_TITLE + 1
    for (const term of terms) {
      const found = bestTier(term, item.titles, item.extras, item.sectionText)
      if (!found) {
        tier = 0
        break
      }
      tier = Math.min(tier, found)
    }
    if (!tier)
      continue
    const match = fuzzyMatch(item.title, needle)
    hits.push({
      entry: item.entry,
      title: item.title,
      detail: item.detail,
      score: tier * 1000 + (match ? match.score : 0),
      ranges: match ? match.ranges : [],
    })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, MAX_HITS)
}

export function countBySection(hits: SettingsSearchHit[]): Map<SettingsSection, number> {
  const counts = new Map<SettingsSection, number>()
  for (const hit of hits)
    counts.set(hit.entry.section, (counts.get(hit.entry.section) ?? 0) + 1)
  return counts
}
