// Original generated score — 68bpm, Am–F–C–G ×2 (8-bar cycle).
// Felt-piano rolled chords, pluck arpeggio, warm pad through a lowpass,
// sine sub-bass, lead melody with vibrato entering bar 3.
// All audio must be started from inside the first tap gesture (mobile autoplay).
import * as Tone from 'tone'
import { SONG_URL } from './config.js'

const CHORDS = [
  { root: 'A2', notes: ['A3', 'C4', 'E4'] }, // Am
  { root: 'F2', notes: ['F3', 'A3', 'C4'] }, // F
  { root: 'C2', notes: ['C3', 'E3', 'G3', 'C4'] }, // C
  { root: 'G2', notes: ['G3', 'B3', 'D4'] }, // G
]

// Original lead melody, one note-list per bar of the 8-bar cycle.
// Rests are nulls. Enters at bar 3 (index 2).
const LEAD = [
  null,
  null,
  [['0:0', 'E5', '2n'], ['0:2', 'C5', '4n'], ['0:3', 'D5', '4n']],
  [['0:0', 'E5', '2n.'], ['0:3', 'G5', '4n']],
  [['0:0', 'A5', '2n'], ['0:2', 'G5', '4n'], ['0:3', 'E5', '4n']],
  [['0:0', 'D5', '1n']],
  [['0:0', 'C5', '2n'], ['0:2', 'E5', '4n'], ['0:3', 'D5', '4n']],
  [['0:0', 'B4', '2n.'], ['0:3', 'A4', '4n']],
]

let built = false
let master, piano, pluck, pad, padFilter, sub, lead, songEl

function build() {
  if (built) return
  built = true

  master = new Tone.Gain(0).toDestination()
  const verb = new Tone.Reverb({ decay: 5.5, wet: 0.42, preDelay: 0.02 })
  const comp = new Tone.Compressor({ threshold: -18, ratio: 3 })
  verb.connect(comp)
  comp.connect(master)

  // Felt piano — soft triangle-heavy poly with a darkened tone
  piano = new Tone.PolySynth(Tone.Synth, {
    volume: -10,
    oscillator: { type: 'triangle8' },
    envelope: { attack: 0.015, decay: 1.6, sustain: 0.22, release: 2.8 },
  })
  const pianoLP = new Tone.Filter(2200, 'lowpass')
  piano.chain(pianoLP, verb)

  // Pluck arpeggio
  pluck = new Tone.PluckSynth({ volume: -16, attackNoise: 0.6, dampening: 3200, resonance: 0.92 })
  pluck.connect(verb)

  // Warm pad — fat saw through a slowly breathing lowpass
  pad = new Tone.PolySynth(Tone.Synth, {
    volume: -24,
    oscillator: { type: 'fatsawtooth', count: 3, spread: 24 },
    envelope: { attack: 2.5, decay: 1, sustain: 0.8, release: 4 },
  })
  padFilter = new Tone.Filter(700, 'lowpass')
  const padLFO = new Tone.LFO({ frequency: 0.05, min: 480, max: 1100 })
  padLFO.connect(padFilter.frequency)
  padLFO.start()
  pad.chain(padFilter, verb)

  // Sine sub-bass
  sub = new Tone.Synth({
    volume: -14,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.08, decay: 0.3, sustain: 0.9, release: 1.5 },
  })
  sub.connect(comp)

  // Lead with vibrato
  lead = new Tone.Synth({
    volume: -15,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.06, decay: 0.4, sustain: 0.65, release: 1.8 },
  })
  const vibrato = new Tone.Vibrato({ frequency: 5.2, depth: 0.12, wet: 1 })
  lead.chain(vibrato, verb)

  Tone.getTransport().bpm.value = 68

  let barCount = 0
  new Tone.Loop((time) => {
    const bar = barCount % 8
    barCount++
    const chord = CHORDS[bar % 4]

    // Rolled chord — stagger note starts like a felt piano
    chord.notes.forEach((n, i) => {
      piano.triggerAttackRelease(n, '1n', time + i * 0.07, 0.55 - i * 0.06)
    })

    // Sub-bass root, gentle swell each bar
    sub.triggerAttackRelease(chord.root, '1n', time, 0.8)

    // Pad re-voiced every other bar
    if (bar % 2 === 0) {
      pad.triggerAttackRelease(chord.notes, '2n', time, 0.5)
    }

    // Pluck arpeggio — up pattern, eighth notes
    const eighth = Tone.Time('8n').toSeconds()
    for (let i = 0; i < 8; i++) {
      const n = chord.notes[i % chord.notes.length]
      pluck.triggerAttack(Tone.Frequency(n).transpose(12), time + i * eighth)
    }

    // Lead melody (enters bar 3)
    const line = LEAD[bar]
    if (line) {
      line.forEach(([off, note, dur]) => {
        lead.triggerAttackRelease(note, dur, time + Tone.Time(off).toSeconds(), 0.7)
      })
    }
  }, '1m').start(0)
}

async function tryHostedSong() {
  if (!SONG_URL) return false
  return new Promise((resolve) => {
    const el = new Audio(SONG_URL)
    el.loop = true
    el.volume = 0
    el.crossOrigin = 'anonymous'
    const fail = () => resolve(false)
    el.addEventListener('error', fail, { once: true })
    el.play().then(() => {
      songEl = el
      // 3.5s fade-in to match the score's swell
      const t0 = performance.now()
      const ramp = () => {
        const k = Math.min(1, (performance.now() - t0) / 3500)
        el.volume = 0.9 * k
        if (k < 1 && songEl === el) requestAnimationFrame(ramp)
      }
      ramp()
      resolve(true)
    }).catch(fail)
  })
}

/** Call synchronously inside the first user tap. */
export async function startMusic() {
  try {
    await Tone.start()
    if (await tryHostedSong()) return
    build()
    Tone.getTransport().start('+0.05')
    // Master swell 0 → 0.9 over 3.5s
    master.gain.rampTo(0.9, 3.5)
  } catch (e) {
    // Music is atmosphere, never a blocker.
    console.warn('[audio]', e)
  }
}

/** Warm shimmer on the yes tap. */
export function yesFlourish() {
  try {
    if (songEl || !built) return
    const now = Tone.now()
    ;['A4', 'C5', 'E5', 'A5', 'C6'].forEach((n, i) => {
      piano.triggerAttackRelease(n, '2n', now + i * 0.09, 0.6)
    })
  } catch { /* ignore */ }
}
