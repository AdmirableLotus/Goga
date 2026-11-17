import type { Specialist, SpecialistId } from '../../../../shared/grimoire'

/**
 * The specialist reviewers.
 *
 * Each entry is a line of reasoning per vulnerability class, modelled on BountyGrimoire's
 * taxonomy (18 hunters, one class each). What changed in the reimplementation: a specialist
 * here ARGUES, it does not act. It is given code or a page description, it says what it would
 * look for and why, and it names the observable on the user's own local copy that would make
 * the thing real. It has no network client, no payload list and no way to send anything.
 *
 * `signals` are read-only regular expressions over the supplied material. They exist to point
 * a human at a line worth reading — the same job a compiler warning does. A match is not a
 * bug; several of these patterns fire on perfectly correct code, and the validator's whole
 * purpose is to separate those cases.
 *
 * `wouldConfirm` is deliberately about the LOCAL copy: a line in the file, a value in a
 * config, a test the user can run on their own machine. A specialist that can only say
 * "send this and see" has not done its job here.
 */

export const SPECIALISTS: Specialist[] = [
  {
    id: 'idor',
    name: 'IDOR / BOLA',
    bugClass: 'An object is fetched or changed by an identifier the caller supplies, without checking that this caller may touch that object.',
    looksFor: [
      'A route, AJAX action or REST callback that takes an id, slug or key straight from the request and hands it to a data call.',
      'A permission check that tests "is logged in" instead of "is this their object".',
      'A capability check placed before the object is even looked up, so it cannot be about this object.',
      'A REST permission_callback that returns true, or checks a nonce, where it should check ownership.',
    ],
    signals: [
      { label: 'id from request', pattern: '\\$_(GET|POST|REQUEST)\\s*\\[\\s*[\'"](id|post_id|user_id|comment_id|attachment_id|term_id|object_id)[\'"]', why: 'an identifier arrives from the caller and is used by name' },
      { label: 'REST permission callback', pattern: 'permission_callback', why: 'the REST permission gate is where BOLA lives or dies' },
      { label: 'permissive check', pattern: '__return_true|is_user_logged_in\\(\\)\\s*\\?', why: 'a login check is not an ownership check' },
      { label: 'direct get by id', pattern: '(get_post|get_user_by|get_comment|get_term|wp_get_attachment)\\s*\\(', why: 'the object is fetched by a caller-supplied value' },
      { label: 'nonce only', pattern: 'check_ajax_referer|wp_verify_nonce', why: 'a nonce proves intent, never entitlement' },
      { label: 'id from request (js)', pattern: 'req\\.(params|query|body)\\.(id|userId|user_id|accountId|account_id|orderId|order_id|invoiceId|invoice_id|uuid|_id)\\b', why: 'an identifier arrives from the caller (Express/Node)' },
      { label: 'fetch by caller id (js)', pattern: '\\.(findById|findByPk|findOne|get|load|retrieve)\\s*\\(\\s*req\\.(params|query|body)', why: 'the object is fetched straight from a caller-supplied id, with no ownership test in the call' },
      { label: 'id from request (py)', pattern: 'request\\.(args|form|json|values|GET|POST)[\\.\\[][^\\n]{0,40}(id|user_id|account_id|order_id|pk)', why: 'an identifier arrives from the caller (Flask/Django)' },
      { label: 'orm get by pk (py)', pattern: '\\.objects\\.(get|filter)\\s*\\(\\s*(pk|id)\\s*=|get_object_or_404\\s*\\(', why: 'a record is fetched by primary key — check it is also scoped to the requesting user' },
    ],
    wouldConfirm: [
      'Two accounts of your own on the local copy, each owning one object.',
      'The handler that reads the identifier, and the line where it decides whether this caller may see it.',
      'The absence of a capability or ownership test between the read and the return.',
      'A local run showing account A receives account B\'s object.',
    ],
    standDown: [
      'The object is public by design (a published post on a public blog).',
      'The identifier is looked up together with the current user in the same query.',
      'The handler is unreachable without an admin session you cannot get.',
    ],
  },
  {
    id: 'ssrf',
    name: 'SSRF',
    bugClass: 'A URL the caller controls is fetched by the server, so the server itself makes a request the caller chose.',
    looksFor: [
      'An outbound fetch whose address comes from a parameter, a stored setting or a remote response.',
      'A fetch helper that builds a URL from pieces without re-validating the final host.',
      'A redirect that is followed, which turns one allowed address into any address.',
      'A host allow-list that is checked before DNS resolution, or with a substring test.',
    ],
    signals: [
      { label: 'outbound request', pattern: 'wp_remote_(get|post|request|head)|curl_exec|file_get_contents\\s*\\(\\s*[\'"]https?', why: 'the server makes an outbound request here' },
      { label: 'url from input', pattern: '\\$_(GET|POST|REQUEST)\\s*\\[\\s*[\'"](url|uri|link|target|redirect|host|dest|src)[\'"]', why: 'the destination comes from the caller' },
      { label: 'redirect following', pattern: 'redirection\\s*=>\\s*[1-9]|CURLOPT_FOLLOWLOCATION|CURLOPT_FOLLOW', why: 'following redirects widens the reachable address space' },
      { label: 'weak host check', pattern: 'strpos\\([^,]+,\\s*\\$[a-z_]*host|str_contains\\([^,]+,\\s*\\$[a-z_]*host', why: 'a substring test on a host is bypassable' },
      { label: 'private-address guard', pattern: '127\\.0\\.0\\.1|169\\.254\\.169\\.254|is_private|FILTER_FLAG_NO_PRIV_RANGE', why: 'the code knows about private addresses — check what it does with them' },
      { label: 'outbound fetch from input (js)', pattern: '(fetch|axios\\.(get|post|put|request)|got|superagent|http\\.(get|request)|https\\.(get|request))\\s*\\(\\s*[^)]{0,80}(req\\.(params|query|body)|\\$\\{|\\+)', why: 'the server fetches a URL built from caller input (Node)' },
      { label: 'outbound request from input (py)', pattern: 'requests\\.(get|post|put|request|head)\\s*\\([^)]{0,80}(request\\.|\\+|%|\\.format|f[\'"])|urllib\\.request\\.urlopen\\s*\\(', why: 'the server fetches a URL built from caller input (Python requests/urllib)' },
    ],
    wouldConfirm: [
      'The line where the URL is read, and the line where it is fetched, with nothing that re-resolves the host between them.',
      'Whether redirect following is enabled.',
      'Whether the validation runs on the raw string or on the parsed host after resolution.',
      'A local test against a listener on your own machine (never a third party) showing where the request actually goes.',
    ],
    standDown: [
      'The address is a constant, or built only from server-side configuration.',
      'The code validates the parsed host against an exact allow-list after resolution and disables redirects.',
      'The fetch is of a fixed first-party origin with no caller-influenced part.',
    ],
  },
  {
    id: 'sqli',
    name: 'SQL injection',
    bugClass: 'Caller-supplied text reaches a SQL string without being bound as a parameter.',
    looksFor: [
      'A query built by interpolation or concatenation rather than through the prepare/placeholder path.',
      'A prepared statement where the placeholder is filled from a variable that was itself interpolated earlier.',
      'An identifier (table, column) interpolated because placeholders cannot carry identifiers — the classic safe-looking hole.',
      'An escaping call applied to the wrong layer, or applied then undone.',
    ],
    signals: [
      { label: 'query interpolation', pattern: `(SELECT|INSERT|UPDATE|DELETE|WHERE|ORDER BY)[^'"\\n]{0,80}(\\.\\s*\\$|\\$[a-zA-Z_]+\\s*\\.)`, why: 'a SQL keyword sits next to a concatenated variable' },
      { label: 'prepare then interpolate', pattern: '(prepare|esc_sql)\\s*\\(', why: 'preparation is the right tool — check what goes into it' },
      { label: 'double query', pattern: '\\$wpdb->(query|get_results|get_var|get_row)\\s*\\(\\s*\\$[a-z_]', why: 'a variable is passed straight to the query method' },
      { label: 'concatenated wpdb query', pattern: `\\$wpdb->(query|get_results|get_var|get_row|get_col)\\s*\\([^)]*["']\\s*\\.\\s*\\$`, why: 'a variable is concatenated into the SQL string passed to wpdb, instead of $wpdb->prepare with a placeholder' },
      { label: 'interpolated identifier', pattern: `ORDER BY\\s+\\$|LIMIT\\s+\\$|FROM\\s+\\$wpdb->|->prefix[^'"]*\\$`, why: 'identifiers cannot be bound, so they are the usual hole' },
      { label: 'sanitise not bind', pattern: 'esc_sql|intval|absint', why: 'sanitising is not the same as binding — check the value still reaches the query' },
      { label: 'sql interpolation (js/py)', pattern: `(SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)[^;\\n]{0,100}(\\$\\{|"\\s*\\+|'\\s*\\+|%s|%d|\\.format\\s*\\()`, why: 'a SQL keyword sits next to a template literal, string concatenation, %-format or .format instead of a bound parameter' },
      { label: 'cursor.execute built string (py)', pattern: `cursor\\.execute\\s*\\(\\s*(f['"]|[^,)\\n]{0,120}(%|\\.format\\s*\\(|['"]\\s*\\+))`, why: 'a Python DB query built with an f-string, %, .format or concatenation rather than a parameter tuple' },
      { label: 'raw query (js orm)', pattern: `\\.(query|raw|\\$queryRawUnsafe)\\s*\\(\\s*['"\`][^'"\`]{0,120}(SELECT|INSERT|UPDATE|DELETE)`, why: 'a raw SQL string in a Node ORM — check it is parameterised, not concatenated' },
    ],
    wouldConfirm: [
      'The exact statement, and the preparation call that should have bound the value.',
      'Whether the value is bound as a parameter or placed into the string.',
      'If it is an identifier, whether it is compared against a fixed list before use.',
      'A local run against your own copy where a parameter changes the query\'s shape.',
    ],
    standDown: [
      'Every variable in the statement is a bound placeholder.',
      'The interpolated value comes from a fixed array defined in the same file.',
      'The value is cast to an integer before it is used and the cast is the only path.',
    ],
  },
  {
    id: 'xss',
    name: 'XSS',
    bugClass: 'Text from one party is written into a page or attribute such that another party\'s browser executes it.',
    looksFor: [
      'Output written into HTML with no escaping, or escaped for the wrong context (attribute vs text vs script).',
      'A stored value echoed in an admin screen — the admin\'s own session is the target.',
      'A JavaScript sink: innerHTML, document.write, a template string put into markup, eval of a page value.',
      'An escaper applied before a transform that re-introduces the dangerous characters.',
    ],
    signals: [
      { label: 'unescaped echo', pattern: 'echo\\s+\\$[a-zA-Z_]|print\\s+\\$[a-zA-Z_]', why: 'a variable is written to output without an escaping call' },
      { label: 'js sink', pattern: 'innerHTML\\s*=|outerHTML\\s*=|document\\.write\\s*\\(|\\.insertAdjacentHTML', why: 'this sink parses markup' },
      { label: 'correct escaper nearby', pattern: 'esc_html|esc_attr|esc_url|wp_kses', why: 'the file knows the escapers — check which outputs skip them' },
      { label: 'attribute context', pattern: 'value=\\\\?"?\\s*<\\?php|\\$[a-zA-Z_]+\\s*=\\\\?\\s*[\'"]' , why: 'markup is being assembled by hand, where context is easy to lose' },
      { label: 'admin screen output', pattern: 'add_(menu|submenu|meta_box)_page|admin_notices|esc_html_e', why: 'output rendered in an admin context' },
      { label: 'html response from input (js)', pattern: 'res\\.(send|write|end)\\s*\\([^)]{0,120}(req\\.(params|query|body)|\\$\\{|\\+)', why: 'a response body is built from request data without an escaping call (Express)' },
      { label: 'raw html sink (framework)', pattern: 'dangerouslySetInnerHTML|v-html|mark_safe|render_template_string|\\|\\s*safe\\b', why: 'a framework escape hatch that renders raw, unescaped HTML (React / Vue / Jinja |safe / Django mark_safe)' },
      { label: 'template literal into markup (js)', pattern: '(innerHTML|outerHTML)\\s*[+]?=\\s*[`\'"]|\\.html\\s*\\(\\s*[`\'"][^`\'"]*\\$\\{', why: 'markup assembled from a template literal or jQuery .html() with interpolation' },
    ],
    wouldConfirm: [
      'The line that writes the value out, and the escaping call it does not have.',
      'Which context it lands in: element text, an attribute, an event handler, or a script block.',
      'Whether the value is stored or reflected, and who supplies it.',
      'A local copy where your own marker appears unescaped in the rendered page source.',
    ],
    standDown: [
      'The output is passed through the escaper for its exact context.',
      'The value is a constant from the code, not from any input.',
      'The value is written into a text node through textContent, not parsed as markup.',
    ],
  },
  {
    id: 'auth',
    name: 'Auth / session',
    bugClass: 'Authentication or session state can be bypassed, fixed, replayed or escalated.',
    looksFor: [
      'A comparison of secret material with == rather than a constant-time check.',
      'Session state trusted from a cookie or parameter without a signature check.',
      'A login path where a failed condition continues into the authenticated branch.',
      'A role or capability granted from user-supplied input.',
      'A password reset or token flow that does not bind the token to the account and an expiry.',
    ],
    signals: [
      { label: 'loose comparison', pattern: '==\\s*\\$(password|token|hash|secret|key|nonce)|\\$(password|token|hash|secret|key|nonce)\\s*==', why: 'loose comparison on secret material' },
      { label: 'token compare', pattern: 'hash_equals|wp_check_password|password_verify', why: 'the safe comparison exists — check whether every path uses it' },
      { label: 'capability from input', pattern: '\\$_(GET|POST|REQUEST)\\s*\\[\\s*[\'"](role|cap|capability|level|is_admin)[\'"]', why: 'privilege named by the caller' },
      { label: 'session from cookie', pattern: '\\$_COOKIE\\s*\\[|setcookie\\s*\\(', why: 'state read from a caller-controlled cookie' },
      { label: 'early auth return', pattern: 'wp_set_auth_cookie|wp_signon|auth_redirect', why: 'where a session is created or trusted' },
    ],
    wouldConfirm: [
      'The exact comparison, and whether both sides are the same shape (a hash against a hash).',
      'What happens on the failure branch — does it return, or fall through?',
      'Whether the token is bound to one account and one expiry.',
      'A local run where a wrong value still reaches the authenticated branch.',
    ],
    standDown: [
      'The comparison uses hash_equals or password_verify on a real hash.',
      'The failure branch returns unconditionally.',
      'The value cannot be reached before the session is established.',
    ],
  },
  {
    id: 'rce',
    name: 'RCE / code injection',
    bugClass: 'Caller-influenced data becomes code: a PHP include, an eval, a command, a deserialised object.',
    looksFor: [
      'eval, assert with a string, create_function, preg_replace with /e, backticks, shell_exec, system, popen.',
      'include or require with a variable path.',
      'unserialize on data that came from outside.',
      'A file written whose name or contents are partly caller-controlled.',
    ],
    signals: [
      { label: 'code execution', pattern: '\\b(eval|assert)\\s*\\(|create_function\\s*\\(|shell_exec|system\\s*\\(|passthru|popen\\s*\\(|proc_open', why: 'this call executes' },
      { label: 'variable include', pattern: '(include|require)(_once)?\\s*\\(?\\s*\\$', why: 'the included path is a variable' },
      { label: 'deserialise', pattern: '\\bunserialize\\s*\\(|maybe_unserialize\\s*\\(', why: 'deserialising untrusted data can construct objects with side effects' },
      { label: 'write file', pattern: 'file_put_contents|fwrite\\s*\\(|move_uploaded_file', why: 'a file is written — check who controls the name and the bytes' },
      { label: 'regex eval', pattern: 'preg_replace\\s*\\(\\s*[\'"][^\'"]*/e', why: 'the /e modifier evaluates the replacement as code' },
      { label: 'command exec (js)', pattern: '(child_process|exec(Sync)?\\s*\\(|execFile(Sync)?\\s*\\(|spawn(Sync)?\\s*\\(|\\beval\\s*\\(|new\\s+Function\\s*\\(|vm\\.runIn)', why: 'a command or code string is executed (Node) — check for caller influence' },
      { label: 'command exec (py)', pattern: 'os\\.(system|popen)\\s*\\(|subprocess\\.(call|run|Popen|check_output)\\s*\\([^)]{0,120}(shell\\s*=\\s*True|\\+|%|\\.format|f[\'"])|\\bexec\\s*\\(|\\beval\\s*\\(|pickle\\.loads\\s*\\(|yaml\\.load\\s*\\((?![^)]*Loader)', why: 'a command, code or unsafe deserialisation is executed (Python) — check for caller influence' },
    ],
    wouldConfirm: [
      'The call, and the chain from an outside value to its argument, with every hop named.',
      'Whether any escaping, allow-list or type cast sits in that chain.',
      'For a file write: who controls the filename, and whether the extension is forced.',
      'A local copy where the code path can be reached at all without an already-privileged session.',
    ],
    standDown: [
      'The argument is a constant or an internal value.',
      'The value passes through an exact allow-list immediately before the call.',
      'The reachability needs a capability that already implies full control of the site.',
    ],
  },
  {
    id: 'xxe',
    name: 'XXE',
    bugClass: 'An XML parser resolves external entities, so a document can read files or make requests.',
    looksFor: [
      'An XML parse of caller-supplied text where external entity loading is not disabled.',
      'A parser constructed without LIBXML_NONET or without disabling entity substitution.',
      'An RSS/OPML/SVG/WXR import that accepts a document from a lower-privileged user.',
    ],
    signals: [
      { label: 'xml parse', pattern: 'simplexml_load_string|DOMDocument|xml_parse|loadXML|\\bXMLReader\\b', why: 'an XML parser is involved' },
      { label: 'entity flags', pattern: 'LIBXML_NOENT|LIBXML_NONET|libxml_disable_entity_loader|resolveExternals|substituteEntities', why: 'entity handling is configured here — check the direction' },
      { label: 'import path', pattern: 'import|upload|feed|rss|opml|wXR', why: 'a document arrives from outside' },
    ],
    wouldConfirm: [
      'The parser construction, and whether external entities are disabled.',
      'Whether the parsed document came from a caller.',
      'Whether PHP\'s libxml version defaults entities on for this build.',
      'A local run where your own local XML file with an external entity is or is not resolved.',
    ],
    standDown: [
      'The parser disables entity loading and network access explicitly.',
      'The XML is generated inside the application, not received.',
      'The import requires a capability that already allows code execution.',
    ],
  },
  {
    id: 'ssti',
    name: 'SSTI',
    bugClass: 'Caller text is compiled as a template, so template syntax executes server-side.',
    looksFor: [
      'A template evaluated from a string that includes caller input.',
      'A templating call where the template body, not just the variables, is dynamic.',
      'A shortcode or block render that concatenates user text into the template source.',
    ],
    signals: [
      { label: 'dynamic template', pattern: 'render_template|Twig|new\\s+Twig|->render\\s*\\(\\s*\\$|sprintf\\s*\\(\\s*\\$[a-z_]*tpl', why: 'a template is rendered from a variable' },
      { label: 'template from input', pattern: '\\$_(GET|POST|REQUEST)\\s*\\[\\s*[\'"](tpl|template|layout|format)[\'"]', why: 'the template body comes from the caller' },
      { label: 'shortcode render', pattern: 'do_shortcode|render_block|add_shortcode', why: 'a rendering path that may re-parse text as markup or template' },
    ],
    wouldConfirm: [
      'Whether the template SOURCE is dynamic or only its data is.',
      'The call that parses it, and whether caller text can reach the source.',
      'A local run where your own marker inside template syntax is evaluated or printed literally.',
    ],
    standDown: [
      'Only the template variables come from the caller; the source is a file.',
      'The renderer is an escaper that never evaluates.',
      'The path requires an administrator who can already edit templates.',
    ],
  },
  {
    id: 'secrets',
    name: 'Secrets exposure',
    bugClass: 'A credential, key or token is committed, logged, returned or written where the wrong party can read it.',
    looksFor: [
      'A hard-coded key, password or token in source.',
      'A secret written into a log line, an error message or an API response.',
      'A debug dump that includes configuration or request headers.',
      'A secret in a URL or query string, which lands in logs and referrers.',
    ],
    signals: [
      { label: 'literal key', pattern: '(api[_-]?key|secret|password|passwd|token|private[_-]?key)\\s*[=:]\\s*[\'"][^\'"]{8,}', why: 'a literal credential-shaped assignment' },
      { label: 'logging', pattern: 'error_log\\s*\\(|trigger_error\\s*\\(|var_dump|print_r\\s*\\(\\s*\\$', why: 'a value is written into a log or debug output' },
      { label: 'secret in response', pattern: 'wp_send_json|\\.\\.\\.\\s*\\$(config|settings|options)', why: 'configuration is flowing toward a response' },
      { label: 'debug flag', pattern: 'WP_DEBUG|SCRIPT_DEBUG|display_errors', why: 'a debug switch decides what is exposed' },
    ],
    wouldConfirm: [
      'The exact line holding the value, and whether it is a real credential or an empty placeholder.',
      'Whether the value is a documented test constant shipped on purpose.',
      'For a log or response: who can read that sink, and whether a real user secret reaches it.',
      'A local search showing the same value is not an obvious sample.',
    ],
    standDown: [
      'The value is an empty string, a placeholder, or a documented sample constant.',
      'The "secret" is a public identifier (a client id, a public key) with no signing power.',
      'The dump is behind WP_DEBUG and only on a developer\'s own machine.',
    ],
  },
  {
    id: 'otp',
    name: 'OTP / token logic',
    bugClass: 'A one-time value is guessable, reusable, never expires, or is not bound to the account it was issued for.',
    looksFor: [
      'A short numeric code with no attempt counter and no expiry.',
      'A reset token compared without binding it to the account.',
      'A token kept in a place that survives its use.',
      'A comparison that accepts a partial or empty value.',
    ],
    signals: [
      { label: 'otp generation', pattern: 'mt_rand|rand\\s*\\(|wp_rand|random_int', why: 'how the code is produced decides whether it can be guessed' },
      { label: 'attempt counter', pattern: '(attempt|tries|retry|throttle|rate_limit)', why: 'a counter is the usual guard — check it is enforced' },
      { label: 'expiry', pattern: '(expire|expiry|expires|ttl|valid_until)', why: 'expiry is claimed here — check it is compared' },
      { label: 'token compare', pattern: '\\$(code|otp|token)\\s*===?\\s*\\$', why: 'a one-time value is compared — check both sides and binding' },
    ],
    wouldConfirm: [
      'How the code is generated (a CSPRNG, or a predictable generator).',
      'Whether an attempt counter is enforced server-side, and what happens at the limit.',
      'Whether the token carries the account it was issued for, and an expiry that is actually compared.',
      'A local run showing the same code accepted twice.',
    ],
    standDown: [
      'The generator is a CSPRNG and the token is bound to the account with a short expiry.',
      'An attempt counter is enforced before the comparison.',
      'The flow cannot be started without an existing verified session.',
    ],
  },
  {
    id: 'pii',
    name: 'PII exposure',
    bugClass: 'Personal data is returned to, or shown to, a party who should not have it.',
    looksFor: [
      'An endpoint that returns email, address, phone or IP to a caller who is not the data subject.',
      'A list endpoint that includes fields it does not need.',
      'An export that ignores the requester\'s entitlement.',
      'Personal data in an error message or a debug page.',
    ],
    signals: [
      { label: 'personal fields', pattern: 'user_email|user_login|billing_|shipping_|phone|address|postcode|date_of_birth', why: 'personal fields are being handled' },
      { label: 'list endpoint', pattern: 'wp_send_json|rest_ensure_response|get_users\\s*\\(|get_posts\\s*\\(', why: 'a collection is being returned — check the fields and the filter' },
      { label: 'export', pattern: 'fputcsv|export|download_csv|Content-Disposition', why: 'an export is produced — check who may export what' },
      { label: 'entitlement check', pattern: 'current_user_can|is_user_logged_in|get_current_user_id', why: 'the entitlement check is here or missing' },
    ],
    wouldConfirm: [
      'The fields actually returned, and whether each is personal data.',
      'The filter that decides which rows are returned, and whether it excludes other people.',
      'Whether the requester is entitled to every row and every field.',
      'A local run with two accounts where one receives the other\'s data.',
    ],
    standDown: [
      'The endpoint returns the caller\'s own record only.',
      'The fields are public by design on a public profile.',
      'The data is aggregated and not attributable to a person.',
    ],
  },
  {
    id: 'logic',
    name: 'Business logic',
    bugClass: 'The code does what it was written to do, but the sequence or the quantities can be abused.',
    looksFor: [
      'A price, quantity, count or quota taken from the request instead of derived.',
      'A multi-step flow where a later step does not re-check the earlier one\'s conditions.',
      'A state change that can be repeated when it was meant to happen once.',
      'A negative, zero or fractional value that the arithmetic accepts.',
    ],
    signals: [
      { label: 'price or amount from input', pattern: '\\$_(GET|POST|REQUEST)\\s*\\[\\s*[\'"](price|amount|total|qty|quantity|count|credits?)[\'"]', why: 'a value with financial meaning comes from the caller' },
      { label: 'arithmetic on input', pattern: '\\*\\s*\\$(qty|quantity|count|price|amount)|\\$(qty|quantity|count|price|amount)\\s*[+\\-*/]', why: 'caller value used in money arithmetic' },
      { label: 'state change', pattern: 'update_option|update_user_meta|wp_insert_post|wp_update_post|set_transient', why: 'persistent state changes here' },
      { label: 'idempotency', pattern: 'already|processed|consumed|used_at', why: 'a once-only guard is claimed — check it holds under repetition' },
    ],
    wouldConfirm: [
      'Where the value should have been derived server-side, and where it is taken from the request instead.',
      'Which step re-checks the earlier state, and what happens if you skip straight to the last step.',
      'What the arithmetic does with zero, a negative number and a fraction.',
      'A local run of your own flow showing the state you did not pay for.',
    ],
    standDown: [
      'Every value with financial meaning is recomputed on the server from stored data.',
      'The flow cannot reach a later state without the earlier one being true.',
      'The only abuse needs an administrator.',
    ],
  },
  {
    id: 'redirect',
    name: 'Callback / open redirect',
    bugClass: 'A destination supplied by the caller is used for a redirect or a callback without an allow-list.',
    looksFor: [
      'wp_redirect, wp_safe_redirect, header Location with a caller-supplied value.',
      'A "return to" or "next" parameter used directly.',
      'A callback URL registered by the user and later fetched without re-validation.',
      'A redirect that happens before an authentication decision.',
    ],
    signals: [
      { label: 'redirect', pattern: 'wp_redirect\\s*\\(|wp_safe_redirect\\s*\\(|header\\s*\\(\\s*[\'"]Location', why: 'a redirect is issued here' },
      { label: 'destination from input', pattern: '\\$_(GET|POST|REQUEST)\\s*\\[\\s*[\'"](redirect_to|return|next|url|callback|continue|dest)[\'"]', why: 'the destination comes from the caller' },
      { label: 'host check', pattern: 'wp_validate_redirect|allowed_redirect_hosts|parse_url\\s*\\(', why: 'validation exists — check it runs on the parsed host' },
      { label: 'string surgery on url', pattern: 'str_replace\\s*\\(|str_contains\\s*\\(|strpos\\s*\\(', why: 'manual string checks on URLs are the usual bypass' },
      { label: 'redirect from input (js)', pattern: 'res\\.redirect\\s*\\([^)]{0,80}(req\\.(params|query|body)|\\$\\{|\\+)', why: 'a redirect destination built from request data (Express)' },
      { label: 'redirect from input (py)', pattern: '(redirect|HttpResponseRedirect)\\s*\\([^)]{0,80}(request\\.|\\+|%|\\.format|f[\'"])', why: 'a redirect destination built from request data (Flask/Django)' },
    ],
    wouldConfirm: [
      'The redirect call and where its destination came from.',
      'Whether the destination is validated with a host allow-list after parsing.',
      'Whether the check is a substring test that a crafted host can satisfy.',
      'A local run where your own local URL receives the redirect.',
    ],
    standDown: [
      'The destination is a constant or built from site configuration.',
      'wp_validate_redirect or allowed_redirect_hosts is applied to the final URL.',
      'The redirect target is your own site\'s fixed path.',
    ],
  },
  {
    id: 'recon',
    name: 'Recon / attack surface mapping',
    bugClass: 'Not a bug class: it maps the surface — entry points, routes, handlers and their entitlements — so the other specialists know where to look.',
    looksFor: [
      'Every registered REST route and what guards it.',
      'Every AJAX action (wp_ajax_ and wp_ajax_nopriv_) and whether the nopriv one is intended.',
      'Every file that takes input directly from $_GET, $_POST or $_REQUEST.',
      'Every shortcode, block and template that renders stored content.',
    ],
    signals: [
      { label: 'rest route', pattern: 'register_rest_route\\s*\\(', why: 'a REST route is registered here' },
      { label: 'ajax action', pattern: 'wp_ajax_(nopriv_)?', why: 'an AJAX handler — nopriv means unauthenticated' },
      { label: 'raw input', pattern: '\\$_(GET|POST|REQUEST|COOKIE|FILES|SERVER)\\s*\\[', why: 'the request is read directly here' },
      { label: 'admin page', pattern: 'add_(menu|submenu|options|management)_page', why: 'an admin screen with its own privilege' },
      { label: 'public entry point', pattern: 'wp_ajax_nopriv_', why: 'reachable without logging in — the highest-value surface' },
    ],
    wouldConfirm: [
      'The list of routes you found and the guard on each.',
      'Which of them are reachable without authentication.',
      'Which read a request value and pass it onward.',
      'A written map you can hand to the other specialists.',
    ],
    standDown: [
      'There is nothing to stand down from: this specialist reports a map, not a bug.',
    ],
  },
  {
    id: 'cors',
    name: 'CORS / exposed admin',
    bugClass: 'A permissive cross-origin policy, or an administrative surface left reachable, lets another origin read what it should not.',
    looksFor: [
      'Access-Control-Allow-Origin echoing the request Origin, especially with credentials.',
      'Access-Control-Allow-Credentials true together with a reflected origin.',
      'An admin or debug endpoint registered without a capability check.',
      'A null-origin allowance.',
    ],
    signals: [
      { label: 'cors header', pattern: 'Access-Control-Allow-(Origin|Credentials|Methods)', why: 'a cross-origin policy is set here' },
      { label: 'origin reflected', pattern: '\\$_SERVER\\s*\\[\\s*[\'"]HTTP_ORIGIN[\'"]', why: 'the request origin is read and may be echoed' },
      { label: 'wildcard origin', pattern: 'Allow-Origin[^\\n]{0,40}\\*', why: 'a wildcard origin is the common permissive case' },
      { label: 'no capability', pattern: 'register_rest_route[\\s\\S]{0,400}?permission_callback[\\s\\S]{0,40}?__return_true', why: 'a route with no permission gate' },
    ],
    wouldConfirm: [
      'The exact header value and whether it is computed from the request.',
      'Whether credentials are allowed with it.',
      'Whether the endpoint behind it requires its own authentication.',
      'A local run with your own two origins on localhost showing what is readable.',
    ],
    standDown: [
      'The origin is matched against an exact allow-list.',
      'The header is a wildcard with no credentials and the response carries no private data.',
      'The endpoint requires authentication that a cross-origin caller cannot supply.',
    ],
  },
  {
    id: 'referer',
    name: 'Referer leakage',
    bugClass: 'A sensitive value travels in a URL, so it reaches third parties through the Referer header, logs and history.',
    looksFor: [
      'A token, key or reset code in a query string.',
      'A page that loads third-party resources while carrying a secret in its own URL.',
      'A logout or action URL with a nonce that is then followed by an external link.',
      'A response that omits Referrer-Policy on a sensitive page.',
    ],
    signals: [
      { label: 'secret in query', pattern: '[?&](token|key|nonce|code|reset|password|secret)=', why: 'a secret-shaped value is in the URL' },
      { label: 'referrer policy', pattern: 'Referrer-Policy|referrerpolicy', why: 'a policy exists — check the sensitive pages have it' },
      { label: 'third-party resource', pattern: 'https?://(?!localhost)[a-z0-9.-]+\\.[a-z]{2,}/[^"\'\\s]*\\.(js|css|png|gif)', why: 'an external resource is loaded from this page' },
      { label: 'nonce in url', pattern: '_wpnonce=', why: 'a nonce travels in the URL' },
    ],
    wouldConfirm: [
      'The exact URL that carries the value, and whether it is a secret or a public nonce.',
      'What the page loads from other origins while that URL is current.',
      'Whether Referrer-Policy is set on that response.',
      'A local look at the request headers your own browser sends from that page.',
    ],
    standDown: [
      'The value in the URL is a public nonce whose leak grants nothing.',
      'The page sets a strict Referrer-Policy and loads nothing external.',
      'The URL is not reachable by a third party.',
    ],
  },
  {
    id: 'integrity',
    name: 'Checksum / integrity',
    bugClass: 'A signature, checksum or webhook MAC is not verified, or is verified in a way that can be satisfied without the key.',
    looksFor: [
      'A webhook handler that acts before checking the signature.',
      'A comparison of MACs with == instead of hash_equals.',
      'A verification that fails open when the key is missing.',
      'A download or update that trusts the payload without a hash.',
    ],
    signals: [
      { label: 'signature check', pattern: 'hash_hmac|hmac|signature|X-Hub-Signature|x-wc-signature', why: 'a signature is computed or checked here' },
      { label: 'fail open', pattern: 'if\\s*\\(\\s*!\\s*\\$[a-z_]*secret\\s*\\)\\s*\\{?\\s*return\\s+true', why: 'a missing key appears to allow the request' },
      { label: 'loose mac compare', pattern: '(mac|signature|digest)\\s*===?\\s*\\$|\\$(mac|signature|digest)\\s*===?', why: 'a MAC comparison — check it is constant-time' },
      { label: 'verify order', pattern: 'wp_remote_retrieve_body|json_decode\\s*\\(\\s*\\$body', why: 'the body is processed — check the signature check came first' },
    ],
    wouldConfirm: [
      'The order: signature check, then processing. Or the other way round.',
      'Whether the comparison is constant-time.',
      'What happens when the secret is unset.',
      'A local run posting to your own copy with a deliberately wrong signature.',
    ],
    standDown: [
      'The handler verifies with hash_equals before reading the body.',
      'A missing secret refuses rather than allows.',
      'The route is not reachable from outside.',
    ],
  },
  {
    id: 'enumeration',
    name: 'Enumeration / timing',
    bugClass: 'Different responses, or measurably different timings, let someone learn which accounts, files or records exist.',
    looksFor: [
      'A login or reset that says "no such user" in one branch and "wrong password" in another.',
      'A user or post lookup that returns 404 for missing and 403 for existing.',
      'A comparison that returns early on the first wrong byte.',
      'A count or length that leaks the size of a hidden collection.',
    ],
    signals: [
      { label: 'distinct error branches', pattern: '(invalid username|no such user|user does not exist|unknown user)', why: 'an error message distinguishes a missing account from a wrong password' },
      { label: 'lookup then branch', pattern: 'get_user_by\\s*\\(|username_exists\\s*\\(|email_exists\\s*\\(', why: 'an existence lookup happens here' },
      { label: 'timing-sensitive compare', pattern: '===?\\s*\\$|hash_equals', why: 'how a comparison is written affects its timing' },
      { label: 'status differs', pattern: 'wp_die\\s*\\(|status_header\\s*\\(\\s*40[34]', why: 'the status code may differ by existence' },
    ],
    wouldConfirm: [
      'The two branches and the exact message or status each returns.',
      "Whether the code path's length differs before the branch.",
      'Whether a rate limit makes the difference unusable in practice.',
      'A local run against your own copy comparing the two responses.',
    ],
    standDown: [
      'Both branches return an identical message and status.',
      'A rate limit makes distinguishing them impractical, and the program treats that as mitigating.',
      'The information revealed is already public.',
    ],
  },
]

export const SPECIALIST_IDS: SpecialistId[] = SPECIALISTS.map(s => s.id)

export function specialistById(id: string): Specialist | null {
  return SPECIALISTS.find(s => s.id === id) ?? null
}

/**
 * The 7-Question Gate.
 *
 * Taken from Agentic-Bug-Hunter's named validation checklist, which is the single most useful
 * idea across the reference repos: before a report is drafted, answer seven questions. A "no"
 * on any of the first four kills the finding outright, and the finding is kept in memory as
 * dead so it is never re-raised.
 *
 * Ordering matters. Question 1 comes first because an unverified item is the one thing
 * WordPress says it will close as spam. Question 2 comes second because out-of-scope work is
 * wasted work, not work.
 */
export const GATE_QUESTIONS = [
  {
    id: 'observed',
    question: 'Did you see it happen yourself, on your own copy?',
    passing: 'You reproduced it: you took a step, and you observed the result with your own eyes.',
    why: 'An unverified item is exactly what a program closes as spam. WordPress says it in writing: "Submitting an unverified report from an automated scan or AI agent is not acceptable."',
  },
  {
    id: 'scope',
    question: 'Is the thing you touched inside the program\'s scope, by its own words?',
    passing: 'The asset is listed as eligible, and the program has not excluded this technique.',
    why: 'Out-of-scope work earns nothing and can get the account banned.',
  },
  {
    id: 'attacker',
    question: 'Can an attacker do this right now, starting from where they really start?',
    passing: 'You can name the starting position (no account, any account, a low-privilege account) and the steps from there.',
    why: 'A bug that needs an administrator who can already edit code is not a vulnerability, it is a feature of being the administrator.',
  },
  {
    id: 'impact',
    question: 'Can you say the concrete impact in one sentence, naming what the attacker gains?',
    passing: '"An unauthenticated visitor can read any user\'s email address" — a specific gain, not "security risk".',
    why: 'Impact first. A triager decides on impact; if you cannot state it, the finding is not ready.',
  },
  {
    id: 'evidence',
    question: 'Do you have the evidence that proves it, in a form someone else can follow?',
    passing: 'Exact steps, exact requests, exact observed output — reproducible by a stranger with your instructions.',
    why: 'Without evidence it is a hypothesis. A hypothesis is fine to hold; it is not fine to submit.',
  },
  {
    id: 'five',
    question: 'Was the whole check short — around five minutes — once you knew where to look?',
    passing: 'Yes. If not, you are still exploring, and exploring is fine; just do not call it a finding yet.',
    why: 'The five-minute rule keeps a session honest: a check that takes two hours is a project, and usually means the understanding is not there yet.',
  },
  {
    id: 'disclose',
    question: 'Have you decided how you will disclose that AI helped?',
    passing: 'You know what Goga did (read code, argue, draft) and you will say so in the report.',
    why: 'WordPress requires it: "you must disclose what tooling you are using and to what extent a report has been authored by AI."',
  },
] as const

export type GateQuestionId = typeof GATE_QUESTIONS[number]['id']

/**
 * Reasons a specialist must stand down before it even argues. These are checked against the
 * supplied material and, when one applies, the specialist says so instead of producing a
 * hypothesis — a reviewer that cannot say "this is not what I look for" is a noise generator.
 */
export const STANDDOWN_NOTE = 'A specialist that cannot stand down is a noise generator.'
