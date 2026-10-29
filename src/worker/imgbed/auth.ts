import type { Context, MiddlewareHandler } from 'hono'
import type { AppBindings } from '../env'
import type { ImgbedTokenScope } from '@shared/imgbed/model'
import { ApiError } from '../lib/errors'
import { resolveToken, scopeAllows } from './tokens'

export interface ImgbedActor {
  kind: 'session' | 'token'
  userId: string
  role: 'owner' | 'member' | null
  scopes: ImgbedTokenScope[]
  actorKey: string
}

export type ImgbedContext = Context<AppBindings>

export async function resolveImgbedActor(c: ImgbedContext): Promise<ImgbedActor | null> {
  const authorization = c.req.header('authorization') ?? ''
  const bearer = /^Bearer\s+(img_[A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1]
  if (bearer) {
    const resolved = await resolveToken(c.env.DB, bearer)
    if (!resolved) return null
    return {
      kind: 'token',
      userId: resolved.userId,
      role: null,
      scopes: resolved.scopes,
      actorKey: `token:${resolved.id}`,
    }
  }
  const user = c.get('user')
  if (!user) return null
  return {
    kind: 'session',
    userId: user.id,
    role: user.role,
    scopes: user.role === 'owner' ? ['list', 'upload', 'delete', 'manage'] : ['list', 'upload'],
    actorKey: `session:${user.id}`,
  }
}

export async function requireImgbedActor(
  c: ImgbedContext,
  scope: ImgbedTokenScope,
  options: { allowMissingSession?: boolean } = {},
): Promise<ImgbedActor | null> {
  const actor = await resolveImgbedActor(c)
  if (!actor) {
    if (options.allowMissingSession) return null
    throw ApiError.unauthenticated()
  }
  if (actor.kind === 'session' && actor.role !== 'owner') {
    if (scope === 'delete' || scope === 'manage') throw ApiError.forbidden('Owner access required')
    return actor
  }
  if (actor.kind === 'token' && !scopeAllows(actor.scopes, scope)) {
    throw ApiError.forbidden(`This token does not carry the ${scope} scope`)
  }
  return actor
}

export function requireImgbed(scope: ImgbedTokenScope): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    await requireImgbedActor(c, scope)
    await next()
  }
}

export async function optionalAdminActor(c: ImgbedContext): Promise<ImgbedActor | null> {
  const actor = await resolveImgbedActor(c)
  if (!actor) return null
  if (actor.kind === 'session' && actor.role !== 'owner') return null
  if (actor.kind === 'token' && !scopeAllows(actor.scopes, 'manage')) return null
  return actor
}
