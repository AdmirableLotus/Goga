/**
 * The script Goga runs inside a page to see what is on it.
 *
 * It is one self-contained function turned into a string, because BiDi evaluates a
 * script in the page and hands back a value — and a JSON string is the only value shape
 * that survives that trip without depending on how empties, functions and cycles are
 * serialised. Everything it returns is page content, which is untrusted data: the caller
 * must never let it change what Goga is allowed to do.
 */

export const PAGE_READ_SCRIPT = `(() => {
  const MAX_TEXT = 12000
  const MAX_ELEMENTS = 120

  const visible = (el) => {
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()

  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return aria.trim()
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const parts = labelledBy.split(/\\s+/).map(id => {
        const t = document.getElementById(id)
        return t ? textOf(t) : ''
      }).filter(Boolean)
      if (parts.length) return parts.join(' ').trim()
    }
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
      if (label) return textOf(label)
    }
    const wrapping = el.closest('label')
    if (wrapping) {
      const own = textOf(el)
      const whole = textOf(wrapping)
      if (whole && whole !== own) return whole
    }
    const own = textOf(el)
    if (own) return own
    const placeholder = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name')
    if (placeholder && placeholder.trim()) return placeholder.trim()
    return (el.value || '').toString().trim()
  }

  const roleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.trim().toLowerCase()
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic'
    if (tag === 'button') return 'button'
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button') return 'button'
      if (type === 'search') return 'searchbox'
      return 'textbox'
    }
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    return tag
  }

  // A short, human-readable selector: an id if it has one, otherwise a tag plus a
  // distinguishing attribute. Not guaranteed unique, which is why the caller reports
  // ambiguity instead of pretending a match is exact.
  const selectorOf = (el) => {
    if (el.id) return '#' + CSS.escape(el.id)
    const tag = el.tagName.toLowerCase()
    const attrs = ['data-testid', 'data-test', 'name', 'aria-label', 'placeholder', 'title', 'type']
    for (const a of attrs) {
      const v = el.getAttribute(a)
      if (v && v.trim()) return tag + '[' + a + '="' + v.replace(/"/g, '\\\\"') + '"]'
    }
    const cls = (el.className || '').toString().trim().split(/\\s+/).filter(Boolean)[0]
    return cls ? tag + '.' + CSS.escape(cls) : tag
  }

  const SELECTOR = [
    'button', 'a[href]', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
    '[role="checkbox"]', '[role="radio"]', '[role="combobox"]', '[role="textbox"]',
    '[role="switch"]', '[role="option"]', '[role="slider"]',
    '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'
  ].join(',')

  const seen = new Set()
  const elements = []
  for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
    if (seen.has(el)) continue
    seen.add(el)
    if (elements.length >= MAX_ELEMENTS) break
    const tag = el.tagName.toLowerCase()
    const isField = tag === 'input' || tag === 'select' || tag === 'textarea' || el.getAttribute('role') === 'textbox' || el.getAttribute('contenteditable') === 'true'
    const entry = {
      role: roleOf(el),
      name: nameOf(el).slice(0, 120),
      tag,
      id: el.id || undefined,
      type: (el.getAttribute('type') || undefined),
      value: isField ? String(el.value === undefined ? '' : el.value).slice(0, 200) : undefined,
      visible: visible(el),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      selector: selectorOf(el),
    }
    if (!entry.visible) continue
    elements.push(entry)
  }

  const rawText = document.body ? (document.body.innerText || '') : ''
  const text = rawText.replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim()

  return JSON.stringify({
    url: location.href,
    title: document.title || '',
    text: text.slice(0, MAX_TEXT),
    textClipped: text.length > MAX_TEXT,
    elements,
  })
})()`

/**
 * Read one element's current value by CSS selector.
 * Returns a JSON string: { found, value, visible }.
 */
export function readValueScript(selector: string): string {
  return `(() => {
    try {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return JSON.stringify({ found: false, value: null, visible: false })
      const style = window.getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return JSON.stringify({
        found: true,
        value: String(el.value === undefined ? (el.innerText || '') : el.value),
        visible: style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0,
      })
    } catch (err) {
      return JSON.stringify({ found: false, value: null, visible: false, error: String(err) })
    }
  })()`
}

/**
 * Is an element matching this text present?
 * Returns a JSON string: { count, firstText, visible }.
 */
export function waitForTextScript(text: string, exact: boolean): string {
  return `(() => {
    const want = ${JSON.stringify(text)}
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim()
    const target = norm(want)
    let count = 0, firstText = ''
    const isVisible = (el) => {
      const style = window.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    if (!target) return JSON.stringify({ count: 0, firstText: '', visible: false })
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const t = norm(el.innerText || '')
      if (!t) continue
      const hit = ${exact ? 't === target' : 't.includes(target)'}
      if (!hit) continue
      count++
      if (!firstText) firstText = t.slice(0, 200)
      if (isVisible(el)) return JSON.stringify({ count, firstText, visible: true })
      if (count >= 50) break
    }
    return JSON.stringify({ count, firstText, visible: false })
  })()`
}

/** Scroll an element into view before clicking it, so a click lands on the real thing. */
export function scrollToScript(selector: string): string {
  return `(() => {
    try {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return JSON.stringify({ ok: false })
      el.scrollIntoView({ block: 'center', inline: 'center' })
      return JSON.stringify({ ok: true })
    } catch (err) { return JSON.stringify({ ok: false, error: String(err) }) }
  })()`
}
