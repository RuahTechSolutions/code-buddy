// Masks secrets so only their first 8 characters show. Everything Code Buddy
// draws, stores or hands back to the model goes through `mask` first.

const KEEP = 8
const HIDDEN = '••••••'

// Whole-token secrets: the match itself is the key.
const TOKENS: RegExp[] = [
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{6,}/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{10,}/g, // Stripe webhook secret
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bsk-[A-Za-z0-9_-]{20,}/g, // Anthropic, OpenAI and similar
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
]

// key = value: the value is the secret.
const ASSIGNED =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passwd|password|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)(\s*[:=]\s*|\s+(?=["']))(["']?)([^\s"'`]{9,})/gi
// --token xyz, --password=xyz
const FLAG = /(--?(?:api[_-]?key|token|secret|password|passwd)(?:=|\s+))(["']?)([^\s"'`]{6,})/gi

// Authorization: Bearer xyz, and user:password@ in URLs.
const BEARER = /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{9,})/g
const URL_PASSWORD = /(:\/\/[^\s:/@]+:)([^\s@/]{1,})@/g

const cut = (secret: string): string => secret.slice(0, KEEP) + HIDDEN

export function mask(text: string): string {
  if (!text) return text
  let out = text
  for (const re of TOKENS) out = out.replace(re, m => cut(m))
  out = out.replace(ASSIGNED, (_m, name: string, sep: string, quote: string, value: string) =>
    value.endsWith(HIDDEN) ? `${name}${sep}${quote}${value}` : `${name}${sep}${quote}${cut(value)}`,
  )
  out = out.replace(FLAG, (_m, flag: string, quote: string, value: string) =>
    value.endsWith(HIDDEN) ? `${flag}${quote}${value}` : `${flag}${quote}${cut(value)}`,
  )
  out = out.replace(BEARER, (_m, kind: string, value: string) => `${kind} ${cut(value)}`)
  out = out.replace(URL_PASSWORD, (_m, head: string, pass: string) => `${head}${cut(pass)}@`)
  return out
}

/** Live Stripe keys, for the guard: sk_live_, rk_live_, pk_live_. */
export const LIVE_STRIPE = /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{6,}/g

export function liveStripeKeys(text: string): string[] {
  return [...new Set(text.match(LIVE_STRIPE) ?? [])]
}
