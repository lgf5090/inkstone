import { gzipSync, gunzipSync } from 'fflate'
import {
  HISTORY_ENTRY_MAX_BYTES,
  STATE_CIPHERTEXT_MAX_CHARS,
  STATE_GZIP_MAX_BYTES,
  STATE_JSON_MAX_BYTES,
} from '@shared/development/api-tester/limits'
import type { Env } from '../../env'
import {
  decryptApiTesterHistory,
  decryptApiTesterState,
  decryptApiTesterWsTicket,
  encryptApiTesterHistory,
  encryptApiTesterState,
  encryptApiTesterWsTicket,
} from '../../lib/crypto'
import { fromBase64, fromUtf8, toBase64, utf8 } from '../../lib/encoding'
import { ApiError } from '../../lib/errors'

function decodeJson<T>(blob: string, what: string): T {
  try {
    const json = fromUtf8(gunzipSync(fromBase64(blob)))
    return JSON.parse(json) as T
  } catch {
    throw new ApiError(502, 'internal', `The stored ${what} could not be decoded`)
  }
}

export async function sealState(env: Env, workspaceId: string, data: unknown): Promise<{ ciphertext: string; gzipBytes: number }> {
  const json = JSON.stringify(data)
  const bytes = utf8(json)
  if (bytes.byteLength > STATE_JSON_MAX_BYTES) {
    throw new ApiError(413, 'apitester_state_too_large', `The API Tester state exceeds ${STATE_JSON_MAX_BYTES} bytes`)
  }
  const compressed = gzipSync(bytes)
  if (compressed.byteLength > STATE_GZIP_MAX_BYTES) {
    throw new ApiError(413, 'apitester_state_too_large', `The API Tester state compresses to more than ${STATE_GZIP_MAX_BYTES} bytes`)
  }
  const blob = toBase64(compressed)
  if (blob.length > STATE_CIPHERTEXT_MAX_CHARS) {
    throw new ApiError(413, 'apitester_state_too_large', 'The API Tester state is too large to store safely')
  }
  return { ciphertext: await encryptApiTesterState(env, workspaceId, blob), gzipBytes: compressed.byteLength }
}

export async function openState<T>(env: Env, workspaceId: string, ciphertext: string): Promise<T> {
  const blob = await decryptApiTesterState(env, workspaceId, ciphertext)
  if (!blob) throw new ApiError(502, 'internal', 'The stored API Tester state could not be opened')
  return decodeJson<T>(blob, 'API Tester state')
}

export async function sealHistory(env: Env, historyId: string, entry: unknown): Promise<string> {
  const json = JSON.stringify(entry)
  const bytes = utf8(json)
  if (bytes.byteLength > HISTORY_ENTRY_MAX_BYTES) {
    throw new ApiError(413, 'apitester_history_too_large', `A history entry exceeds ${HISTORY_ENTRY_MAX_BYTES} bytes`)
  }
  return encryptApiTesterHistory(env, historyId, toBase64(gzipSync(bytes)))
}

export async function openHistory<T>(env: Env, historyId: string, ciphertext: string): Promise<T> {
  const blob = await decryptApiTesterHistory(env, historyId, ciphertext)
  if (!blob) throw new ApiError(502, 'internal', 'A stored history entry could not be opened')
  return decodeJson<T>(blob, 'history entry')
}

export async function sealWsTicket(env: Env, ticketId: string, payload: unknown): Promise<string> {
  return encryptApiTesterWsTicket(env, ticketId, JSON.stringify(payload))
}

export async function openWsTicket<T>(env: Env, ticketId: string, ciphertext: string): Promise<T> {
  const payload = await decryptApiTesterWsTicket(env, ticketId, ciphertext)
  if (!payload) throw new ApiError(502, 'internal', 'The WebSocket ticket could not be opened')
  try {
    return JSON.parse(payload) as T
  } catch {
    throw new ApiError(502, 'internal', 'The WebSocket ticket payload is invalid')
  }
}
