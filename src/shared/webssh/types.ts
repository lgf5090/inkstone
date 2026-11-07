export interface WebsshHealth {
  ok: true
  module: 'webssh'
}

export type WebsshSessionStatus = 'pending' | 'connecting' | 'active' | 'closed' | 'error'

/** The session row as the owner-facing status route returns it. */
export interface WebsshSessionView {
  id: string
  hostId: string
  status: WebsshSessionStatus
  startedAt: number
  connectedAt: number | null
  endedAt: number | null
  lastActivityAt: number
  closeReason: string
  errorCode: string
  /** Empty when this session was not recorded (recording is off by default). */
  recordingId: string
}

export interface WebsshSessionCreated {
  sessionId: string
  status: WebsshSessionStatus
}

export interface WebsshSessionTicket {
  ticket: string
  /** The finished same-origin WebSocket URL, ticket included. */
  url: string
  expiresAt: number
}

export type WebsshCloseReason = 'eof' | 'idle' | 'error'

/** Rates are bytes per second; `null` means this is the first sample after connecting. */
export interface WebsshMonitorNetworkRate {
  rx: number | null
  tx: number | null
}

export interface WebsshMonitorNetworkInterface extends WebsshMonitorNetworkRate {
  name: string
  rxBytes: number
  txBytes: number
}

export interface WebsshMonitorNetwork {
  total: WebsshMonitorNetworkRate & { rxBytes: number; txBytes: number }
  interfaces: WebsshMonitorNetworkInterface[]
}

export interface WebsshMonitorDisk {
  mount: string
  totalBytes: number | null
  usedBytes: number | null
  availableBytes: number | null
  usedPercent: number | null
}

export interface WebsshMonitorMemory {
  totalBytes: number | null
  usedBytes: number | null
  availableBytes: number | null
  swapTotalBytes: number | null
  swapUsedBytes: number | null
}

export interface WebsshMonitorResources {
  os: { system: string; release: string; arch: string; hostname: string; pretty: string }
  uptimeSeconds: number | null
  load: [number, number, number] | null
  cpuPercent: number | null
  memory: WebsshMonitorMemory
  disks: WebsshMonitorDisk[]
}

export interface WebsshMonitorProcess {
  pid: number
  user: string
  cpuPercent: number
  memPercent: number
  rssBytes: number
  state: string
  command: string
}

export interface WebsshMonitorProcesses {
  total: number
  byCpu: WebsshMonitorProcess[]
  byMemory: WebsshMonitorProcess[]
  /** True when the remote `ps` output was longer than the exec channel's cap. */
  truncated: boolean
}

export interface WebsshMonitorContainer {
  id: string
  name: string
  image: string
  state: string
  status: string
  cpuPercent: number | null
  memoryUsage: string
  networkIo: string
}

export interface WebsshMonitorContainers {
  /** False when `docker` is not installed on the host. */
  available: boolean
  truncated: boolean
  items: WebsshMonitorContainer[]
}

/** One throttled sample of a live session; every field is `null`/empty when the host lacks that source. */
export interface WebsshMonitorSnapshot {
  sampledAt: number
  resources: WebsshMonitorResources
  network: WebsshMonitorNetwork
  processes: WebsshMonitorProcesses
  containers: WebsshMonitorContainers
}

export interface WebsshMonitorKillResult {
  ok: true
  pid: number
  exitCode: number | null
  stderr: string
}

export type WebsshWidgetType = 'resources' | 'network' | 'processes' | 'containers'

export const WEBSSH_WIDGET_TYPES: readonly WebsshWidgetType[] = ['resources', 'network', 'processes', 'containers']

/** A widget's rectangle on the 12-column dashboard grid. */
export interface WebsshDashboardWidget {
  id: string
  type: WebsshWidgetType
  x: number
  y: number
  w: number
  h: number
  config: Record<string, string | number | boolean | null>
}

export interface WebsshDashboard {
  id: string
  name: string
  locked: boolean
  widgets: WebsshDashboardWidget[]
  createdAt: number
  updatedAt: number
}

export interface WebsshDashboardListResponse {
  dashboards: WebsshDashboard[]
}

/** The portable layout file. It holds no host, credential, session or account identifier. */
export interface WebsshDashboardExport {
  version: 1
  name: string
  locked: boolean
  widgets: Array<Pick<WebsshDashboardWidget, 'type' | 'x' | 'y' | 'w' | 'h' | 'config'>>
}

/** One directory entry from the W5 SFTP listing route. */
export interface WebsshSftpEntry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'socket' | 'block-device' | 'character-device' | 'fifo' | 'unknown'
  /** Bytes, `0` when the server did not report a size. */
  size: number
  /** Unix mtime in seconds, `null` when the server did not report one. */
  mtime: number | null
  /** `ls`-style permission string such as `drwxr-xr-x`. */
  permissions: string
  longname: string
}

export interface WebsshSftpListing {
  path: string
  entries: WebsshSftpEntry[]
}

/** A staged upload. Chunks are PUT to the transfer before `complete` writes them to the host. */
export interface WebsshSftpUploadCreated {
  transferId: string
  size: number
  /** The largest block the chunk route accepts, in bytes. */
  chunkSize: number
}

export interface WebsshSftpUploadStatus {
  transferId: string
  received: number
  size: number
}

export interface WebsshSftpMutationResult {
  ok: true
}

/** A saved command snippet; `command` is the text inserted into the terminal. */
export interface WebsshSnippet {
  id: string
  title: string
  command: string
  description: string
  tags: string[]
  shell: string
  favorite: boolean
  sortOrder: number
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

export interface WebsshSnippetListResponse {
  items: WebsshSnippet[]
  total: number
  page: number
  pageSize: number
}

/** One host definition parsed from an import preview; `issues` blocks it from being created. */
export interface WebsshImportCandidate {
  name: string
  host: string
  port: number
  username: string
  tags: string[]
  provider: string
  issues: string[]
}

export interface WebsshImportPreview {
  format: 'ssh-config' | 'csv'
  candidates: WebsshImportCandidate[]
  rejected: number
}

/** The result of a confirmed import: hosts written and rows left out with a reason code. */
export interface WebsshImportCommitResult {
  created: WebsshHost[]
  skipped: Array<{ name: string; reason: string }>
}

/** The append-only event vocabulary, shared so the filter and the writer cannot drift. */
export const WEBSSH_AUDIT_EVENT_TYPES = [
  'session_create',
  'ticket_issue',
  'ticket_consumed',
  'ticket_rejected',
  'connect',
  'connect_blocked',
  'host_key_new',
  'host_key_changed',
  'host_key_trusted',
  'session_ready',
  'auth_fail',
  'disconnect',
  'session_error',
  'file_list',
  'file_upload',
  'file_download',
  'file_delete',
  'file_rename',
  'dir_create',
  'recording_start',
  'recording_finalize',
  'recording_fail',
  'recording_delete',
  'recording_access',
  'share_create',
  'share_revoke',
  'share_access',
  'retention_fail',
  'process_kill',
] as const

export type WebsshAuditEventType = typeof WEBSSH_AUDIT_EVENT_TYPES[number]

/** One append-only audit row, with metadata already parsed for the read-only viewer. */
export interface WebsshAuditEventView {
  id: string
  eventType: string
  sessionId: string
  hostId: string
  metadata: Record<string, string | number | boolean | null>
  ipHash: string
  createdAt: number
}

export interface WebsshAuditListResponse {
  items: WebsshAuditEventView[]
  total: number
  page: number
  pageSize: number
}

export type WebsshHealthAlertCode =
  | 'session_failures'
  | 'host_key_changed'
  | 'retention_failed'
  | 'ticket_anomaly'

export interface WebsshHealthAlert {
  code: WebsshHealthAlertCode
  severity: 'warning' | 'danger'
  count: number
  lastAt: number | null
}

/** Local-only statistics; nothing in this shape triggers an external notification. */
export interface WebsshHealthReport {
  generatedAt: number
  sessions: { total: number; failed: number; failureRate: number }
  signals: {
    hostKeyChanged: number
    retentionFailed: number
    ticketRejected: number
  }
  alerts: WebsshHealthAlert[]
}

/** Client -> server frames; every frame is JSON text on the same-origin socket. */
export type WebsshClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }

/**
 * Server -> client frames.
 *
 * `exitCode`/`signal` are additive fields on `exit`: the frozen frame set names only `reason` and
 * `message`, while an interactive shell's real status is worth carrying for the status bar.
 */
export type WebsshServerFrame =
  | { type: 'ready'; cols: number; rows: number }
  | { type: 'output'; data: string }
  | { type: 'exit'; reason: WebsshCloseReason; message?: string; exitCode?: number | null; signal?: string | null }
  | { type: 'error'; code: string; message?: string }
  | { type: 'pong' }

export type WebsshAuthMethod = 'password' | 'publickey'

export interface WebsshHostGroup {
  id: string
  parentId: string
  name: string
  color: string
  icon: string
  position: number
  createdAt: number
  updatedAt: number
}

/** The icon a row paints: the provider monogram, a curated Lucide glyph, an emoji or an uploaded image. */
export type WebsshHostIconKind = '' | 'lucide' | 'emoji' | 'image'

export interface WebsshHost {
  id: string
  name: string
  host: string
  port: number
  username: string
  groupId: string
  authMethod: WebsshAuthMethod
  credentialId: string
  keyId: string
  encoding: string
  termType: string
  initialCommand: string
  color: string
  tags: string[]
  notes: string
  favorite: boolean
  pinned: boolean
  sortOrder: number
  provider: string
  iconKind: WebsshHostIconKind
  iconValue: string
  /** Same-origin URL of an uploaded icon; empty when the chosen icon is not an image. */
  iconUrl: string
  lastConnectedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface WebsshHostListResponse {
  items: WebsshHost[]
  total: number
  page: number
  pageSize: number
}

/** Ordering the list offers; `manual` is the drag-reordered position inside a folder. */
export type WebsshHostSort = 'manual' | 'name' | 'recent' | 'created' | 'provider'

/** The rail views: every host, the starred ones, the pinned ones, and those that have connected. */
export type WebsshHostQuickView = 'all' | 'favorites' | 'pinned' | 'recent'

/** Connection state the filter can ask for; empty means no restriction. */
export type WebsshHostStatusFilter = '' | 'connected' | 'never'

/** A user-defined provider row; built-ins live in the shared provider table. */
export interface WebsshProvider {
  id: string
  label: string
  color: string
  createdAt: number
  updatedAt: number
}

/** A provider's host count and how many sessions its hosts have opened. */
export interface WebsshProviderCount {
  id: string
  hostCount: number
  connectionCount: number
}

export interface WebsshHostTimeRange {
  from: string
  to: string
}

/** The combinable list filters; nil/empty fields place no restriction. */
export interface WebsshHostFilters {
  provider: string
  pinned: boolean
  status: WebsshHostStatusFilter
  connected: WebsshHostTimeRange
  created: WebsshHostTimeRange
}

/** A folder row with its direct host count, so the rail can print a number beside every name. */
export interface WebsshHostFolder extends WebsshHostGroup {
  hostCount: number
}

export interface WebsshHostTagCount {
  name: string
  count: number
}

/** Everything the rail needs without asking for a page of hosts. */
export interface WebsshHostsOverview {
  total: number
  favorites: number
  pinned: number
  /** Hosts with at least one recorded connection. */
  connected: number
  /** Hosts that have never connected. */
  never: number
  folders: WebsshHostFolder[]
  tags: WebsshHostTagCount[]
  providers: WebsshProviderCount[]
}

export type WebsshHostBatchAction = 'move' | 'tag' | 'favorite' | 'unfavorite' | 'delete' | 'provider'

export interface WebsshHostBatchInput {
  action: WebsshHostBatchAction
  ids: string[]
  /** Required for `move`. */
  groupId?: string
  /** Required for `tag`; added to each host's existing tags. */
  tags?: string[]
  /** Required for `provider`. */
  provider?: string
}

export interface WebsshHostBatchResult {
  affected: number
  skipped: number
}

/** One prior connection of a host, for the detail pane's history section. */
export interface WebsshHostSessionSummary {
  id: string
  status: WebsshSessionStatus
  startedAt: number
  connectedAt: number | null
  endedAt: number | null
  closeReason: string
  errorCode: string
  recordingId: string
}

export type WebsshHostExportFormat = 'ssh-config' | 'csv'

export interface WebsshCredential {
  id: string
  label: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  hostCount: number
}

export interface WebsshKey {
  id: string
  label: string
  algorithm: string
  publicKey: string
  fingerprint: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  hostCount: number
}

export type WebsshHostKeyState = 'untrusted' | 'trusted' | 'changed' | 'revoked'

export interface WebsshHostKey {
  algorithm: string
  fingerprint: string
  firstSeenAt: number
  lastSeenAt: number
  trustedAt: number | null
  revokedAt: number | null
}

export interface WebsshHostKeyCheck {
  state: WebsshHostKeyState
  algorithm: string
  fingerprint: string
  trustedFingerprint: string | null
}

export interface WebsshHostPreflight {
  hostId: string
  host: string
  port: number
  username: string
  authMethod: WebsshAuthMethod
  ready: boolean
  issues: string[]
  credentialLabel: string | null
  keyLabel: string | null
  hostKey: WebsshHostKeyCheck | null
}

/**
 * An asciinema cast v2 header. `timestamp` is in whole seconds; terminal output and resize events
 * follow as one JSON tuple per line.
 */
export interface WebsshCastHeader {
  version: 2
  width: number
  height: number
  timestamp: number
  env?: Record<string, string>
}

/** `[seconds since the recording started, kind, payload]` — `o` output text, `r` `colsxrows`. */
export type WebsshCastEvent =
  | [number, 'o', string]
  | [number, 'r', string]

export type WebsshRecordingStatus = 'recording' | 'finalizing' | 'ready' | 'failed' | 'deleted'

/** The owner-facing metadata of one session recording. */
export interface WebsshRecordingView {
  id: string
  sessionId: string
  hostId: string
  format: 'cast'
  status: WebsshRecordingStatus
  sizeBytes: number
  durationMs: number
  cols: number
  rows: number
  createdAt: number
  finalizedAt: number | null
  expiresAt: number
}

/** A recording in the owner's library, joined with the host label for grouping. */
export interface WebsshRecordingListItem extends WebsshRecordingView {
  hostName: string
}

export interface WebsshRecordingListResponse {
  items: WebsshRecordingListItem[]
  total: number
  page: number
  pageSize: number
}

/**
 * One byte-addressed slice of a cast file. `offset` is the requested offset, `startOffset` the byte
 * the first returned line begins at (a partial first line is skipped), and `nextOffset` the byte
 * after the last complete line — the value to pass as `offset` for the next slice.
 */
export interface WebsshRecordingFrames {
  recordingId: string
  sessionId: string
  offset: number
  startOffset: number
  nextOffset: number
  totalSize: number
  complete: boolean
  header?: WebsshCastHeader
  frames: WebsshCastEvent[]
}

export interface WebsshRecordingSettingsView {
  recording: {
    enabled: boolean
    retentionDays: number
  }
  hostKeys: {
    /** First-seen host keys are trusted without a prompt when true (the default). */
    autoTrustFirst: boolean
  }
}

/**
 * The owner-facing view of one public replay link. `url` is the `/w/<slug>` address a browser opens
 * and `hasPassword` says whether a passcode stands in front of it; the recording's R2 key is never
 * part of this shape.
 */
export interface WebsshShareView {
  slug: string
  recordingId: string
  title: string
  url: string
  hasPassword: boolean
  expiresAt: number
  maxViews: number
  views: number
  isEnabled: boolean
  createdAt: number
  lastViewedAt: number | null
}

/** What a visitor is told about a recording once the link's gate has been passed. */
export interface WebsshPublicShareRecording {
  format: 'cast'
  sizeBytes: number
  durationMs: number
  cols: number
  rows: number
  createdAt: number
  finalizedAt: number | null
}

/**
 * The public metadata read. It names the share, never the session: no recording id, session id, host
 * id, account id, R2 key or host address reaches a visitor.
 */
export interface WebsshPublicShareView {
  share: {
    slug: string
    title: string
    createdAt: number
    expiresAt: number
    maxViews: number
    views: number
  }
  recording: WebsshPublicShareRecording
}

/**
 * One byte-addressed slice of a shared cast. The slicing rules are the owner-side replay's, but the
 * answer carries no recording or session identity.
 */
export interface WebsshPublicShareFrames {
  offset: number
  startOffset: number
  nextOffset: number
  totalSize: number
  complete: boolean
  header?: WebsshCastHeader
  frames: WebsshCastEvent[]
}
