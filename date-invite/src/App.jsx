import { useState, useRef, useEffect, useCallback, Component } from 'react'
import Scene from './Scene.jsx'
import { startMusic, yesFlourish } from './audio.js'
import { herName, typedLines, NO_LABELS, YOUR_NAME } from './config.js'

// ── WebGL error boundary → CSS gradient fallback ─────────────────────────────
class SceneBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false } }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <div className="scene-fallback" />
    return this.props.children
  }
}

// ── heart fireworks (2D canvas overlay) ──────────────────────────────────────
function heartPoint(t) {
  // classic parametric heart, normalised to ~[-1, 1]
  const x = 16 * Math.pow(Math.sin(t), 3)
  const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
  return [x / 17, -y / 17]
}
const FIREWORK_COLORS = ['#ff6ea0', '#ffd27a', '#fff3e0', '#ff9ec2', '#ffb86b']

function Fireworks({ reduced }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const fit = () => {
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
    }
    fit()
    window.addEventListener('resize', fit)

    let particles = []
    let raf
    const burst = () => {
      const cx = canvas.width * (0.25 + Math.random() * 0.5)
      const cy = canvas.height * (0.18 + Math.random() * 0.3)
      const size = (55 + Math.random() * 55) * dpr
      const color = FIREWORK_COLORS[(Math.random() * FIREWORK_COLORS.length) | 0]
      const n = reduced ? 26 : 64
      for (let i = 0; i < n; i++) {
        const [hx, hy] = heartPoint((i / n) * Math.PI * 2)
        const speed = 0.85 + Math.random() * 0.3
        particles.push({
          x: cx, y: cy,
          vx: hx * size * speed * 0.022,
          vy: hy * size * speed * 0.022,
          life: 1, decay: 0.008 + Math.random() * 0.006,
          color, r: (1.1 + Math.random() * 1.4) * dpr,
        })
      }
    }
    const loop = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.globalCompositeOperation = 'lighter'
      particles = particles.filter((p) => p.life > 0)
      for (const p of particles) {
        p.x += p.vx; p.y += p.vy
        p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.010 * dpr
        p.life -= p.decay
        ctx.globalAlpha = Math.max(0, p.life)
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r * (0.5 + p.life * 0.5), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(loop)
    }
    burst()
    const early = setTimeout(burst, 350)
    const burstTimer = setInterval(burst, reduced ? 2600 : 1250)
    loop()
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(burstTimer)
      clearTimeout(early)
      window.removeEventListener('resize', fit)
    }
  }, [reduced])
  return <canvas ref={canvasRef} className="fireworks" />
}

// ── petal rain ───────────────────────────────────────────────────────────────
function PetalRain({ reduced }) {
  const petals = useRef(Array.from({ length: reduced ? 10 : 34 }, (_, i) => ({
    left: Math.random() * 100,
    delay: Math.random() * 5,
    dur: 5 + Math.random() * 5,
    size: 9 + Math.random() * 12,
    hue: Math.random() > 0.35 ? 'p' : 'g',
    sway: 20 + Math.random() * 50,
    key: i,
  }))).current
  return (
    <div className="petal-rain" aria-hidden="true">
      {petals.map((p) => (
        <span key={p.key} className={`petal petal-${p.hue}`}
          style={{
            left: `${p.left}%`,
            width: p.size, height: p.size * 1.25,
            animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s`,
            '--sway': `${p.sway}px`,
          }} />
      ))}
    </div>
  )
}

// ── typewriter ───────────────────────────────────────────────────────────────
const CHAR_MS = 58
const LINE_PAUSE_MS = 700
function Typewriter({ lines, onDone, reduced }) {
  const [shown, setShown] = useState(() => (reduced ? lines : ['']))
  useEffect(() => {
    if (reduced) { const t = setTimeout(onDone, 3200); return () => clearTimeout(t) }
    // wall-clock driven so a slow device or throttled timers can't stall the flow
    const t0 = performance.now() + 400
    const total = lines.reduce((s, l) => s + l.length * CHAR_MS + LINE_PAUSE_MS, 0)
    let done = false
    const timer = setInterval(() => {
      let budget = performance.now() - t0
      if (budget >= total + 1100) {
        if (!done) { done = true; clearInterval(timer); onDone() }
        return
      }
      const out = []
      for (const l of lines) {
        const lineTotal = l.length * CHAR_MS + LINE_PAUSE_MS
        if (budget <= 0) break
        out.push(l.slice(0, Math.ceil(Math.min(budget, l.length * CHAR_MS) / CHAR_MS)))
        budget -= lineTotal
      }
      setShown(out.length ? out : [''])
    }, 45)
    return () => clearInterval(timer)
  }, [lines, onDone, reduced])
  return (
    <div className="typewriter">
      {shown.map((l, i) => (
        <p key={i} className="type-line">
          {l}
          {!reduced && i === shown.length - 1 && <span className="caret" />}
        </p>
      ))}
    </div>
  )
}

// ── tilting glass question card ──────────────────────────────────────────────
function QuestionCard({ gyroRef, onYes, reduced }) {
  const cardRef = useRef(null)
  const glareRef = useRef(null)
  const [noIdx, setNoIdx] = useState(0)
  const [noPos, setNoPos] = useState(null)
  const [yesScale, setYesScale] = useState(1)

  // live tilt: pointer on desktop, gyro on device, gentle idle float always
  useEffect(() => {
    if (reduced) return
    let raf
    let px = 0, py = 0
    const onMove = (e) => {
      px = (e.clientX / window.innerWidth - 0.5) * 2
      py = (e.clientY / window.innerHeight - 0.5) * 2
    }
    window.addEventListener('pointermove', onMove)
    const loop = () => {
      const t = performance.now() / 1000
      const gx = Math.max(-1, Math.min(1, (gyroRef.current.gamma || 0) / 30))
      const gy = Math.max(-1, Math.min(1, ((gyroRef.current.beta || 0) - gyroRef.current.beta0) / 35))
      const rx = (-py - gy) * 7 + Math.sin(t * 0.9) * 2.2
      const ry = (px + gx) * 9 + Math.sin(t * 0.7 + 2) * 2.6
      if (cardRef.current) {
        cardRef.current.style.transform =
          `translateY(${Math.sin(t * 1.1) * 6}px) rotateX(${rx}deg) rotateY(${ry}deg)`
      }
      if (glareRef.current) {
        glareRef.current.style.background =
          `radial-gradient(circle at ${50 + ry * 3.5}% ${45 - rx * 3.5}%, rgba(255,240,215,0.34), rgba(255,255,255,0.05) 42%, transparent 70%)`
      }
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => { cancelAnimationFrame(raf); window.removeEventListener('pointermove', onMove) }
  }, [gyroRef, reduced])

  const lastDodge = useRef(0)
  const dodge = useCallback(() => {
    // pointerenter + click both fire on a tap — count it once
    const now = performance.now()
    if (now - lastDodge.current < 350) return
    lastDodge.current = now
    setNoIdx((i) => Math.min(i + 1, NO_LABELS.length - 1))
    setYesScale((s) => Math.min(s + 0.13, 2.1))
    const pad = 70
    setNoPos({
      x: pad + Math.random() * Math.max(40, window.innerWidth - pad * 2 - 110),
      y: pad + Math.random() * Math.max(40, window.innerHeight - pad * 2 - 50),
    })
    if (navigator.vibrate) navigator.vibrate(12)
  }, [])

  return (
    <div className="question-wrap">
      <div className="card3d" ref={cardRef}>
        <div className="glare" ref={glareRef} />
        <p className="eyebrow">a question, at golden hour</p>
        <h1 className="question">Will you go on a date with me?</h1>
        <div className="answers">
          <button className="yes-btn" style={{ transform: `scale(${yesScale})` }} onClick={onYes}>
            Yes 🌹
          </button>
          {!noPos && (
            <button className="no-btn" onPointerEnter={dodge} onClick={dodge}>
              {NO_LABELS[noIdx]}
            </button>
          )}
        </div>
      </div>
      {noPos && (
        <button className="no-btn no-fled" style={{ left: noPos.x, top: noPos.y }}
          onPointerEnter={dodge} onClick={dodge}>
          {NO_LABELS[noIdx]}
        </button>
      )}
    </div>
  )
}

// ── yes phase ────────────────────────────────────────────────────────────────
function YesScreen({ reduced }) {
  const name = herName()
  return (
    <div className="yes-wrap">
      <Fireworks reduced={reduced} />
      <PetalRain reduced={reduced} />
      <div className="yes-content">
        <h1 className="its-a-date">It&rsquo;s a date.</h1>
        <div className="ticket">
          <div className="ticket-shine" />
          <p className="ticket-admit">ADMIT TWO</p>
          <p className="ticket-names">{name ? `${name} & ${YOUR_NAME}` : `you & ${YOUR_NAME}`}</p>
          <p className="ticket-line">one perfect sunset together</p>
          <p className="ticket-small">date: your choice · dress code: that smile</p>
          <p className="ticket-small">🌹 no expiry</p>
        </div>
        <p className="signoff">— {YOUR_NAME === 'me' ? 'with all my heart' : YOUR_NAME}</p>
        <p className="screenshot-hint">screenshot this &amp; send it back 😉</p>
      </div>
    </div>
  )
}

// ── app root: the phase machine ──────────────────────────────────────────────
export default function App() {
  const [phase, setPhase] = useState('start')
  const growT0 = useRef(0)
  const gyroRef = useRef({ beta: 0, gamma: 0, beta0: 0 })
  const [reduced] = useState(() =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [quality] = useState(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'low'
    if (navigator.deviceMemory && navigator.deviceMemory < 4) return 'low'
    return 'high'
  })

  const begin = useCallback(() => {
    // everything sensitive to the user-gesture call stack goes first
    startMusic()

    function listenGyro() {
      let first = true
      window.addEventListener('deviceorientation', (e) => {
        if (e.beta == null) return
        if (first) { gyroRef.current.beta0 = e.beta; first = false }
        gyroRef.current.beta = e.beta
        gyroRef.current.gamma = e.gamma || 0
      })
    }
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then((res) => {
          if (res === 'granted') listenGyro()
        }).catch(() => {})
      } else {
        listenGyro()
      }
    } catch { /* gyro is a bonus, never required */ }

    // debug: ?t=8 opens the grow clock 8s in
    const skip = parseFloat(new URLSearchParams(window.location.search).get('t') || '0') || 0
    growT0.current = performance.now() - skip * 1000
    setPhase('grow')
  }, [])

  // grow → message after the world has assembled
  useEffect(() => {
    if (phase !== 'grow') return
    const t = setTimeout(() => setPhase('message'), reduced ? 1200 : 5600)
    return () => clearTimeout(t)
  }, [phase, reduced])

  const onTyped = useCallback(() => setPhase('question'), [])
  const onYes = useCallback(() => {
    yesFlourish()
    if (navigator.vibrate) navigator.vibrate([18, 60, 24, 60, 36])
    setPhase('yes')
  }, [])

  const name = herName()

  return (
    <div className={`app phase-${phase}${reduced ? ' reduced' : ''}`}>
      <style>{CSS}</style>

      <SceneBoundary>
        <Scene growT0={growT0} gyroRef={gyroRef} reduced={reduced} quality={quality} />
      </SceneBoundary>

      {/* readability scrim over the bright sky */}
      <div className="scrim" />

      {phase === 'start' && (
        <div className="start-overlay">
          <p className="eyebrow">for {name || 'you'}</p>
          <button className="rose-btn" onClick={begin} aria-label="open your surprise">
            <span className="rose-emoji">🌹</span>
          </button>
          <p className="hint">tap the rose · sound on 🎧 · then tilt your phone</p>
        </div>
      )}

      {phase === 'message' && (
        <div className="message-overlay">
          <Typewriter lines={typedLines()} onDone={onTyped} reduced={reduced} />
        </div>
      )}

      {phase === 'question' && (
        <QuestionCard gyroRef={gyroRef} onYes={onYes} reduced={reduced} />
      )}

      {phase === 'yes' && <YesScreen reduced={reduced} />}
    </div>
  )
}

// ── stylesheet ───────────────────────────────────────────────────────────────
const CSS = /* css */ `
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  .app {
    position: fixed; inset: 0; overflow: hidden;
    height: 100dvh;
    font-family: 'Jost', system-ui, sans-serif;
    color: #fff7ee;
    background: #12081f;
    user-select: none; -webkit-user-select: none;
  }
  .scene-fallback {
    position: absolute; inset: 0;
    background: linear-gradient(to bottom,
      #0e0721 0%, #3b1650 30%, #7a1e3c 46%, #c2461f 55%,
      #ffb347 63%, #331020 68%, #0a0510 100%);
  }
  .scrim {
    position: absolute; inset: 0; pointer-events: none; z-index: 2;
    background:
      linear-gradient(to bottom, rgba(10,4,18,0.42) 0%, transparent 30%),
      linear-gradient(to top, rgba(8,3,14,0.55) 0%, transparent 34%);
  }

  .eyebrow {
    font-family: 'Jost', sans-serif;
    font-size: clamp(13px, 3.6vw, 16px);
    letter-spacing: 0.42em; text-transform: uppercase;
    color: #ffd9ad; opacity: 0.9; margin: 0;
    text-shadow: 0 1px 14px rgba(0,0,0,0.6);
  }

  /* ── start ── */
  .start-overlay {
    position: absolute; inset: 0; z-index: 10;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 34px; padding: 24px;
    background: radial-gradient(120% 100% at 50% 40%, rgba(14,6,26,0.78) 0%, rgba(9,3,16,0.97) 100%);
    animation: fadein 1.4s ease both;
  }
  .rose-btn {
    background: none; border: none; cursor: pointer; padding: 18px;
    perspective: 500px;
    filter: drop-shadow(0 0 34px rgba(255,90,140,0.55));
    animation: heartbeat 1.9s ease-in-out infinite;
  }
  .rose-emoji {
    display: block; font-size: clamp(76px, 21vw, 110px); line-height: 1;
    animation: sway3d 4.5s ease-in-out infinite;
  }
  @keyframes heartbeat {
    0%, 100% { transform: scale(1); }
    12% { transform: scale(1.09); }
    24% { transform: scale(1); }
    36% { transform: scale(1.06); }
    50% { transform: scale(1); }
  }
  @keyframes sway3d {
    0%, 100% { transform: rotateY(-14deg) rotateZ(-3deg); }
    50% { transform: rotateY(14deg) rotateZ(3deg); }
  }
  .hint {
    font-size: clamp(13px, 3.8vw, 15px); font-weight: 300;
    letter-spacing: 0.14em; color: #e9d5c4; opacity: 0.85; margin: 0;
  }

  /* ── message / typewriter ── */
  .message-overlay {
    position: absolute; inset: 0; z-index: 10;
    display: flex; align-items: flex-start; justify-content: center;
    padding: max(9vh, 54px) 26px 0; pointer-events: none;
    /* veil only the top text band — never the sun */
    background: linear-gradient(to bottom,
      rgba(10,4,18,0.44) 0%, rgba(10,4,18,0.28) 26%, rgba(10,4,18,0) 40%);
    animation: fadein 0.9s ease both;
  }
  .typewriter { max-width: 620px; text-align: center; }
  .type-line {
    font-family: 'Cormorant Garamond', serif; font-style: italic; font-weight: 500;
    font-size: clamp(26px, 7.2vw, 38px);
    line-height: 1.45; margin: 0 0 6px;
    color: #fff6ea;
    text-shadow: 0 2px 8px rgba(10,3,16,0.85), 0 0 44px rgba(20,6,30,0.9);
    min-height: 1.4em;
  }
  .caret {
    display: inline-block; width: 2px; height: 0.95em;
    background: #ffd9ad; margin-left: 5px; vertical-align: -0.12em;
    animation: blink 0.85s step-end infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }

  /* ── question ── */
  .question-wrap {
    position: absolute; inset: 0; z-index: 10;
    display: flex; align-items: flex-end; justify-content: center;
    padding: 26px 26px max(7vh, 40px); perspective: 900px;
    animation: fadein 1.1s ease both;
  }
  .card3d {
    position: relative; overflow: hidden;
    width: min(92vw, 480px);
    padding: clamp(30px, 8vw, 48px) clamp(24px, 6vw, 42px);
    border-radius: 26px;
    background: linear-gradient(155deg, rgba(46,16,42,0.50), rgba(20,7,26,0.60));
    border: 1px solid rgba(255,214,170,0.30);
    box-shadow: 0 28px 70px rgba(6,2,12,0.65), inset 0 1px 0 rgba(255,235,205,0.22);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    text-align: center; transform-style: preserve-3d;
    will-change: transform;
  }
  .glare { position: absolute; inset: 0; pointer-events: none; border-radius: inherit; }
  .question {
    font-family: 'Cormorant Garamond', serif; font-style: italic; font-weight: 600;
    font-size: clamp(32px, 9vw, 48px); line-height: 1.14;
    margin: 16px 0 30px; color: #fff6ea;
    text-shadow: 0 2px 20px rgba(0,0,0,0.5);
  }
  .answers {
    display: flex; align-items: center; justify-content: center;
    gap: 26px; flex-wrap: wrap; min-height: 74px;
  }
  .yes-btn {
    font-family: 'Jost', sans-serif; font-weight: 600;
    font-size: clamp(19px, 5.4vw, 23px); letter-spacing: 0.05em;
    color: #3b1024; cursor: pointer;
    padding: 15px 36px; border: none; border-radius: 999px;
    background: linear-gradient(135deg, #ffd9a0, #ff9ec2 55%, #ff6ea0);
    box-shadow: 0 0 34px rgba(255,140,170,0.65), 0 8px 24px rgba(8,2,10,0.5);
    transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
    animation: yesglow 2.2s ease-in-out infinite;
  }
  @keyframes yesglow {
    0%, 100% { box-shadow: 0 0 30px rgba(255,140,170,0.55), 0 8px 24px rgba(8,2,10,0.5); }
    50% { box-shadow: 0 0 52px rgba(255,170,190,0.9), 0 8px 24px rgba(8,2,10,0.5); }
  }
  .no-btn {
    font-family: 'Jost', sans-serif; font-weight: 400;
    font-size: clamp(14px, 4vw, 16px);
    color: #e5cdbb; cursor: pointer;
    padding: 12px 22px; border-radius: 999px;
    border: 1px solid rgba(235,205,180,0.4);
    background: rgba(20,8,24,0.35);
    white-space: nowrap;
  }
  .no-fled {
    position: fixed; z-index: 40;
    transition: left 0.22s ease, top 0.22s ease;
  }

  /* ── yes ── */
  .yes-wrap {
    position: absolute; inset: 0; z-index: 10;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }
  .fireworks { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .yes-content {
    position: relative; z-index: 3; text-align: center;
    display: flex; flex-direction: column; align-items: center;
    gap: 22px; padding: 26px;
  }
  .its-a-date {
    font-family: 'Cormorant Garamond', serif; font-style: italic; font-weight: 600;
    font-size: clamp(52px, 13vw, 82px); margin: 0; color: #fff6ea;
    text-shadow: 0 4px 28px rgba(0,0,0,0.65), 0 0 60px rgba(255,150,120,0.4);
    animation: pop3d 1.1s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  @keyframes pop3d {
    0% { opacity: 0; transform: scale(0.4) rotateX(38deg) translateY(50px); }
    100% { opacity: 1; transform: scale(1) rotateX(0) translateY(0); }
  }
  .ticket {
    position: relative; overflow: hidden;
    width: min(86vw, 400px);
    padding: 26px 26px 22px;
    border-radius: 18px;
    background: linear-gradient(160deg, #2c1226 0%, #1b0a1c 60%, #241019 100%);
    border: 1.5px solid #d7a15c;
    box-shadow: 0 22px 55px rgba(5,2,10,0.7), inset 0 0 0 1px rgba(255,215,160,0.12);
    animation: ticketflip 1.15s 0.55s cubic-bezier(0.34, 1.4, 0.64, 1) both;
    transform-style: preserve-3d;
  }
  @keyframes ticketflip {
    0% { opacity: 0; transform: rotateY(94deg) scale(0.9); }
    100% { opacity: 1; transform: rotateY(0) scale(1); }
  }
  .ticket-shine {
    position: absolute; inset: -30%; pointer-events: none;
    background: linear-gradient(115deg, transparent 42%, rgba(255,226,170,0.5) 50%, transparent 58%);
    animation: foil 3.2s 1.6s ease-in-out infinite;
  }
  @keyframes foil {
    0% { transform: translateX(-70%); }
    55%, 100% { transform: translateX(70%); }
  }
  .ticket-admit {
    font-family: 'Jost', sans-serif; font-weight: 600;
    letter-spacing: 0.5em; font-size: 13px; color: #e9b96a;
    margin: 0 0 12px; padding-bottom: 12px;
    border-bottom: 1px dashed rgba(233,185,106,0.45);
  }
  .ticket-names {
    font-family: 'Cormorant Garamond', serif; font-style: italic; font-weight: 600;
    font-size: clamp(26px, 7vw, 32px); color: #ffe9d2; margin: 4px 0 8px;
  }
  .ticket-line {
    font-family: 'Cormorant Garamond', serif; font-style: italic;
    font-size: clamp(18px, 5vw, 21px); color: #f2cfae; margin: 0 0 12px;
  }
  .ticket-small {
    font-size: clamp(12px, 3.4vw, 14px); font-weight: 300;
    letter-spacing: 0.12em; color: #d9b393; margin: 3px 0;
  }
  .signoff {
    font-family: 'Cormorant Garamond', serif; font-style: italic;
    font-size: clamp(20px, 5.6vw, 25px); color: #ffddb8; margin: 6px 0 0;
    text-shadow: 0 2px 12px rgba(0,0,0,0.6);
    animation: fadein 1s 1.6s ease both;
  }
  .screenshot-hint {
    font-size: clamp(13px, 3.7vw, 15px); font-weight: 300;
    letter-spacing: 0.14em; color: #cfa98e; margin: 0;
    animation: fadein 1s 2.3s ease both;
  }

  /* ── petal rain ── */
  .petal-rain { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
  .petal {
    position: absolute; top: -30px; display: block;
    border-radius: 60% 40% 55% 45% / 50% 60% 40% 50%;
    animation-name: fall; animation-iteration-count: infinite; animation-timing-function: linear;
    opacity: 0.9;
  }
  .petal-p { background: radial-gradient(circle at 35% 30%, #ffc2d8, #ff7ba6 70%); }
  .petal-g { background: radial-gradient(circle at 35% 30%, #ffe6b8, #ffb161 70%); }
  @keyframes fall {
    0% { transform: translateY(-4vh) translateX(0) rotate(0deg); opacity: 0; }
    8% { opacity: 0.9; }
    100% { transform: translateY(108vh) translateX(var(--sway)) rotate(340deg); opacity: 0.55; }
  }

  @keyframes fadein { from { opacity: 0; } to { opacity: 1; } }

  /* ── reduced motion ── */
  .reduced *, .reduced *::before, .reduced *::after {
    animation-duration: 0.001s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001s !important;
  }
  .reduced .caret, .reduced .petal { display: none; }
`
