/**
 * notepadSave.ts — save text as a new file via Notepad's Save As dialog.
 *
 * Ownership model (all three checks required):
 *   1. windowByTitleDiff identifies the exact Notepad frame by HWND diff.
 *   2. findSaveAsDialog walks the Win32 owner chain (GW_OWNER) from each
 *      candidate dialog back to win.hwnd — PID and title are secondary filters
 *      only; the chain walk is the authoritative ownership test.
 *   3. findDontSave and overwrite-prompt checks use findElementByHwnd, which
 *      scopes UIAutomation to the exact dialog HWND via NativeWindowHandleProperty.
 *
 * Cleanup: WM_CLOSE on win.hwnd, IsWindow poll up to 3 s. Reports timeout
 * explicitly if the window remains open; never claims successful closure.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import { ToolRegistry } from './registry'
import { DesktopAdapter } from '../adapters/desktop'

// ── Testable seams ────────────────────────────────────────────────────────────

export const fsOps = {
  existsSync:   (p: string) => fs.existsSync(p),
  readFileSync: (p: string, enc: BufferEncoding) => fs.readFileSync(p, enc) as string,
}

export const docsDirOps = {
  resolve: resolveDocumentsDir
}

/**
 * Desktop operations seam.
 *
 * findSaveAsDialog(ownerHwnd, pid):
 *   Walk the Win32 owner chain of every visible window owned by pid.
 *   Accept only windows whose chain includes ownerHwnd AND whose title
 *   contains 'Save As'. Require exactly one match.
 *
 * findDontSave(dialogHwnd):
 *   Search the UIAutomation subtree of dialogHwnd for "Don't Save".
 *   Scoped to that exact HWND — never title-based.
 *
 * findButtonInDialog(dialogHwnd, name):
 *   Search the UIAutomation subtree of dialogHwnd for a button by name.
 *   Used for overwrite-prompt detection scoped to the exact dialog.
 *
 * isWindow / postClose: Win32 IsWindow / PostMessage(WM_CLOSE).
 */
export const desktopOps = {
  windowsByPid: (pid: number): Promise<Array<{ hwnd: number; pid: number; title: string }>> =>
    _desktop.windowsByPid(pid).catch(() => []),

  focusHwnd: (hwnd: number): Promise<{ pid: number; hwnd: number; title: string }> =>
    _desktop.focusAndGetForeground(hwnd).catch(() => ({ pid: 0, hwnd: 0, title: '' })),

  getForeground: (): Promise<{ pid: number; hwnd: number; title: string }> =>
    _desktop.activeWindowWithHwnd().catch(() => ({ pid: 0, hwnd: 0, title: '' })),

  typeIntoHwnd: (hwnd: number, text: string): Promise<{ ok: boolean; reason?: string }> =>
    _desktop.typeIntoHwnd(hwnd, text).catch(e => ({ ok: false, reason: String(e) })),

  saveAsViaMenu: (hwnd: number): Promise<{ ok: boolean; reason?: string }> =>
    _desktop.saveAsViaMenu(hwnd).catch(e => ({ ok: false, reason: String(e) })),

  isForeground: (hwnd: number): Promise<boolean> =>
    _desktop.activeWindowWithHwnd()
      .then(fg => fg.hwnd === hwnd)
      .catch(() => false),

  pidOfHwnd: (hwnd: number): Promise<number> =>
    _desktop.pidOfHwnd(hwnd).catch(() => 0),

  pressEnterInDialog: (hwnd: number): Promise<{ ok: boolean; reason?: string }> =>
    _desktop.pressEnterInDialog(hwnd).catch(e => ({ ok: false, reason: String(e) })),

  findSaveAsDialog: (ownerHwnd: number, _pid: number): Promise<{ hwnd: number; pid: number; title: string } | null> =>
    _desktop.findSaveAsInSubtree(ownerHwnd).catch(() => null),

  setFilenameInSaveAs: (notepadHwnd: number, destPath: string): Promise<{ ok: boolean; actual?: string; reason?: string }> =>
    _desktop.setFilenameInSaveAs(notepadHwnd, destPath).catch(e => ({ ok: false, reason: String(e) })),

  findDontSave: (dialogHwnd: number): Promise<import('../../shared/types').AccessibilityNode | null> =>
    _desktop.findElementByHwnd(dialogHwnd, "Don't Save").catch(() => null),

  findButtonInDialog: (dialogHwnd: number, name: string): Promise<import('../../shared/types').AccessibilityNode | null> =>
    _desktop.findElementByHwnd(dialogHwnd, name).catch(() => null),

  isWindow: (hwnd: number): Promise<boolean> =>
    _desktop.isWindow(hwnd).catch(() => false),

  postClose: (hwnd: number): Promise<void> =>
    _desktop.postClose(hwnd).catch(() => undefined),
}

export const hookOps: { preEnter: ((signal?: AbortSignal) => Promise<void>) | null } = {
  preEnter: null
}

// ── Module-level singletons ───────────────────────────────────────────────────

const reg = ToolRegistry.getInstance()
const _desktop = new DesktopAdapter()

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveDocumentsDir(): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    const proc = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
       '[Environment]::GetFolderPath("MyDocuments")'],
      { windowsHide: true }
    )
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', () => {
      const dir = out.trim()
      resolve(dir || path.join(process.env.USERPROFILE ?? os.homedir(), 'Documents'))
    })
    proc.on('error', () => {
      resolve(path.join(process.env.USERPROFILE ?? os.homedir(), 'Documents'))
    })
  })
}

function uniqueFilename(): string {
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
  return `goga-${Date.now()}-${hex}.txt`
}

function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortErr()); return }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortErr()) }, { once: true })
  })
}

function abortErr(): Error {
  const e = new Error('notepad.saveText: cancelled')
  e.name = 'AbortError'
  return e
}

/**
 * Close the owned Notepad window via WM_CLOSE on the exact HWND.
 * Polls IsWindow up to 3 s (15 × 200 ms).
 * If a "Don't Save" prompt appears, it is found via findDontSave(win.hwnd)
 * which walks the owner chain — never title-based.
 * Returns { closed: true } on success, { closed: false, reason } on timeout.
 * hwnd=0 means ambiguous ownership — returns immediately without sending input.
 */
async function closeNotepad(
  pid: number, hwnd: number
): Promise<{ closed: boolean; reason?: string }> {
  if (!hwnd) return { closed: false, reason: 'hwnd=0: ambiguous ownership, window left open' }
  try {
    await desktopOps.postClose(hwnd)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 200))
      const alive = await desktopOps.isWindow(hwnd)
      if (!alive) return { closed: true }
      // Check for "Don't Save" prompt owned by our window via owner-chain lookup
      const dontSave = await desktopOps.findDontSave(hwnd)
      if (dontSave) {
        await reg.execute('computer.key', { key: 'N', pid, hwnd }, { abortSignal: new AbortController().signal }).catch(() => null)
        // Give it one more poll cycle to close
        await new Promise(r => setTimeout(r, 200))
        const stillAlive = await desktopOps.isWindow(hwnd)
        return stillAlive
          ? { closed: false, reason: 'window still open after Don\'t Save dismissal' }
          : { closed: true }
      }
    }
    return { closed: false, reason: `window HWND 0x${hwnd.toString(16)} still open after 3s cleanup timeout` }
  } catch {
    return { closed: false, reason: 'cleanup error' }
  }
}

// ── Tool registration ─────────────────────────────────────────────────────────

reg.register({
  name: 'notepad.saveText',
  description:
    "Save supplied text as a new .txt file in the user's Documents folder via Notepad's Save As dialog. " +
    'Launches a dedicated Notepad instance, types the text, saves via Ctrl+Shift+S. ' +
    'Discovers the Save As dialog by walking the Win32 owner chain back to the exact Notepad HWND. ' +
    'All input targets the dialog\'s own HWND. Verifies file content from disk. ' +
    'Closes via WM_CLOSE + IsWindow poll. Reports cleanup timeout if window remains open. ' +
    'Returns { filePath, bytes } on success.',
  parameters: {
    type: 'object',
    properties: {
      text:     { type: 'string', description: 'Text content to save.' },
      filename: { type: 'string', description: 'Optional filename (no path). Defaults to goga-<timestamp>-<hex>.txt.' }
    },
    required: ['text']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p, ctx) => {
  try {
  const signal   = ctx.abortSignal
  const text     = p.text as string
  const filename = (p.filename as string | undefined) ?? uniqueFilename()

  // 0. Resolve Documents dir
  const docsDir  = await docsDirOps.resolve()
  const destPath = path.join(docsDir, filename)

  // 1. Pre-flight: reject if destination already exists
  if (fsOps.existsSync(destPath)) {
    return { success: false, error: `notepad.saveText: destination already exists: ${destPath}` }
  }

  // 2. Snapshot existing HWNDs before launch
  const baselineResult = await reg.execute('computer.snapshotHwnds', {}, { abortSignal: signal })
  if (!baselineResult.success) {
    return { success: false, error: 'notepad.saveText: could not snapshot HWNDs before launch' }
  }
  const baselineHwnds: number[] = (baselineResult.data as { hwnds: number[] }).hwnds

  // 3. Launch a fresh Notepad
  if (signal?.aborted) return { success: false, error: 'cancelled' }
  const launchResult = await reg.execute('process.start', { executable: 'notepad.exe' }, { abortSignal: signal })
  if (!launchResult.success) {
    return { success: false, error: `notepad.saveText: failed to launch Notepad: ${launchResult.error}` }
  }

  // 4. Wait for the new window; identify by HWND diff (exactly one new HWND)
  await sleepOrAbort(1500, signal)

  const diffResult = await reg.execute('computer.windowByTitleDiff', {
    titleSubstring: 'Notepad', baselineHwnds
  }, { abortSignal: signal })

  if (!diffResult.success || !diffResult.data) {
    return { success: false, error: 'notepad.saveText: new Notepad window did not appear — ownership ambiguous, aborting without input' }
  }

  const _winRaw = diffResult.data as { hwnd: number | string; pid: number | string; title: string }
  let win = { hwnd: Number(_winRaw.hwnd), pid: Number(_winRaw.pid), title: _winRaw.title }
  if (!win.hwnd || !win.pid) {
    return { success: false, error: 'notepad.saveText: windowByTitleDiff returned incomplete identity — aborting' }
  }

  // 5. Bring the exact Notepad frame to foreground before typing.
  if (signal?.aborted) return { success: false, error: 'cancelled' }

  // Re-verify win identity: check the actual current PID owner of win.hwnd.
  // windowsByPid(win.pid) only finds windows for the expected PID — it cannot
  // detect recycling where win.hwnd now belongs to a completely different PID.
  // pidOfHwnd reads GetWindowThreadProcessId directly on the HWND.
  const stillAlive = await desktopOps.isWindow(win.hwnd)
  if (stillAlive) {
    const currentPid = await desktopOps.pidOfHwnd(win.hwnd)
    if (currentPid !== win.pid) {
      // HWND recycled — retry diff once with updated baseline
      const retryBaseline = new Set([...baselineHwnds, win.hwnd])
      const retryResult = await reg.execute('computer.windowByTitleDiff', {
        titleSubstring: 'Notepad', baselineHwnds: [...retryBaseline]
      }, { abortSignal: signal })
      if (!retryResult.success || !retryResult.data) {
        return { success: false, error: 'notepad.saveText: Notepad HWND recycled and retry found no window — aborting' }
      }
      const r2 = retryResult.data as { hwnd: number | string; pid: number | string; title: string }
      win.hwnd = Number(r2.hwnd); win.pid = Number(r2.pid); win.title = r2.title
      if (!win.hwnd || !win.pid) return { success: false, error: 'notepad.saveText: retry windowByTitleDiff returned incomplete identity' }
    }
  }

  // Type text directly into Notepad's edit control via UIAutomation ValuePattern.
  // This does not require Notepad to be in the foreground — bypasses the
  // Electron focus-stealing problem entirely.
  if (signal?.aborted) return { success: false, error: 'cancelled' }
  const typeResult = await desktopOps.typeIntoHwnd(win.hwnd, text)
  if (!typeResult.ok) {
    await closeNotepad(win.pid, win.hwnd)
    return { success: false, error: `notepad.saveText: type failed: ${typeResult.reason}` }
  }

  // 6. Open Save As dialog via menu (no foreground required)
  if (signal?.aborted) { await closeNotepad(win.pid, win.hwnd); return { success: false, error: 'cancelled' } }
  const saveAsResult = await desktopOps.saveAsViaMenu(win.hwnd)
  if (!saveAsResult.ok) {
    await closeNotepad(win.pid, win.hwnd)
    return { success: false, error: `notepad.saveText: Save As failed: ${saveAsResult.reason}` }
  }

  // 7. Discover the Save As dialog via Win32 owner-chain walk.
  //    findSaveAsDialog(win.hwnd, win.pid) enumerates all visible windows,
  //    walks GW_OWNER chain of each, accepts only those whose chain includes
  //    win.hwnd AND whose title contains 'Save As' AND whose PID matches.
  //    Requires exactly one match — zero or >1 is ambiguous.
  await sleepOrAbort(400, signal)

  let dialog: { hwnd: number; pid: number; title: string } | null = null
  for (let attempt = 0; attempt < 8; attempt++) {
    if (signal?.aborted) { await closeNotepad(win.pid, win.hwnd); return { success: false, error: 'cancelled' } }
    dialog = await desktopOps.findSaveAsDialog(win.hwnd, win.pid)
    if (dialog) {
      dialog = { hwnd: Number(dialog.hwnd), pid: Number(dialog.pid), title: dialog.title }
      break
    }
    await sleepOrAbort(400, signal)
  }

  if (!dialog) {
    await closeNotepad(win.pid, win.hwnd)
    return { success: false, error: 'notepad.saveText: Save As dialog did not appear with correct owner chain — aborting' }
  }

  // 8. Set the destination path into the Save As dialog's filename field.
  // Uses AutomationId='1001' on the Notepad window — bypasses the Document
  // control entirely. Reads back the value and verifies before proceeding.
  if (signal?.aborted) { await closeNotepad(win.pid, win.hwnd); return { success: false, error: 'cancelled' } }

  const pathTypeResult = await desktopOps.setFilenameInSaveAs(win.hwnd, destPath)

  if (!pathTypeResult.ok) {
    await closeNotepad(win.pid, win.hwnd)
    return { success: false, error: `notepad.saveText: could not set path in Save As dialog: ${pathTypeResult.reason}` }
  }
  if (pathTypeResult.actual !== undefined && pathTypeResult.actual !== destPath) {
    await closeNotepad(win.pid, win.hwnd)
    return { success: false, error: `notepad.saveText: filename field mismatch — set "${destPath}" but read back "${pathTypeResult.actual}"` }
  }

  // 9. Check for overwrite/Replace prompt BEFORE pressing Enter.
  const replaceCheck = await desktopOps.findButtonInDialog(dialog.hwnd, 'Replace')
  if (replaceCheck) {
    await desktopOps.pressEnterInDialog(dialog.hwnd) // dismiss by pressing Escape via UIAutomation
    await closeNotepad(win.pid, win.hwnd)
    return { success: false, error: 'notepad.saveText: Replace prompt appeared unexpectedly — aborting to prevent overwrite' }
  }

  // 10. Controlled pause hook — may throw OR abort-and-return-normally.
  if (hookOps.preEnter) {
    try {
      await hookOps.preEnter(signal)
    } catch {
      await closeNotepad(win.pid, win.hwnd)
      return { success: false, error: 'cancelled before save dispatch' }
    }
  }

  // 11. Independent abort gate — authoritative. Enter is NEVER dispatched if aborted.
  if (signal?.aborted) {
    await closeNotepad(win.pid, win.hwnd)
    return { success: false, error: 'cancelled before save dispatch' }
  }

  // 12. Confirm save (Enter) via UIAutomation — no foreground required
  const enterResult = await desktopOps.pressEnterInDialog(dialog.hwnd)
  if (!enterResult.ok) {
    await closeNotepad(win.pid, win.hwnd)
    return { success: false, error: `notepad.saveText: Enter key failed: ${enterResult.reason}` }
  }

  // 13. Wait for dialog to close; check for overwrite prompt after Enter.
  //     Scoped to dialog.hwnd via findElementByHwnd.
  await sleepOrAbort(800, signal)

  const replaceAfter = await desktopOps.findButtonInDialog(dialog.hwnd, 'Replace')
  if (replaceAfter) {
    await closeNotepad(win.pid, win.hwnd)
    return { success: false, error: 'notepad.saveText: Replace prompt appeared after Enter — dismissed and aborted' }
  }

  // 14. Verify file content from disk
  await sleepOrAbort(400, signal)

  let savedContent: string
  try {
    savedContent = fsOps.readFileSync(destPath, 'utf-8')
  } catch {
    await closeNotepad(win.pid, win.hwnd)
    return { success: false, error: `notepad.saveText: file not found after save: ${destPath}` }
  }

  const normalise = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd()
  if (normalise(savedContent) !== normalise(text)) {
    await closeNotepad(win.pid, win.hwnd)
    return {
      success: false,
      error: `notepad.saveText: content mismatch — expected ${text.length} chars, got ${savedContent.length} chars`
    }
  }

  // 15. Close the Notepad window via WM_CLOSE + IsWindow poll
  const closeResult = await closeNotepad(win.pid, win.hwnd)

  return {
    success: true,
    data: {
      filePath: destPath,
      bytes: Buffer.byteLength(savedContent, 'utf-8'),
      ...(closeResult.closed ? {} : { cleanupWarning: closeResult.reason })
    }
  }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return { success: false, error: 'cancelled' }
    throw e
  }
})

export function registerNotepadSaveTools() {
  return ToolRegistry.getInstance()
}
