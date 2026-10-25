/**
 * The provider a reader's account reads through.
 *
 * The stored Netease cookie is a ciphertext, so it is decrypted only for this call. A vault that
 * cannot open it degrades to anonymous reads (public tracks still play) and says so in the log rather
 * than pretending the account is connected. A deployment that points `MUSIC_UPSTREAM_API` at a
 * self-hosted NCM server uses the same cookie through that adapter.
 */
import type { Env } from '../../env'
import { decryptMusicCookie } from '../../lib/crypto'
import { MusicStore } from '../store'
import { createNeteaseProvider } from './netease/client'
import type { MusicProvider } from './types'

export async function musicProviderFor(env: Env, userId: string): Promise<MusicProvider> {
  const stored = await new MusicStore(env.DB, userId).getAccountCookie('netease')
  let cookie: string | null = null
  if (stored) {
    try {
      cookie = await decryptMusicCookie(env, userId, stored)
    } catch (error) {
      console.warn('[inkstone] Music account cookie could not be decrypted; reading anonymously:', error)
    }
  }
  return createNeteaseProvider({
    ...(cookie ? { cookie } : {}),
    ...(env.MUSIC_UPSTREAM_API ? { upstreamBaseUrl: env.MUSIC_UPSTREAM_API } : {}),
  })
}
