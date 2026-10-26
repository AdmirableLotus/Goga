// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ChatComposer from '../ChatComposer'
import MissionMode from '../MissionMode'
vi.mock('../GogaCore/GogaTriangleScene', () => ({ default: () => null }))

const prepare = vi.hoisted(() => vi.fn())
vi.mock('../prepareAttachment', () => ({ prepareAttachment: prepare }))
vi.mock('../../context/GogaVisualContext', () => ({ useGogaVisual: () => ({ setVisualState: vi.fn(), setAudioAmplitude: vi.fn() }) }))

afterEach(() => { cleanup(); vi.clearAllMocks() })
function setup(onSend = vi.fn().mockResolvedValue(true)) {
  Object.defineProperty(window, 'goga', { configurable: true, value: { on: () => () => {}, invoke: vi.fn() } })
  render(<ChatComposer allowAttachments onSend={onSend} />)
  prepare.mockResolvedValue({ id: '1', name: 'shot.png', kind: 'image', images: ['data:image/jpeg;base64,/9j/AAAA'] })
  return onSend
}

it('previews, removes, and sends an image without requiring text', async () => {
  const onSend = setup()
  const choose = () => fireEvent.change(screen.getByLabelText('Choose images or videos'), { target: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } })
  choose()
  await screen.findByAltText('shot.png')
  fireEvent.click(screen.getByLabelText('Remove shot.png'))
  expect(screen.queryByAltText('shot.png')).toBeNull()
  choose()
  await screen.findByAltText('shot.png')
  fireEvent.click(screen.getByText('Send', { exact: true }))
  await waitFor(() => expect(onSend).toHaveBeenCalledWith('', [expect.objectContaining({ name: 'shot.png' })]))
  await waitFor(() => expect(screen.queryByAltText('shot.png')).toBeNull())
})

it('preserves an attachment when send fails and reports invalid media', async () => {
  setup(vi.fn().mockResolvedValue(false))
  fireEvent.change(screen.getByLabelText('Choose images or videos'), { target: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } })
  await screen.findByAltText('shot.png')
  fireEvent.click(screen.getByText('Send', { exact: true }))
  await waitFor(() => expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(false))
  expect(screen.queryByAltText('shot.png')).not.toBeNull()
  prepare.mockRejectedValueOnce(new Error('Cannot decode video'))
  fireEvent.change(screen.getByLabelText('Choose images or videos'), { target: { files: [new File(['x'], 'bad.mp4', { type: 'video/mp4' })] } })
  expect((await screen.findByRole('alert')).textContent).toContain('Cannot decode video')
})

it('exposes attachments in Mission Mode, forwards media, and displays its analysis reply', async () => {
  const invoke = vi.fn().mockResolvedValue({ id: 'reply', role: 'assistant', content: 'The image shows a window.', timestamp: 1 })
  Object.defineProperty(window, 'goga', { configurable: true, value: { on: () => () => {}, invoke } })
  prepare.mockResolvedValue({ id: '1', name: 'shot.png', kind: 'image', images: ['data:image/jpeg;base64,/9j/AAAA'] })
  render(<MissionMode onOpenChat={() => {}} onOpenSettings={() => {}} />)
  expect(screen.getByRole('button', { name: 'Attach images or videos' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Choose images or videos'), { target: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } })
  await screen.findByAltText('shot.png')
  fireEvent.click(screen.getByText('Send', { exact: true }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('chat:send', '', [expect.objectContaining({ name: 'shot.png' })]))
  expect(await screen.findByText('The image shows a window.')).toBeTruthy()
})
