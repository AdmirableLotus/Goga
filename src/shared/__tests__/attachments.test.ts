import { describe, expect, it } from 'vitest'
import { validateAttachments, attachmentPrompt } from '../attachments'

const jpeg = 'data:image/jpeg;base64,/9j/AAAA'
const image = { id: '1', name: 'image.jpg', kind: 'image', images: [jpeg] }
const video = { id: '2', name: 'clip.mp4', kind: 'video', images: [jpeg, jpeg], sampledAtSeconds: [1, 3], durationSeconds: 4 }

describe('chat attachments', () => {
  it('accepts images and sampled videos and describes frame timing', () => {
    expect(validateAttachments([image, video])).toEqual([image, video])
    expect(attachmentPrompt([video as any])).toContain('1.0, 3.0 seconds')
    expect(validateAttachments(undefined)).toEqual([])
  })
  it('rejects file paths, non-images, oversized payloads, and excess frames', () => {
    expect(() => validateAttachments([{ ...image, images: ['file:///private'] }])).toThrow()
    expect(() => validateAttachments([{ ...image, images: ['data:text/html;base64,AAAA'] }])).toThrow()
    expect(() => validateAttachments([{ ...image, images: [jpeg + 'A'.repeat(16_000_000)] }])).toThrow('too large')
    expect(() => validateAttachments(Array(5).fill(image))).toThrow('four')
    expect(() => validateAttachments(Array(3).fill({ ...video, images: Array(6).fill(jpeg), sampledAtSeconds: [0, 0, 1, 2, 3, 4] }))).toThrow('too large')
  })
  it('rejects missing or impossible video timestamps', () => {
    expect(() => validateAttachments([{ ...video, sampledAtSeconds: [1] }])).toThrow('timestamps')
    expect(() => validateAttachments([{ ...video, durationSeconds: Infinity }])).toThrow('timestamps')
    expect(() => validateAttachments([{ ...video, sampledAtSeconds: [1, 5] }])).toThrow('timestamps')
  })
})
