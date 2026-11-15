import type { Curriculum, Lesson } from '../../../shared/security'

/**
 * The study area's content.
 *
 * Ground rules for this file:
 *  - every section cites the page it came from, and the claim is one that page actually
 *    makes as read on 2026-11-08 (UTC);
 *  - where a lesson describes a procedure rather than quoting a source, it says so and
 *    points at a source the reader can check;
 *  - nothing here says a target may be tested. Scope and program rules do that.
 */

const OWASP_2021 = 'https://top10.owasp.org/2021/'
const PORTSWIGGER_XSS = 'https://portswigger.net/web-security/cross-site-scripting'
const MDN_SOP = 'https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy'
const H1_API = 'https://api.hackerone.com/hacker-resources/'
const H1_STANDARDS = 'https://docs.hackerone.com/en/articles/8369826-detailed-platform-standards'
const BC_API = 'https://docs.bugcrowd.com/api/getting-started/'
const BC_RESEARCHERS = 'https://docs.bugcrowd.com/researchers/onboarding/welcome'
const OWASP_PROJECT = 'https://owasp.org/www-project-top-ten/'

const LESSONS: Lesson[] = [
  {
    id: 'web-fundamentals',
    track: 'Foundations',
    title: 'How a web request really works',
    minutes: 25,
    sections: [
      {
        heading: 'The pieces',
        body: [
          'A browser turns a URL into a request: scheme (http or https), host, optional port, path, and query string. Two URLs share an origin when the protocol, the port (when specified) and the host all match — the "scheme/host/port tuple". Path differences do not change the origin.',
          'That matters for almost every bug you will report: an injection is only interesting where the application trusts, stores or reflects something it should not.',
        ].join('\n\n'),
        sources: [{ title: 'MDN — Same-origin policy', url: MDN_SOP }],
      },
      {
        heading: 'Why an origin is a security boundary',
        body: 'The same-origin policy restricts how a document or script from one origin can interact with a resource from another. Cross-origin reads are typically disallowed; cross-origin writes (links, form submissions, redirects) are typically allowed. Memory of this asymmetry is what makes CSRF, XSS and CORS bugs readable instead of mysterious.',
        sources: [{ title: 'MDN — Same-origin policy: cross-origin network access', url: MDN_SOP }],
      },
      {
        heading: 'Practice',
        body: 'Open a site you own or a lab, open the browser devtools Network tab, and follow one request from request line to response headers. Write down: the origin, the method, the parameters, the cookies, and where in the HTML the parameter comes back.',
        sources: [{ title: 'PortSwigger Web Security Academy — XSS (lab-based practice)', url: PORTSWIGGER_XSS }],
      },
    ],
    check: 'Can you say, for a URL you just loaded, which of its query parameters appear in the response HTML?',
  },
  {
    id: 'owasp-top-10',
    track: 'Foundations',
    title: 'The OWASP Top 10 as a map, not a checklist',
    minutes: 40,
    sections: [
      {
        heading: 'What it is',
        body: 'OWASP describes the Top 10 as "a standard awareness document for developers and web application security", representing "a broad consensus about the most critical security risks to web applications". The most current released version is the OWASP Top 10 2025; the 2021 list is the one most programs still rate against, and is the one quoted here.',
        sources: [
          { title: 'OWASP — Top 10 project page (version status)', url: OWASP_PROJECT },
          { title: 'OWASP Top 10:2021', url: OWASP_2021 },
        ],
      },
      {
        heading: 'The 2021 categories',
        body: [
          'A01 Broken Access Control',
          'A02 Cryptographic Failures',
          'A03 Injection',
          'A04 Insecure Design',
          'A05 Security Misconfiguration',
          'A06 Vulnerable and Outdated Components',
          'A07 Identification and Authentication Failures',
          'A08 Software and Data Integrity Failures',
          'A09 Security Logging and Monitoring Failures',
          'A10 Server Side Request Forgery (SSRF)',
        ].join('\n'),
        sources: [{ title: 'OWASP Top 10:2021 — the list', url: OWASP_2021 }],
      },
      {
        heading: 'How to use it when you hunt',
        body: 'Treat each category as a question about the feature in front of you. Access control: can I change an id and see someone else\'s data? Injection: does my input reach an interpreter — SQL, HTML, a shell, a template? Misconfiguration: what does the response tell me about the stack, and is a debug route open? This turns a big list into a work order.',
        sources: [{ title: 'OWASP Top 10:2021', url: OWASP_2021 }],
      },
    ],
    check: 'Name the Top 10 category an "I changed the order id and saw another customer\'s invoice" bug belongs to, and why.',
  },
  {
    id: 'xss',
    track: 'Finding bugs',
    title: 'XSS: what it is and how to confirm it',
    minutes: 45,
    sections: [
      {
        heading: 'Definition',
        body: 'Cross-site scripting is "a web security vulnerability that allows an attacker to compromise the interactions that users have with a vulnerable application". It works by manipulating a site so it returns JavaScript to users, which then runs inside a victim\'s browser and can act with that user\'s permissions.',
        sources: [{ title: 'PortSwigger — Cross-site scripting', url: PORTSWIGGER_XSS }],
      },
      {
        heading: 'The three types',
        body: [
          'Reflected: the malicious script comes from the current HTTP request.',
          'Stored: the malicious script comes from the website\'s database.',
          'DOM-based: the vulnerability exists in client-side code rather than server-side code.',
        ].join('\n'),
        sources: [{ title: 'PortSwigger — Cross-site scripting: types', url: PORTSWIGGER_XSS }],
      },
      {
        heading: 'Confirming it, honestly',
        body: [
          'The accepted proof of concept is to make your own browser execute arbitrary JavaScript from the injection. PortSwigger notes that alert() has long been used because it is short, harmless and hard to miss.',
          'One practical caveat from the same page: from Chrome 92 onward, cross-origin iframes are prevented from calling alert(), so print() is the recommended alternative payload in that situation.',
          'What "confirmation" must include, for a report: the exact request (method, URL, parameters, headers that matter), the exact response fragment where your input lands unencoded, and the payload that executed. A screenshot of an alert box without the request is not evidence a triager can reproduce.',
        ].join('\n\n'),
        sources: [{ title: 'PortSwigger — XSS proof of concept and the alert()/print() caveat', url: PORTSWIGGER_XSS }],
      },
      {
        heading: 'Where to look first',
        body: 'Search fields, error messages that echo your input, profile fields rendered back to other users, redirect parameters, URL fragments read by client-side code, and anything that ends up inside an HTML attribute or a script block. Test with a unique benign string first to find reflection, then work out the encoding context before trying a payload.',
        sources: [{ title: 'PortSwigger — Cross-site scripting', url: PORTSWIGGER_XSS }],
      },
    ],
    check: 'Given a response where your string appears inside an HTML attribute, what do you need to know before choosing a payload?',
  },
  {
    id: 'report-writing',
    track: 'Getting paid',
    title: 'Writing a report a triager will accept',
    minutes: 30,
    sections: [
      {
        heading: 'The shape of a report',
        body: [
          'Title: the vulnerability class plus the exact asset, e.g. "Reflected XSS in the search query parameter on shop.example.com".',
          'Summary: two or three sentences — what it is, where it is, what it lets an attacker do.',
          'Steps to reproduce: numbered, exact, with a request you can paste. Assume the triager has never seen the page.',
          'Impact: what an attacker gains, in the program\'s terms — account takeover, access to other users\' data, action on their behalf.',
          'Evidence: the request, the relevant response, and the proof of execution. Redact other people\'s data.',
          'Remediation: what would fix it. Encode output for the context, validate input, use a CSP as defence in depth.',
        ].join('\n\n'),
        sources: [
          { title: 'HackerOne Hacker API — the fields a report is built from (title, vulnerability information, impact, structured scope id)', url: H1_API },
          { title: 'PortSwigger — XSS (for the confirmation evidence)', url: PORTSWIGGER_XSS },
        ],
      },
      {
        heading: 'Severity, and why it gets argued about',
        body: 'Programs commonly start from CVSS and then adjust for business impact. HackerOne\'s published platform standards show how a rating is argued in practice: for IDORs with unpredictable identifiers the standard says the CVSS "Attack Complexity" should be set to High unless the report demonstrates a reliable, repeatable way to obtain the ids — in which case Low. Read a program\'s stated standards before you argue severity, and make your report answer the question the standard actually asks.',
        sources: [{ title: 'HackerOne — Detailed Platform Standards (IDOR severity example)', url: H1_STANDARDS }],
      },
      {
        heading: 'The mistakes that get reports closed',
        body: [
          'Testing outside the listed assets. Scope is not a suggestion.',
          'A "vulnerability" with no security impact: a missing header, a version string, a self-XSS that needs the victim to paste code.',
          'A report that cannot be reproduced because the request or the encoding context is missing.',
          'Duplicate noise: five reports for one root cause. HackerOne\'s platform standards discuss how multiple reports of the same systemic issue are valued.',
        ].join('\n'),
        sources: [{ title: 'HackerOne — Detailed Platform Standards', url: H1_STANDARDS }],
      },
    ],
    check: 'Would a triager who has never seen this application be able to reproduce your finding from the report alone?',
  },
  {
    id: 'program-rules',
    track: 'Staying legal',
    title: 'Scope, rules and ethics',
    minutes: 35,
    sections: [
      {
        heading: 'Goga cannot give you permission',
        body: 'No tool, curriculum or checklist here grants testing rights. A program\'s own policy page and scope list are the only thing that does, and they can change without notice. Import the program, read the policy, and re-read it before a testing session. When a target is not listed, the answer is no.',
        sources: [
          { title: 'HackerOne Hacker API — programs and structured scopes', url: H1_API },
          { title: 'Bugcrowd researcher documentation', url: BC_RESEARCHERS },
        ],
      },
      {
        heading: 'What scope looks like in the two platforms you use',
        body: [
          'HackerOne exposes each program\'s structured scopes through its Hacker API. A structured scope carries the asset identifier, the asset type, and separate flags for "eligible for bounty" and "eligible for submission" — a target can be bounty-eligible and still not be accepting submissions, or the reverse. Goga only ever authorizes assets whose submission flag is true, and keeps every flag visible so you can check.',
          'Programs also publish scope exclusions: categories excluded from rewards in addition to the core ineligible findings.',
        ].join('\n\n'),
        sources: [{ title: 'HackerOne Hacker API — structured scopes and scope exclusions', url: H1_API }],
      },
      {
        heading: 'Bugcrowd',
        body: 'Bugcrowd\'s API is reached at api.bugcrowd.com with a token you generate yourself on its API credentials page, sent as an Authorization header, and it is rate limited to 60 requests per minute per IP address. Tokens can be pinned to an allowlist of IP addresses, in which case calls from any other address are rejected. Its researcher documentation is the place to read the code of conduct and disclosure terms.',
        sources: [
          { title: 'Bugcrowd — Getting started with the API', url: BC_API },
          { title: 'Bugcrowd researcher docs', url: BC_RESEARCHERS },
        ],
      },
      {
        heading: 'Rules of engagement that keep you out of trouble',
        body: [
          'Test only assets on the current in-scope list, and treat anything excluded as off limits even if it looks reachable.',
          'Do not touch other people\'s accounts or data. Prove access, do not harvest it.',
          'Respect stated rate limits, and do not run automated scanners unless the program explicitly allows them.',
          'Do not test denial of service, social engineering, or physical access unless listed.',
          'Report privately, never publicly, until the program says disclosure is allowed.',
          'When in doubt, ask the program. A question costs a day; an out-of-scope test can cost a lot more.',
        ].join('\n'),
        sources: [
          { title: 'Bugcrowd researcher docs (code of conduct, disclosure)', url: BC_RESEARCHERS },
          { title: 'HackerOne program policy and scope model', url: H1_API },
        ],
      },
    ],
    check: 'An asset is listed as bounty-eligible but not submission-eligible. Are you allowed to test it?',
  },
  {
    id: 'recon',
    track: 'Finding bugs',
    title: 'Reconnaissance that stays inside scope',
    minutes: 30,
    sections: [
      {
        heading: 'Why recon is mostly reading',
        body: 'Most useful recon is passive: reading the imported scope, the policy, the site\'s own sitemap and robots file, JavaScript bundles, and public documentation. Query those first. Active probing (requests that touch the application) needs per-request approval from the user in Goga, and must stay on an imported eligible asset.',
        sources: [{ title: 'HackerOne Hacker API — structured scopes', url: H1_API }],
      },
      {
        heading: 'A safe order of work',
        body: [
          '1. Import the program and read every asset rule and exclusion.',
          '2. Map the endpoints the application itself links to, from pages and JS bundles.',
          '3. Note parameters, especially ones that end up in the page.',
          '4. Only then plan a single, small, in-scope request, and get approval for that exact request.',
          '5. Log what you sent and what came back into the finding draft as evidence.',
        ].join('\n'),
        sources: [{ title: 'Bugcrowd researcher docs — methodology checklist', url: BC_RESEARCHERS }],
      },
      {
        heading: 'Choosing what to look at',
        body: 'Prefer features where the application must trust a user\'s input: search, export, sharing, profile rendering, support tickets, redirects after login. Those are where reflection and storage happen, which is where XSS and injection live.',
        sources: [{ title: 'OWASP Top 10:2021 — A03 Injection', url: OWASP_2021 }],
      },
    ],
    check: 'Which of your findings so far came from a passive source rather than a request you sent?',
  },
  {
    id: 'ethics-in-practice',
    track: 'Staying legal',
    title: 'Ethics in practice: the second bug',
    minutes: 20,
    sections: [
      {
        heading: 'Stop at proof',
        body: 'Once you can show impact, stop. Do not pivot to the admin panel, do not download the customer table, do not leave a shell. The minimum proof that a triager can reproduce is the goal; anything more becomes a new incident.',
        sources: [{ title: 'Bugcrowd researcher docs — code of conduct', url: BC_RESEARCHERS }],
      },
      {
        heading: 'Handling other people\'s data',
        body: 'If a test returns someone else\'s personal data, redact it in the report, note that you redacted it, and delete your local copy once the report is accepted. Never paste real user data into a public disclosure.',
        sources: [{ title: 'Bugcrowd researcher docs — disclosure', url: BC_RESEARCHERS }],
      },
      {
        heading: 'When something goes wrong',
        body: 'If a test causes an outage or exposes data beyond what you intended, stop, tell the program immediately through their stated channel, and keep a factual timeline. Programs treat an honest report of an accident very differently from a covered-up one.',
        sources: [{ title: 'Bugcrowd researcher docs', url: BC_RESEARCHERS }],
      },
    ],
    check: 'What is the first thing you do if an approved request returns another customer\'s records?',
  },
]

export function curriculum(): Curriculum {
  return {
    version: '2026-11-08',
    note: 'Compiled from the pages cited in each section, read on 2026-11-08 (UTC). Where a lesson describes a procedure, it is general guidance and the cited source is where to check it. Nothing here grants permission to test anything: the program\'s own scope and policy do that.',
    lessons: LESSONS,
  }
}

export function lessonById(id: string): Lesson | null {
  return LESSONS.find(l => l.id === id) ?? null
}
