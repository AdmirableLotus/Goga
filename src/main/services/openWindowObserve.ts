// "Look at the paper I opened" / "go to my browser and look at the video": find the window the
// user means among everything open (never Goga's own chat window), then gather real evidence —
// the document's full text from its file, or the page text plus a vision look at a screenshot —
// and hand it to the brain with the request. Runs directly, without the action planner.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import type { WindowInfo } from '../adapters/desktop'

export type ObserveKind = 'document' | 'browser' | 'any'
export interface OpenObserveCommand { kind: ObserveKind; play: boolean }

const LOOK = /\b(look(ing)?( (at|over|through|into))?|analy[sz]e|read|review|check( out)?|summari[sz]e|go (over|through|to|into)|watch|see|tell me (about|what)|what'?s (in|on)|what is (in|on)|explain|play|study|open up)\b/i
const DOC_NOUN = /\b(paper|papers|document|doc|docs|pdf|file|article|report|essay|spreadsheet|slides?|presentation|manuscript|proposal)\b/i
const WEB_NOUN = /\b(browser|tab|web ?page|website|site|video|youtube|clip)\b/i
const SCREEN_NOUN = /\b(screen|window|desktop)\b/i
// The user is pointing at something already open, not asking Goga to find or open something new.
const ALREADY_OPEN = /\b(i( have| 've|'ve| just| already)? (opened|open|pulled up|brought up|have up)|i'?m (on|in|looking at|watching|reading)|i am (on|in|looking at|watching|reading)|(that'?s|that is|which is|currently|already|now|still) (open|opened|up|playing|on( my)? screen)|on my screen|in front of me|(open|opened) (already|right now|now)|my (screen|browser|open)|this (paper|document|pdf|page|video|tab|screen|window)|the (open|opened) )/i
const PLAY = /\bplay\b|\b(start|resume) (it|the video|the clip|playing)\b/i

/** A request to look at something the user already has open, or null. */
export function parseOpenObserve(text: string): OpenObserveCommand | null {
  const t = text.replace(/’/g, "'").trim()
  if (!t || t.length > 600) return null
  if (!LOOK.test(t) || !ALREADY_OPEN.test(t)) return null
  const doc = DOC_NOUN.test(t), web = WEB_NOUN.test(t), screen = SCREEN_NOUN.test(t)
  if (!doc && !web && !screen) return null
  // "the video in my browser" is web; "the paper I opened (in the browser)" is a document.
  const kind: ObserveKind = doc && !/\b(video|youtube|clip)\b/i.test(t) ? 'document' : web ? 'browser' : 'any'
  return { kind, play: PLAY.test(t) }
}

const BROWSER_TITLE = /\b(brave|chrome|google chrome|microsoft.? edge|edge|firefox|opera|vivaldi|youtube)\b/i
const DOC_TITLE = /\.(pdf|docx?|txt|md|rtf|pptx?|xlsx?|csv|odt|epub)\b|\b(word|acrobat|adobe|pdf|reader|powerpoint|excel|libreoffice|notepad|google (docs|sheets|slides))\b/i
const VIDEO_TITLE = /\b(youtube|netflix|vimeo|twitch|hulu|prime video|disney\+?|tiktok|video|watch|movie|episode)\b/i
const NOT_A_TARGET = /^(program manager|task ?bar|start|search|notification center|system tray|goga|snipping tool)$/i

/** The window the user means: the top-most matching window that is not Goga itself.
 *  With preferVideo, a browser window showing a video wins over other browser windows. */
export function pickWindow(windows: WindowInfo[], kind: ObserveKind, selfPid: number, preferVideo = false): WindowInfo | null {
  // Minimized windows report 0×0 bounds; keep them (they can be restored), drop only tiny slivers.
  const candidates = windows.filter(w => w.title?.trim() && w.pid !== selfPid && !NOT_A_TARGET.test(w.title.trim())
    && !/\bGoga\b/.test(w.title) && (w.bounds && w.bounds.width > 0 ? w.bounds.width > 120 && w.bounds.height > 80 : true))
  if (kind === 'document') return candidates.find(w => DOC_TITLE.test(w.title)) ?? null
  if (kind === 'browser') {
    const browsers = candidates.filter(w => BROWSER_TITLE.test(w.title))
    return (preferVideo ? browsers.find(w => VIDEO_TITLE.test(w.title)) : undefined) ?? browsers[0] ?? null
  }
  return candidates[0] ?? null
}

/** "ReLume_Plan.pdf - Adobe Acrobat Reader" → "ReLume_Plan.pdf"; "Budget - Word" → "Budget". */
export function docNameFromTitle(title: string): string | null {
  let name = title.split(/\s+[-–—|]\s+/)[0].replace(/^[•*\s]+/, '').replace(/\s+and \d+ more pages?$/i, '').trim()
  // Word/Acrobat decorate titles: "[Compatibility Mode]", "(Last saved by user)", "(Read-Only)"…
  name = name.replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s*\((last saved by[^)]*|read-only|repaired|autorecovered|saved to this pc|unlicensed product|protected view)\)\s*/gi, ' ')
    .trim()
  return name.length >= 2 ? name : null
}

const READABLE = ['pdf', 'docx', 'txt', 'md', 'csv', 'epub']

/** Find the file a window shows, searching the usual folders (newest match wins). */
export function findDocument(name: string, roots = defaultRoots(), maxEntries = 25_000): string | null {
  const want = name.toLowerCase()
  const hasExt = READABLE.includes(path.extname(want).slice(1))
  let best: { file: string; mtime: number } | null = null
  let seen = 0
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || seen > maxEntries) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (++seen > maxEntries) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!/^(node_modules|\.git|AppData|\$Recycle\.Bin|\..*)$/i.test(e.name)) walk(full, depth + 1)
        continue
      }
      const lower = e.name.toLowerCase()
      const ext = path.extname(lower).slice(1)
      if (!READABLE.includes(ext)) continue
      const match = hasExt ? lower === want : path.basename(lower, path.extname(lower)) === want
      if (!match) continue
      try {
        const mtime = fs.statSync(full).mtimeMs
        if (!best || mtime > best.mtime) best = { file: full, mtime }
      } catch { /* unreadable */ }
    }
  }
  for (const root of roots) walk(root, 0)
  return best ? (best as { file: string }).file : null
}

/** Windows records every file the user opens as a shortcut in the Recent folder — the most
 *  reliable way to find the file behind an open window, wherever it lives. */
export function findRecentDocument(name: string): Promise<string | null> {
  const safe = name.replace(/'/g, "''")
  const script = `
$n = '${safe}'
$sh = New-Object -ComObject WScript.Shell
Get-ChildItem "$env:APPDATA\\Microsoft\\Windows\\Recent" -Filter *.lnk -ErrorAction SilentlyContinue |
  Where-Object { $_.BaseName -eq $n -or [IO.Path]::GetFileNameWithoutExtension($_.BaseName) -eq $n } |
  Sort-Object LastWriteTime -Descending |
  ForEach-Object { $sh.CreateShortcut($_.FullName).TargetPath } |
  Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
  Select-Object -First 5
`
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, (_err, stdout) => {
      const hits = String(stdout ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      resolve(hits.find(f => READABLE.includes(path.extname(f).toLowerCase().slice(1))) ?? null)
    })
  })
}

function defaultRoots(): string[] {
  const home = os.homedir()
  return ['Desktop', 'Documents', 'Downloads', 'OneDrive/Desktop', 'OneDrive/Documents']
    .map(p => path.join(home, p)).filter(p => { try { return fs.statSync(p).isDirectory() } catch { return false } })
}

/** Bring a window to the front even when another app has focus (Windows foreground lock). */
export function focusWindowExact(pid: number, title: string): Promise<boolean> {
  const safeTitle = title.replace(/'/g, "''")
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type @"
using System; using System.Runtime.InteropServices;
public class GogaFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
$wins = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$w = $wins | Where-Object { $_.Current.ProcessId -eq ${pid} -and $_.Current.Name -eq '${safeTitle}' } | Select-Object -First 1
if (-not $w) { $w = $wins | Where-Object { $_.Current.ProcessId -eq ${pid} } | Select-Object -First 1 }
if (-not $w) { 'NOWINDOW'; exit }
$h = [IntPtr]$w.Current.NativeWindowHandle
if ([GogaFocus]::IsIconic($h)) { [GogaFocus]::ShowWindow($h, 9) | Out-Null }
[GogaFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[GogaFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[GogaFocus]::BringWindowToTop($h) | Out-Null
[GogaFocus]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 250
if ([GogaFocus]::GetForegroundWindow() -eq $h) { 'OK' } else { 'NOTFRONT' }
`
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 },
      (_err, stdout) => resolve(String(stdout ?? '').trim().endsWith('OK')))
  })
}

export interface ObserveDeps {
  listWindows(): Promise<WindowInfo[]>
  focus(pid: number, title: string): Promise<boolean>
  pressKey(key: string): Promise<unknown>
  readWindowText(): Promise<{ pid: number; texts: string[] } | null>
  screenshotBase64(): Promise<string>
  describeImage(base64: string, prompt: string): Promise<string>
  readDocument(file: string): Promise<string>
  findDocument(name: string): string | null | Promise<string | null>
  wait(ms: number): Promise<void>
  selfPid: number
}

export interface ObserveEvidence {
  ok: boolean
  /** What Goga tells the brain (request + evidence), or a plain explanation when ok is false. */
  prompt: string
  target?: string
}

const MAX_DOC_CHARS = 60_000
const MAX_PAGE_CHARS = 3_500

/** Gather what is really in the window the user means, ready for the brain to answer from. */
export async function gatherOpenWindow(request: string, cmd: OpenObserveCommand, deps: ObserveDeps): Promise<ObserveEvidence> {
  const windows = await deps.listWindows()
  const wantsVideo = cmd.play || /\b(video|youtube|clip|movie|watch|episode)\b/i.test(request)
  let win = pickWindow(windows, cmd.kind, deps.selfPid, wantsVideo)
  // A paper open in a browser tab, or a request that names no app: fall back to the top window.
  if (!win && cmd.kind === 'document') win = pickWindow(windows, 'browser', deps.selfPid)
  if (!win && cmd.kind !== 'any') win = pickWindow(windows, 'any', deps.selfPid)
  if (!win) {
    const open = windows.filter(w => w.pid !== deps.selfPid && w.title.trim()).slice(0, 8).map(w => `- ${w.title}`).join('\n')
    return { ok: false, prompt: `I couldn't find the ${cmd.kind === 'document' ? 'document' : cmd.kind === 'browser' ? 'browser window' : 'window'} you mean. These windows are open right now:\n${open || '- (none I can see)'}\nTell me which one, for example "the one called …".` }
  }

  // A document: read the real file, not a picture of one page.
  if (cmd.kind === 'document' || DOC_TITLE.test(win.title)) {
    const name = docNameFromTitle(win.title)
    const file = name ? await deps.findDocument(name) : null
    if (file) {
      let text = ''
      try { text = (await deps.readDocument(file)).trim() } catch { /* fall through to looking at it */ }
      if (text) {
        const clipped = text.length > MAX_DOC_CHARS ? `${text.slice(0, MAX_DOC_CHARS)}\n[…document continues; this is the first ${MAX_DOC_CHARS.toLocaleString()} characters]` : text
        return {
          ok: true, target: path.basename(file),
          prompt: `I asked you: "${request}"\n\nThe document I have open is "${path.basename(file)}" (${file}). I read the actual file for you; its full text is below. Do exactly what I asked using this text. Quote or name the sections you rely on.\n\n--- DOCUMENT TEXT ---\n${clipped}\n--- END OF DOCUMENT ---`,
        }
      }
    }
  }

  // Anything else (a browser tab, a video, an app): bring it forward and look at it.
  const focused = await deps.focus(win.pid, win.title)
  if (cmd.play && focused) {
    await deps.wait(300)
    await deps.pressKey(/youtube/i.test(win.title) ? 'K' : 'Space')
    await deps.wait(1500)
  } else {
    await deps.wait(700)
  }
  let pageText = ''
  try {
    const seen = await deps.readWindowText()
    if (seen && seen.pid === win.pid) pageText = [...new Set(seen.texts.map(s => s.trim()).filter(Boolean))].join('\n').slice(0, MAX_PAGE_CHARS)
  } catch { /* page text is optional */ }
  let look = ''
  try {
    const shot = await deps.screenshotBase64()
    look = (await deps.describeImage(shot,
      `The user asked: "${request}". Describe what this window shows in detail: the page or document, any video (title, what is in the frame, whether it is playing), and any text you can read.`)).trim()
  } catch (err) {
    look = `(could not look at the screen: ${err instanceof Error ? err.message : String(err)})`
  }
  const isVideo = /youtube|video|\bclip\b/i.test(`${win.title} ${request}`)
  const protectedVideo = /\b(netflix|hulu|prime video|disney)\b/i.test(win.title)
  return {
    ok: true, target: win.title,
    prompt: [
      `I asked you: "${request}"`,
      ``,
      `You switched to the window "${win.title}"${focused ? '' : ' (it may still be behind other windows)'}${cmd.play ? (focused ? ' and pressed play' : ', but could not bring it to the front to press play') : ''}.`,
      `What the vision model saw in a screenshot of it:\n${look || '(nothing)'}`,
      pageText ? `\nText read from the window:\n${pageText}` : '',
      ``,
      `Answer my request from this evidence only.${isVideo ? ' You saw a single frame plus the page text: you cannot hear the audio or watch the whole video, so say what you can tell from the title, description and frame, and do not claim you watched it.' : ''}${protectedVideo ? ' Streaming services like Netflix block screenshots of the video itself (it appears black), so only the title and page text are reliable.' : ''} If the evidence doesn't show something, say so.`,
    ].filter(s => s !== '').join('\n'),
  }
}
