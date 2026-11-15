import type { KbCitation, KnowledgeBase, KnowledgeEntry, SpecialistId } from '../../../../shared/grimoire'

/**
 * The disclosure-derived knowledge base.
 *
 * Every entry here is drawn from a PUBLICLY DISCLOSED HackerOne report on the WordPress
 * program, read through HackerOne's own read-only API. Each entry carries the report id, the
 * report's own title, its severity and CWE as the API reports them, and a link.
 *
 * What this file deliberately does NOT contain: payloads, request bodies, or a summary of a
 * report body. HackerOne's API returns report METADATA (title, CWE, severity, disclosure
 * date) and not the body, and the report pages themselves would not render for a signed-out
 * read. So every entry says `bodyUnread: true` and draws only on what the title and the CWE
 * actually state. Where a title is all we have, the entry says so rather than inventing the
 * mechanism — that is the difference between a knowledge base and a plausible-sounding one.
 *
 * The HuggingFace HackerOne transparency dataset that BountyGrimoire cites was not reachable
 * from this machine, so nothing here is drawn from it. That is stated in `sources` rather
 * than quietly omitted.
 */

const H1 = 'https://hackerone.com/reports/'

function cite(reportId: string, title: string, severity: string | null, cwe: string | null, disclosed: string | null): KbCitation {
  return { reportId, title, severity, cwe, disclosed, url: `${H1}${reportId}`, bodyUnread: true }
}

const entries: KnowledgeEntry[] = [
  {
    id: 'kb-xss-stored-admin',
    specialist: 'xss',
    bugClass: 'Stored XSS reaching an administrator',
    what: 'A lower-privileged user stores text that is later rendered unescaped in an admin screen. The victim is the administrator, so the impact is usually privilege escalation rather than a defaced page.',
    fix: 'Escape at the point of output for the exact context (esc_html for text, esc_attr for attributes, esc_url for URLs), and never assemble markup by hand from stored values.',
    citations: [
      cite('3931771', 'Author → stored XSS in wp-admin: unescaped sub-size filename from attachment metadata breaks out of the `src`', 'Critical', 'Cross-site Scripting (XSS) - Stored', '2026-08-28'),
      cite('4100259', 'Stored XSS in the Classic block element path', 'None', 'Cross-site Scripting (XSS) - Stored', '2026-11-11'),
      cite('497724', 'Stored XSS in Post Preview as Contributor', 'Medium', 'Cross-site Scripting (XSS) - Stored', '2020-08-18'),
      cite('509930', 'Potential unprivileged Stored XSS through wp_targeted_link_rel', 'High', 'Cross-site Scripting (XSS) - Stored', '2020-01-08'),
    ],
    limit: 'Titles and CWE only. The report bodies were not readable, so the exact sink in each case is not stated here.',
  },
  {
    id: 'kb-xss-dom',
    specialist: 'xss',
    bugClass: 'DOM-based XSS',
    what: 'The server sends a page that is safe, and the page\'s own JavaScript then writes a value from the URL into the document. Nothing appears in the server response, which is why a response-body check alone misses it.',
    fix: 'Use textContent rather than innerHTML for values that came from the URL, and validate the URL parameter against an allow-list before it reaches any sink.',
    citations: [
      cite('3863343', 'DOM-based XSS in playground.wordpress.net (/scope:*/wp-includes/empty.html) lets any attacker run JavaScript on the origin via a single crafted link', 'Low', 'Cross-site Scripting (XSS) - DOM', '2026-11-11'),
      cite('1238528', 'wp-embed XSS on Safari', 'Medium', 'Cross-site Scripting (XSS) - DOM', '2023-07-01'),
      cite('3878399', 'Large-site Quick Edit reparses a Contributor display name into active HTML', 'Medium', 'Cross-site Scripting (XSS) - DOM', '2026-10-21'),
    ],
    limit: 'Titles and CWE only. The specific sink is not stated here because the body was not readable.',
  },
  {
    id: 'kb-xss-kses-bypass',
    specialist: 'xss',
    bugClass: 'Sanitiser bypass',
    what: 'The escaping or filtering function is present and is called, but a crafted encoding slips past it. This is the class that punishes "there is an escaper on that line" as a reason to stand down.',
    fix: 'Fix the sanitiser itself, and add the crafted encoding to its test suite so the bypass cannot return.',
    citations: [
      cite('339483', '"Bad Protocols Validation" Bypass in "wp_kses_bad_protocol_once" using HTML-encoding without trailing semicolons', 'Medium', 'Cross-site Scripting (XSS) - Generic', '2019-11-16'),
      cite('179695', 'XSS via unicode characters in upload filename', 'Medium', 'Cross-site Scripting (XSS) - Generic', '2020-08-28'),
    ],
    limit: 'Titles and CWE only. The exact encoding used is not reproduced here.',
  },
  {
    id: 'kb-sqli-prepare',
    specialist: 'sqli',
    bugClass: 'SQL injection through a misused prepare',
    what: 'The code calls the preparation function, so it looks safe, but the value is placed into the statement rather than bound to a placeholder. The presence of `prepare` is not evidence of safety.',
    fix: 'Bind every value as a placeholder argument. For identifiers, which cannot be bound, compare against a fixed list before use.',
    citations: [
      cite('179920', 'WordPress DB Class, bad implementation of prepare method guides to sqli and information disclosure', 'Critical', 'SQL Injection', '2017-11-13'),
    ],
    limit: 'Title and CWE only. The report body was not readable, so the exact misuse is not described here.',
  },
  {
    id: 'kb-path-traversal',
    specialist: 'rce',
    bugClass: 'Path traversal leading to file deletion or write',
    what: 'A filename or path from the caller is joined to a base directory without normalising it, so `..` escapes the intended folder. Deletion and write are the two outcomes that turn this into site takeover.',
    fix: 'Resolve the final path and confirm it is still inside the intended directory before touching the filesystem; reject any path containing a traversal segment.',
    citations: [
      cite('3931777', 'Author → arbitrary file deletion anywhere on disk (site takeover) via `POST /wp/v2/media/<id>/finalize` poison', 'Critical', 'Path Traversal', '2026-08-28'),
      cite('291878', 'Arbitrary file deletion in wp-core - guides towards RCE and information disclosure', 'Critical', 'Path Traversal', '2018-08-29'),
      cite('436928', 'RCE as Admin defeats WordPress hardening and file permissions', 'Critical', 'Path Traversal', '2020-06-09'),
      cite('183568', '[Buddypress] Arbitrary File Deletion through bp_avatar_set', 'High', null, '2017-08-22'),
    ],
    limit: 'Titles and CWE only. The traversal sequence itself is not reproduced.',
  },
  {
    id: 'kb-ssrf',
    specialist: 'ssrf',
    bugClass: 'Server-side request forgery',
    what: 'The server fetches an address the caller chose. The interesting part is rarely the fetch itself; it is what the server can reach that the caller cannot — internal services, metadata endpoints, other tenants.',
    fix: 'Resolve the host, check the resolved address against a deny-list of private and link-local ranges, and disable redirect following for caller-supplied URLs.',
    citations: [
      cite('187520', 'Wordpress 4.7 - CSRF -> HTTP SSRF any private ip:port and basic-auth', 'High', 'Cross-Site Request Forgery (CSRF)', '2017-11-20'),
    ],
    limit: 'Title and CWE only. The report body was not readable.',
  },
  {
    id: 'kb-access-control',
    specialist: 'idor',
    bugClass: 'Broken object-level access control',
    what: 'The endpoint is reachable and the caller is authenticated, but the object is chosen by the caller and never checked against them. This is the most common real bug class in WordPress-adjacent code, and the one a beginner can actually find by reading.',
    fix: 'Check entitlement against the specific object, not against "is logged in". In REST, that means a permission_callback that loads the object and tests the caller against it.',
    citations: [
      cite('4152553', 'Unauthenticated Disclosure of Private, Draft, and Password-Protected Post Content via Core Read-Permission Bypass in SCF Reference Fields', 'High', 'Information Disclosure', '2026-11-05'),
      cite('4029867', 'WordCamp Meta gpre: password-protected event RSVP list readable without password via /gpre/v1/.../rsvp-responses', 'Medium', 'Improper Access Control - Generic', '2026-11-05'),
      cite('3871816', 'Unauthenticated private CSV export of Meetup organizer PII via broken authz check in WordCamp Reports', 'High', 'Improper Access Control - Generic', '2026-11-05'),
      cite('282176', 'Unauthenticated hidden groups disclosure via Ajax groups search', 'Medium', 'Improper Access Control - Generic', '2017-11-02'),
      cite('837256', 'Improper Access Control in Buddypress core allows reply,delete any user\'s activity', 'Medium', 'Improper Access Control - Generic', '2020-05-22'),
      cite('490782', 'Mssing Authorization on Private Message replies (BuddyPress)', 'Low', 'Improper Access Control - Generic', '2019-03-08'),
    ],
    limit: 'Titles and CWE only. The exact handler in each case is not stated here.',
  },
  {
    id: 'kb-priv-esc',
    specialist: 'auth',
    bugClass: 'Privilege escalation',
    what: 'A lower role can reach a capability it should not have, usually through a REST route, an AJAX action or a role-assignment path that trusts a value from the request.',
    fix: 'Check the capability at the point of the action, and validate any role or capability name against the roles the current user is allowed to assign.',
    citations: [
      cite('1107282', 'Privilege Escalation via REST API to Administrator leads to RCE', 'High', 'Privilege Escalation', '2021-05-17'),
      cite('3942522', 'wordpress.org Rosetta: invite stores unvalidated role — Editor can assign site Administrator despite editable_roles', 'High', 'Improper Access Control - Generic', '2026-11-05'),
      cite('837018', 'Privilege Escalation in BuddyPress core allows Moderate to Administrator', 'Medium', null, '2020-05-22'),
      cite('833782', 'Allow authenticated users can edit, trash,and add new in BuddyPress Emails function', 'Medium', 'Privilege Escalation', '2020-05-22'),
      cite('538008', 'Add users to groups who have restricted group invites', 'High', 'Improper Access Control - Generic', '2019-07-27'),
    ],
    limit: 'Titles and CWE only. The report bodies were not readable.',
  },
  {
    id: 'kb-csrf',
    specialist: 'auth',
    bugClass: 'Cross-site request forgery',
    what: 'A state-changing action has no nonce, or checks one that a third-party page can satisfy. The impact is whatever the action does, performed as the victim.',
    fix: 'Require and verify a nonce on every state-changing request, and check the capability as well — a nonce proves intent, not entitlement.',
    citations: [
      cite('836187', 'CSRF in Profile Fields allows deleting any field in BuddyPress', 'Medium', 'Cross-Site Request Forgery (CSRF)', '2020-05-22'),
      cite('881855', 'Arbitrary change of blog\'s background image via CSRF', 'Medium', 'Cross-Site Request Forgery (CSRF)', '2020-12-14'),
      cite('153093', 'WordPress core - Denial of Service via Cross Site Request Forgery', 'None', 'Uncontrolled Resource Consumption', '2017-11-16'),
    ],
    limit: 'Titles and CWE only.',
  },
  {
    id: 'kb-open-redirect',
    specialist: 'redirect',
    bugClass: 'Open redirect',
    what: 'A destination from the request is used for a redirect. On its own it is low severity; it matters when it lends a trusted domain to a phishing chain, or when it can be chained to reach an internal address.',
    fix: 'Validate the destination against an allow-list of hosts after parsing it, and prefer a fixed path over a caller-supplied URL.',
    citations: [
      cite('277502', '[BuddyPress 2.9.1] Open Redirect via "wp_http_referer" parameter on "bp-profile-edit" endpoint', 'Low', 'Open Redirect', '2017-11-02'),
      cite('3933198', 'wordpress.org/openverse/: unauthenticated open redirect — `str_replace()`\'s 4th arg is a count, not a limit', 'Medium', 'Open Redirect', '2026-10-30'),
    ],
    limit: 'Titles and CWE only. The second title states the mechanism in its own words; nothing further is inferred.',
  },
  {
    id: 'kb-business-logic',
    specialist: 'logic',
    bugClass: 'Business logic and parameter tampering',
    what: 'The code behaves as written, but a value the caller supplies has financial or state meaning, so the caller can choose an outcome they did not earn.',
    fix: 'Derive every value with financial meaning on the server from stored state, and re-check the earlier step\'s conditions at the later step.',
    citations: [
      cite('682344', 'Parameter tampering : Price Manipulation of Products', 'None', 'Business Logic Errors', '2019-08-29'),
      cite('404323', 'Logic flaw in the Post creation process allows creating posts with arbitrary types without needing the corresponding nonce', 'High', 'Business Logic Errors', '2019-02-14'),
      cite('3941626', 'Instamojo CampTix: fail-open MAC + webhook Credit without binding payment to order', 'High', 'Improper Access Control - Generic', '2026-11-05'),
    ],
    limit: 'Titles and CWE only.',
  },
  {
    id: 'kb-integrity',
    specialist: 'integrity',
    bugClass: 'Fail-open signature or MAC check',
    what: 'A webhook or callback is processed before its signature is verified, or the verification allows the request when the key is missing. The result is that anyone can post a "payment succeeded" event.',
    fix: 'Verify the signature with a constant-time comparison before reading the body, and refuse when the secret is unset.',
    citations: [
      cite('3941626', 'Instamojo CampTix: fail-open MAC + webhook Credit without binding payment to order', 'High', 'Improper Access Control - Generic', '2026-11-05'),
    ],
    limit: 'Title and CWE only. The title itself names "fail-open MAC", which is what this entry draws on.',
  },
  {
    id: 'kb-pii',
    specialist: 'pii',
    bugClass: 'Personal data disclosure',
    what: 'An endpoint or export returns personal data to someone not entitled to it. The severity depends on whose data and how much, which is why the impact sentence matters more than the class.',
    fix: 'Filter rows by entitlement, return only the fields the caller needs, and require the same capability for an export as for the screen it exports.',
    citations: [
      cite('3871816', 'Unauthenticated private CSV export of Meetup organizer PII via broken authz check in WordCamp Reports', 'High', 'Improper Access Control - Generic', '2026-11-05'),
      cite('221734', 'Administrator(s) Information disclosure via JSON on wordpress.org', 'Medium', 'Information Disclosure', '2017-04-19'),
      cite('273726', 'Information / sensitive data disclosure on some endpoints', 'Medium', 'Information Disclosure', '2018-08-22'),
      cite('4053546', 'Information Disclosure - Unauthen Leak Private Content', 'Medium', 'Information Disclosure', '2026-10-10'),
    ],
    limit: 'Titles and CWE only.',
  },
  {
    id: 'kb-auth-token',
    specialist: 'otp',
    bugClass: 'Token derived from a predictable value',
    what: 'A one-time or access token is computed from something the requester controls or can guess, so it is not really a secret. The CampTix case is the clearest published example: the view token was derived from the requester\'s own IP.',
    fix: 'Generate tokens from a CSPRNG, bind them to the account and an expiry, and store only a hash of them.',
    citations: [
      cite('4043537', 'CampTix [camptix_private]: the view token is derived from the requester\'s own IP, so naming any attendee\'s e-mail', 'Medium', 'Improper Authentication - Generic', '2026-10-30'),
    ],
    limit: 'Title and CWE only. The title states the derivation, which is what this entry draws on.',
  },
  {
    id: 'kb-enumeration',
    specialist: 'enumeration',
    bugClass: 'Account enumeration',
    what: 'The response tells you whether an account exists. On its own it is usually low; it becomes useful when chained with a login or reset flow.',
    fix: 'Return one message and one status for both cases, and keep the work done before the branch the same in both.',
    citations: [
      cite('221734', 'Administrator(s) Information disclosure via JSON on wordpress.org', 'Medium', 'Information Disclosure', '2017-04-19'),
    ],
    limit: 'Drawn from a disclosure-class report, not from a report titled as enumeration. Stated plainly rather than stretched.',
  },
  {
    id: 'kb-recon-surface',
    specialist: 'recon',
    bugClass: 'Attack surface in WordPress core',
    what: 'Not a bug: the map. WordPress core exposes REST routes, AJAX actions (including nopriv ones), admin screens and file handlers. Reading which of them take input and what guards each is the work that makes every other specialist useful.',
    fix: 'Not applicable — this entry is a map, not a defect.',
    citations: [
      cite('1107282', 'Privilege Escalation via REST API to Administrator leads to RCE', 'High', 'Privilege Escalation', '2021-05-17'),
      cite('3931777', 'Author → arbitrary file deletion anywhere on disk (site takeover) via `POST /wp/v2/media/<id>/finalize` poison', 'Critical', 'Path Traversal', '2026-08-28'),
    ],
    limit: 'Titles only, used to show which surfaces have produced real reports.',
  },
  {
    id: 'kb-cors-admin',
    specialist: 'cors',
    bugClass: 'Exposed administrative surface',
    what: 'An admin or internal endpoint is reachable without the capability it should require. In the published WordPress cases this shows up as an unauthenticated read of something that should need a role.',
    fix: 'Require the capability at the endpoint, and do not rely on the UI having hidden the link.',
    citations: [
      cite('4029867', 'WordCamp Meta gpre: password-protected event RSVP list readable without password via /gpre/v1/.../rsvp-responses', 'Medium', 'Improper Access Control - Generic', '2026-11-05'),
      cite('222692', 'plugins.trac.wordpress.org likely vulnerable to Cross Site Tracing (xst), TRACE HTTP method should be disabled', 'None', 'Violation of Secure Design Principles', '2019-11-03'),
    ],
    limit: 'Titles and CWE only. No CORS-specific WordPress report was found in the readable set, so this entry is honest about drawing on adjacent classes.',
  },
  {
    id: 'kb-referer',
    specialist: 'referer',
    bugClass: 'Sensitive value in a URL',
    what: 'A token or nonce travels in the query string, so it reaches logs, history and any third party the page loads. The published WordPress cases are mostly nonce-in-URL rather than a named referer leak.',
    fix: 'Keep secrets out of URLs; where a nonce must be in a URL, set a strict Referrer-Policy on that response.',
    citations: [
      cite('277502', '[BuddyPress 2.9.1] Open Redirect via "wp_http_referer" parameter on "bp-profile-edit" endpoint', 'Low', 'Open Redirect', '2017-11-02'),
    ],
    limit: 'No report in the readable set is titled as referer leakage. This entry says so instead of inventing one.',
  },
  {
    id: 'kb-xxe-ssti',
    specialist: 'xxe',
    bugClass: 'XXE and template injection in WordPress-adjacent code',
    what: 'Neither class appears in the readable WordPress report set. They are real classes in PHP generally, and the specialists still review for them, but this knowledge base will not pretend a WordPress report exists for them.',
    fix: 'Disable external entity loading on every XML parser; never compile caller text as a template.',
    citations: [],
    limit: 'No disclosed WordPress report for this class was found in the readable set. The entry is empty of citations on purpose rather than padded with an unrelated report.',
  },
]

export function knowledgeBase(): KnowledgeBase {
  return {
    version: '1',
    sources: [
      {
        title: 'HackerOne — WordPress program, disclosed reports',
        url: 'https://hackerone.com/wordpress/hacktivity',
        what: 'Report ids, titles, CWE, severity and disclosure dates, read through HackerOne\'s read-only API (/v1/hackers/hacktivity). Report bodies were not readable, so no entry summarises one.',
      },
      {
        title: 'HackerOne API — hacktivity endpoint',
        url: 'https://api.hackerone.com/v1/hackers/hacktivity',
        what: 'The metadata source. It returns title, CWE, severity and dates; it does not return report bodies.',
      },
      {
        title: 'HuggingFace — HackerOne transparency dataset (cited by BountyGrimoire)',
        url: 'https://huggingface.co/datasets/HackerOne/hackerone-transparency',
        what: 'NOT USED. It was not reachable from this machine during this build, so nothing here is drawn from it. Listed so the gap is visible rather than hidden.',
      },
    ],
    note: [
      'Every entry is drawn from a publicly disclosed HackerOne report on the WordPress program, and cites the report id it came from.',
      'What is recorded is the bug class and its fix — never a payload. A knowledge base of payloads is a scanner; a knowledge base of classes and fixes is something you can read and learn from.',
      'HackerOne\'s API returns report metadata, not report bodies, and the report pages would not render for a signed-out read. So each citation is marked "body unread" and no entry claims to summarise a body it never saw.',
      'Where no disclosed report exists for a class, the entry says so and carries no citation, rather than borrowing an unrelated report to look complete.',
    ].join('\n\n'),
    entries,
  }
}

export function knowledgeFor(specialist: SpecialistId): KnowledgeEntry[] {
  return entries.filter(e => e.specialist === specialist)
}

export function knowledgeEntry(id: string): KnowledgeEntry | null {
  return entries.find(e => e.id === id) ?? null
}
