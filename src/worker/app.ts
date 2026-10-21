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
import { memoPreferenceRoutes } from './routes/memos/preferences'
import { memoReactionRoutes } from './routes/memos/reactions'
import { memoAttachmentRoutes } from './routes/memos/attachments'
import { memoFileRoutes } from './routes/memos/files'
import { foldersRoutes } from './routes/folders'
import { tagsRoutes } from './routes/tags'
import { communityTemplatesRoutes } from './routes/community-templates'
import { templateLibraryRoutes } from './routes/template-library'
import { quickAddRoutes } from './routes/quickadd'
import { searchRoutes } from './routes/search'
import { syncRoutes } from './routes/sync'
import { filesRoutes } from './routes/files'
import { avatarRoutes } from './routes/avatars'
import { backupRoutes } from './routes/backup'
import { settingsRoutes } from './routes/settings'
import { conversationSharePageRoutes, shareManageRoutes, sharePageRoutes, shareRoutes } from './routes/share'
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
  app.use('/authorize', async (c, next) => {
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
  app.route('/api/memos/spaces', memoSpaceRoutes)
  app.route('/api/memos/views', memoViewRoutes)
  app.route('/api/memos/preferences', memoPreferenceRoutes)
  app.route('/api/memos/attachments', memoAttachmentRoutes)
  app.route('/api/memos/files', memoFileRoutes)
  app.route('/api/memos', memoReactionRoutes)
  app.route('/api/memos', memoListRoutes)
  app.route('/api/folders', foldersRoutes)
  app.route('/api/tags', tagsRoutes)
  app.route('/api/templates/community', communityTemplatesRoutes)
  app.route('/api/templates', templateLibraryRoutes)
  app.route('/api/quickadd', quickAddRoutes)
  app.route('/api/rss', rssRoutes)
  app.route('/api/subscriptions', subscriptionRoutes)
  app.route('/api', searchRoutes)
  app.route('/api/sync', syncRoutes)
  app.route('/api/files', filesRoutes)
  app.route('/api/avatars', avatarRoutes)
  app.route('/api/backup', backupRoutes)
  app.route('/api/settings', settingsRoutes)
  app.route('/api/update', updateRoutes)
  app.route('/api/mcp', mcpSettingsRoutes)
  app.route('/api/ai', aiProxyRoutes)
  app.route('/api/assistant', assistantRoutes)
  app.route('/api/excalidraw/ai', aiProxyRoutes)
  app.route('/api/excalidraw/library', excalidrawLibraryRoutes)
  app.route('/api/reading', readingRoutes)
  app.route('/api/reader/discovery', readerDiscoveryRoutes)
  app.route('/api/reader', readerLibraryRoutes)
  app.route('/api/share', shareManageRoutes)
  app.route('/api/public', shareRoutes)
  app.route('/api', transferRoutes)

  // Outside the API prefix on purpose, and the path is shared with the settings screen that prints it.
  app.route(INBOUND_HOOK_PATH, subscriptionInboundRoutes)

  app.all('/api/*', () => {
    throw ApiError.notFound('API endpoint not found')
  })


  app.route('/s', sharePageRoutes)
  app.route('/c', conversationSharePageRoutes)
  app.route('/memos', memosPublicPageRoutes)
  app.route('/', mcpAuthorizeRoutes)


  app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

  return app
}
