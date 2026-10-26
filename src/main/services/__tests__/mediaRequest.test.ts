import { expect, it } from 'vitest'
import { buildMediaRequest } from '../mediaRequest'
const image = { id: '1', name: 'token.png', kind: 'image' as const, images: ['data:image/jpeg;base64,/9j/AAAA'] }

it('supplies current image bytes without replaying stale refusals', () => {
  const request = buildMediaRequest('https://example.com/game', [image], [
    { id: '1', role: 'user', content: 'Make a pixel character based on this image', timestamp: 1 },
    { id: '2', role: 'assistant', content: 'I cannot access images', timestamp: 2 },
    { id: '3', role: 'user', content: 'https://example.com/game\n[Attached media: token.png]', timestamp: 3 },
  ])
  expect(request.messages[1].images).toEqual(['/9j/AAAA'])
  expect(request.messages[1].content).toContain('Make a pixel character')
  expect(request.messages.map(m => m.content).join('\n')).not.toContain('I cannot access images')
  expect(request.messages[1].content).toContain('Describe the attached visual content')
  expect(request.options.num_ctx).toBe(8192)
})

it('allocates more than the default 4096 tokens for six-frame video input', () => {
  const request = buildMediaRequest('Describe the video', [{ ...image, kind: 'video', images: Array(6).fill(image.images[0]), durationSeconds: 6, sampledAtSeconds: [0, 1, 2, 3, 4, 5] }], [])
  expect(request.options.num_ctx).toBe(16384)
  expect(request.messages[1].images).toHaveLength(6)
  expect(request.messages[1].content).toContain('Frames at')
})
