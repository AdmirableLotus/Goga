import type { ChatAttachment } from '../../shared/attachments'

function frame(source: CanvasImageSource, width: number, height: number): string {
  if (!width || !height) throw new Error('Could not decode this media file.')
  const scale = Math.min(1, 1280 / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Image processing is unavailable.')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.85)
}

function mediaEvent(element: HTMLMediaElement | HTMLImageElement, event: string, action: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const clear = () => { clearTimeout(timer); element.removeEventListener(event, ok); element.removeEventListener('error', fail) }
    const ok = () => { clear(); resolve() }
    const fail = () => { clear(); reject(new Error('Could not decode this media. Try a PNG/JPEG image or MP4/WebM video.')) }
    const timer = setTimeout(fail, 20_000)
    element.addEventListener(event, ok, { once: true }); element.addEventListener('error', fail, { once: true })
    try { action() } catch { fail() }
  })
}

export async function prepareAttachment(file: File): Promise<ChatAttachment> {
  const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : null
  if (!kind) throw new Error('Choose an image or video file.')
  if (file.size > (kind === 'image' ? 20 : 100) * 1024 * 1024) throw new Error('Images must be under 20 MB and videos under 100 MB.')
  const url = URL.createObjectURL(file)
  const base: Pick<ChatAttachment, 'id' | 'name' | 'kind'> = { id: crypto.randomUUID(), name: file.name, kind }
  try {
    if (kind === 'image') {
      const image = new Image()
      await mediaEvent(image, 'load', () => { image.src = url })
      return { ...base, images: [frame(image, image.naturalWidth, image.naturalHeight)] }
    }
    const video = document.createElement('video')
    video.muted = true; video.preload = 'auto'
    try {
      await mediaEvent(video, 'loadeddata', () => { video.src = url })
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('This video has no readable duration.')
      const images: string[] = [], sampledAtSeconds: number[] = []
      for (let i = 0; i < 6; i++) {
        const time = video.duration * (i + 0.5) / 6
        await mediaEvent(video, 'seeked', () => { video.currentTime = time })
        images.push(frame(video, video.videoWidth, video.videoHeight)); sampledAtSeconds.push(time)
      }
      return { ...base, images, sampledAtSeconds, durationSeconds: video.duration }
    } finally { video.removeAttribute('src'); video.load() }
  } finally { URL.revokeObjectURL(url) }
}
