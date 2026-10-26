// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState, AgentStep } from '../../../shared/types'
import ActivityPage from '../ActivityPage'

const task = 'make a text file called activity-check.txt in my Documents'
const filePath = 'C:\\Users\\Fixture\\Documents\\activity-check.txt'
const idle: AgentState = { status: 'idle', task: '', steps: [] }
const saved: AgentStep = {
  index: 0, tool: 'notepad.saveText', thought: 'private planner text',
  params: { text: 'private file content', apiKey: 'fixture-private-key' },
  result: { success: true, data: { filePath, bytes: 13 }, screenshotAfter: 'private screenshot' },
  verified: true, timestamp: 1,
}

let listeners: Set<(state: AgentState) => void>
let snapshot: Promise<AgentState>
let invoke: ReturnType<typeof vi.fn>

function emit(state: AgentState) {
  act(() => { listeners.forEach(listener => listener(state)) })
}

beforeEach(() => {
  listeners = new Set()
  snapshot = Promise.resolve(idle)
  invoke = vi.fn((channel: string) => {
    if (channel === 'agent:state') return snapshot
    if (channel === 'logs:list') return Promise.resolve([{ id: 'log', level: 'info', message: 'Existing log entry', timestamp: 1 }])
    if (channel === 'logs:clear') return Promise.resolve()
    throw new Error(`Unexpected IPC: ${channel}`)
  })
  vi.stubGlobal('goga', {
    invoke,
    on: (channel: string, listener: (state: AgentState) => void) => {
      expect(channel).toBe('agent:state')
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Activity tab uses existing agent state and result events', () => {
  it('shows planning, selected tool before completion, and a successful returned path', async () => {
    render(<ActivityPage />)
    await screen.findByText('Existing log entry')
    emit({ status: 'running', task, steps: [] })
    expect(screen.getByRole('status').textContent).toBe('Running')
    expect(screen.getByText('Planning next action…')).toBeTruthy()
    emit({ status: 'running', task, steps: [], currentTool: 'notepad.saveText' })
    expect(screen.getByText('Selected tool:').textContent).toContain('notepad.saveText')
    expect(screen.queryByText(filePath)).toBeNull()
    emit({ status: 'done', task, steps: [saved] })
    expect(screen.getByRole('status').textContent).toBe('Completed')
    expect(screen.getByRole('list', { name: 'Tool results' }).textContent).toContain('Succeeded')
    expect(screen.getByText(filePath)).toBeTruthy()
    for (const privateText of [saved.thought, 'private file content', 'fixture-private-key', 'private screenshot']) {
      expect(screen.queryByText(privateText, { exact: false })).toBeNull()
    }
    expect(invoke.mock.calls.every(([channel]) => channel === 'logs:list' || channel === 'agent:state')).toBe(true)
  })

  it('loads completed steps when opening or returning to Activity after the task finished', async () => {
    snapshot = Promise.resolve({ status: 'done', task, steps: [saved] })
    const first = render(<ActivityPage />)
    await screen.findByText(filePath)
    first.unmount()
    expect(listeners.size).toBe(0)
    render(<ActivityPage />)
    await screen.findByText(filePath)
    expect(screen.getByRole('status').textContent).toBe('Completed')
    expect(listeners.size).toBe(1)
  })

  it.each(['cancelled', 'cancelled before save dispatch'])('shows explicit %s as Stopped without a success claim', async error => {
    render(<ActivityPage />)
    await screen.findByText('Existing log entry')
    emit({ status: 'running', task, steps: [], currentTool: saved.tool })
    emit({ status: 'stopped', task, steps: [{ ...saved, result: { success: false, error } }] })
    const results = screen.getByRole('list', { name: 'Tool results' })
    expect(screen.getByRole('status').textContent).toBe('Stopped')
    expect(results.textContent).toContain('Stopped')
    expect(results.textContent).toContain(error)
    expect(results.textContent).not.toContain('Succeeded')
    expect(screen.queryByText(filePath)).toBeNull()
    expect(screen.queryByText('Running')).toBeNull()
    expect(screen.queryByText('Planning next action…')).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it.each(['done', 'error', 'stopped'] as const)('a new task clears the previous %s outcome', async status => {
    const error = status === 'stopped' ? 'cancelled before save dispatch' : 'fixture previous failure'
    snapshot = Promise.resolve({ status, task, steps: [status === 'done' ? saved : {
      ...saved, result: { success: false, error },
    }], ...(status === 'error' ? { error } : {}) })
    render(<ActivityPage />)
    await screen.findByRole('list', { name: 'Tool results' })
    emit({ status: 'running', task: 'Open a different app', steps: [] })
    expect(screen.getByRole('status').textContent).toBe('Running')
    expect(screen.getByText('Open a different app')).toBeTruthy()
    expect(screen.getByText('Planning next action…')).toBeTruthy()
    expect(screen.queryByText(task)).toBeNull()
    expect(screen.queryByText(filePath)).toBeNull()
    expect(screen.queryByText(error)).toBeNull()
    expect(screen.queryByRole('list', { name: 'Tool results' })).toBeNull()
    expect(screen.queryByText('Selected tool:')).toBeNull()
  })

  it.each(['filename_input_target_mismatch', 'cancelled before save dispatch; cleanup failed: still open'])('shows failure and returned error: %s', async error => {
    snapshot = Promise.resolve({ status: 'error', task, error: `Save failed: ${error}`, steps: [{ ...saved, result: { success: false, error } }] })
    render(<ActivityPage />)
    await screen.findByRole('list', { name: 'Tool results' })
    expect(screen.getByRole('status').textContent).toBe('Failed')
    expect(screen.getByText(`Save failed: ${error}`)).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Tool results' }).textContent).toContain('Failed')
    expect(screen.queryByText(filePath)).toBeNull()
  })

  it('shows approval waiting without relabeling the last tool, and planner errors with no steps', async () => {
    render(<ActivityPage />)
    await screen.findByText('Existing log entry')
    emit({ status: 'waiting-approval', task, steps: [saved], currentTool: saved.tool })
    expect(screen.getByRole('status').textContent).toBe('Waiting for approval')
    expect(screen.getByText('Last tool:')).toBeTruthy()
    expect(screen.queryByText('Selected tool:')).toBeNull()
    emit({ status: 'error', task, error: 'planning_failed: invalid planner response', steps: [] })
    expect(screen.getByRole('status').textContent).toBe('Failed')
    expect(screen.getByText('planning_failed: invalid planner response')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Tool results' })).toBeNull()
  })

  it('does not replace a newer live result with a stale initial snapshot', async () => {
    let resolve!: (state: AgentState) => void
    snapshot = new Promise(done => { resolve = done })
    render(<ActivityPage />)
    emit({ status: 'done', task, steps: [saved] })
    await act(async () => { resolve(idle); await snapshot })
    expect(screen.getByRole('status').textContent).toBe('Completed')
    expect(screen.getByText(filePath)).toBeTruthy()
  })

  it('shows a state-load error and recovers on the next existing state event', async () => {
    snapshot = Promise.reject(new Error('fixture IPC failure'))
    render(<ActivityPage />)
    await screen.findByRole('alert')
    emit({ status: 'running', task, steps: [] })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Running')
  })

  it('keeps existing log refresh and clear behavior without clearing the task result', async () => {
    snapshot = Promise.resolve({ status: 'done', task, steps: [saved] })
    render(<ActivityPage />)
    await screen.findByText(filePath)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(invoke.mock.calls.filter(([channel]) => channel === 'logs:list')).toHaveLength(2)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear' })) })
    expect(screen.queryByText('Existing log entry')).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Current task' })).getByText(filePath)).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith('logs:clear')
  })
})
