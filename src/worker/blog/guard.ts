import { createMiddleware } from 'hono/factory'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'

/**
 * Public blog reads are served to the blog Worker, not to browsers. A deployment must set
 * BLOG_PROXY_KEY; local development may omit it so the two dev servers can talk without secrets.
 */
export const requireBlogProxy = createMiddleware<AppBindings>(async (c, next) => {
  const expected = c.env.BLOG_PROXY_KEY
  if (!expected) {
    if (import.meta.env?.DEV === true) {
      await next()
      return
    }
    throw new ApiError(503, 'server_misconfigured', 'BLOG_PROXY_KEY is not configured')
  }
  if (c.req.header('x-blog-proxy-key') !== expected) {
    throw ApiError.forbidden('The blog proxy key is invalid')
  }
  await next()
})
