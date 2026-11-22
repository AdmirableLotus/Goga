import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The WordPress XSS path, and the one claim it must never make.
 *
 * A payload coming back in a response is an echo. An XSS is a script that ran. The runner is
 * given two kinds of stand-in browser here — one that runs the payload, one that only reflects
 * it — and the second is the important case: the result must say reflected, must not say
 * executed, and must produce no finding. A runner that collapsed those two would be the exact
 * failure this project keeps rejecting.
 *
 * The source side is a real file on disk, so `readSinks` runs the real specialist and the real
 * validator over real text.
 */

const tmp = path.join(os.tmpdir(), `goga-wpxss-${process.pid}`)

const SINK_FILE = `<?php
/**
 * A small template used by the tests. It has one unescaped echo of a request value.
 */
$tag_name_value = isset( $_GET['name'] ) ? wp_unslash( $_GET['name'] ) : '';
?>
<td><input name="name" id="name" type="text" value="<?php echo $tag_name_value; ?>" /></td>
`

const SAFE_FILE = `<?php
$tag_name_value = isset( $_GET['name'] ) ? wp_unslash( $_GET['name'] ) : '';
?>
<td><input name="name" value="<?php echo esc_attr( $tag_name_value ); ?>" /></td>
`

beforeAll(() => {
  fs.mkdirSync(tmp, { recursive: true })
  fs.writeFileSync(path.join(tmp, 'sink.php'), SINK_FILE)
  fs.writeFileSync(path.join(tmp, 'safe.php'), SAFE_FILE)
})

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

/** A browser that reflects without running: the title never becomes the nonce. */
function echoOnlyBrowser() {
  let title = 'local reproduction'
  let html = ''
  return {
    async navigate(url: string) {
      const u = new URL(url)
      const v = u.searchParams.get('v') ?? ''
      title = 'local reproduction'
      // Reflects the value exactly as an unescaping page would, and never evaluates it.
      html = `<html><head><title>${title}</title></head><body><input value="${v}" /></body></html>`
      return { url, title }
    },
    async evaluate(expr: string) {
      if (expr.includes('document.title')) return title
      return html
    },
  }
}

/** A browser that runs an onerror handler when the markup is live. */
function executingBrowser() {
  let title = 'local reproduction'
  let html = ''
  return {
    async navigate(url: string) {
      const u = new URL(url)
      const v = u.searchParams.get('v') ?? ''
      title = 'local reproduction'
      html = `<html><head><title>${title}</title></head><body><input value="${v}" /></body></html>`
      const m = /onerror="document\.title='([^']*)'"/.exec(v)
      if (m && v.includes('<img')) title = m[1]
      return { url, title }
    },
    async evaluate(expr: string) {
      if (expr.includes('document.title')) return title
      return html
    },
  }
}

/** Dispatch that performs the same unescaped reflection the reproduction server would. */
function echoingDispatch(un: { value: string }) {
  return async (url: string, payload: string) => {
    const target = url.replace('{payload}', encodeURIComponent(payload))
    const v = new URL(target).searchParams.get('v') ?? ''
    un.value = v
    return {
      status: 200,
      bytes: v.length,
      // Deliberately unescaped: this is the vulnerable line's behaviour.
      body: `<html><body><input type="text" name="q" value="${v}" /></body></html>`,
    }
  }
}

describe('the source read runs the real specialist and validator', () => {
  it('finds the unescaped echo and reports where the value would land', async () => {
    const { readSinks } = await import('../lab/wpXss')
    const reading = readSinks(tmp, 'sink.php')
    expect(reading.candidates.length).toBeGreaterThan(0)
    const hit = reading.candidates[0]
    expect(hit.file).toBe('sink.php')
    expect(hit.excerpt).toContain('echo')
    expect(hit.context).toBe('attribute-double')
    expect(hit.wouldConfirm.length).toBeGreaterThan(0)
  })

  it('drops the escaped line, because an escaper on the same line is counter-evidence', async () => {
    const { readSinks } = await import('../lab/wpXss')
    const reading = readSinks(tmp, 'safe.php')
    expect(reading.candidates).toHaveLength(0)
    expect(reading.dropped.length).toBeGreaterThan(0)
    expect(reading.dropped[0].outcome).toBe('refuted')
  })

  it('does NOT confirm an echo of an internal label just because the file reads a request elsewhere', async () => {
    // The real false positive this caught on WordPress: edit-tag-form.php echoes a taxonomy
    // label into an <h1>, and an unrelated `$_REQUEST['fetch']` appears hundreds of lines away.
    // A validator that confirms from "the file reads a request somewhere" confirms everything.
    const far = path.join(tmp, 'far.php')
    const filler = Array.from({ length: 40 }, (_, i) => `// padding line ${i}`).join('\n')
    fs.writeFileSync(far, [
      '<?php',
      "$mode = isset( $_REQUEST['fetch'] ) ? $_REQUEST['fetch'] : '';",
      filler,
      '<h1><?php echo $tax->labels->edit_item; ?></h1>',
      '?>',
    ].join('\n'))

    const { readSinks } = await import('../lab/wpXss')
    const reading = readSinks(tmp, 'far.php')
    expect(reading.candidates).toHaveLength(0)
    const dropped = reading.dropped.find(c => c.excerpt.includes('edit_item'))
    expect(dropped).toBeDefined()
    expect(dropped!.outcome).toBe('cannot-confirm')
  })

  it('DOES confirm when the value written is the request value', async () => {
    const near = path.join(tmp, 'near.php')
    fs.writeFileSync(near, [
      '<?php',
      "$q = isset( $_GET['q'] ) ? wp_unslash( $_GET['q'] ) : '';",
      '<h1><?php echo $q; ?></h1>',
      '?>',
    ].join('\n'))

    const { readSinks } = await import('../lab/wpXss')
    const reading = readSinks(tmp, 'near.php')
    expect(reading.candidates.length).toBeGreaterThan(0)
    expect(reading.candidates[0].excerpt).toContain('echo $q')
  })
})

describe('an echo is never reported as an execution', () => {
  it('says reflected and NOT executed when the browser only echoes, and records no finding', async () => {
    const { runWordPressXss } = await import('../lab/wpXss')
    const un = { value: '' }
    const result = await runWordPressXss({
      root: tmp,
      file: 'sink.php',
      dispatch: echoingDispatch(un),
      drive: echoOnlyBrowser(),
    })
    expect(result.reflected).toBe(true)
    expect(result.tookAsMarkup).toBe(true)     // the markup did survive the response
    expect(result.executed).toBe(false)        // but nothing ran
    expect(result.finding).toBeNull()
    const executionStep = result.steps.find(s => s.step === 'Execution')
    expect(executionStep?.detail).toMatch(/did NOT run/i)
  })

  it('records a finding only when the browser actually ran the payload', async () => {
    const { runWordPressXss } = await import('../lab/wpXss')
    const un = { value: '' }
    const result = await runWordPressXss({
      root: tmp,
      file: 'sink.php',
      dispatch: echoingDispatch(un),
      drive: executingBrowser(),
    })
    expect(result.executed).toBe(true)
    expect(result.finding).not.toBeNull()
    expect(result.finding!.confidence).toBe('confirmed')
    expect(result.finding!.evidence).toMatch(/document\.title became/i)
  })

  it('does not claim execution when no browser was supplied', async () => {
    const { runWordPressXss } = await import('../lab/wpXss')
    const result = await runWordPressXss({
      root: tmp,
      file: 'sink.php',
      dispatch: echoingDispatch({ value: '' }),
    })
    expect(result.executed).toBe(false)
    expect(result.finding).toBeNull()
    expect(result.steps.find(s => s.step === 'Execution')?.detail).toMatch(/not tested/i)
  })
})

describe('the payload is built for the context the source predicts', () => {
  it('prepends a quote-and-bracket breakout for a double-quoted attribute', async () => {
    const { payloadFor, breakoutFor, sinkContext } = await import('../lab/wpXss')
    expect(sinkContext('<input value="<?php echo $x; ?>" />')).toBe('attribute-double')
    expect(breakoutFor('attribute-double')).toBe('">')
    expect(payloadFor('attribute-double', 'abc')).toContain('">')
  })

  it('closes a textarea, and uses no breakout in element text', async () => {
    const { payloadFor, breakoutFor, sinkContext } = await import('../lab/wpXss')
    expect(sinkContext('<textarea name="d"><?php echo $x; ?></textarea>')).toBe('textarea')
    expect(breakoutFor('textarea')).toBe('</textarea>')
    expect(sinkContext('<div>You searched for: <?php echo $q; ?></div>')).toBe('text')
    expect(breakoutFor('text')).toBe('')
    expect(payloadFor('text', 'abc').startsWith('<img')).toBe(true)
  })
})
