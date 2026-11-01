import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'

/** Beyond this an image is not something a browser should decode just to look for one code. */
const MAX_QR_IMAGE_BYTES = 20 * 1024 * 1024

/**
 * The one gate every image that enters the workshop passes: dropped, picked, or pasted. Returns the
 * file when it can be decoded here, and tells the reader why it cannot otherwise.
 */
export function acceptQrImageFile(file: File | undefined): File | null {
  if (!file) return null
  if (!file.type.startsWith('image/')) {
    useUi.getState().toast({ title: t('tools.qrcode.scanner.not_image'), tone: 'danger' })
    return null
  }
  if (file.size > MAX_QR_IMAGE_BYTES) {
    useUi.getState().toast({ title: t('tools.qrcode.scanner.too_large'), tone: 'danger' })
    return null
  }
  return file
}
