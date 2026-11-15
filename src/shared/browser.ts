/**
 * The general browser-control layer: types shared by the main process and the renderer.
 *
 * Goga drives Mozilla Firefox, which it launches itself on a debugging port with its own
 * profile directory. Firefox 160 speaks the WebDriver BiDi protocol on that port; it no
 * longer speaks Chrome DevTools Protocol at all (see firefox.ts). Nothing here reads a
 * cookie store, a password store or a profile secret: the layer attaches to the port and
 * works the pages, and that is the whole of it.
 */

/** One open tab Goga can drive. */
export interface BrowserTab {
  /** BiDi browsing context id — stable while the tab is open. */
  id: string
  url: string
  title: string
  /** True for the tab Goga is currently pointed at. */
  current: boolean
}

/**
 * What the layer can honestly say about itself right now.
 *
 * `state` is the whole story in one word:
 *   - `stopped`  — no debugging port is listening; Goga has not launched Firefox.
 *   - `running`  — the port answers, but Goga is not attached yet.
 *   - `attached` — Goga holds a session and can read and drive tabs.
 *   - `blocked`  — the port answers but it is not Firefox, so Goga refuses to touch it.
 */
export type BrowserLayerState = 'stopped' | 'running' | 'attached' | 'blocked'

export interface BrowserStatus {
  state: BrowserLayerState
  port: number
  /** 'firefox' once a BiDi handshake has named the browser, otherwise null. */
  browserName: string | null
  browserVersion: string | null
  /** The profile directory Goga launches Firefox with, so it never touches the real one. */
  profileDir: string | null
  /** Where Goga found firefox.exe, or null when it is not installed. */
  executable: string | null
  tabCount: number
  /** Plain words for the user: what is true, and the one step that would change it. */
  message: string
}

/** An interactive element as the page itself describes it. */
export interface PageElement {
  role: string
  name: string
  tag: string
  id?: string
  type?: string
  /** Current value for inputs, selects and textareas. */
  value?: string
  /** True when the element is on screen (not display:none / zero-size). */
  visible: boolean
  disabled?: boolean
}

export interface PageRead {
  url: string
  title: string
  /** The page's visible text, whitespace collapsed and clipped. */
  text: string
  elements: PageElement[]
  /** True when `text` was clipped, so the caller knows it did not read everything. */
  textClipped: boolean
}

export interface FoundElement {
  found: boolean
  match: PageElement | null
  /** How many elements matched; more than one means the caller must be more specific. */
  count: number
  /** Descriptions of the alternatives, so the user can pick one. */
  candidates: string[]
}

export type ElementQuery =
  | { by: 'role'; role: string; name?: string; exact?: boolean }
  | { by: 'label'; text: string; exact?: boolean }
  | { by: 'text'; text: string; exact?: boolean }
  | { by: 'css'; selector: string }

/**
 * A per-site description Goga wrote after reading a page it had not seen before, so the
 * next visit does not start from zero. Stored as plain JSON the user can read and correct.
 */
export interface SiteRecipe {
  /** Hostname, e.g. app.pivex.com — one recipe per site. */
  host: string
  /** The page the recipe was learned from, for the record. */
  learnedFrom: string
  pageTitle: string
  learnedAt: string
  updatedAt: string
  /** What the page appears to be for, in one plain sentence. */
  purpose: string
  fields: RecipeField[]
  actions: RecipeAction[]
  /** What a finished action looks like on this site, in the learner's words. */
  completion: string[]
  /** The learner's own notes: uncertainty it found, things it could not tell. */
  notes: string[]
  /** Anything the user typed to correct or extend the description. */
  userNotes: string
  /** How many times Goga has re-read the site and updated this recipe. */
  revisions: number
}

export interface RecipeField {
  /** A stable-ish name for the field, derived from its label or placeholder. */
  name: string
  role: string
  /** Where it was found, so a correction can be targeted. */
  selector: string
  /** Example value seen on the page, if any. */
  sample: string | null
}

export interface RecipeAction {
  name: string
  role: string
  selector: string
  /** What the learner thinks it does, from its wording and its neighbours. */
  expectation: string
}
