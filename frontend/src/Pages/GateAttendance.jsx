import React, { useRef, useState, useEffect, useCallback } from 'react'
import { ATTENDANCE_API_URL } from '../utils/backendUrl'

const RECOGNIZE_INTERVAL_MS = 900
const PERSON_COOLDOWN_MS    = 12000
const UNKNOWN_COOLDOWN_MS   = 3000
const SUCCESS_HOLD_MS       = 4000
const UNKNOWN_HOLD_MS       = 2000

const pad = (n) => String(n).padStart(2, '0')
const fmtTime = () => {
  const d = new Date()
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const fmtDate = () => {
  const d = new Date()
  return d.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

export default function GateAttendance({ onExit }) {
  const videoRef    = useRef(null)
  const canvasRef   = useRef(null)
  const streamRef   = useRef(null)
  const timerRef    = useRef(null)
  const holdRef     = useRef(null)
  const busyRef     = useRef(false)
  const cooldownRef = useRef({})

  const [camState,   setCamState]   = useState('idle')   // idle | starting | live | error
  const [camError,   setCamError]   = useState('')
  const [phase,      setPhase]      = useState('idle')   // idle | scanning | success | already | unknown
  const [lastMatch,  setLastMatch]  = useState(null)
  const [, setFaceBox] = useState(null)
  const [log,        setLog]        = useState([])
  const [stats,      setStats]      = useState({ present: 0, unknown: 0 })
  const [encodings,  setEncodings]  = useState(0)
  const [clock,      setClock]      = useState(fmtTime())
  const [date,       setDate]       = useState(fmtDate())

  /* clock tick */
  useEffect(() => {
    const t = setInterval(() => { setClock(fmtTime()); setDate(fmtDate()) }, 1000)
    return () => clearInterval(t)
  }, [])

  /* fetch encoding count on mount */
  useEffect(() => {
    fetch(`${ATTENDANCE_API_URL}/live/status`)
      .then(r => r.json())
      .then(d => setEncodings(d?.live?.encodingCount || 0))
      .catch(() => {})
  }, [])

  /* ── camera ── */
  const stopCamera = useCallback(() => {
    clearInterval(timerRef.current)
    clearTimeout(holdRef.current)
    timerRef.current = null
    busyRef.current  = false
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCamState('idle')
    setPhase('idle')
    setFaceBox(null)
  }, [])

  useEffect(() => () => stopCamera(), [stopCamera])

  const startCamera = useCallback(async () => {
    setCamState('starting')
    setCamError('')
    try {
      const preferredConstraints = {
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
        audio: false,
      }

      let stream

      try {
        stream = await navigator.mediaDevices.getUserMedia(preferredConstraints)
      } catch (preferredError) {
        const fallbackConstraints = {
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        }

        const canFallback = ['NotFoundError', 'OverconstrainedError'].includes(preferredError?.name)

        if (!canFallback) {
          throw preferredError
        }

        // Some desktop webcams do not advertise a "user" facing mode.
        stream = await navigator.mediaDevices.getUserMedia(fallbackConstraints)
      }

      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCamState('live')
      setPhase('scanning')
      timerRef.current = setInterval(runRecognize, RECOGNIZE_INTERVAL_MS)
    } catch (err) {
      setCamState('error')
      setCamError(err.message || 'Camera access denied')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── recognition loop ── */
  const runRecognize = async () => {
    if (busyRef.current) return
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    busyRef.current = true
    try {
      const tmp = document.createElement('canvas')
      tmp.width  = video.videoWidth
      tmp.height = video.videoHeight
      tmp.getContext('2d').drawImage(video, 0, 0)
      const frameData = tmp.toDataURL('image/jpeg', 0.65)

      const r = await fetch(`${ATTENDANCE_API_URL}/recognize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: frameData }),
      })
      const { result } = await r.json()

      if (!result) { setFaceBox(null); return }

      const { face, match, confidence, detectedAt, alreadyPresent } = result

      /* face bounding box on overlay canvas */
      const overlay = canvasRef.current
      if (overlay && face) {
        overlay.width  = video.videoWidth
        overlay.height = video.videoHeight
        const ctx = overlay.getContext('2d')
        ctx.clearRect(0, 0, overlay.width, overlay.height)
        const { top, left, right, bottom } = face
        const isMatch = !!match
        ctx.strokeStyle = isMatch ? (alreadyPresent ? '#facc15' : '#22c55e') : '#ef4444'
        ctx.lineWidth = 3
        ctx.shadowColor = ctx.strokeStyle
        ctx.shadowBlur = 18
        ctx.beginPath()
        ctx.roundRect(left, top, right - left, bottom - top, 8)
        ctx.stroke()
        setFaceBox({ top, left, right, bottom,
          fw: video.videoWidth, fh: video.videoHeight,
          color: ctx.strokeStyle })
      } else {
        setFaceBox(null)
      }

      /* cooldown gate */
      const key = match ? match.name : '__unknown__'
      const now = Date.now()
      const last = cooldownRef.current[key] || 0
      const cd   = match ? PERSON_COOLDOWN_MS : UNKNOWN_COOLDOWN_MS
      if ((now - last) < cd) return
      cooldownRef.current[key] = now

      /* update phase + log */
      clearTimeout(holdRef.current)
      if (match) {
        const newPhase = alreadyPresent ? 'already' : 'success'
        setLastMatch({ ...match, confidence, alreadyPresent })
        setPhase(newPhase)
        holdRef.current = setTimeout(() => setPhase('scanning'), SUCCESS_HOLD_MS)

        const entry = {
          id: now,
          name: match.name,
          roll: match.rollNumber,
          cls: `${match.className}${match.section ? '-' + match.section : ''}`,
          time: new Date(detectedAt || now).toLocaleTimeString(),
          already: !!alreadyPresent,
        }
        setLog(prev => [entry, ...prev].slice(0, 50))
        if (!alreadyPresent) setStats(p => ({ ...p, present: p.present + 1 }))
      } else {
        setPhase('unknown')
        setLastMatch(null)
        holdRef.current = setTimeout(() => setPhase('scanning'), UNKNOWN_HOLD_MS)
        setStats(p => ({ ...p, unknown: p.unknown + 1 }))
      }
    } catch { /* network errors are silent */ }
    finally { busyRef.current = false }
  }

  const live = camState === 'live'

  /* accent colour driven by phase */
  const accent = phase === 'success' ? '#22c55e'
               : phase === 'already' ? '#facc15'
               : phase === 'unknown' ? '#ef4444'
               : '#6366f1'

  return (
    <div style={S.root}>

      {/* ── BACKGROUND GRID ── */}
      <div style={S.gridBg} />
      <div style={{ ...S.gradBlob, top: '-20%', left: '-10%', background: 'radial-gradient(ellipse,rgba(99,102,241,0.18) 0%,transparent 70%)' }} />
      <div style={{ ...S.gradBlob, bottom: '-20%', right: '-10%', background: 'radial-gradient(ellipse,rgba(34,197,94,0.1) 0%,transparent 70%)' }} />

      {/* ── TOP BAR ── */}
      <header style={S.topBar}>
        <div style={S.topLeft}>
          <div style={S.orgDot} />
          <div>
            <div style={S.orgName}>SmartGate · Attendance Terminal</div>
            <div style={S.orgDate}>{date}</div>
          </div>
        </div>
        <div style={S.clockBox}>{clock}</div>
        <div style={S.topRight}>
          <div style={S.dbPill}>
            <span style={{ ...S.dbDot, background: encodings > 0 ? '#22c55e' : '#ef4444' }} />
            {encodings} face{encodings !== 1 ? 's' : ''} enrolled
          </div>
          {onExit && (
            <button onClick={onExit} style={S.exitBtn} title="Exit to launcher">
              ✕ Exit
            </button>
          )}
        </div>
      </header>

      {/* ── MAIN CONTENT ── */}
      <main style={S.main}>

        {/* ── CAMERA COLUMN ── */}
        <section style={S.camSection}>

          {/* viewfinder */}
          <div style={{ ...S.vf, boxShadow: live ? `0 0 0 1px ${accent}44, 0 0 60px ${accent}22` : '0 0 0 1px rgba(99,102,241,0.2)' }}>

            <video
              ref={videoRef}
              muted playsInline
              style={{ ...S.video, opacity: live ? 1 : 0 }}
            />

            {/* canvas overlay for face box */}
            <canvas
              ref={canvasRef}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', transform: 'scaleX(-1)', zIndex: 4, pointerEvents: 'none' }}
            />

            {/* corner brackets */}
            {['tl','tr','bl','br'].map(k => <Corner key={k} k={k} c={accent} />)}

            {/* scan line */}
            {phase === 'scanning' && (
              <div style={{ ...S.scanLine, background: `linear-gradient(90deg,transparent,${accent}99,${accent},${accent}99,transparent)` }} />
            )}

            {/* idle overlay */}
            {!live && (
              <div style={S.overlay}>
                {camState === 'starting' && <SpinnerRing color="#6366f1" />}
                {camState === 'idle'     && <IdlePrompt />}
                {camState === 'error'    && <ErrorPrompt msg={camError} />}
              </div>
            )}

            {/* ── SUCCESS OVERLAY ── */}
            {live && phase === 'success' && lastMatch && (
              <div style={S.resultOverlay}>
                <SuccessCard match={lastMatch} />
              </div>
            )}

            {/* ── ALREADY MARKED OVERLAY ── */}
            {live && phase === 'already' && lastMatch && (
              <div style={S.resultOverlay}>
                <AlreadyCard match={lastMatch} />
              </div>
            )}

            {/* ── UNKNOWN OVERLAY ── */}
            {live && phase === 'unknown' && (
              <div style={S.resultOverlay}>
                <UnknownCard />
              </div>
            )}

            {/* scanning label */}
            {live && phase === 'scanning' && (
              <div style={S.scanLabel}>
                <span style={{ color: accent, fontSize: '0.68rem', fontWeight: 900, letterSpacing: '0.45em' }}>SCANNING</span>
              </div>
            )}

            {/* grid overlay */}
            <div style={S.gridOverlay} />
          </div>

          {/* controls */}
          <div style={S.ctrlRow}>
            {!live ? (
              <button
                onClick={startCamera}
                disabled={camState === 'starting'}
                style={S.startBtn}
              >
                {camState === 'starting'
                  ? <><SpinnerInline /> Opening camera…</>
                  : <><span style={S.btnIcon}>▶</span> Start Gate</>
                }
              </button>
            ) : (
              <button onClick={stopCamera} style={S.stopBtn}>
                <span style={S.btnIcon}>■</span> Stop Gate
              </button>
            )}
            <button
              onClick={async () => {
                const r = await fetch(`${ATTENDANCE_API_URL}/reload-encodings`, { method: 'POST' }).then(x => x.json()).catch(() => ({}))
                setEncodings(r.encodingCount || 0)
              }}
              style={S.reloadBtn}
              title="Reload face database"
            >
              ↺
            </button>
          </div>

          {/* status strip */}
          <div style={S.strip}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: live ? '#22c55e' : '#475569', boxShadow: live ? '0 0 8px #22c55e' : 'none', flexShrink: 0 }} />
              <span style={{ color: live ? '#4ade80' : '#475569', fontSize: '0.78rem', fontWeight: 600 }}>
                {live ? 'Gate camera live' : 'Gate camera off'}
              </span>
            </span>
            <span style={{ color: '#818cf8', fontSize: '0.78rem' }}>
              Today: <strong style={{ color: '#a5b4fc' }}>{stats.present}</strong> marked present
            </span>
          </div>
        </section>

        {/* ── LOG COLUMN ── */}
        <aside style={S.logCol}>

          {/* stats pills */}
          <div style={S.statsRow}>
            <StatPill label="Present Today" value={stats.present} color="#22c55e" />
            <StatPill label="Unrecognised"  value={stats.unknown} color="#ef4444" />
          </div>

          {/* log */}
          <div style={S.logCard}>
            <div style={S.logHead}>
              <span style={S.logTitle}>ENTRY LOG</span>
              <span style={S.logCount}>{log.length}</span>
            </div>
            <div style={S.logBody}>
              {log.length === 0 ? (
                <div style={S.logEmpty}>
                  <div style={{ fontSize: '2.4rem', opacity: 0.15, marginBottom: '0.6rem' }}>🚪</div>
                  <p style={{ color: '#334155', fontSize: '0.82rem', textAlign: 'center', margin: 0 }}>
                    No entries yet.<br />Start the gate camera.
                  </p>
                </div>
              ) : (
                log.map((e, i) => <LogRow key={e.id} e={e} fresh={i === 0} />)
              )}
            </div>
          </div>
        </aside>

      </main>

      <style>{`
        @keyframes scan-v {
          0%,100% { top: 4% }
          50%      { top: 88% }
        }
        @keyframes spin {
          to { transform: rotate(360deg) }
        }
        @keyframes pop-in {
          from { opacity: 0; transform: scale(0.88) translateY(12px) }
          to   { opacity: 1; transform: scale(1)    translateY(0) }
        }
        @keyframes tick-draw {
          from { stroke-dashoffset: 60 }
          to   { stroke-dashoffset: 0  }
        }
        @keyframes pulse-ring {
          0%   { transform: scale(1);   opacity: 0.7 }
          100% { transform: scale(2.4); opacity: 0   }
        }
        @keyframes shimmer {
          0%   { background-position: -400px 0 }
          100% { background-position:  400px 0 }
        }
      `}</style>
    </div>
  )
}

/* ── SUCCESS CARD ── */
function SuccessCard({ match }) {
  return (
    <div style={{ ...C.card, borderColor: '#22c55e44', boxShadow: '0 0 80px rgba(34,197,94,0.35)', animation: 'pop-in 0.35s cubic-bezier(0.34,1.56,0.64,1) both' }}>
      {/* pulse rings */}
      {[0, 0.4, 0.8].map(d => (
        <div key={d} style={{ ...C.pulseRing, borderColor: '#22c55e', animationDelay: `${d}s` }} />
      ))}

      {/* big animated tick */}
      <div style={C.tickWrap}>
        <svg width="72" height="72" viewBox="0 0 72 72" fill="none">
          <circle cx="36" cy="36" r="34" fill="rgba(34,197,94,0.12)" stroke="#22c55e" strokeWidth="2" />
          <polyline
            points="18,37 30,50 54,24"
            fill="none"
            stroke="#22c55e"
            strokeWidth="4.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="60"
            strokeDashoffset="0"
            style={{ animation: 'tick-draw 0.45s ease-out 0.1s both' }}
          />
        </svg>
      </div>

      <div style={C.label}>ATTENDANCE RECORDED</div>
      <div style={C.name}>{match.name}</div>
      <div style={C.meta}>{match.rollNumber}  ·  {match.className}{match.section ? `-${match.section}` : ''}</div>
      <div style={C.conf}>{Math.round((match.confidence || 0) * 100)}% match</div>
      <div style={{ ...C.badge, background: 'linear-gradient(135deg,#16a34a,#15803d)', boxShadow: '0 4px 20px rgba(22,163,74,0.5)' }}>
        ✓ MARKED PRESENT
      </div>
    </div>
  )
}

/* ── ALREADY MARKED CARD ── */
function AlreadyCard({ match }) {
  return (
    <div style={{ ...C.card, borderColor: '#facc1544', boxShadow: '0 0 80px rgba(250,204,21,0.25)', animation: 'pop-in 0.3s ease-out both' }}>
      <div style={C.tickWrap}>
        <svg width="72" height="72" viewBox="0 0 72 72" fill="none">
          <circle cx="36" cy="36" r="34" fill="rgba(250,204,21,0.1)" stroke="#facc15" strokeWidth="2" />
          <polyline
            points="18,37 30,50 54,24"
            fill="none"
            stroke="#facc15"
            strokeWidth="4.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="60"
            strokeDashoffset="0"
            style={{ animation: 'tick-draw 0.4s ease-out 0.1s both' }}
          />
        </svg>
      </div>
      <div style={{ ...C.label, color: '#fde68a' }}>ALREADY RECORDED</div>
      <div style={C.name}>{match.name}</div>
      <div style={C.meta}>{match.rollNumber}  ·  {match.className}{match.section ? `-${match.section}` : ''}</div>
      <div style={{ ...C.badge, background: 'linear-gradient(135deg,#a16207,#854d0e)', boxShadow: '0 4px 20px rgba(161,98,7,0.45)' }}>
        ✓ ALREADY PRESENT
      </div>
    </div>
  )
}

/* ── UNKNOWN CARD ── */
function UnknownCard() {
  return (
    <div style={{ ...C.card, borderColor: '#ef444444', boxShadow: '0 0 60px rgba(239,68,68,0.25)', animation: 'pop-in 0.25s ease-out both' }}>
      <div style={C.tickWrap}>
        <svg width="72" height="72" viewBox="0 0 72 72" fill="none">
          <circle cx="36" cy="36" r="34" fill="rgba(239,68,68,0.1)" stroke="#ef4444" strokeWidth="2" />
          <line x1="24" y1="24" x2="48" y2="48" stroke="#ef4444" strokeWidth="4.5" strokeLinecap="round" />
          <line x1="48" y1="24" x2="24" y2="48" stroke="#ef4444" strokeWidth="4.5" strokeLinecap="round" />
        </svg>
      </div>
      <div style={{ ...C.label, color: '#fca5a5' }}>FACE NOT RECOGNISED</div>
      <div style={{ color: '#f87171', fontSize: '0.9rem', marginTop: '0.35rem' }}>Not enrolled in system</div>
      <div style={{ ...C.badge, background: 'linear-gradient(135deg,#991b1b,#7f1d1d)', marginTop: '1rem', boxShadow: '0 4px 20px rgba(153,27,27,0.5)' }}>
        ✗ ACCESS UNKNOWN
      </div>
    </div>
  )
}

/* ── IDLE PROMPT ── */
function IdlePrompt() {
  return (
    <div style={{ textAlign: 'center', animation: 'pop-in 0.3s ease-out' }}>
      <div style={{ fontSize: '3.5rem', opacity: 0.2, marginBottom: '1rem' }}>📷</div>
      <p style={{ color: '#818cf8', fontSize: '0.9rem', letterSpacing: '0.15em', fontWeight: 700, margin: '0 0 0.4rem' }}>GATE CAMERA INACTIVE</p>
      <p style={{ color: '#334155', fontSize: '0.78rem', margin: 0 }}>Press Start Gate to begin</p>
    </div>
  )
}

function ErrorPrompt({ msg }) {
  return (
    <div style={{ textAlign: 'center', padding: '1rem', maxWidth: 260 }}>
      <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>⚠️</div>
      <p style={{ color: '#f87171', fontWeight: 700, margin: '0 0 0.35rem' }}>Camera Error</p>
      <p style={{ color: '#fca5a5', fontSize: '0.78rem', margin: 0 }}>{msg}</p>
    </div>
  )
}

/* ── CORNER BRACKETS ── */
function Corner({ k, c }) {
  const t = k[0] === 't', l = k[1] === 'l'
  return (
    <div style={{
      position: 'absolute', width: 28, height: 28, zIndex: 12, pointerEvents: 'none',
      top: t ? 16 : 'auto', bottom: t ? 'auto' : 16,
      left: l ? 16 : 'auto', right: l ? 'auto' : 16,
      borderTop:    t  ? `2.5px solid ${c}` : 'none',
      borderBottom: !t ? `2.5px solid ${c}` : 'none',
      borderLeft:   l  ? `2.5px solid ${c}` : 'none',
      borderRight:  !l ? `2.5px solid ${c}` : 'none',
      transition: 'border-color 0.3s',
    }} />
  )
}

/* ── STAT PILL ── */
function StatPill({ label, value, color }) {
  return (
    <div style={{ flex: 1, background: 'rgba(8,8,24,0.7)', borderRadius: 14, border: `1px solid ${color}22`, padding: '0.9rem 1rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
      <strong style={{ fontSize: '2.2rem', fontWeight: 900, color, lineHeight: 1 }}>{value}</strong>
      <span style={{ fontSize: '0.62rem', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.12em' }}>{label}</span>
    </div>
  )
}

/* ── LOG ROW ── */
function LogRow({ e, fresh }) {
  const c = e.already ? '#facc15' : '#22c55e'
  return (
    <div style={{
      padding: '0.65rem 0.9rem',
      borderRadius: 10,
      background: 'rgba(15,23,42,0.6)',
      borderLeft: `3px solid ${c}`,
      animation: fresh ? 'pop-in 0.3s ease-out' : 'none',
      display: 'flex', flexDirection: 'column', gap: '0.18rem',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: '0.87rem', color: c }}>{e.name}</span>
        <span style={{ fontSize: '0.68rem', color: '#475569' }}>{e.time}</span>
      </div>
      <div style={{ fontSize: '0.72rem', color: '#475569' }}>{e.roll}{e.cls ? ` · ${e.cls}` : ''}</div>
      {e.already && <span style={{ fontSize: '0.65rem', color: '#fde68a', fontWeight: 700 }}>already present</span>}
    </div>
  )
}

/* ── SPINNERS ── */
function SpinnerRing({ color = '#6366f1' }) {
  return (
    <div style={{ width: 48, height: 48, borderRadius: '50%', border: `3px solid ${color}22`, borderTopColor: color, animation: 'spin 0.8s linear infinite' }} />
  )
}
function SpinnerInline() {
  return (
    <span style={{ display: 'inline-block', width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.2)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite', marginRight: '0.5rem', verticalAlign: 'middle' }} />
  )
}

/* ════════════════════════════════════
   STYLES
════════════════════════════════════ */
const S = {
  root: {
    position: 'fixed', inset: 0,
    background: '#020209',
    color: '#e2e8f0',
    fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
  gridBg: {
    position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
    backgroundImage: 'linear-gradient(rgba(99,102,241,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,0.04) 1px,transparent 1px)',
    backgroundSize: '48px 48px',
  },
  gradBlob: {
    position: 'absolute', width: '60vw', height: '60vw',
    zIndex: 0, pointerEvents: 'none',
  },

  /* top bar */
  topBar: {
    position: 'relative', zIndex: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.85rem 1.75rem',
    borderBottom: '1px solid rgba(99,102,241,0.12)',
    background: 'rgba(2,2,9,0.85)',
    backdropFilter: 'blur(16px)',
    flexShrink: 0,
  },
  topLeft: { display: 'flex', alignItems: 'center', gap: '0.85rem' },
  orgDot: {
    width: 36, height: 36, borderRadius: 10,
    background: 'linear-gradient(135deg,#4f46e5,#7c3aed)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '1.1rem', flexShrink: 0,
  },
  orgName: { fontWeight: 800, fontSize: '0.95rem', color: '#f1f5f9', letterSpacing: '-0.01em' },
  orgDate: { fontSize: '0.72rem', color: '#475569', marginTop: '0.1rem' },
  clockBox: {
    fontFamily: "'Courier New', monospace",
    fontSize: '2rem', fontWeight: 900, color: '#f1f5f9',
    letterSpacing: '0.05em',
    background: 'rgba(99,102,241,0.08)',
    padding: '0.3rem 1rem', borderRadius: 10,
    border: '1px solid rgba(99,102,241,0.15)',
  },
  topRight: { display: 'flex', alignItems: 'center', gap: '0.75rem' },
  dbPill: {
    display: 'flex', alignItems: 'center', gap: '0.45rem',
    background: 'rgba(15,23,42,0.8)', padding: '0.4rem 0.9rem',
    borderRadius: 999, border: '1px solid rgba(99,102,241,0.2)',
    fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600,
  },
  dbDot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  exitBtn: {
    padding: '0.4rem 0.9rem', borderRadius: 8,
    border: '1px solid rgba(239,68,68,0.3)',
    background: 'rgba(239,68,68,0.08)', color: '#fca5a5',
    fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
    transition: 'background 0.15s',
  },

  /* main grid */
  main: {
    position: 'relative', zIndex: 2,
    flex: 1, display: 'flex', gap: '1.25rem',
    padding: '1.25rem 1.75rem',
    overflow: 'hidden',
  },

  /* camera section */
  camSection: {
    flex: 1, display: 'flex', flexDirection: 'column', gap: '0.85rem', minWidth: 0,
  },
  vf: {
    flex: 1, position: 'relative',
    borderRadius: 20, overflow: 'hidden',
    background: '#060612',
    border: '1px solid',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'box-shadow 0.4s',
  },
  video: {
    position: 'absolute', inset: 0,
    width: '100%', height: '100%',
    objectFit: 'cover',
    transform: 'scaleX(-1)',
    transition: 'opacity 0.4s', zIndex: 1,
  },
  overlay: {
    position: 'absolute', inset: 0, zIndex: 6,
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
  },
  resultOverlay: {
    position: 'absolute', inset: 0, zIndex: 15,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(2,2,9,0.55)',
    backdropFilter: 'blur(4px)',
  },
  scanLine: {
    position: 'absolute', left: 0, right: 0, height: 3,
    animation: 'scan-v 2.8s ease-in-out infinite',
    zIndex: 8, pointerEvents: 'none',
  },
  scanLabel: {
    position: 'absolute', bottom: 18, left: 0, right: 0,
    display: 'flex', justifyContent: 'center', zIndex: 11, pointerEvents: 'none',
  },
  gridOverlay: {
    position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none',
    backgroundImage: 'linear-gradient(rgba(99,102,241,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,0.025) 1px,transparent 1px)',
    backgroundSize: '44px 44px',
  },

  /* controls */
  ctrlRow: { display: 'flex', gap: '0.75rem', flexShrink: 0 },
  startBtn: {
    flex: 1, padding: '0.95rem 1.5rem',
    border: 'none', borderRadius: 14,
    background: 'linear-gradient(135deg,#4f46e5,#7c3aed)',
    color: '#fff', fontWeight: 800, fontSize: '0.95rem',
    letterSpacing: '0.06em', cursor: 'pointer', fontFamily: 'inherit',
    boxShadow: '0 0 28px rgba(79,70,229,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'opacity 0.2s, transform 0.15s',
  },
  stopBtn: {
    flex: 1, padding: '0.95rem 1.5rem',
    border: '1px solid rgba(239,68,68,0.35)',
    borderRadius: 14,
    background: 'rgba(239,68,68,0.1)',
    color: '#f87171', fontWeight: 800, fontSize: '0.95rem',
    letterSpacing: '0.06em', cursor: 'pointer', fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  reloadBtn: {
    width: 52, borderRadius: 14,
    border: '1px solid rgba(99,102,241,0.25)',
    background: 'rgba(99,102,241,0.1)',
    color: '#a5b4fc', fontSize: '1.2rem',
    cursor: 'pointer', fontFamily: 'inherit',
  },
  btnIcon: { marginRight: '0.55rem', fontSize: '0.85rem' },
  strip: {
    display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem',
    padding: '0.55rem 0.95rem',
    background: 'rgba(15,23,42,0.5)', borderRadius: 10,
    border: '1px solid rgba(99,102,241,0.1)',
    flexShrink: 0,
  },

  /* log column */
  logCol: {
    width: 300, display: 'flex', flexDirection: 'column', gap: '0.85rem', flexShrink: 0,
  },
  statsRow: { display: 'flex', gap: '0.6rem' },
  logCard: {
    flex: 1, display: 'flex', flexDirection: 'column',
    background: 'rgba(8,8,24,0.75)', borderRadius: 18,
    border: '1px solid rgba(99,102,241,0.15)', overflow: 'hidden',
  },
  logHead: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '0.8rem 1rem',
    borderBottom: '1px solid rgba(99,102,241,0.1)',
    background: 'rgba(99,102,241,0.05)',
    flexShrink: 0,
  },
  logTitle: { fontSize: '0.67rem', letterSpacing: '0.22em', color: '#818cf8', fontWeight: 800 },
  logCount: {
    background: 'rgba(99,102,241,0.18)', color: '#a5b4fc',
    padding: '0.14rem 0.5rem', borderRadius: 999, fontSize: '0.72rem', fontWeight: 700,
  },
  logBody: {
    flex: 1, overflowY: 'auto', padding: '0.6rem',
    display: 'flex', flexDirection: 'column', gap: '0.35rem',
  },
  logEmpty: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem',
  },
}

/* result card shared styles */
const C = {
  card: {
    position: 'relative',
    background: 'linear-gradient(160deg,rgba(8,8,28,0.97) 0%,rgba(2,2,14,0.97) 100%)',
    border: '1px solid',
    borderRadius: 24,
    padding: '2.5rem 2.8rem',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    minWidth: 320, maxWidth: 400,
    overflow: 'hidden',
  },
  pulseRing: {
    position: 'absolute',
    width: 200, height: 200,
    borderRadius: '50%',
    border: '1.5px solid',
    animation: 'pulse-ring 1.8s ease-out infinite',
    pointerEvents: 'none',
    top: '50%', left: '50%',
    transform: 'translate(-50%,-50%)',
    zIndex: 0,
  },
  tickWrap: { position: 'relative', zIndex: 1, marginBottom: '1.25rem' },
  label: {
    fontSize: '0.7rem', fontWeight: 900, letterSpacing: '0.25em',
    color: '#86efac', textTransform: 'uppercase', marginBottom: '0.65rem',
    position: 'relative', zIndex: 1,
  },
  name: {
    fontSize: '1.75rem', fontWeight: 900, color: '#f1f5f9',
    letterSpacing: '-0.03em', textAlign: 'center',
    position: 'relative', zIndex: 1,
  },
  meta: {
    fontSize: '0.88rem', color: '#64748b', marginTop: '0.3rem',
    position: 'relative', zIndex: 1,
  },
  conf: {
    fontSize: '0.75rem', color: '#475569', marginTop: '0.25rem',
    position: 'relative', zIndex: 1,
  },
  badge: {
    marginTop: '1.4rem',
    padding: '0.55rem 1.6rem',
    borderRadius: 999,
    color: '#fff',
    fontWeight: 900,
    fontSize: '0.8rem',
    letterSpacing: '0.12em',
    position: 'relative', zIndex: 1,
  },
}
