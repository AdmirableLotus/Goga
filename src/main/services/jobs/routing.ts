/**
 * Which chat messages become jobs, and how a job is answered from chat.
 *
 * Pure and dependency-free so the routing rules can be tested on their own. The point of the
 * split is: a small one-tool request stays a single chat turn (the agent loop does that well),
 * and a big compound request becomes one job with sub-steps, where it can run for a long time,
 * ask questions and report honestly.
 */

/** Two or more of these joined together means the request is really several jobs in one. */
const CONJUNCTION = /\b(and then|then|after that|also|plus|as well as|while you'?re at it|and also|and find|and write|and build|and make|and research)\b/i

/** Verbs that mean "go do real work", not "answer me here". */
const WORK_VERB = /\b(build|create|make|set ?up|research|find|collect|write|draft|prepare|install|configure|deploy|publish|test|check|review|fix|refactor|organi[sz]e|gather|compare|summari[sz]e|audit|scan|import|transcribe|study|backtest|analyse|analyze|plan out|work through|go through)\b/i

/** Things that want many steps on their own. */
const BIG_SHAPE = /\b(app|application|landing page|website|site|bot|script|tool|report|proposal|business plan|curriculum|portfolio|dataset|spreadsheet|dashboard|pipeline|integration|tester|testers|test plan|audit|assessment)\b/i

export const MIN_BIG_TASK_CHARS = 90
export const MIN_JOB_STEPS_LABEL = 3

/**
 * True when a request is big enough to deserve its own worker.
 *
 * Deliberately conservative: a one-sentence "open youtube" or "what is the price of AAPL"
 * stays a chat turn. The signal is a long request, or several joined pieces of work, plus at
 * least one real work verb.
 */
export function looksLikeBigTask(message: string): boolean {
  const text = String(message ?? '').trim()
  if (text.length < 40) return false
  // A question is a question, however long. ("What is X?" is not a job.)
  const questionShaped = /^\s*(explain|what|why|how (do|does|is|are)|when|who|which|is |are |can you explain|could you explain)\b/i.test(text)
  if (questionShaped && /\?/.test(text) && !WORK_VERB.test(text)) return false

  const pieces = text.split(CONJUNCTION).length - 1
  const verbs = (text.match(new RegExp(WORK_VERB.source, 'gi')) ?? []).length
  const big = BIG_SHAPE.test(text)

  if (pieces >= 2) return true                        // "build X, then write Y, and find Z"
  if (pieces >= 1 && (big || verbs >= 2)) return true  // "build X and find testers"
  if (text.length >= MIN_BIG_TASK_CHARS && big && verbs >= 1) return true
  if (verbs >= 3) return true
  return false
}

export type JobCommand =
  | { kind: 'list' }
  | { kind: 'read'; id: string }
  | { kind: 'answer'; id: string; answer: string }
  | { kind: 'cancel'; id: string }
  | { kind: 'resume'; id: string }
  | { kind: 'start'; goal: string }
  | null

/**
 * Read a job instruction typed into chat.
 *
 * Answers are only accepted with the job named ("job 3: yes") or with a "answer" prefix, so a
 * normal message is never silently taken as an answer to a job's question.
 */
export function parseJobCommand(message: string): JobCommand {
  const text = String(message ?? '').trim()
  if (!text) return null

  if (/^(my |the )?jobs?$|^(job board|what'?s running|what is running|show (me )?(the )?jobs)$/i.test(text)) return { kind: 'list' }
  if (/^(my |the )?jobs?\s+(please|now)$/i.test(text)) return { kind: 'list' }

  const read = text.match(/^(?:job|jobs)\s+(\S+)\s*\?$/i) ?? text.match(/^show (?:me )?job\s+(\S+)$/i)
  if (read) return { kind: 'read', id: read[1] }

  const cancel = text.match(/^(?:cancel|stop) (?:the )?job\s+(\S+)$/i)
  if (cancel) return { kind: 'cancel', id: cancel[1] }

  const resume = text.match(/^resume (?:the )?job\s+(\S+)$/i)
  if (resume) return { kind: 'resume', id: resume[1] }

  const answer = text.match(/^(?:answer|reply to) (?:the )?job\s+(\S+?)[:\s]\s*([\s\S]+)$/i)
    ?? text.match(/^(?:job|jobs)\s+(\S+?)\s*:\s*([\s\S]+)$/i)
  if (answer) return { kind: 'answer', id: answer[1], answer: answer[2].trim() }

  const start = text.match(/^start (?:a )?job[:\s]+([\s\S]+)$/i)
  if (start) return { kind: 'start', goal: start[1].trim() }

  return null
}

/** What the board tells the user in chat when a job stops to ask something. */
export function questionMessage(job: { id: string; title: string; question?: { text: string; detail?: string; options?: string[] } }): string {
  const q = job.question
  if (!q) return ''
  const options = q.options?.length ? `\n\nOptions: ${q.options.join(' / ')}` : ''
  return `❓ Job "${job.title}" needs you:\n\n${q.text}${q.detail ? `\n\n${q.detail}` : ''}${options}\n\nAnswer on the Jobs page, or here with: job ${job.id}: <your answer>`
}
