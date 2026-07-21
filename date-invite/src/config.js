// ── Personalise here ─────────────────────────────────────────────────────────
// HER_NAME: leave "" for the universal "hey you…" opening, or set her name.
// Can also be overridden per-link with ?name=Aisha in the URL.
export const HER_NAME = ''
export const YOUR_NAME = 'me'

// If you host an mp3 you have rights to, put its URL here and it will play
// instead of the generated score. NEVER bundle copyrighted audio with the site —
// attach the real song to the DM instead.
export const SONG_URL = ''

export function herName() {
  try {
    const q = new URLSearchParams(window.location.search).get('name')
    if (q && q.trim()) return q.trim().slice(0, 24)
  } catch { /* SSR / weird env */ }
  return HER_NAME
}

export function typedLines() {
  const name = herName()
  return [
    name ? `${name}…` : 'hey you…',
    "I couldn't find flowers that last forever,",
    'so I grew you crystal ones that never wilt.',
    'They caught this sunset the moment you opened this.',
  ]
}

export const NO_LABELS = [
  'No',
  'are you sure?',
  'really sure? 🥺',
  'look at the roses…',
  "they'll shatter 💔",
  'the sun is watching 🌅',
  'okay, wow.',
  '…yes is right there.',
]
