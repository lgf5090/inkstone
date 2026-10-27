import { Hono } from 'hono'
import { initializeDatabase } from './db/schema'
import { ApiError, errorResponse } from './lib/errors'
import { securityHeaders } from './lib/security-headers'
import { loadSession, requireClientHeader } from './middleware/auth'
import { authRoutes } from './routes/auth'
import { totpRoutes } from './routes/totp'
import { notesRoutes } from './routes/notes'
import { memoListRoutes } from './routes/memos'
import { memoSpaceRoutes } from './routes/memos/spaces'
import { memoViewRoutes } from './routes/memos/views'
import { memoTokenRoutes } from './routes/memos/tokens'
import { memoPreferenceRoutes } from './routes/memos/preferences'
import { memoReactionRoutes } from './routes/memos/reactions'
import { memoShareRoutes } from './routes/memos/shares'
import { memoWebhookRoutes } from './routes/memos/webhooks'
import { memoTransferRoutes } from './routes/memos/transfer'
import { memoPublicDataRoutes } from './routes/memos/public'
import { memoStatsRoutes } from './routes/memos/stats'
import { memoAiRoutes } from './routes/memos/ai'
import { memoLinkMetaRoutes } from './routes/memos/link-meta'
import { memoAttachmentRoutes } from './routes/memos/attachments'
import { memoFileRoutes } from './routes/memos/files'
import { foldersRoutes } from './routes/folders'
import { tagsRoutes } from './routes/tags'
import { communityTemplatesRoutes } from './routes/community-templates'
import { templateLibraryRoutes } from './routes/template-library'
import { templaterRoutes } from './routes/templater'
import { quickAddRoutes } from './routes/quickadd'
import { searchRoutes } from './routes/search'
import { syncRoutes } from './routes/sync'
import { filesRoutes } from './routes/files'
import { attachmentHubRoutes } from './routes/attachments'
import { avatarRoutes } from './routes/avatars'
import { backupRoutes } from './routes/backup'
import { settingsRoutes } from './routes/settings'
import { conversationSharePageRoutes, shareManageRoutes, sharePageRoutes, shareRoutes } from './routes/share'
import { shareAnalyticsRoutes } from './routes/share-analytics'
import { shareOrganizerRoutes } from './routes/share-organizer'
import { publicCollectionPageRoutes, publicCollectionRoutes, shareCollectionRoutes } from './routes/share-collections'
import { memosPublicPageRoutes } from './routes/memos-public'
import { transferRoutes } from './routes/transfer'
import { updateRoutes } from './routes/update'
import { mcpAuthorizeRoutes } from './routes/mcp-authorize'
import { mcpSettingsRoutes } from './routes/mcp-settings'
import { aiProxyRoutes } from './routes/ai-proxy'
import { assistantRoutes } from './routes/assistant'
import { excalidrawLibraryRoutes } from './routes/excalidraw-library'
import { readingRoutes } from './routes/reading'
import { readerLibraryRoutes } from './routes/reader-library'
import { readerDiscoveryRoutes } from './routes/reader-discovery'
import { rssRoutes } from './routes/rss'
import { subscriptionRoutes } from './routes/subscriptions'
import { todoRoutes } from './routes/todos'
import { todoMailRoutes } from './routes/todo-mail'
import { todoAttachmentRoutes } from './routes/todo-attachments'
import { todoImportRoutes } from './routes/todo-import'
import { todoFeedRoutes } from './routes/todo-feeds'
import { emailRoutes } from './routes/email'
import { musicRoutes } from './routes/music'
import { toolsPasswordRoutes } from './routes/tools-password'
import { toolsQrcodeRoutes } from './routes/tools-qrcode'
import { toolsColorRoutes } from './routes/tools-color'
import { toolsIdPhotoRoutes } from './routes/tools-id-photo'
import { toolsShortlinksRoutes } from './routes/tools-shortlinks'
import { toolsShortlinksRedirectRoutes } from './routes/tools-shortlinks-redirect'
import { developmentDatabaseRoutes } from './routes/development-database'
import { calendarRoutes } from './routes/calendar'
import { calendarIcsRoutes } from './routes/calendar-ics'
import { calendarSubscriptionRoutes } from './routes/calendar-subscriptions'
import { calendarSyncRoutes } from './routes/calendar-sync'
import { calendarShareRoutes } from './routes/calendar-shares'
import { calendarAttachmentRoutes } from './routes/calendar-attachments'
import { calendarPublicRoutes } from './routes/calendar-public'
import { musicSharePageRoutes, musicSharePublicRoutes } from './routes/music-share'
import { emailSearchesRoutes } from './routes/email-searches'
import { emailTemplatesRoutes } from './routes/email-templates'
import { emailRulesRoutes } from './routes/email-rules'
import { emailContactsRoutes } from './routes/email-contacts'
import { emailSendRoutes } from './routes/email-send'
import { emailScheduleRoutes } from './routes/email-schedule'
import { subscriptionInboundRoutes } from './routes/subscriptions-inbound'
import { INBOUND_HOOK_PATH } from '@shared/subscriptions/channels'
import type { AppBindings } from './env'
import { selectAttachmentStorage } from './attachments/backend'

export function createApp() {
  const app = new Hono<AppBindings>()

  app.onError((err, c) => errorResponse(c, err))
  app.use('*', async (c, next) => {
    await next()
    // A 1xx handshake response carries the socket, and Hono rebuilds the Response to
    // mutate its headers — which the Response constructor rejects below 200.
    if (c.res.status < 200) return
    const devDocument = import.meta.env?.DEV === true
      && (c.res.headers.get('content-type') ?? '').includes('text/html')
    for (const [name, value] of Object.entries(securityHeaders(c.req.url, {
      allowDevInlineScripts: devDocument,
      aiConnectHosts: c.env.AI_CONNECT_HOSTS,
    }))) {
      c.header(name, value)
    }
    if (c.req.path.startsWith('/api/') && !c.res.headers.has('Cache-Control')) {
      c.header('Cache-Control', 'no-store')
    }
  })


  app.use('/api/*', requireClientHeader)
  app.use('/api/*', async (c, next) => {
    c.set('database', await initializeDatabase(c.env))
    await next()
  })
  app.use('/s/*', async (c, next) => {
    c.set('database', await initializeDatabase(c.env))
    await next()
  })
  app.use('/feeds/*', async (c, next) => {
    c.set('database', await initializeDatabase(c.env))
    await next()
  })
  app.use('/authorize', async (c, next) => {
    c.set('database', await initializeDatabase(c.env))
    await next()
  })
  app.use('/m/*', async (c, next) => {
    c.set('database', await initializeDatabase(c.env))
    await next()
  })
  app.use('/l/*', async (c, next) => {
    c.set('database', await initializeDatabase(c.env))
    await next()
  })

  app.use('/api/*', loadSession)
  app.use('/authorize', loadSession)

  app.get('/api/health', async (c) => {
    const database = c.get('database')
    if (!c.get('userId')) return c.json({ ok: true })
    return c.json({
      ok: true,
      database: 'ready',
      fts: database.ftsEnabled,
      r2: Boolean(c.env.FILES),
      kv: Boolean(c.env.FILES_KV),
      attachmentStorage: selectAttachmentStorage(c.env),
      realtime: Boolean(c.env.SYNC_HUB),
      credentialVault: Boolean(c.env.CREDENTIAL_VAULT),
      mcp: Boolean(c.env.OAUTH_KV),
      time: Date.now(),
    })
  })

  app.route('/api/auth/totp', totpRoutes)
  app.route('/api/auth', authRoutes)
  app.route('/api/notes', notesRoutes)
  // Public reads and share-authorized files must be registered before the authenticated
  // `/api/memos` mounts: a mounted app's `use('*')` would otherwise turn an anonymous
  // share page into a 401 before these routes ever see it.
  app.route('/api/memos/public', memoPublicDataRoutes)
  app.route('/api/memos/files', memoFileRoutes)
  app.route('/api/memos/spaces', memoSpaceRoutes)
  app.route('/api/memos/views', memoViewRoutes)
  app.route('/api/memos/tokens', memoTokenRoutes)
  app.route('/api/memos/preferences', memoPreferenceRoutes)
  app.route('/api/memos/webhooks', memoWebhookRoutes)
  app.route('/api/memos', memoTransferRoutes)
  app.route('/api/memos/stats', memoStatsRoutes)
  app.route('/api/memos/ai', memoAiRoutes)
  app.route('/api/memos/link-metadata', memoLinkMetaRoutes)
  app.route('/api/memos/attachments', memoAttachmentRoutes)
  app.route('/api/memos', memoShareRoutes)
  app.route('/api/memos', memoReactionRoutes)
  app.route('/api/memos', memoListRoutes)
  app.route('/api/folders', foldersRoutes)
  app.route('/api/tags', tagsRoutes)
  app.route('/api/templates/community', communityTemplatesRoutes)
  app.route('/api/templates', templateLibraryRoutes)
  app.route('/api/templater', templaterRoutes)
  app.route('/api/quickadd', quickAddRoutes)
  app.route('/api/rss', rssRoutes)
  app.route('/api/calendar/ics', calendarIcsRoutes)
  app.route('/api/calendar/subscriptions', calendarSubscriptionRoutes)
  app.route('/api/calendar', calendarSyncRoutes)
  app.route('/api/calendar', calendarShareRoutes)
  app.route('/api/calendar', calendarAttachmentRoutes)
  app.route('/feeds', calendarPublicRoutes)
  app.route('/api/calendar', calendarRoutes)
  app.route('/api/subscriptions', subscriptionRoutes)
  app.route('/api', searchRoutes)
  app.route('/api/sync', syncRoutes)
  app.route('/api/files', filesRoutes)
  app.route('/api/attachments', attachmentHubRoutes)
  app.route('/api/avatars', avatarRoutes)
  app.route('/api/backup', backupRoutes)
  app.route('/api/settings', settingsRoutes)
  app.route('/api/update', updateRoutes)
  app.route('/api/mcp', mcpSettingsRoutes)
  app.route('/api/ai', aiProxyRoutes)
  // Before `/api/todos`: Hono matches in registration order and that router owns `/:id`, so the
  // import path has to be claimed first or it would read as the id of a task called "import".
  app.route('/api/todos/import', todoImportRoutes)
  // The mail address is the same shape of collision: "mail-token" must be a route, not a task id.
  app.route('/api/todos/mail-token', todoMailRoutes)
  // The attachment surface names a task too, so it is claimed before the task router as well; its
  // paths carry the extra `/attachments` segment, which the task router would never match.
  app.route('/api/todos', todoAttachmentRoutes)
  app.route('/api/todos', todoRoutes)
  app.route('/api/email', emailSearchesRoutes)
  app.route('/api/email', emailTemplatesRoutes)
  app.route('/api/email', emailRulesRoutes)
  app.route('/api/email', emailScheduleRoutes)
  app.route('/api/email', emailContactsRoutes)
  app.route('/api/email', emailSendRoutes)
  app.route('/api/email', emailRoutes)
  app.route('/api/music', musicRoutes)
  app.route('/api/tools/password', toolsPasswordRoutes)
  app.route('/api/tools/qrcode', toolsQrcodeRoutes)
  app.route('/api/tools/color', toolsColorRoutes)
  app.route('/api/tools/id-photo', toolsIdPhotoRoutes)
  app.route('/api/tools/shortlinks', toolsShortlinksRoutes)
  app.route('/api/development/database', developmentDatabaseRoutes)
  app.route('/api/assistant', assistantRoutes)
  app.route('/api/excalidraw/ai', aiProxyRoutes)
  app.route('/api/excalidraw/library', excalidrawLibraryRoutes)
  app.route('/api/reading', readingRoutes)
  app.route('/api/reader/discovery', readerDiscoveryRoutes)
  app.route('/api/reader', readerLibraryRoutes)
  // The hub's own routers are claimed before `shareManageRoutes`, which reads any one-segment path
  // under `/api/share` as a note id: mounted the other way round, `GET /api/share/folders` would be
  // answered as "the share of a note called folders" rather than as the folder list.
  app.route('/api/share', shareAnalyticsRoutes)
  app.route('/api/share', shareOrganizerRoutes)
  app.route('/api/share', shareCollectionRoutes)
  app.route('/api/share', shareManageRoutes)
  app.route('/api/public', publicCollectionRoutes)
  app.route('/api/public/music', musicSharePublicRoutes)
  app.route('/api/public', shareRoutes)
  app.route('/api', transferRoutes)

  // Outside the API prefix on purpose, and the path is shared with the settings screen that prints it.
  app.route(INBOUND_HOOK_PATH, subscriptionInboundRoutes)

  app.all('/api/*', () => {
    throw ApiError.notFound('API endpoint not found')
  })


  app.route('/s', sharePageRoutes)
  app.route('/m', musicSharePageRoutes)
  app.route('/c', conversationSharePageRoutes)
  app.route('/collections', publicCollectionPageRoutes)
  app.route('/feeds', todoFeedRoutes)
  app.route('/memos', memosPublicPageRoutes)
  app.route('/', toolsShortlinksRedirectRoutes)
  app.route('/', mcpAuthorizeRoutes)


  app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

  return app
}
