import { randomBytes } from 'crypto'

/**
 * A random string for an OAuth `state` value. Kept in its own file so the business service
 * does not have to import anything from the broker or the security layer just for this.
 */
export function appSecret(bytes = 16): string {
  return randomBytes(Math.max(8, bytes)).toString('base64url')
}
