/**
 * Which Brave Goga drives for the Cantina work, and what that honestly means.
 *
 * Two modes, and the difference is the whole point of this file:
 *
 *   own-profile  Goga launches Brave itself with a profile of its own, under Goga's userData.
 *                A different profile is a different browser as far as sign-in goes: the user
 *                signs in to Cantina once in that window, and Goga never sees their everyday
 *                Brave at all.
 *
 *   everyday     Goga attaches over CDP to the Brave the user already has running, and works in
 *                a tab it opens itself. That Brave is the user's real one, already signed in to
 *                whatever they are signed in to — so Goga can see and act in those pages. The
 *                old sentence "never your everyday Brave, passwords or cookies" is not true in
 *                this mode and must not be printed. What stays true: Goga reads no cookie, no
 *                password and no token, and it does not take over a tab the user is using.
 *
 * Nothing here authorizes anything. A mode is a browser choice; the scope gate, the single-use
 * approval, the rate cap and the stop are unchanged by it.
 */

export type BraveSessionMode = 'own-profile' | 'everyday'

/** The default the user asked for: drive the Brave they already use. */
export const DEFAULT_BRAVE_SESSION_MODE: BraveSessionMode = 'everyday'

/** Normalise any stored value to a known mode. Anything unrecognised reads as the default. */
export function asBraveSessionMode(value: unknown): BraveSessionMode {
  return value === 'own-profile' ? 'own-profile' : DEFAULT_BRAVE_SESSION_MODE
}

/** The short label a chip shows. */
export function braveSessionModeLabel(mode: BraveSessionMode): string {
  return mode === 'own-profile' ? 'own profile' : 'your everyday Brave'
}

/** One sentence naming the browser, for a live-log line. */
export function braveSessionModeSentence(mode: BraveSessionMode): string {
  return mode === 'own-profile'
    ? 'Brave launched by Goga in its own profile'
    : 'your everyday Brave, attached over its debugging port'
}

/**
 * The Cantina card's limitation text, per mode.
 *
 * Written plainly in both directions: in own-profile mode it says the profile is separate and
 * the sign-in is separate; in everyday mode it says Goga is in the browser the user is signed
 * into and will act in pages they are already logged in to. No reassurance either way.
 */
export function cantinaCardText(mode: BraveSessionMode): string {
  if (mode === 'own-profile') {
    return 'Goga starts Brave itself, in a profile of its own that lives under Goga, and drives that window. '
      + 'It is a separate profile, so it has a separate sign-in: you sign in to Cantina once in the window Goga opens, '
      + 'by hand, and that login is remembered there across restarts. Goga reads no cookie, password or token from '
      + 'your everyday Brave, and does not use its sessions. Being signed in is not permission to test — every request '
      + 'still passes the scope gate.'
  }
  return 'Goga attaches to the Brave you already use, over its debugging port, and does its work in a new tab it opens '
    + 'itself. This is your own signed-in browser, so Goga can see and act in the pages that window is signed in to, '
    + 'Cantina included. It reads no cookie, password or token — the sign-in it sees is the one your browser already '
    + 'has. It does not close, navigate or take over a tab you are using. It navigates only to Cantina hosts '
    + '(bounties.cantina.xyz and cantina.xyz); any other host is refused by name before anything is opened. '
    + 'Being signed in is not permission to test — every request still passes the scope gate.'
}

/** What the card says about the sign-in step, per mode. */
export function cantinaSignInHint(mode: BraveSessionMode): string {
  return mode === 'own-profile'
    ? 'Sign in to Cantina by hand in the window Goga opens, then press "I\'ve signed in".'
    : 'If you are already signed in to Cantina in your everyday Brave, there is no sign-in step: press "Check the page" '
      + 'and Goga reads the Cantina page it reaches to see whether that page shows you as signed in. It does not read '
      + 'cookies or storage to decide.'
}

/** The port Goga looks for on the running Brave, and the flag the user adds to it. */
export const EVERYDAY_DEBUG_PORT = 9222

export const EVERYDAY_DEBUG_FLAG = `--remote-debugging-port=${EVERYDAY_DEBUG_PORT}`

/**
 * Exactly what the user must do to make their own Brave attachable.
 *
 * Stated as a procedure, because "enable remote debugging" is not something a person can act on.
 * It says plainly that Brave must be started again with the flag: an already-running Brave
 * cannot be given a debugging port after the fact.
 */
export function everydayAttachInstructions(bravePath: string | null): string {
  const exe = bravePath || 'brave.exe'
  return [
    `Nothing answered on port ${EVERYDAY_DEBUG_PORT}, so Goga attached to nothing and launched nothing.`,
    `Your Brave has to be running with ${EVERYDAY_DEBUG_FLAG}. A Brave that is already open cannot be given that port afterwards — it has to be started again with the flag.`,
    `The simple way: make a desktop shortcut to "${exe}", add ${EVERYDAY_DEBUG_FLAG} to the end of its Target box, then close Brave completely (every window, and check the tray) and open it from that shortcut. Then start Goga.`,
    `Or from a Command Prompt: "${exe}" ${EVERYDAY_DEBUG_FLAG}`,
    'One thing to know: current Chromium — and Brave follows it — ignores the debugging port when Brave is started on its default profile folder, unless the folder is named explicitly. If you add the flag, restart Brave, and Goga still says nothing answered, that is why. Do not work around it by handing Goga your profile folder: Goga will not launch Brave against your real profile, and a copy of that folder is a second profile with none of your sign-ins.',
    'Check it yourself: with Brave started that way, http://127.0.0.1:' + EVERYDAY_DEBUG_PORT + '/json/version answers with a line naming Brave.',
  ].join(' ')
}
