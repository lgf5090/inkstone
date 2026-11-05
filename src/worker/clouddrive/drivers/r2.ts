/**
 * Cloudflare R2 driver.
 *
 * R2 is an S3-compatible object store, so this driver reuses the S3 core in `s3.ts`: the same
 * ListObjectsV2 flow, placeholder directories and multipart upload. A Workers R2 *binding* is only
 * reachable from `env`, which `DriverContext` deliberately does not expose, so the mount always uses
 * the S3 API (`accountId` derives the endpoint when no explicit one is given).
 */
import type { DriverContext, MountDriver } from './contract'
import { S3Driver } from './s3'

export class R2Driver extends S3Driver {
  constructor(ctx: DriverContext) {
    super(ctx, 'r2')
  }

  protected override endpoint(): string {
    const explicit = super.endpoint()
    if (explicit) return explicit
    const accountId = this.configText('accountId').trim()
    return accountId ? `https://${accountId}.r2.cloudflarestorage.com` : ''
  }

  protected override region(): string {
    return this.configText('region', 'auto').trim() || 'auto'
  }

  protected override pathStyle(): boolean {
    return true
  }
}

export function createR2Driver(ctx: DriverContext): MountDriver {
  return new R2Driver(ctx)
}
