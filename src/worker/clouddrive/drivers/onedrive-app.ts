/**
 * OneDrive application-identity driver.
 *
 * An app-only token is requested with the `client_credentials` grant, so there is no user to refresh
 * and no `/me` endpoint: the drive belongs to a configured user (`/users/{email}/drive`) or is
 * addressed directly by id (`/drives/{driveId}`). Everything else is the shared OneDrive logic.
 */
import { DriverError, type DriverContext, type MountDriver } from './contract'
import { OneDriveDriver } from './onedrive'
import { ClientCredentialsSession, type OAuthSession } from './token'

const GRAPH = 'https://graph.microsoft.com/v1.0'

/**
 * Presents the `token`/`withToken` surface OneDriveDriver expects on top of a client-credentials
 * session. There is no refresh token, so an auth failure re-requests the application token and only
 * marks the storage for review when that request is refused.
 */
class ClientCredentialsAdapter {
  constructor(
    private readonly ctx: DriverContext,
    private readonly session: ClientCredentialsSession,
  ) {}

  token(force = false): Promise<string> {
    return this.session.token(force)
  }

  invalidate(): void {
    // The client-credentials session keeps its own expiry; nothing to drop here.
  }

  async withToken<T>(work: (token: string) => Promise<T>): Promise<T> {
    let token: string
    try {
      token = await this.session.token()
    } catch (error) {
      await this.markAuthFailure(error)
      throw error
    }
    try {
      return await work(token)
    } catch (error) {
      if (!(error instanceof DriverError) || error.kind !== 'auth') throw error
      let fresh: string
      try {
        fresh = await this.session.token(true)
      } catch (refreshError) {
        await this.markAuthFailure(refreshError)
        throw refreshError
      }
      try {
        return await work(fresh)
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : 'The storage needs to be authorized again'
        await this.ctx.markNeedsReauth(message)
        throw DriverError.auth(message)
      }
    }
  }

  private async markAuthFailure(error: unknown): Promise<void> {
    if (error instanceof DriverError && error.kind === 'auth') await this.ctx.markNeedsReauth(error.message)
  }
}

export class OneDriveAppDriver extends OneDriveDriver {
  constructor(ctx: DriverContext) {
    const tenantId = String(ctx.config.tenantId ?? '').trim() || 'common'
    const clientId = String(ctx.credentials.clientId ?? '')
    const clientSecret = String(ctx.credentials.clientSecret ?? '')
    const session = new ClientCredentialsSession(ctx, {
      tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      scope: 'https://graph.microsoft.com/.default',
      clientId,
      clientSecret,
    })
    const driveId = String(ctx.config.driveId ?? '').trim()
    const email = String(ctx.config.email ?? '').trim()
    const base = driveId
      ? `${GRAPH}/drives/${encodeURIComponent(driveId)}`
      : email
        ? `${GRAPH}/users/${encodeURIComponent(email)}/drive`
        : ''
    if (!base) throw DriverError.auth('OneDrive application mounts need a drive id or a user email')
    super(ctx, {
      definitionId: 'onedrive_app',
      base,
      session: new ClientCredentialsAdapter(ctx, session) as unknown as OAuthSession,
    })
  }
}

export function createOneDriveAppDriver(ctx: DriverContext): MountDriver {
  return new OneDriveAppDriver(ctx)
}
