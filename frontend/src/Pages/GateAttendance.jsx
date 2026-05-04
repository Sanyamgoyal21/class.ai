import React from 'react'
import { ATTENDANCE_API_URL } from '../utils/backendUrl'

const injectCSS = () => {
  if (document.getElementById('gate-anim-css')) return
  const s = document.createElement('style')
  s.id = 'gate-anim-css'
  s.textContent = `
    @keyframes scan-line {
      0%   { top: 4%;  opacity: 1; }
      48%  { opacity: 0.8; }
      50%  { top: 93%; opacity: 0.6; }
      52%  { opacity: 0.8; }
      100% { top: 4%;  opacity: 1; }
    }
    @keyframes pulse-ring {
      0%   { transform: scale(0.9); opacity: 0.7; }
      100% { transform: scale(2.6); opacity: 0; }
    }
    @keyframes glow-idle {
      0%,100% { box-shadow: 0 0 18px rgba(99,102,241,0.25),inset 0 0 30px rgba(99,102,241,0.03); }
      50%      { box-shadow: 0 0 45px rgba(99,102,241,0.55),inset 0 0 50px rgba(99,102,241,0.06); }
    }
    @keyframes glow-match {
      0%,100% { box-shadow: 0 0 30px rgba(34,197,94,0.45),inset 0 0 40px rgba(34,197,94,0.06); }
      50%     { box-shadow: 0 0 80px rgba(34,197,94,0.85),inset 0 0 80px rgba(34,197,94,0.12); }
    }
    @keyframes glow-fail {
      0%,100% { box-shadow: 0 0 30px rgba(239,68,68,0.45),inset 0 0 40px rgba(239,68,68,0.06); }
      50%     { box-shadow: 0 0 80px rgba(239,68,68,0.85),inset 0 0 80px rgba(239,68,68,0.12); }
    }
    @keyframes radar-spin { to { transform: rotate(360deg); } }
    @keyframes name-in {
      from { opacity:0; transform: translateY(14px) scale(0.92); filter: blur(6px); }
      to   { opacity:1; transform: translateY(0)   scale(1);    filter: blur(0);  }
    }
    @keyframes shimmer-move {
      0%   { background-position: -200% center; }
      100% { background-position:  200% center; }
    }
    @keyframes badge-pop {
      0%  { transform: scale(0); opacity: 0; }
      65% { transform: scale(1.18); }
      100%{ transform: scale(1);   opacity: 1; }
    }
    @keyframes heartbeat {
      0%,100%{ transform: scale(1); }
      15%    { transform: scale(1.18); }
      30%    { transform: scale(1); }
      45%    { transform: scale(1.1); }
      60%    { transform: scale(1); }
    }
    @keyframes corner-blink {
      0%,100%{ opacity:1; }
      50%    { opacity:0.35; }
    }
    @keyframes slide-in-right {
      from { opacity:0; transform: translateX(36px); }
      to   { opacity:1; transform: translateX(0);    }
    }
    @keyframes stat-glow {
      0%,100%{ opacity:0.85; }
      50%    { opacity:1; }
    }
    .gate-corner   { animation: corner-blink 2s ease-in-out infinite; }
    .gate-det-card { animation: slide-in-right 0.35s ease-out forwards; }
  `
  document.head.appendChild(s)
}

export default function GateAttendance() {
  const [live, setLive] = React.useState({
    running: false, recentDetections: [], encodingCount: 0, cameraOpen: false,
  })
  const [loading, setLoading] = React.useState(false)
  const [matchState, setMatchState] = React.useState('idle')
  const [lastMatch, setLastMatch] = React.useState(null)
  const [clock, setClock] = React.useState(new Date().toLocaleTimeString())
  const prevCountRef = React.useRef(0)
  const matchTimerRef = React.useRef(null)

  React.useEffect(() => { injectCSS() }, [])

  // Clock tick
  React.useEffect(() => {
    const t = setInterval(() => setClock(new Date().toLocaleTimeString()), 1000)
    return () => clearInterval(t)
  }, [])

  const fetchStatus = React.useCallback(async () => {
    try {
      const res = await fetch(`${ATTENDANCE_API_URL}/live/status`)
      if (!res.ok) return
      const { live: data } = await res.json()
      setLive(data || {})

      const dets = data?.recentDetections || []
      const count = data?.detectionCount ?? dets.length
      if (count > prevCountRef.current) {
        const newest = dets[0]
        clearTimeout(matchTimerRef.current)
        if (newest?.match) {
          setLastMatch(newest.match)
          setMatchState('matched')
          matchTimerRef.current = setTimeout(() => setMatchState('scanning'), 4500)
        } else {
          setMatchState('unknown')
          matchTimerRef.current = setTimeout(() => setMatchState('scanning'), 2500)
        }
      }
      prevCountRef.current = count

      if (!data?.running) setMatchState('idle')
      else if (data?.cameraOpen && matchState === 'idle') setMatchState('scanning')
    } catch (_) {}
  }, [matchState])

  React.useEffect(() => {
    fetchStatus()
    const iv = setInterval(fetchStatus, 2000)
    return () => clearInterval(iv)
  }, [fetchStatus])

  const runGate = async (action) => {
    setLoading(true)
    try {
      const res = await fetch(`${ATTENDANCE_API_URL}/live/${action}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `Failed to ${action}`)
      setLive(data.live || {})
      if (action === 'start') setMatchState('scanning')
      else { setMatchState('idle'); setLastMatch(null); prevCountRef.current = 0 }
    } catch (_) {}
    finally { setLoading(false) }
  }

  // Theme colors
  const C = matchState === 'matched' ? '#22c55e'
           : matchState === 'unknown' ? '#ef4444'
           : '#6366f1'
  const glowAnim = matchState === 'matched' ? 'glow-match 1.4s ease-in-out infinite'
                 : matchState === 'unknown'  ? 'glow-fail 0.9s ease-in-out infinite'
                 : 'glow-idle 3s ease-in-out infinite'

  const recognizedToday = live.recentDetections?.filter(d => d.match).length || 0

  return (
    <div style={S.page}>
      {/* ── HEADER ─────────────────────────────── */}
      <header style={S.header}>
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:'0.6rem', marginBottom:'0.4rem' }}>
            <span style={{ ...S.liveDot, background: live.running ? '#22c55e' : '#475569',
              boxShadow: live.running ? '0 0 10px #22c55e, 0 0 20px #22c55e44' : 'none' }} />
            <p style={S.eyebrow}>Gate Attendance System · {clock}</p>
          </div>
          <h1 style={S.title}>Smart Gate Scanner</h1>
          <p style={S.subtitle}>AI face recognition marks students present as they enter the gate</p>
        </div>
        <div style={S.statRow}>
          <StatPill label="Recognized" value={recognizedToday} color="#22c55e" />
          <StatPill label="Known faces" value={live.encodingCount || 0} color="#818cf8" />
          <StatPill label="Camera" value={live.cameraOpen ? 'LIVE' : 'OFF'} color={live.cameraOpen ? '#22c55e' : '#64748b'} />
        </div>
      </header>

      {/* ── MAIN LAYOUT ────────────────────────── */}
      <div style={S.grid}>

        {/* SCANNER PANEL */}
        <div style={S.scannerCol}>

          {/* Viewfinder */}
          <div style={{ ...S.viewfinder, animation: glowAnim, borderColor: `${C}55` }}>

            {/* Live camera stream */}
            {live.running && (
              <img
                src={`${ATTENDANCE_API_URL}/live/stream`}
                alt="live feed"
                style={S.streamImg}
                onError={e => { e.target.style.display = 'none' }}
              />
            )}

            {/* Corner brackets */}
            {[['top','left'],['top','right'],['bottom','left'],['bottom','right']].map(([v,h]) => (
              <div key={`${v}${h}`} className="gate-corner" style={{
                position:'absolute', width:32, height:32,
                [v]: 12, [h]: 12,
                borderTop:    v==='top'    ? `3px solid ${C}` : 'none',
                borderBottom: v==='bottom' ? `3px solid ${C}` : 'none',
                borderLeft:   h==='left'   ? `3px solid ${C}` : 'none',
                borderRight:  h==='right'  ? `3px solid ${C}` : 'none',
                zIndex: 10,
              }} />
            ))}

            {/* Scan line */}
            {matchState === 'scanning' && (
              <div style={{ ...S.scanLine, background:
                `linear-gradient(90deg,transparent,${C}88,${C}ff,${C}88,transparent)`,
                boxShadow: `0 0 14px 5px ${C}44` }} />
            )}

            {/* Pulse rings on match */}
            {matchState === 'matched' && [0, 0.55, 1.1].map(delay => (
              <div key={delay} style={{ ...S.pulseRing,
                borderColor: C,
                animationDelay: `${delay}s` }} />
            ))}

            {/* Grid overlay — subtle on top of feed */}
            <div style={S.gridOverlay} />

            {/* Bottom info bar when matched/unknown */}
            {(matchState === 'matched' || matchState === 'unknown') && (
              <div style={S.infoBar}>
                {matchState === 'matched' && lastMatch && <MatchedView match={lastMatch} />}
                {matchState === 'unknown' && <UnknownView />}
              </div>
            )}

            {/* Center content only when not streaming */}
            {!live.running && (
              <div style={S.vfCenter}>
                {matchState === 'idle' && <IdleView />}
                {matchState === 'scanning' && <ScanningView color={C} />}
              </div>
            )}

            {/* Scanning radar overlay when running but no match yet */}
            {live.running && matchState === 'scanning' && (
              <div style={S.radarOverlay}>
                <ScanningView color={C} />
              </div>
            )}
          </div>

          {/* Controls */}
          <div style={S.ctrlRow}>
            <button onClick={() => runGate('start')} disabled={loading || live.running}
              style={{ ...S.btn, ...S.btnStart, opacity: live.running ? 0.45 : 1 }}>
              {live.running ? '⬤  RUNNING' : '▶  START GATE'}
            </button>
            <button onClick={() => runGate('stop')} disabled={loading || !live.running}
              style={{ ...S.btn, ...S.btnStop, opacity: !live.running ? 0.45 : 1 }}>
              ■  STOP
            </button>
          </div>

          {/* Status bar */}
          <div style={S.statusBar}>
            <span style={{ color: live.cameraOpen ? '#4ade80' : '#475569', fontSize:'0.8rem' }}>
              {live.cameraOpen ? '⬤ Camera active' : '⬤ Camera off'}
            </span>
            <span style={{ color:'#818cf8', fontSize:'0.8rem' }}>
              {live.encodingCount || 0} registered faces
            </span>
            <span style={{ color:'#334155', fontSize:'0.8rem' }}>
              Press Q in camera window to stop
            </span>
          </div>
        </div>

        {/* DETECTION LOG */}
        <div style={S.sidebar}>
          <div style={S.sidebarHead}>
            <span style={S.sidebarTitle}>DETECTION LOG</span>
            <span style={S.sidebarBadge}>{live.recentDetections?.length || 0}</span>
          </div>
          <div style={S.detList}>
            {!(live.recentDetections?.length) ? (
              <div style={S.emptyLog}>
                <div style={{ fontSize:'2.5rem', opacity:0.3, marginBottom:'0.5rem' }}>📡</div>
                <p style={{ color:'#334155', textAlign:'center', fontSize:'0.85rem' }}>
                  Waiting for detections…
                </p>
              </div>
            ) : live.recentDetections.slice(0, 15).map((entry, i) => (
              <DetCard key={`${entry.detectedAt}-${i}`} entry={entry} idx={i} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Sub-components ─────────────────────────────────────── */

function IdleView() {
  return (
    <div style={{ textAlign:'center', color:'#334155' }}>
      <div style={{ fontSize:'3.5rem', marginBottom:'0.75rem', opacity:0.5 }}>🎯</div>
      <p style={{ fontSize:'0.95rem', letterSpacing:'0.1em' }}>START GATE TO BEGIN</p>
    </div>
  )
}

function ScanningView({ color }) {
  return (
    <div style={{ textAlign:'center' }}>
      <div style={SR.radarWrap}>
        <div style={{ ...SR.radarRing, width:160, height:160, borderColor:`${color}22` }} />
        <div style={{ ...SR.radarRing, width:110, height:110, borderColor:`${color}33` }} />
        <div style={SR.radarInner}>
          <div style={{ ...SR.sweep,
            background:`linear-gradient(90deg,${color}cc,transparent)` }} />
          <div style={{ ...SR.dot, background:color, boxShadow:`0 0 10px ${color}` }} />
        </div>
      </div>
      <p style={{ color:'#818cf8', fontSize:'0.85rem', marginTop:'1.5rem',
        letterSpacing:'0.2em', animation:'stat-glow 1.8s ease-in-out infinite' }}>
        SCANNING FOR FACES…
      </p>
    </div>
  )
}

function MatchedView({ match }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:'1rem',
      animation:'name-in 0.45s ease-out forwards', width:'100%' }}>
      <div style={{ fontSize:'2.8rem', animation:'heartbeat 1.4s ease-in-out infinite',
        flexShrink:0 }}>✅</div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={MR.shimmer}>{match.name}</div>
        <div style={MR.sub}>{match.rollNumber} · {match.className} {match.section}</div>
      </div>
      <div style={{ ...MR.badge, animation:'badge-pop 0.4s ease-out', flexShrink:0 }}>
        ✓ PRESENT
      </div>
    </div>
  )
}

function UnknownView() {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:'1rem',
      animation:'name-in 0.3s ease-out forwards', width:'100%' }}>
      <div style={{ fontSize:'2.8rem', flexShrink:0 }}>⚠️</div>
      <div>
        <div style={{ color:'#fca5a5', fontSize:'1.3rem', fontWeight:800 }}>NOT REGISTERED</div>
        <div style={{ color:'#f87171', fontSize:'0.85rem', marginTop:'0.2rem',
          letterSpacing:'0.08em' }}>Face not found in database</div>
      </div>
    </div>
  )
}

function DetCard({ entry, idx }) {
  const ok = !!entry.match
  return (
    <div className="gate-det-card" style={{
      ...DC.card,
      borderLeftColor: ok ? '#22c55e' : '#ef4444',
      animationDelay: `${idx * 0.04}s`,
      opacity: 0,
    }}>
      <div style={DC.row}>
        <span style={{ ...DC.name, color: ok ? '#4ade80' : '#f87171' }}>
          {ok ? entry.match.name : 'Unknown'}
        </span>
        <span style={{ ...DC.pct, color: ok ? '#86efac' : '#fca5a5' }}>
          {((entry.confidence || 0) * 100).toFixed(0)}%
        </span>
      </div>
      {ok && (
        <div style={DC.meta}>
          {entry.match.rollNumber} · {entry.match.className}-{entry.match.section}
        </div>
      )}
      <div style={DC.time}>{new Date(entry.detectedAt).toLocaleTimeString()}</div>
    </div>
  )
}

function StatPill({ label, value, color }) {
  return (
    <div style={SP.wrap}>
      <strong style={{ ...SP.val, color, animation:'stat-glow 2s ease-in-out infinite' }}>
        {value}
      </strong>
      <span style={SP.lbl}>{label}</span>
    </div>
  )
}

/* ── Styles ─────────────────────────────────────────────── */

const S = {
  page: {
    minHeight: '100vh',
    background: 'radial-gradient(ellipse at 20% 0%, #12022f 0%, #08081c 45%, #020209 100%)',
    padding: '1.5rem',
    color: '#e2e8f0',
    fontFamily: "'Courier New', Courier, monospace",
  },
  header: {
    display:'flex', justifyContent:'space-between', alignItems:'flex-start',
    gap:'1.5rem', marginBottom:'2rem', flexWrap:'wrap',
  },
  liveDot: { width:10, height:10, borderRadius:'50%', transition:'all 0.4s', flexShrink:0 },
  eyebrow: {
    margin:0, fontSize:'0.72rem', letterSpacing:'0.22em',
    textTransform:'uppercase', color:'#818cf8', fontWeight:700,
  },
  title: {
    margin:'0.35rem 0 0', fontSize:'clamp(1.8rem,3vw,2.6rem)',
    fontWeight:900, letterSpacing:'-0.035em', color:'#f1f5f9',
  },
  subtitle: { margin:'0.4rem 0 0', color:'#475569', maxWidth:'460px', fontSize:'0.9rem' },
  statRow: { display:'flex', gap:'0.75rem', flexWrap:'wrap' },
  grid: {
    display:'grid', gridTemplateColumns:'1fr 360px',
    gap:'1.25rem', alignItems:'start',
  },
  scannerCol: { display:'flex', flexDirection:'column', gap:'1rem' },
  viewfinder: {
    position:'relative', height:'480px', borderRadius:'24px',
    border:'1px solid', overflow:'hidden',
    background:'linear-gradient(160deg,rgba(10,8,28,0.95),rgba(5,5,18,0.98))',
    display:'flex', alignItems:'center', justifyContent:'center',
    transition:'border-color 0.4s',
  },
  scanLine: {
    position:'absolute', left:0, right:0, height:'3px',
    animation:'scan-line 3.2s ease-in-out infinite', zIndex:5, pointerEvents:'none',
  },
  pulseRing: {
    position:'absolute', width:180, height:180, borderRadius:'50%',
    border:'2px solid', animation:'pulse-ring 1.6s ease-out infinite',
    pointerEvents:'none',
  },
  gridOverlay: {
    position:'absolute', inset:0, pointerEvents:'none',
    backgroundImage:'linear-gradient(rgba(99,102,241,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,0.04) 1px,transparent 1px)',
    backgroundSize:'40px 40px',
  },
  streamImg: {
    position:'absolute', inset:0, width:'100%', height:'100%',
    objectFit:'cover', zIndex:1, borderRadius:'23px',
  },
  infoBar: {
    position:'absolute', bottom:0, left:0, right:0, zIndex:8,
    background:'linear-gradient(0deg,rgba(2,2,12,0.92) 60%,transparent)',
    padding:'1.5rem 1.5rem 1.25rem',
    display:'flex', justifyContent:'center',
  },
  radarOverlay: {
    position:'absolute', top:'50%', left:'50%',
    transform:'translate(-50%,-50%)', zIndex:7,
    pointerEvents:'none', opacity:0.55,
  },
  vfCenter: { position:'relative', zIndex:6, padding:'1.5rem' },
  ctrlRow: { display:'flex', gap:'0.75rem' },
  btn: {
    flex:1, padding:'1rem', border:'none', borderRadius:'14px',
    fontSize:'0.9rem', fontWeight:800, letterSpacing:'0.12em',
    cursor:'pointer', fontFamily:'inherit', transition:'all 0.25s',
  },
  btnStart: {
    background:'linear-gradient(135deg,#4f46e5,#7c3aed)',
    color:'#fff', boxShadow:'0 0 24px rgba(79,70,229,0.5)',
  },
  btnStop: {
    background:'rgba(239,68,68,0.12)', color:'#f87171',
    border:'1px solid rgba(239,68,68,0.35)',
  },
  statusBar: {
    display:'flex', justifyContent:'space-between', flexWrap:'wrap', gap:'0.5rem',
    padding:'0.7rem 1rem',
    background:'rgba(15,23,42,0.5)', borderRadius:'12px',
    border:'1px solid rgba(99,102,241,0.1)',
  },
  sidebar: {
    background:'rgba(8,8,24,0.8)', borderRadius:'20px',
    border:'1px solid rgba(99,102,241,0.18)', overflow:'hidden',
    display:'flex', flexDirection:'column', maxHeight:'580px',
  },
  sidebarHead: {
    display:'flex', justifyContent:'space-between', alignItems:'center',
    padding:'0.9rem 1.25rem', borderBottom:'1px solid rgba(99,102,241,0.12)',
    background:'rgba(99,102,241,0.06)',
  },
  sidebarTitle: { fontSize:'0.72rem', letterSpacing:'0.22em', color:'#818cf8', fontWeight:800 },
  sidebarBadge: {
    background:'rgba(99,102,241,0.2)', color:'#a5b4fc',
    padding:'0.2rem 0.65rem', borderRadius:'999px',
    fontSize:'0.78rem', fontWeight:700,
  },
  detList: {
    padding:'0.75rem', overflowY:'auto', flex:1,
    display:'flex', flexDirection:'column', gap:'0.5rem',
  },
  emptyLog: {
    flex:1, display:'flex', flexDirection:'column',
    alignItems:'center', justifyContent:'center', padding:'3rem 1rem',
  },
}

const SP = {
  wrap: {
    display:'flex', flexDirection:'column', alignItems:'center',
    padding:'0.85rem 1.25rem', minWidth:'110px',
    background:'rgba(8,8,24,0.7)', borderRadius:'16px',
    border:'1px solid rgba(99,102,241,0.18)',
  },
  val: { fontSize:'1.9rem', fontWeight:900, lineHeight:1 },
  lbl: { fontSize:'0.66rem', color:'#475569', textTransform:'uppercase',
    letterSpacing:'0.12em', marginTop:'0.35rem' },
}

const SR = {
  radarWrap: { position:'relative', width:160, height:160, margin:'0 auto',
    display:'flex', alignItems:'center', justifyContent:'center' },
  radarRing: {
    position:'absolute', borderRadius:'50%', border:'1px solid',
  },
  radarInner: {
    width:80, height:80, borderRadius:'50%', overflow:'hidden',
    position:'relative', display:'flex', alignItems:'center', justifyContent:'center',
    border:'1px solid rgba(99,102,241,0.4)',
  },
  sweep: {
    position:'absolute', top:'50%', left:'50%', width:'50%', height:'2px',
    transformOrigin:'left center', animation:'radar-spin 2s linear infinite',
    boxShadow:'0 0 8px 2px rgba(99,102,241,0.5)',
  },
  dot: { width:8, height:8, borderRadius:'50%', position:'relative', zIndex:2 },
}

const MR = {
  shimmer: {
    fontSize:'clamp(1.6rem,3vw,2.2rem)', fontWeight:900, letterSpacing:'-0.02em',
    background:'linear-gradient(90deg,#4ade80,#86efac,#4ade80,#86efac)',
    backgroundSize:'200% auto',
    WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text',
    animation:'shimmer-move 1.8s linear infinite',
  },
  sub: { color:'#86efac', fontSize:'0.95rem', marginTop:'0.4rem', opacity:0.85 },
  badge: {
    display:'inline-block', marginTop:'1rem', padding:'0.5rem 1.4rem',
    background:'linear-gradient(135deg,#16a34a,#15803d)',
    color:'#fff', borderRadius:'999px', fontWeight:800,
    fontSize:'0.8rem', letterSpacing:'0.14em',
    boxShadow:'0 0 24px rgba(34,197,94,0.55)',
  },
}

const DC = {
  card: {
    background:'rgba(15,23,42,0.65)', borderRadius:'10px',
    padding:'0.8rem 1rem', borderLeft:'3px solid',
    borderTop:'1px solid rgba(255,255,255,0.04)',
    borderRight:'1px solid rgba(255,255,255,0.04)',
    borderBottom:'1px solid rgba(255,255,255,0.04)',
  },
  row: { display:'flex', justifyContent:'space-between', alignItems:'center' },
  name: { fontWeight:700, fontSize:'0.9rem' },
  pct:  { fontSize:'0.8rem', fontWeight:700 },
  meta: { fontSize:'0.74rem', color:'#475569', marginTop:'0.18rem' },
  time: { fontSize:'0.68rem', color:'#334155', marginTop:'0.22rem' },
}
