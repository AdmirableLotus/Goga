/**
 * Replies about a "new device on your home network" alert. The guardian only sees a device's
 * address and hardware (MAC) ID, and can't allow or block anything; left to the chat brain,
 * Goga claimed a device "is an ultra-smartphone" and that he'd "added it to the authorized
 * list". These answers say only what is really known and done.
 */

const ALERT = /^Heads up — new device on your home network\. (\S+) \(([0-9A-Fa-f]{2}(?:[-:][0-9A-Fa-f]{2}){5})\)/
const ABOUT_DEVICE = /\b(device|phone|iphone|android|tablet|ipad|laptop|computer|tv|printer|console|watch|speaker|192\.168\.\d+\.\d+)\b/i
const OWNED = /\b(my|mine|our|ours|i know|i recogni[sz]e|it'?s (fine|ok|okay|me)|that'?s (me|fine|ok|okay))\b/i
const QUESTION = /\?|\b(what|which|who|is (it|the|this|that)|can you (tell|see|check))\b/i

export interface DeviceReply { reply: string; fact?: string }

/** A reply to the user's message about the latest new-device alert, or null when it isn't about one. */
export function deviceAlertReply(message: string, recentAssistant: string[] | (() => string[]), userName: string): DeviceReply | null {
  const text = message.trim()
  if (!text || text.length > 200 || !ABOUT_DEVICE.test(text)) return null
  const alert = (typeof recentAssistant === 'function' ? recentAssistant() : recentAssistant).map(m => m.match(ALERT)).find(Boolean)
  if (!alert) return null
  const [, ip, mac] = alert
  const what = (text.match(/\b(?:my|our)\s+((?:new\s+|old\s+|work\s+)?[a-z][a-z ]{1,30}?)(?=[.!,]|$|\s+(?:and|but))/i)?.[1] ?? 'device').trim()
  if (OWNED.test(text) && !/\?\s*$/.test(text)) {
    return {
      reply: `Thanks, ${userName} — so ${ip} is your ${what}. It's already on my list of devices I've seen, so I won't alert you about it again. (I can only notice new devices, not allow or block them; that's done in your router's settings.)`,
      fact: `The device ${mac} (${ip}) on ${userName}'s home network is ${userName}'s ${what}.`,
    }
  }
  if (QUESTION.test(text)) {
    return {
      reply: `I can't tell what kind of device it is. All I can see is its network address (${ip}) and its hardware ID (${mac}). Your router's device list usually shows its name, or check your phone's Wi-Fi settings for that address. If it's yours, just tell me (for example "that's my new phone") and I'll remember it.`,
    }
  }
  return null
}
