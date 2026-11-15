import type { ReviewIssue } from '../../../shared/ee'
import { getComponent } from './components'

/**
 * Design review: compare a stated design decision against the recorded datasheet figures.
 *
 * The rule is one-directional. A decision that contradicts a recorded rating is an error.
 * A decision that AGREES is reported as "consistent with" — never as "verified correct",
 * because the review can only check the figures somebody recorded.
 */

export interface DesignClaim {
  partNumber: string
  /** What the design does, e.g. "runs the analog rail at 3.3 V". */
  claim: string
  /** The quantity being compared and the value the design uses. */
  quantity: string
  value: number
  unit: string
}

function parseRange(text: string): { min: number; max: number } | null {
  const nums = (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  if (!nums.length) return null
  if (/to/.test(text) && nums.length >= 2) return { min: Math.min(nums[0], nums[1]), max: Math.max(nums[0], nums[1]) }
  return { min: nums[0], max: nums[0] }
}

/** Compare one claim against the recorded ratings. */
export function reviewClaim(claim: DesignClaim): ReviewIssue[] {
  const rec = getComponent(claim.partNumber)
  if (!rec) {
    return [{
      severity: 'warning',
      claim: claim.claim,
      problem: `I have no datasheet figures for ${claim.partNumber}. I will not check this claim from memory — add the part's datasheet to the library first, or check the figure yourself.`,
      evidence: 'No record for this part number in the component library.',
      datasheet: null,
    }]
  }
  if (!rec.datasheet.url) {
    return [{ severity: 'error', claim: claim.claim, problem: `${claim.partNumber} has no datasheet URL recorded, so its figures cannot be quoted.`, evidence: 'record without a source', datasheet: null }]
  }
  const rating = rec.ratings.find(r => r.name.toLowerCase().includes(claim.quantity.toLowerCase()) || claim.quantity.toLowerCase().includes(r.name.toLowerCase()))
  if (!rating) {
    return [{
      severity: 'warning',
      claim: claim.claim,
      problem: `${claim.partNumber}'s record has no "${claim.quantity}" figure. I won't guess it — read the datasheet section you need and add it, or ask me with the number.`,
      evidence: `Recorded figures: ${rec.ratings.map(r => r.name).join(', ')}.`,
      datasheet: { title: rec.datasheet.title, url: rec.datasheet.url },
    }]
  }
  const range = parseRange(rating.value)
  if (!range) {
    return [{
      severity: 'warning',
      claim: claim.claim,
      problem: `"${rating.value} ${rating.unit}" is not a single number I can compare against ${claim.value} ${claim.unit}.`,
      evidence: `${rating.name} = ${rating.value} ${rating.unit} (${rating.where})`, datasheet: { title: rec.datasheet.title, url: rec.datasheet.url },
    }]
  }
  const inRange = claim.value >= range.min && claim.value <= range.max
  return [{
    severity: inRange ? 'note' : 'error',
    claim: claim.claim,
    problem: inRange
      ? `Consistent with the recorded rating: ${claim.value} ${claim.unit} sits inside ${rating.value} ${rating.unit}. Note that "inside the operating range" is not "within the absolute maximum" — check both in the datasheet.`
      : `Contradicts the datasheet: the design uses ${claim.value} ${claim.unit} but ${rating.name} is ${rating.value} ${rating.unit}.`,
    evidence: `${rating.name} = ${rating.value} ${rating.unit} — ${rating.where}, ${rec.datasheet.title}.`,
    datasheet: { title: rec.datasheet.title, url: rec.datasheet.url },
  }]
}

export function reviewDesign(claims: DesignClaim[]): { issues: ReviewIssue[]; summary: string } {
  const issues = (claims ?? []).flatMap(reviewClaim)
  const errors = issues.filter(i => i.severity === 'error').length
  const warnings = issues.filter(i => i.severity === 'warning').length
  return {
    issues,
    summary: `${issues.length} item(s) checked against recorded datasheet figures: ${errors} contradiction(s), ${warnings} thing(s) I could not check. Nothing here replaces reading the datasheet.`,
  }
}
