import type { Hypothesis, SpecialistId, ValidationVerdict } from '../../../../shared/grimoire'

/**
 * The independent validator.
 *
 * This is the idea BountyGrimoire is actually right about, kept faithful: a specialist's
 * proposal is not a finding. Before anything is shown as a finding, a second line of reasoning
 * — one that did not write the proposal — has to state, in concrete terms, what evidence would
 * confirm it, and then check whether that evidence is present in the material we have.
 *
 * Three outcomes, and the third is the point:
 *
 *   confirmed-observable  the confirming observable is present in the material, quoted. This
 *                         still does not mean the bug is exploitable — the user reproduces it.
 *   refuted               the material contains the thing that makes the proposal wrong (an
 *                         escaper on the same line, a bound placeholder, a constant).
 *   cannot-confirm        the material does not settle it. The item is DROPPED, not softened.
 *
 * The validator is deliberately not a second copy of the specialist's patterns. It looks for
 * the counter-evidence first, because the commonest failure of an automated reviewer is
 * flagging correct code. A validator that only ever agrees is decoration.
 *
 * It reads a string. It has no network client and no way to send anything.
 */

export interface ValidationInput {
  specialist: SpecialistId
  /** The line the specialist reacted to. */
  line: number | null
  /** The excerpt the specialist quoted. */
  excerpt: string
  /** The full material, so the validator can look at context the specialist did not quote. */
  material: string
  /** The file or page the material came from, for the observable's location. */
  location: string
}

const ESCAPERS = /\b(esc_html|esc_attr|esc_url|esc_textarea|esc_js|wp_kses|wp_kses_post|wp_kses_data|sanitize_text_field|sanitize_key|absint|intval|wp_json_encode|json_encode|escapeHtml|DOMPurify\.sanitize|escape\s*\(|markupsafe\.escape|bleach\.clean)\s*\(/
const INPUT_READ = /\$_(GET|POST|REQUEST|COOKIE|FILES|SERVER)\s*\[/
/** Caller input across stacks: PHP superglobals, Express/Node req.*, Flask/Django request.*. */
const INPUT_READ_ANY = /\$_(GET|POST|REQUEST|COOKIE|FILES|SERVER)\s*\[|\breq\.(params|query|body|cookies|headers)\b|\brequest\.(args|form|json|values|data|cookies|GET|POST)\b/
const BOUND_PLACEHOLDER = /prepare\s*\([^)]*,\s*[^)]*\$/
const CONSTANT_ASSIGN = /^\s*(?:const|let|var|private|public|protected)?\s*\$?[A-Za-z_][A-Za-z0-9_]*\s*=\s*['"][^'"]*['"]\s*;?\s*$/

/** The line's own text, when we can find it. */
function lineText(material: string, line: number | null): string {
  if (line === null || line === undefined) return ''
  const lines = material.split(/\r?\n/)
  return lines[line - 1] ?? ''
}

/** A few lines around the hit, so the validator can see the guard that sits next to it. */
function window(material: string, line: number | null, radius = 4): string {
  if (line === null || line === undefined) return material.slice(0, 2000)
  const lines = material.split(/\r?\n/)
  const from = Math.max(0, line - 1 - radius)
  const to = Math.min(lines.length, line + radius)
  return lines.slice(from, to).join('\n')
}

/**
 * Does a request value actually reach the expression being written out?
 *
 * The old check asked whether the FILE read a request anywhere in its first 4000
 * characters. On WordPress that is almost always true, so a taxonomy label echoed into an
 * <h1> at line 72 was confirmed because an unrelated `$_REQUEST['fetch']` appeared hundreds
 * of lines away. A validator that agrees with everything is decoration.
 *
 * This traces the variable actually written: if the expression reads a request directly, it
 * is traced. Otherwise each variable root in the expression is looked up in the material and
 * the assignment line is checked — and only that line, plus the two after it, so a
 * conditional spread over a few lines still counts while an unrelated read elsewhere does
 * not. When the trace cannot be made, the answer is "cannot confirm", never a guess.
 */
export function tracesFromRequest(subject: string, material: string): boolean {
  if (INPUT_READ_ANY.test(subject)) return true
  // Every variable root written to output, e.g. `$tax` from `$tax->labels->edit_item`.
  const roots = new Set<string>()
  for (const m of subject.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) roots.add(m[1])
  // A PHP/JS variable written bare, without the sigil.
  if (!roots.size) {
    for (const m of subject.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
      const id = m[1]
      if (/^(echo|print|return|res|send|write|end|document|window|innerHTML|outerHTML|then)$/i.test(id)) continue
      if (/\($/.test(subject.slice(0, m.index + id.length + 1))) continue
      roots.add(id)
    }
  }
  if (!roots.size) return false

  const lines = material.split(/\r?\n/)
  for (const root of roots) {
    const assign = new RegExp(`(^|[^A-Za-z0-9_$])\\$?${root}\\s*(\\[[^\\]]*\\])?\\s*=[^=]`)
    for (let i = 0; i < lines.length; i++) {
      if (!assign.test(lines[i])) continue
      // The assignment, and the two lines after it, so a multi-line ternary still counts.
      const statement = lines.slice(i, i + 3).join(' ')
      if (INPUT_READ_ANY.test(statement)) return true
    }
  }
  return false
}
function at(location: string, line: number | null): string {
  return line === null || line === undefined ? location : `${location}:${line}`
}

/**
 * The validator's own check, per class. Each returns a verdict. The `check` field always says
 * what was actually looked at, so the user can disagree with it.
 */
export function validate(input: ValidationInput): ValidationVerdict {
  const { specialist, line, excerpt, material, location } = input
  const here = lineText(material, line)
  const near = window(material, line)
  const subject = here || excerpt

  const cannot = (why: string, check: string, wouldConfirm: string[]): ValidationVerdict => ({
    outcome: 'cannot-confirm', observable: null, observableAt: null, wouldConfirm, why, check,
  })
  const refuted = (why: string, check: string, observable: string | null = null): ValidationVerdict => ({
    outcome: 'refuted', observable, observableAt: observable ? at(location, line) : null, wouldConfirm: [], why, check,
  })
  const confirmed = (observable: string, check: string, wouldConfirm: string[]): ValidationVerdict => ({
    outcome: 'confirmed-observable', observable, observableAt: at(location, line), wouldConfirm, why: 'The confirming observable is present in the material. That makes this worth reproducing by hand — it does not make it a finding yet.', check,
  })

  switch (specialist) {
    /* ── XSS: is the value escaped for its context, and does it come from outside? ── */
    case 'xss': {
      const check = 'Looked for an escaping call on the same line and in the four lines around it, and for a request read that could supply the value.'
      if (ESCAPERS.test(subject) || ESCAPERS.test(near)) {
        return refuted('An escaping or sanitising call is applied on or beside this line, so the value is not written raw. If you still suspect a bypass, that is a different claim and needs the crafted encoding named.', check, subject.trim().slice(0, 200))
      }
      if (!/echo|print|innerHTML|outerHTML|document\.write|insertAdjacentHTML|<\?=|res\.(send|write|end)|dangerouslySetInnerHTML|v-html|render_template_string|mark_safe|\.html\s*\(/.test(subject)) {
        return cannot('This line does not itself write anything to output, so there is no sink here to confirm.', check, [
          'The line that actually writes the value out.',
          'The context it lands in: element text, an attribute, an event handler, or a script block.',
        ])
      }
      // Does a request value actually reach THIS write? Not "does the file read a request
      // anywhere" — that is how a taxonomy label echoed at line 72 was confirmed because an
      // unrelated `$_REQUEST['fetch']` appeared hundreds of lines earlier in the same file.
      const fromInput = tracesFromRequest(subject, material)
      if (!fromInput) {
        return cannot('There is an unescaped write here, but nothing in the surrounding code shows the value coming from a request. It may be a constant or an internal value.', check, [
          'Where the written variable is assigned, and whether a request value reaches it.',
          'Whether the value is stored first (stored XSS) or reflected straight back.',
        ])
      }
      return confirmed(subject.trim().slice(0, 300), check, [
        'The request parameter that reaches this write.',
        'The rendered page source on your own copy, showing your marker unescaped in that context.',
      ])
    }

    /* ── SQLi: is the value bound, or placed into the statement? ── */
    case 'sqli': {
      const check = 'Looked for a bound placeholder in the prepare call, and for a variable interpolated into the statement itself.'
      if (BOUND_PLACEHOLDER.test(near) && !/\$[a-zA-Z_]+\s*\.\s*['"]|\$[a-zA-Z_]+\s*\.\s*\$/.test(subject)) {
        return refuted('The statement is prepared with the value passed as a placeholder argument, which is the correct form. A placeholder is not a hole.', check, subject.trim().slice(0, 200))
      }
      if (!/SELECT|INSERT|UPDATE|DELETE|WHERE|ORDER BY|LIMIT/i.test(subject)) {
        return cannot('This line is not a SQL statement, so there is nothing here to confirm.', check, [
          'The statement that uses this value.',
          'Whether the value is bound or interpolated.',
        ])
      }
      if (/\$[a-zA-Z_]+\s*\.\s*['"]|\$[a-zA-Z_]+\s*\.\s*\$|"\s*\.\s*\$[a-zA-Z_]|['"]\s*\+\s*\w|\$\{|%s|%d|\.format\s*\(|\bf['"]/.test(subject)) {
        return confirmed(subject.trim().slice(0, 300), check, [
          'The variable that is concatenated, and where it is assigned.',
          'Whether that variable came from a request value.',
          'A local run where a quote in the value changes the statement.',
        ])
      }
      return cannot('A SQL statement is here, but this line does not show a variable being concatenated into it. The value may be bound a line or two away.', check, [
        'The full statement, including how each variable enters it.',
        'Whether an identifier (table or column) is interpolated, which cannot be bound.',
      ])
    }

    /* ── IDOR: is there an entitlement check on the object? ── */
    case 'idor': {
      const check = 'Looked for a capability or ownership test in the surrounding handler, and for a permission_callback that is not a blanket true.'
      if (/permission_callback\s*['"]?\s*=>\s*['"]?__return_true/.test(near)) {
        return confirmed('permission_callback is __return_true, so the route has no permission gate at all.', check, [
          'What the route returns, and whether it includes another user\'s data.',
          'Whether the route is reachable without logging in.',
        ])
      }
      if (/current_user_can\s*\(|get_current_user_id\s*\(\s*\)\s*===|wp_get_current_user|user_can\s*\(|\breq\.user\b|isAuthenticated|@login_required|\brequest\.user\b|permission_classes|IsAuthenticated|\bownerId?\b|userId\s*===?\s*req|WHERE[^;]*user_id\s*=/.test(near)) {
        return cannot('There is a capability or identity check nearby. Whether it is about THIS object is the question, and that needs the object lookup read in full.', check, [
          'The line that loads the object, and the line that decides entitlement to it.',
          'Whether the check tests the object\'s owner or only that someone is logged in.',
        ])
      }
      if (!/get_post|get_user_by|get_comment|get_term|wp_get_attachment|wpdb->get_row|wpdb->get_results|\.(findById|findByPk|findOne|find|get|load|retrieve)\s*\(|\.objects\.(get|filter)|get_object_or_404|\.(query|execute)\s*\(|SELECT\b/.test(near)) {
        return cannot('No object lookup is visible around this line, so there is no object to be unauthorized about here.', check, [
          'The handler that loads the object by the caller\'s identifier.',
        ])
      }
      return confirmed(subject.trim().slice(0, 300), check, [
        'The identifier as it arrives from the request.',
        'The object lookup that uses it.',
        'The absence of an ownership test between the two.',
      ])
    }

    /* ── SSRF: does the address come from outside, and is it re-validated? ── */
    case 'ssrf': {
      const check = 'Looked for a caller-supplied address reaching a fetch, and for a host allow-list or private-range guard between them.'
      if (!/wp_remote_|curl_exec|file_get_contents|fsockopen|\bfetch\s*\(|axios\.|requests\.(get|post|put|request|head)|urllib\.request\.urlopen|\bhttp\.(get|request)|\bhttps\.(get|request)|\bgot\s*\(/.test(near)) {
        return cannot('No outbound fetch is visible around this line, so there is no request for the server to be tricked into making here.', check, [
          'The line that performs the outbound request.',
          'Where its URL is built.',
        ])
      }
      if (/wp_http_validate_url|FILTER_VALIDATE_IP|FILTER_FLAG_NO_PRIV_RANGE|is_private_ip|allowed_redirect_hosts/.test(near)) {
        return cannot('A URL or address validation is present nearby. Whether it runs on the parsed host after resolution, and before the fetch, is what decides this.', check, [
          'The order: validation, then fetch — or the other way round.',
          'Whether redirects are followed after the check.',
        ])
      }
      if (INPUT_READ_ANY.test(near) || /\$[a-zA-Z_]*(url|uri|host|target|dest)[a-zA-Z_]*\s*=|(req|request)\.[a-z.]*\b(url|uri|host|target|dest|link|next)\b/.test(near)) {
        return confirmed(subject.trim().slice(0, 300), check, [
          'The line where the URL is read or built.',
          'The fetch, with no re-validation between them.',
          'Whether redirect following is enabled.',
        ])
      }
      return cannot('A fetch is here, but this line does not show its address coming from the caller.', check, [
        'Where the fetched URL is assigned.',
        'Whether any part of it is caller-controlled.',
      ])
    }

    /* ── RCE: is the argument reachable from outside? ── */
    case 'rce': {
      const check = 'Looked for a code-execution or file-write call, and for an allow-list or constant argument beside it.'
      if (!/eval\s*\(|assert\s*\(|create_function|shell_exec|system\s*\(|passthru|popen|proc_open|unserialize|include|require|file_put_contents|fwrite|move_uploaded_file|child_process|exec(Sync)?\s*\(|execFile|spawn(Sync)?\s*\(|\bos\.(system|popen)|subprocess\.|new\s+Function|pickle\.loads|yaml\.load/.test(subject)) {
        return cannot('This line does not execute code or write a file, so there is nothing here to confirm.', check, [
          'The call that executes or writes.',
          'The chain from an outside value to its argument.',
        ])
      }
      if (/in_array\s*\(|array_key_exists\s*\(|switch\s*\(|\.includes\s*\(|\bin\s+\[|allowlist|allowList|whitelist/.test(near)) {
        return cannot('An allow-list or switch is nearby. If the value is compared against a fixed set before the call, this is not reachable.', check, [
          'Whether the allow-list is applied to the exact value passed to the call.',
        ])
      }
      if (INPUT_READ_ANY.test(near) || /\$[a-zA-Z_]+\s*=\s*\$_(GET|POST|REQUEST)/.test(near)) {
        return confirmed(subject.trim().slice(0, 300), check, [
          'The outside value, and every hop to the call\'s argument.',
          'Whether any cast or allow-list sits in that chain.',
          'Whether the path is reachable without an already-privileged session.',
        ])
      }
      return cannot('The call is here, but this line does not show its argument coming from outside the application.', check, [
        'Where the argument is assigned.',
        'Whether a request value reaches it.',
      ])
    }

    /* ── Auth: is the comparison sound, and does failure return? ── */
    case 'auth': {
      const check = 'Looked for a constant-time comparison, and for whether the failure branch returns.'
      if (/hash_equals\s*\(|password_verify\s*\(|wp_check_password\s*\(/.test(near)) {
        return refuted('The comparison uses a constant-time or password-verifying function, which is the correct form.', check, subject.trim().slice(0, 200))
      }
      if (/==\s*\$[a-zA-Z_]*(password|token|hash|secret|key)|(\$[a-zA-Z_]*(password|token|hash|secret|key))\s*==/.test(subject)) {
        return confirmed(subject.trim().slice(0, 300), check, [
          'Both sides of the comparison, and whether they are the same shape.',
          'What happens on the failure branch.',
        ])
      }
      return cannot('This line does not show a comparison of secret material, so there is nothing here to confirm.', check, [
        'The comparison itself.',
        'The failure branch, and whether it returns.',
      ])
    }

    /* ── Redirect: is the destination validated after parsing? ── */
    case 'redirect': {
      const check = 'Looked for a redirect call, and for host validation applied to the final destination.'
      if (!/wp_redirect|wp_safe_redirect|header\s*\(\s*['"]Location|res\.redirect\s*\(|HttpResponseRedirect|\bredirect\s*\(/.test(subject)) {
        return cannot('No redirect is issued on this line.', check, ['The redirect call and where its destination came from.'])
      }
      if (/wp_safe_redirect|wp_validate_redirect|allowed_redirect_hosts|url_has_allowed_host_and_scheme|is_safe_url/.test(subject)) {
        return refuted('The redirect goes through the safe variant, which validates the destination against the allowed hosts.', check, subject.trim().slice(0, 200))
      }
      if (INPUT_READ_ANY.test(near) || /\$[a-zA-Z_]*(redirect|return|next|dest|url)[a-zA-Z_]*\s*=|(req|request)\.[a-z.]*\b(redirect|return|next|dest|url)\b/.test(near)) {
        return confirmed(subject.trim().slice(0, 300), check, [
          'The destination as it arrives from the request.',
          'Whether any host validation runs on it.',
          'Whether the check is a substring test a crafted host could satisfy.',
        ])
      }
      return cannot('A redirect is here, but this line does not show its destination coming from the caller.', check, [
        'Where the destination is assigned.',
      ])
    }

    /* ── Secrets: is the value a real credential or a placeholder? ── */
    case 'secrets': {
      const check = 'Looked at the literal value itself, to tell a real credential from a placeholder or a public identifier.'
      const literal = /['"]([^'"]{8,})['"]/.exec(subject)?.[1] ?? ''
      if (!literal) return cannot('No literal value is visible on this line.', check, ['The line holding the value.'])
      if (/^(x{4,}|\*{4,}|your[_-]?|changeme|placeholder|example|test|dummy|sample|todo|none|null|false|true)/i.test(literal)) {
        return refuted(`The value "${literal.slice(0, 24)}" reads as a placeholder or a sample, not a credential.`, check, literal.slice(0, 40))
      }
      if (/^(pk_|pub_|client_id|public)/i.test(literal)) {
        return refuted('The value looks like a public identifier, which has no signing power on its own.', check, literal.slice(0, 40))
      }
      if (literal.length >= 16 && /[A-Za-z]/.test(literal) && /[0-9]/.test(literal)) {
        return confirmed(subject.trim().slice(0, 200), check, [
          'Whether this value is a real credential or a documented test constant.',
          'Whether the same value appears in the project\'s own documentation as a sample.',
          'Whether the file is shipped to users or only used in development.',
        ])
      }
      return cannot('The value is too short or too uniform to judge from the text alone.', check, [
        'What the value is used for, and whether it grants anything.',
      ])
    }

    /* ── Integrity: does verification happen before processing, and fail closed? ── */
    case 'integrity': {
      const check = 'Looked for a signature check, its position relative to body processing, and what happens when the secret is unset.'
      if (/hash_equals\s*\(/.test(near) && /hash_hmac\s*\(/.test(near)) {
        return refuted('A constant-time comparison of a computed HMAC is present, which is the correct form.', check, subject.trim().slice(0, 200))
      }
      if (/if\s*\(\s*!\s*\$[a-zA-Z_]*(secret|key)[a-zA-Z_]*\s*\)\s*\{?\s*return\s+true/.test(near)) {
        return confirmed('The handler returns true when the secret is unset — a fail-open check.', check, [
          'What the handler does after that return.',
          'Whether the route is reachable from outside.',
        ])
      }
      if (!/hash_hmac|signature|hmac/i.test(near)) {
        return cannot('No signature verification is visible around this line, so there is nothing here to confirm.', check, [
          'The handler that receives the callback.',
          'Whether it verifies anything before acting.',
        ])
      }
      return cannot('A signature is mentioned nearby, but this line does not show the comparison or its order relative to processing.', check, [
        'The order: verify, then process.',
        'Whether the comparison is constant-time.',
      ])
    }

    /* ── Logic: is the value derived server-side? ── */
    case 'logic': {
      const check = 'Looked for a value with financial meaning arriving from the request, and for server-side derivation beside it.'
      if (!INPUT_READ.test(near)) {
        return cannot('No request value is read around this line, so there is no caller-chosen quantity here.', check, [
          'Where the quantity or price is read.',
          'Whether it is recomputed from stored data.',
        ])
      }
      if (/\$[a-zA-Z_]*(price|amount|total)[a-zA-Z_]*\s*=\s*\$[a-zA-Z_]*(product|item|order)[a-zA-Z_]*->/.test(near)) {
        return refuted('The value appears to be taken from stored product or order data rather than from the request.', check, subject.trim().slice(0, 200))
      }
      return confirmed(subject.trim().slice(0, 300), check, [
        'The value as it arrives from the request.',
        'Where it should have been derived from stored data instead.',
        'What the arithmetic does with zero, a negative number and a fraction.',
      ])
    }

    /* ── PII: is the row filtered to the caller? ── */
    case 'pii': {
      const check = 'Looked for personal fields in a response, and for a filter that limits rows to the caller.'
      // A comment or a docblock is not a response. The commonest false positive in this class is
      // the word "address" inside a description of an IP helper, so a comment line is refused
      // before anything else is considered.
      if (/^\s*(?:\*|\/\/|#)/.test(subject)) {
        return cannot('This line is a comment or a docblock, not code that returns data. A word in a description is not a field in a response.', check, [
          'The line that actually returns or prints the data.',
          'The fields in that response.',
        ])
      }
      const FIELD = /user_email|user_login|billing_|shipping_|phone|address|postcode|date_of_birth/
      const OUTPUT = /return\b|echo\b|print\b|wp_send_json|rest_ensure_response|json_encode|fputcsv|\$response\b/
      if (!FIELD.test(near)) {
        return cannot('No personal field is visible around this line.', check, ['The fields actually returned.'])
      }
      // The field must appear on a line that hands data back. "address" in a docblock, or in the
      // name of a function that VALIDATES an address, is not a field in a response — and those
      // are the two false positives this class produces most often.
      const lines = material.split(/\r?\n/).slice(Math.max(0, (line ?? 1) - 4), (line ?? 1) + 3)
      // A comment line is excluded even here: "@return ... an IPv4 address" is a description of a
      // return value, not a return of personal data, and it is the exact shape that fooled this
      // check on WordPress's IP helper.
      const isComment = (l: string) => /^\s*(?:\*|\/\*|\/\/|#)/.test(l)
      const handsBackFields = lines.some(l => !isComment(l) && OUTPUT.test(l) && FIELD.test(l))
      if (!handsBackFields) {
        return cannot('Personal field names appear near this line, but no line here both names a personal field and returns or prints it, so there is no response to be exposed.', check, [
          'The line that returns or prints the data, with the field names it uses.',
          'The fields in that response.',
        ])
      }
      if (/get_current_user_id\s*\(\s*\)|wp_get_current_user\s*\(/.test(near) && /WHERE[^;]*user/i.test(near)) {
        return cannot('The query appears to be limited to the current user. Whether every path does that is the question.', check, [
          'The filter that decides which rows are returned.',
        ])
      }
      return confirmed(subject.trim().slice(0, 300), check, [
        'The fields returned, and which of them are personal.',
        'The filter on the rows, and whether it excludes other people.',
        'Whether the requester is entitled to every row.',
      ])
    }

    /* ── OTP: is the token unpredictable and bound? ── */
    case 'otp': {
      const check = 'Looked at how the one-time value is generated, and whether an attempt counter or expiry is enforced.'
      if (/random_int\s*\(|random_bytes\s*\(|wp_generate_password\s*\(/.test(near)) {
        return cannot('A CSPRNG is used to generate the value, which removes the guessability half. Binding and expiry still need checking.', check, [
          'Whether the token is bound to the account it was issued for.',
          'Whether an expiry is compared, and an attempt counter enforced.',
        ])
      }
      if (/mt_rand\s*\(|rand\s*\(|uniqid\s*\(|time\s*\(\s*\)/.test(near)) {
        return confirmed(subject.trim().slice(0, 300), check, [
          'The generator, and whether its output is predictable.',
          'Whether the token is bound to the account and an expiry.',
          'Whether an attempt counter is enforced before the comparison.',
        ])
      }
      return cannot('This line does not show how the one-time value is produced.', check, [
        'The generation call.',
        'The comparison, and what it is bound to.',
      ])
    }

    /* ── CORS: is the origin reflected, and are credentials allowed? ── */
    case 'cors': {
      const check = 'Looked for a reflected origin, a wildcard, and whether credentials are allowed with it.'
      if (/Allow-Origin[^\n]{0,40}\*/.test(subject) && !/Allow-Credentials[^\n]{0,20}true/.test(near)) {
        return refuted('A wildcard origin without credentials is the ordinary public-API case; it does not let another origin read private data.', check, subject.trim().slice(0, 200))
      }
      if (/HTTP_ORIGIN/.test(near) && /Allow-Origin/.test(near)) {
        return confirmed(subject.trim().slice(0, 300), check, [
          'Whether the origin is echoed from the request.',
          'Whether credentials are allowed with it.',
          'Whether the endpoint behind it requires its own authentication.',
        ])
      }
      return cannot('This line does not show a cross-origin policy being computed from the request.', check, [
        'The header value and how it is computed.',
      ])
    }

    /* ── Referer: is the value in the URL actually a secret? ── */
    case 'referer': {
      const check = 'Looked at what the URL parameter carries, and whether a referrer policy is set.'
      const m = /[?&](token|key|nonce|code|reset|password|secret)=/.exec(subject)
      if (!m) return cannot('No secret-shaped value is in a URL on this line.', check, ['The URL that carries the value.'])
      if (m[1] === 'nonce' || m[1] === '_wpnonce') {
        return cannot('A nonce in a URL is common in WordPress and usually grants nothing on its own. Whether this one does is the question.', check, [
          'What the nonce authorises, and for how long.',
          'Whether the page sets a strict Referrer-Policy.',
        ])
      }
      return confirmed(subject.trim().slice(0, 300), check, [
        'What the value in the URL authorises.',
        'What the page loads from other origins while that URL is current.',
        'Whether Referrer-Policy is set on that response.',
      ])
    }

    /* ── Enumeration: do the branches differ? ── */
    case 'enumeration': {
      const check = 'Looked for a message or status that distinguishes a missing account from a wrong credential.'
      if (/invalid username|no such user|user does not exist|unknown user/i.test(subject)) {
        return confirmed(subject.trim().slice(0, 300), check, [
          'The other branch\'s message, and whether it differs.',
          'Whether a rate limit makes the difference unusable.',
        ])
      }
      return cannot('This line does not show a message that distinguishes existence.', check, [
        'Both branches, and the message and status each returns.',
      ])
    }

    /* ── XXE / SSTI: the parser and the template source ── */
    case 'xxe': {
      const check = 'Looked for an XML parser and whether external entity loading is disabled.'
      if (/LIBXML_NOENT|libxml_disable_entity_loader\s*\(\s*true|resolveExternals\s*=\s*false|substituteEntities\s*=\s*false/.test(near)) {
        return refuted('External entity handling is explicitly disabled here, which is the fix for this class.', check, subject.trim().slice(0, 200))
      }
      if (!/simplexml_load_string|DOMDocument|loadXML|XMLReader|xml_parse/.test(near)) {
        return cannot('No XML parser is visible around this line.', check, ['The parser construction.'])
      }
      return confirmed(subject.trim().slice(0, 300), check, [
        'The parser construction, and whether entities are disabled.',
        'Whether the parsed document came from a caller.',
      ])
    }
    case 'ssti': {
      const check = 'Looked at whether the template SOURCE is dynamic or only its data.'
      if (!/render|template|Twig|sprintf|Jinja|Handlebars|\$\{/.test(near)) {
        return cannot('No template rendering is visible around this line.', check, ['The render call.'])
      }
      if (INPUT_READ_ANY.test(near)) {
        return confirmed(subject.trim().slice(0, 300), check, [
          'Whether the template source, not just its variables, comes from the caller.',
          'A local run where your marker inside template syntax is evaluated or printed literally.',
        ])
      }
      return cannot('A template is rendered here, but this line does not show caller text reaching the template source.', check, [
        'Whether the source is a file or a string.',
      ])
    }

    /* ── Recon: a map, not a claim. It is never "confirmed" as a bug. ── */
    case 'recon': {
      return cannot('Recon reports a map, not a defect. There is nothing here to confirm as a bug — the map is the output.', 'Listed the entry points and their guards.', [
        'Which routes are reachable without authentication.',
        'Which of them read a request value and pass it onward.',
      ])
    }

    default:
      return cannot('No independent check exists for this class yet, so the item cannot be confirmed.', 'No check available.', [])
  }
}

/**
 * Apply the validator to a hypothesis. A hypothesis whose verdict is not
 * `confirmed-observable` is marked dropped, and stays in the record as dropped.
 */
export function applyValidation(h: Hypothesis, material: string): Hypothesis {
  const verdict = validate({
    specialist: h.specialist,
    line: h.line,
    excerpt: h.excerpt,
    material,
    location: h.location,
  })
  const state = verdict.outcome === 'confirmed-observable' ? 'hypothesis' : 'dropped'
  return { ...h, validation: verdict, state }
}
