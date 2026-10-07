


export type UserRole = 'owner' | 'member'

export interface PublicUser {
  id: string
  login: string
  name: string
  avatarUrl: string
  role: UserRole
  createdAt: number

  username: string
}

export interface SiteInfo {
  name: string

  initialized: boolean

  registrationOpen: boolean

  r2Enabled: boolean

  kvEnabled: boolean

  attachmentStorage: 'r2' | 'kv' | null

  realtimeEnabled: boolean
  version?: string
}

export interface SessionInfo {
  user: PublicUser | null
  site: SiteInfo
  settings: UserSettings | null
}

export interface TotpLoginChallenge {
  twoFactorRequired: true
  challengeToken: string
  expiresAt: number
}

export type PasswordLoginResult = SessionInfo | TotpLoginChallenge

export type TotpLoginResult = SessionInfo & {
  recoveryCodeUsed: boolean
  recoveryCodesRemaining: number | null
}

export interface TotpStatus {
  available: boolean
  enabled: boolean
  enabledAt: number | null
  recoveryCodesRemaining: number
}

export interface TotpSetupInfo {
  setupToken: string
  secret: string
  uri: string
  expiresAt: number
}

export interface TotpRecoveryCodesResult {
  recoveryCodes: string[]
  recoveryCodesRemaining: number
  generatedAt: number
}

export type UpdateCheckStatus = 'ok' | 'unavailable'

export interface UpdateCheckResponse {
  currentVersion: string
  latestVersion: string | null
  updateUrl: string | null
  checkedAt: number | null
  status: UpdateCheckStatus
}


export type ThemePref = 'light' | 'dark' | 'system'
export type AppLocale = 'zh-CN' | 'en-US'
export type AccentName = 'cinnabar' | 'indigo' | 'celadon' | 'amber' | 'terracotta' | 'wisteria' | 'graphite'
export type BackgroundName = 'paper' | 'white'
export type UiDensity = 'comfortable' | 'compact'
export type ProseFont = 'sans' | 'serif'
export type ProseWidth = 'narrow' | 'normal' | 'wide' | 'full'
export type EditorLayout = 'live' | 'split' | 'preview'
export type BackupSchedule = 'off' | 'hourly' | 'sixHourly' | 'daily' | 'weekly' | 'monthly' | 'yearly'

export interface AppearanceSettings {
  language: AppLocale
  theme: ThemePref
  accent: AccentName
  background: BackgroundName
  density: UiDensity
  proseFont: ProseFont
  proseSize: number
  proseWidth: ProseWidth
  proseLineHeight: number
}

export interface EditorSettings {
  fontSize: number
  fontFamily: 'mono' | 'sans'
  lineNumbers: boolean
  typewriter: boolean
  focusMode: boolean
  spellcheck: boolean
  showToolbar: boolean
  livePreview: boolean
  tabSize: number
  autoSaveDelay: number
  codeFormatKeywordCase: CodeFormatKeywordCase
}

export type CodeFormatKeywordCase = 'upper' | 'lower' | 'keep'

export type PinnedWindowSizeName = 'small' | 'medium' | 'large' | 'custom'
export type OutlineModeName = 'sidebar' | 'floating-always' | 'floating-hover' | 'floating-circle'
export type OutlineAutoExpandName = 'off' | 'ancestors'
export type OutlineTextDirectionName = 'system' | 'text'

export interface PreviewSettings {
  layout: EditorLayout
  syncScroll: boolean
  showToc: boolean
  outlineMode: OutlineModeName
  outlineDefaultLevel: number
  outlineShowProgress: boolean
  outlineAutoExpand: OutlineAutoExpandName
  outlineTooltipSide: 'left' | 'right'
  outlineTruncateLength: number
  outlineMarkdownLabels: boolean
  outlineHoverPeek: boolean
  outlineTextDirection: OutlineTextDirectionName
  outlineShowReadingTime: boolean
  outlineReadingSpeed: number
  outlineDragEdits: boolean
  outlineKeepSearch: boolean
  outlineLocateByCursor: boolean
  /** Right-click (or a long press) opens the note's own menu instead of the browser's. */
  contextMenu: boolean
  /** The clipboard and history strip above the menu's rows. */
  contextMenuToolbar: boolean
  /** The filter box that narrows the menu to what the query matches. */
  contextMenuSearch: boolean
  math: boolean
  mermaid: boolean
  chart: boolean
  codeBlockCollapse: boolean
  codeBlockCollapseLines: number
  codeFormatButton: boolean
  linkHover: boolean
  linkHoverDelayMs: number
  linkPreviewLength: number
  pinnedWindowSize: PinnedWindowSizeName
  pinnedWindowWidth: number
  pinnedWindowHeight: number
  /** Whether a show opens with the slide list already beside it. The room still
   * decides the ceiling: a phone never gets one it has no space for. */
  presentationSlideList: boolean
  /** Whether a chart plays its entrance on the projector, or arrives drawn. */
  presentationChartAnimation: boolean
  /** Whether the controls and the list fade out while the presenter is idle. */
  presentationAutoHideChrome: boolean
}

export interface BackupSettings {
  schedule: BackupSchedule
  retentionCount: number
}

export interface SyncSettings {
  realtime: boolean
  pollIntervalMs: number
}

export interface NotesSettings {
  todoTag: string
}

export interface UserSettings {
  appearance: AppearanceSettings
  editor: EditorSettings
  preview: PreviewSettings
  backup: BackupSettings
  sync: SyncSettings
  notes: NotesSettings
}


export interface DateRangeFilter {
  start: string
  end: string
}

export interface NoteSummary {
  id: string
  title: string
  excerpt: string
  folderId: string | null
  tags: string[]
  isPinned: boolean
  isStarred: boolean
  isArchived: boolean
  wordCount: number
  charCount: number
  rev: number
  position: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface Note extends NoteSummary {
  content: string
}

export interface Folder {
  id: string
  parentId: string | null
  name: string
  icon: string | null
  color: string | null
  position: number
  createdAt: number
  updatedAt: number

  noteCount?: number
}

export interface Tag {
  id: string
  name: string
  color: string | null
  isPinned?: boolean
  count: number
  createdAt: number
}

export interface NoteVersionMeta {
  id: string
  noteId: string
  title: string
  size: number
  createdAt: number
}

export interface NoteVersion extends NoteVersionMeta {
  content: string
}

export interface Backlink {
  id: string
  title: string
  context: string
}

export interface Attachment {
  id: string
  noteId: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  url: string
  createdAt: number
}

export interface AttachmentWithUsage extends Attachment {
  references: number
}


export type ViewKind =
  | 'all'
  | 'recent'
  | 'starred'
  | 'unfiled'
  | 'untagged'
  | 'archived'
  | 'trash'
  | 'folder'
  | 'tag'

export type SortKey = 'updated' | 'created' | 'title'
export type SortOrder = 'asc' | 'desc'

export interface ListNotesQuery {
  view?: ViewKind
  folderId?: string
  tag?: string
  sort?: SortKey
  order?: SortOrder
  limit?: number
  cursor?: string
}

export interface ListNotesResponse {
  notes: NoteSummary[]
  nextCursor: string | null
  /** Only computed on the first page of a listing; later keyset pages return null. */
  total: number | null
}

export interface CreateNoteBody {
  id?: string
  title?: string
  content?: string
  folderId?: string | null
  isStarred?: boolean
}

export interface PatchNoteBody {
  rev: number
  title?: string
  content?: string
  folderId?: string | null
  isPinned?: boolean
  isStarred?: boolean
  isArchived?: boolean

  quiet?: boolean
  preserveVersion?: boolean
}

export interface ConflictPayload {
  code: 'conflict'
  message: string
  server: Note
}


export type SearchMode = 'fts' | 'like'

export interface SearchHit {
  note: NoteSummary
  snippet: string
  score: number
}

export interface SearchResponse {
  results: SearchHit[]
  mode: SearchMode
  took: number
  query: {
    text: string
    tags: string[]
    excludedTags: string[]
    folder: string | null
    starred: boolean | null
    archived: boolean | null
  }
}

export interface GraphNode {
  id: string
  title: string
  /** `tag` nodes are synthesized from note tags, `unresolved` from links to missing notes. */
  kind: 'note' | 'unresolved' | 'tag'
  degree: number
  inDegree: number
  outDegree: number
  folderId: string | null
  folderName: string | null
  folderColor: string | null
  tags: Array<{ name: string; color: string | null }>
}

export interface GraphEdge {
  source: string
  target: string
}

export interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  meta: {
    mode: 'global' | 'local'
    centerId: string | null
    depth: number
    totalNodes: number
    totalEdges: number
    truncated: boolean
    limit: number
  }
}

export interface GraphQuery {
  mode?: 'global' | 'local'
  center?: string
  depth?: number
  q?: string
  folderId?: string
  tag?: string
  /** Tags to filter by. Overrides `tag`; sent comma-separated. */
  tags?: string[]
  /** How multiple tags combine: `any` (default) for union, `all` for intersection. */
  tagsMatch?: 'any' | 'all'
  includeOrphans?: boolean
  includeUnresolved?: boolean
  /** Draw each tag as its own node, linking the notes that carry it. Sent as `1`. */
  showTagNodes?: boolean
  /** Notes the reader took out of the graph. Sent comma-separated, like `tags`. */
  excluded?: string[]
  /** Which side of a link a local graph walks. Only meaningful with `mode: 'local'`. */
  direction?: 'both' | 'incoming' | 'outgoing'
  limit?: number
}


export interface SyncDeletion {
  entity: 'note' | 'folder' | 'tag'
  id: string
}

export interface SyncResponse {
  cursor: number
  full: boolean

  hasMore: boolean

  nextKey: string | null

  facetsFull: boolean

  settingsChanged: boolean
  profileChanged?: boolean
  siteChanged?: boolean
  notes: NoteSummary[]
  folders: Folder[]
  tags: Tag[]
  deletions: SyncDeletion[]
  serverTime: number
}

export type RealtimeMessage =
  | { type: 'changed'; cursor: number; origin: string | null }
  | { type: 'ping' }
  | { type: 'pong'; serverTime: number }


export type BackupTargetType = 'webdav' | 's3'
export type BackupMode = 'archive' | 'mirror'

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  pathStyle: boolean
  mode: BackupMode
}

export interface WebdavConfig {
  url: string
  username: string
  prefix: string
  mode: BackupMode
}

export type BackupTargetConfig = S3Config | WebdavConfig

export interface BackupTarget {
  id: string
  type: BackupTargetType
  name: string
  enabled: boolean
  config: BackupTargetConfig
  hasSecret: boolean
  lastRunAt: number | null
  lastStatus: 'success' | 'failed' | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface BackupTargetInput {
  type: BackupTargetType
  name: string
  enabled?: boolean
  config: Partial<S3Config> & Partial<WebdavConfig>

  secret?: {
    password?: string
    accessKeyId?: string
    secretAccessKey?: string
  }
}

export type BackupTargetPatchInput = Partial<BackupTargetInput> & {
  expectedUpdatedAt?: number
}

export interface BackupTargetResult {
  targetId: string
  targetName: string
  targetType: BackupTargetType
  ok: boolean
  warning?: string
  files: number
  bytes: number
  ms: number
  error: string | null
}

export interface BackupRun {
  id: string
  trigger: 'manual' | 'cron'
  status: 'running' | 'success' | 'partial' | 'failed'
  startedAt: number
  finishedAt: number | null
  noteCount: number
  fileCount: number
  bytes: number
  results: BackupTargetResult[]
}

export interface TestConnectionResult {
  ok: boolean
  message: string
  detail?: string
  latencyMs?: number
}


export interface ShareInfo {
  slug: string
  noteId: string
  url: string
  hasPassword: boolean
  expiresAt: number | null
  views: number
  createdAt: number
}

export interface ShareListItem extends ShareInfo {
  noteTitle: string
  deletedAt: number | null
}

export interface PublicNote {
  title: string
  content: string
  updatedAt: number
  createdAt: number
  author: { name: string; avatarUrl: string }
  site: { name: string }
  share: { slug: string }
}


export interface ExportBundle {

  format: string
  version: 1
  exportedAt: number
  user: { login: string; name: string }
  folders: Folder[]
  tags: Tag[]
  notes: Note[]

  attachments: ExportAttachment[]
}

export interface ExportAttachment {
  id: string
  noteId: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  createdAt: number
  path: string
  sha256: string
}

export interface ImportResult {
  createdNotes: number
  updatedNotes: number
  skippedNotes: number
  createdFolders: number
  createdAttachments: number
  skippedAttachments: number
  warnings: string[]
}


export interface McpPreferences {
  writeEnabled: boolean
  trashEnabled: boolean
  updatedAt: number
}

export interface McpGrant {
  id: string
  clientId: string
  clientName: string
  clientUri: string | null
  scopes: string[]
  createdAt: number
  expiresAt: number | null
}

export interface McpApiKey {
  id: string
  name: string
  scopes: string[]
  createdAt: number
  lastUsedAt: number | null
}

export interface McpAiSearchStatus {
  available: boolean
  enabled: boolean
  model: string
  indexedCount: number
  pendingCount: number
  reason: 'no_ai_binding' | null
}

export interface McpSettingsInfo {
  enabled: boolean
  canManageGlobal: boolean
  endpoint: string
  oauth: true
  preferences: McpPreferences
  apiKeys: McpApiKey[]
  aiSearch: McpAiSearchStatus
  grants: McpGrant[]
  privacy: {
    publicEndpoint: false
    perUserIndex: true
    externalClientReceivesSelectedContent: true
  }
}


export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'bad_request'
  | 'payload_too_large'
  | 'storage_unavailable'
  | 'internal'
  | 'invalid_username'
  | 'invalid_profile_name'
  | 'invalid_avatar'
  | 'weak_password'
  | 'username_taken'
  | 'invalid_credentials'
  | 'invalid_two_factor_code'
  | 'wrong_password'
  | 'too_many_attempts'
  | 'registration_closed'
  | 'setup_token_required'
  | 'note_quota_exceeded'
  | 'organizer_quota_exceeded'
  | 'server_misconfigured'
  | 'two_factor_already_enabled'
  | 'two_factor_challenge_expired'
  | 'two_factor_not_enabled'
  | 'two_factor_setup_expired'
  | 'two_factor_unavailable'
