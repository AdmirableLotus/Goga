// A chat answer has not touched the computer. The local brain still writes "I've opened it",
// "I'm downloading it" — so such claims are caught in code, not left to the prompt.

const DONE = /\bI(?:['’]ve| have| just| already)?\s+(?:now\s+|just\s+|already\s+)?(opened|clicked|typed|navigated|launched|downloaded|installed|uploaded|sent|emailed|saved|deleted|moved|renamed|fetched|cloned|scanned|browsed|executed|submitted|posted|logged in|signed in|pulled up|went to|looked it up|searched (?:the web|online|for))\b/i
const DOING = /\bI(?:['’]m| am)\s+(?:now\s+)?(opening|clicking|typing|navigating|launching|downloading|installing|uploading|sending|saving|deleting|fetching|cloning|scanning|searching|running|executing|initiating|pulling up)\b/i

/** True when a reply says it did, or is doing, something on the computer. */
export function claimsAction(reply: string): boolean {
  return DONE.test(reply) || DOING.test(reply)
}

/** The note added to a chat answer that claims an action no tool performed, or ''. */
export function chatHonestyNote(reply: string): string {
  return claimsAction(reply)
    ? '\n\n⚠️ Goga\'s check: nothing was done on the computer for this answer; it was only a chat reply. Ask me to do it ("open …", "search for …") and I will actually do it.'
    : ''
}

// One brain decides between talking and acting. When the phrase rules don't recognise a
// request, the local brain is asked this narrow question before a chat answer is written.
export function routeQuestion(message: string, lastAssistant = ''): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: 'Decide what the user\'s latest message asks for. ACT: carry out something on the computer or online right now (open or use an app or website, click or type, search the web, read or change files, download, send, run or check something). TALK: a question, opinion, advice, explanation, plan, writing text, feelings or small talk. Answer with exactly one word: ACT or TALK.' },
    { role: 'user', content: `${lastAssistant ? `Assistant's previous message: ${lastAssistant.slice(0, 400)}\n` : ''}User's message: ${message.slice(0, 600)}` },
  ]
}

export function parseRoute(answer: string): 'act' | 'talk' | null {
  // Words inside (even unfinished) thinking are not the answer.
  const m = answer.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').match(/\b(ACT|TALK)\b/i)
  return m ? (m[1].toUpperCase() === 'ACT' ? 'act' : 'talk') : null
}
