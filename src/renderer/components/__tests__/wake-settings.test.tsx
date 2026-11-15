// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WakeWordSettings from '../WakeWordSettings'
import type { WakeStatus } from '../../../main/services/wakeWord'

/**
 * The wake switch has one job: never claim to be listening when it is not.
 * These tests drive the real component against the real IPC contract.
 */

const OFF: WakeStatus = {
  enabled: false, state: 'off', message: 'Wake word is off.', phrase: 'hey goga', micReady: false,
}
const NO_MIC: WakeStatus = {
  enabled: false, state: 'error', micReady: false, phrase: 'hey goga',
  message: 'No microphone is connected. Plug one in, then turn this on again.',
}
const LISTENING: WakeStatus = {
  enabled: true, state: 'listening', message: 'Listening for "hey goga".', phrase: 'hey goga', micReady: true,
}

function installApi(initial: WakeStatus, onStart: () => WakeStatus) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'voice:wakeStatus') return initial
    if (channel === 'voice:startWakeLoop') return onStart()
    if (channel === 'voice:stopWakeLoop') return OFF
    return null
  })
  ;(window as unknown as { goga: unknown }).goga = { invoke, on: vi.fn(() => () => {}) }
  return invoke
}

afterEach(() => cleanup())

describe('WakeWordSettings', () => {
  it('is off by default and says so', async () => {
    installApi(OFF, () => OFF)
    render(<WakeWordSettings voiceEnabled wakeEnabled={false} phrase="hey goga" onEnable={() => {}} />)
    const box = screen.getByLabelText(/Wake word, listening for hey goga/) as HTMLInputElement
    expect(box.checked).toBe(false)
    await waitFor(() => expect(screen.getByText('Wake word is off.')).toBeTruthy())
  })

  it('stays off and explains when there is no microphone', async () => {
    const onEnable = vi.fn()
    installApi(OFF, () => NO_MIC)
    render(<WakeWordSettings voiceEnabled wakeEnabled={false} phrase="hey goga" onEnable={onEnable} />)
    const box = screen.getByLabelText(/Wake word, listening for hey goga/) as HTMLInputElement
    fireEvent.click(box)
    await waitFor(() => expect(screen.getByText(/No microphone is connected/)).toBeTruthy())
    expect(box.checked).toBe(false)
    expect(onEnable).toHaveBeenLastCalledWith(false)
  })

  it('shows listening only when the main process says it is listening', async () => {
    const onEnable = vi.fn()
    installApi(OFF, () => LISTENING)
    render(<WakeWordSettings voiceEnabled wakeEnabled={false} phrase="hey goga" onEnable={onEnable} />)
    const box = screen.getByLabelText(/Wake word, listening for hey goga/) as HTMLInputElement
    fireEvent.click(box)
    await waitFor(() => expect(screen.getByText('Listening for "hey goga".')).toBeTruthy())
    expect(box.checked).toBe(true)
    expect(onEnable).toHaveBeenLastCalledWith(true)
  })

  it('cannot be turned on while voice is off', () => {
    installApi(OFF, () => OFF)
    render(<WakeWordSettings voiceEnabled={false} wakeEnabled={false} phrase="hey goga" onEnable={() => {}} />)
    const box = screen.getByLabelText(/Wake word, listening for hey goga/) as HTMLInputElement
    expect(box.disabled).toBe(true)
    expect(screen.getByText(/Turn voice on first/)).toBeTruthy()
  })

  it('tells the user the microphone stays on and nothing is recorded', () => {
    installApi(OFF, () => OFF)
    render(<WakeWordSettings voiceEnabled wakeEnabled={false} phrase="hey goga" onEnable={() => {}} />)
    expect(screen.getByText(/nothing is recorded, and no audio leaves this computer/)).toBeTruthy()
  })
})
