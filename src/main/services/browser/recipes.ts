import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { PageElement, PageRead, RecipeAction, RecipeField, SiteRecipe } from '../../../shared/browser'
import { browserLayer } from './layer'

/**
 * Learning a site instead of hand-coding it.
 *
 * Pointed at a page it has not seen, Goga reads it, works out which elements are fields
 * and which are actions, and writes a description it can reuse next time. The description
 * is plain JSON in one file under Goga's userData: the user can open it, read it, and
 * correct it, and a correction is kept (the learner never silently overwrites what the
 * user wrote).
 *
 * The learner is honest about its limits. It infers what a button probably does from its
 * wording and its neighbours. That is a guess, not an observation, and every guess is
 * labelled as one in the recipe.
 */

function recipesFile(): string {
  return path.join(app.getPath('userData'), 'site-recipes.json')
}

export function readRecipes(): SiteRecipe[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(recipesFile(), 'utf8'))
    return Array.isArray(parsed) ? parsed as SiteRecipe[] : []
  } catch { return [] }
}

function writeRecipes(list: SiteRecipe[]): void {
  const file = recipesFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(list, null, 2), { mode: 0o600 })
}

export function recipeFor(host: string): SiteRecipe | null {
  return readRecipes().find(r => r.host === host) ?? null
}

const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'])
const ACTION_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'switch', 'option', 'checkbox', 'radio'])

/** A field name from what the page calls it, falling back to a stable shape. */
export function fieldName(el: PageElement, index: number): string {
  const raw = (el.name || el.id || '').trim()
  if (!raw) return `field${index + 1}`
  return raw.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || `field${index + 1}`
}

const VERBS = /\b(?:open|place|submit|confirm|cancel|close|buy|sell|send|save|place order|log ?in|sign ?in|next|continue|search|apply|withdraw|deposit|transfer)\b/i

/**
 * What an action probably does, from its own wording.
 *
 * Deliberately says "probably": this is an inference from a label, not a fact about the
 * page, and the recipe keeps that distinction in the text the user reads.
 */
export function inferAction(label: string): string {
  const text = label.trim()
  if (!text) return 'probably does something, but the page gives it no label'
  const verb = text.match(VERBS)?.[0]?.toLowerCase()
  if (verb) return `probably ${verb}s — inferred from the label "${text}"`
  return `probably acts on "${text}" — inferred from the label`
}

/** One plain sentence about what the page appears to be for. */
export function inferPurpose(page: PageRead, host: string): string {
  const title = page.title.trim()
  const text = page.text.toLowerCase()
  const hints: string[] = []
  if (/\b(?:buy|sell|bid|ask|spread|position|balance|equity|order)\b/.test(text)) hints.push('a trading screen')
  if (/\b(?:sign in|log in|password)\b/.test(text)) hints.push('a sign-in screen')
  if (/\b(?:search results|no results)\b/.test(text)) hints.push('a search or results page')
  if (/\b(?:add to cart|checkout|buy now)\b/.test(text)) hints.push('a shop or checkout page')
  if (/\b(?:dashboard|account|settings|profile)\b/.test(text)) hints.push('an account or settings page')
  const what = hints.length ? hints.join(' and ') : 'a page with no obvious single purpose'
  return `${host} shows ${what}${title ? `, titled "${title}"` : ''}.`
}

/** Work out a recipe from a page Goga has just read. */
export function learnFromPage(page: PageRead, host: string, previous: SiteRecipe | null): SiteRecipe {
  const fields: RecipeField[] = []
  const actions: RecipeAction[] = []
  const notes: string[] = []

  page.elements.forEach((el, i) => {
    const role = el.role.toLowerCase()
    const selector = el.id ? `#${el.id}` : `${el.tag}${el.type ? `[type="${el.type}"]` : ''}`
    if (FIELD_ROLES.has(role) || (el.tag === 'input' && el.type !== 'submit' && el.type !== 'button')) {
      fields.push({ name: fieldName(el, fields.length), role, selector, sample: el.value && el.value.trim() ? el.value : null })
      return
    }
    if (ACTION_ROLES.has(role) || el.tag === 'button') {
      actions.push({ name: el.name || `action${actions.length + 1}`, role, selector, expectation: inferAction(el.name) })
    }
  })

  if (!fields.length) notes.push('I found no input fields on this page.')
  if (!actions.length) notes.push('I found no buttons or links I could name on this page.')
  if (page.textClipped) notes.push('The page had more text than I read in one pass, so this description may be missing the footer parts.')
  const unlabelled = actions.filter(a => !a.name.trim()).length
  if (unlabelled) notes.push(`${unlabelled} clickable element${unlabelled === 1 ? ' has' : 's have'} no label, so I could not say what they do.`)
  if (/\b(captcha|verify you are human|cloudflare)\b/i.test(page.text)) notes.push('This page mentions a verification step. Goga will not attempt to pass a human-verification check.')

  // What "done" looks like: the phrasing a site uses after an action succeeds.
  const completion: string[] = []
  for (const phrase of ['confirmed', 'success', 'submitted', 'accepted', 'filled', 'completed', 'position opened', 'order placed']) {
    if (new RegExp(`\\b${phrase}`, 'i').test(page.text)) completion.push(`the page says "${phrase}" somewhere`)
  }
  if (!completion.length) completion.push('I did not see a success message on this page, so a finished action here must be confirmed another way: re-read the page and look for the change.')

  const now = new Date().toISOString()
  return {
    host,
    learnedFrom: page.url,
    pageTitle: page.title,
    learnedAt: previous?.learnedAt ?? now,
    updatedAt: now,
    purpose: inferPurpose(page, host),
    fields,
    actions,
    completion,
    notes,
    // A correction the user typed is carried forward and never overwritten by a re-learn.
    userNotes: previous?.userNotes ?? '',
    revisions: (previous?.revisions ?? 0) + 1,
  }
}

export function saveRecipe(recipe: SiteRecipe): SiteRecipe {
  const list = readRecipes().filter(r => r.host !== recipe.host)
  list.push(recipe)
  writeRecipes(list)
  return recipe
}

/** Keep a correction the user typed, without touching the learned parts. */
export function correctRecipe(host: string, userNotes: string): SiteRecipe {
  const existing = recipeFor(host)
  if (!existing) throw new Error(`There is no saved description for ${host} yet. Open the site and press "Learn this page" first.`)
  return saveRecipe({ ...existing, userNotes: String(userNotes ?? ''), updatedAt: new Date().toISOString() })
}

export function forgetRecipe(host: string): void {
  writeRecipes(readRecipes().filter(r => r.host !== host))
}

/** Host of a URL, for keying a recipe. Empty when it is not a web address. */
export function hostOf(url: string): string {
  try { return new URL(url).host } catch { return '' }
}

/**
 * Read the selected tab and learn (or re-learn) its site.
 *
 * Re-learning keeps the user's own correction and adds one to the revision count, so the
 * file shows how many times Goga has looked and when.
 */
export async function learnCurrentPage(): Promise<SiteRecipe> {
  const layer = browserLayer()
  if (!layer.isAttached) throw new Error('Goga is not attached to Firefox. Attach on the Browser page first.')
  const page = await layer.readPage()
  const host = hostOf(page.url)
  if (!host) throw new Error(`The open tab is not a web page (${page.url || 'no address'}), so there is nothing to learn from it.`)
  const recipe = learnFromPage(page, host, recipeFor(host))
  saveRecipe(recipe)
  return recipe
}
