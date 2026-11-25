let terminate: (() => Promise<void>) | null = null

export function registerPdfOcrTerminator(fn: () => Promise<void>): void {
  terminate = fn
}

export async function terminatePdfOcrIfLoaded(): Promise<void> {
  if (terminate) await terminate()
}
