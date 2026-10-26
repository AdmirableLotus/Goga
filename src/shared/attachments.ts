export interface ChatAttachment {
  id: string
  name: string
  kind: 'image' | 'video'
  /** Normalized JPEG data URLs; videos contain sampled frames. */
  images: string[]
  sampledAtSeconds?: number[]
  durationSeconds?: number
}

export const MAX_ATTACHMENTS = 4
export const MAX_ATTACHMENT_FRAMES = 12

export function validateAttachments(value: unknown): ChatAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new Error('Attach up to four images or videos.')
  let frames = 0, bytes = 0
  return value.map(a => {
    if (!a || typeof a.id !== 'string' || typeof a.name !== 'string' || a.name.length > 255 || !['image', 'video'].includes(a.kind) || !Array.isArray(a.images) || !a.images.length) throw new Error('Invalid attachment.')
    if (a.kind === 'image' && a.images.length !== 1 || a.kind === 'video' && a.images.length > 6) throw new Error('Invalid attachment frame count.')
    for (const image of a.images) {
      if (typeof image !== 'string' || !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/=]+$/.test(image)) throw new Error('Attachments must contain decoded JPEG images.')
      bytes += image.length
    }
    frames += a.images.length
    if (frames > MAX_ATTACHMENT_FRAMES || bytes > 16_000_000) throw new Error('Attachments are too large. Try fewer or smaller files.')
    if (a.kind === 'video' && (!Number.isFinite(a.durationSeconds) || a.durationSeconds <= 0 || !Array.isArray(a.sampledAtSeconds) || a.sampledAtSeconds.length !== a.images.length || a.sampledAtSeconds.some((t: unknown) => typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > a.durationSeconds))) throw new Error('Invalid video timestamps.')
    return { id: a.id.slice(0, 100), name: a.name, kind: a.kind, images: a.images,
      ...(a.kind === 'video' ? { durationSeconds: a.durationSeconds, sampledAtSeconds: a.sampledAtSeconds } : {}) }
  })
}

export function attachmentPrompt(attachments: ChatAttachment[]): string {
  return attachments.map(a => a.kind === 'image' ? `Image: ${a.name}` : `Video: ${a.name}, duration ${a.durationSeconds?.toFixed(1)}s. Frames at ${a.sampledAtSeconds?.map(t => t.toFixed(1)).join(', ')} seconds.`).join('\n')
}
