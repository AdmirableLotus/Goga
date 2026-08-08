import { randomBytes } from 'crypto'
export const nanoid = () => randomBytes(8).toString('hex')
