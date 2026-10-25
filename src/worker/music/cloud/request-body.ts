/**
 * Build the body half of a fetch init for a cloud upload.
 *
 * A streamed body has to declare `duplex: 'half'` for runtimes that follow the Fetch standard
 * (Node enforces it; the Workers runtime accepts it and streams the request). Byte arrays and
 * Blobs are sent without it so ordinary small uploads stay a plain RequestInit.
 */
export function uploadBodyInit(
  body: Uint8Array | Blob | ReadableStream<Uint8Array>,
): { body: BodyInit; duplex?: 'half' } {
  if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    return { body: body as BodyInit, duplex: 'half' }
  }
  return { body: body as BodyInit }
}
