export type InkAttachmentKind = 'image' | 'pdf' | 'audio'

const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.ogg']

/** The kinds the canvas can place; everything else stays in the attachment library. */
export function kindFromMime(mime: string | null | undefined, filename: string | null | undefined): InkAttachmentKind | null {
    const type = (mime ?? '').trim().toLowerCase()
    const name = (filename ?? '').trim().toLowerCase()
    if (type.startsWith('image/')) return 'image'
    if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
    if (type.startsWith('audio/') || AUDIO_EXTENSIONS.some((extension) => name.endsWith(extension))) return 'audio'
    return null
}
