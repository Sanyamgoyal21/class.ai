import React, { useState, useCallback, useEffect, useRef } from 'react'
import { ATTENDANCE_API_URL as _BASE, BACKEND_URL } from '../utils/backendUrl'

// Attendance API must always reach the local Python service directly.
const ATTENDANCE_API_URL = _BASE.includes('localhost') || _BASE.includes('127.0.0.1')
  ? _BASE
  : 'http://localhost:8000/attendance'

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

/* ═══════════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════════ */
export default function AttendanceSystem() {
  const [tab, setTab] = useState('register')

  return (
    <div style={S.page}>
      <header style={S.header}>
        <div>
          <p style={S.eyebrow}>Attendance Management</p>
          <h1 style={S.title}>Student Attendance System</h1>
          <p style={S.subtitle}>MongoDB-backed · Register once · Automatic daily gate attendance</p>
        </div>
      </header>

      <nav style={S.tabs}>
        {[
          { id: 'register', label: '+ Register Student' },
          { id: 'records',  label: '📋 Daily Records'   },
          { id: 'roster',   label: '👥 Student Roster'  },
          { id: 'history',  label: '📈 Student History'  },
          { id: 'summary',  label: '📊 Summary'          },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{ ...S.tab, ...(tab === t.id ? S.tabActive : {}) }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'register' && <RegisterPanel />}
      {tab === 'records'  && <RecordsPanel />}
      {tab === 'roster'   && <RosterPanel />}
      {tab === 'history'  && <HistoryPanel />}
      {tab === 'summary'  && <SummaryPanel />}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   REGISTER PANEL
═══════════════════════════════════════════════════════════ */
function RegisterPanel() {
  const videoRef  = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const detectRef = useRef(null)
  const busyRef   = useRef(false)

  const [form, setForm] = useState({ name: '', rollNumber: '', className: '', section: '', parentMobile: '', parentEmail: '' })
  const [samples, setSamples] = useState([])
  const [camState, setCamState] = useState('idle')
  const [camError, setCamError] = useState('')
  const [faceDetected, setFaceDetected] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => () => stopCam(), [])

  const stopCam = () => {
    clearInterval(detectRef.current)
    detectRef.current = null
    busyRef.current = false
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCamState('idle')
    setFaceDetected(false)
  }

  const startCam = async () => {
    setCamError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCamState('live')
      if (typeof window.FaceDetector !== 'undefined') {
        const detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 })
        detectRef.current = setInterval(() => runBrowserDetect(detector), 600)
      } else {
        setFaceDetected(true)
      }
    } catch (e) {
      setCamState('error')
      setCamError(e.message || 'Camera access denied')
    }
  }

  const runBrowserDetect = async (detector) => {
    if (busyRef.current || !videoRef.current?.videoWidth) return
    busyRef.current = true
    try {
      const faces = await detector.detect(videoRef.current)
      const overlay = canvasRef.current
      if (!overlay || !videoRef.current) return
      overlay.width  = videoRef.current.videoWidth
      overlay.height = videoRef.current.videoHeight
      const ctx = overlay.getContext('2d')
      ctx.clearRect(0, 0, overlay.width, overlay.height)
      if (faces.length > 0) {
        const { x, y, width, height } = faces[0].boundingBox
        const mirroredX = overlay.width - x - width
        ctx.strokeStyle = '#22c55e'
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.roundRect(mirroredX, y, width, height, 6)
        ctx.stroke()
        setFaceDetected(true)
      } else {
        setFaceDetected(false)
      }
    } catch {
      setFaceDetected(true)
    } finally { busyRef.current = false }
  }

  const capture = () => {
    if (!videoRef.current) return
    const c = document.createElement('canvas')
    c.width  = videoRef.current.videoWidth  || 640
    c.height = videoRef.current.videoHeight || 480
    c.getContext('2d').drawImage(videoRef.current, 0, 0)
    setSamples(prev => [...prev, c.toDataURL('image/jpeg', 0.92)])
  }

  const removeSample = (idx) => setSamples(prev => prev.filter((_, i) => i !== idx))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setMsg(null)
    const { name, rollNumber, className, section, parentMobile, parentEmail } = form
    if (!name.trim() || !rollNumber.trim() || !className.trim() || !section.trim()) {
      return setMsg({ type: 'err', text: 'Name, roll number, class, and section are required.' })
    }
    if (samples.length < 3) {
      return setMsg({ type: 'err', text: `Capture at least 3 face samples (you have ${samples.length}).` })
    }
    setRegistering(true)
    try {
      const res = await fetch(`${ATTENDANCE_API_URL}/students/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), rollNumber: rollNumber.trim(), className: className.trim(), section: section.trim(), parentMobile: parentMobile.trim(), parentEmail: parentEmail.trim(), images: samples }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Registration failed')
      setMsg({ type: 'ok', text: `✅ ${data.student.name} registered successfully with ${samples.length} face samples. Saved to MongoDB.` })
      setForm({ name: '', rollNumber: '', className: '', section: '', parentMobile: '', parentEmail: '' })
      setSamples([])
      stopCam()
    } catch (err) {
      setMsg({ type: 'err', text: err.message })
    } finally {
      setRegistering(false)
    }
  }

  const live = camState === 'live'

  return (
    <div style={R.wrap}>
      <div style={R.left}>
        <div style={R.card}>
          <h2 style={R.cardTitle}>Student Details</h2>
          <p style={R.cardSub}>Fill in details, then capture 5 face angles from the camera.</p>

          <form onSubmit={handleSubmit} style={R.form}>
            <div style={R.grid2}>
              <Field label="Full Name *" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} placeholder="Rahul Sharma" />
              <Field label="Roll Number *" value={form.rollNumber} onChange={v => setForm(p => ({ ...p, rollNumber: v }))} placeholder="2024CS001" />
              <Field label="Class *" value={form.className} onChange={v => setForm(p => ({ ...p, className: v }))} placeholder="10" />
              <Field label="Section *" value={form.section} onChange={v => setForm(p => ({ ...p, section: v }))} placeholder="A" />
            </div>
            <Field label="Parent Mobile" value={form.parentMobile} onChange={v => setForm(p => ({ ...p, parentMobile: v }))} placeholder="9876543210" type="tel" />
            <Field label="Parent Email" value={form.parentEmail} onChange={v => setForm(p => ({ ...p, parentEmail: v }))} placeholder="parent@example.com" type="email" />

            {msg && (
              <div style={{ ...R.msg, background: msg.type === 'ok' ? '#f0fdf4' : '#fff1f2', color: msg.type === 'ok' ? '#15803d' : '#be123c', borderColor: msg.type === 'ok' ? '#86efac' : '#fecdd3' }}>
                {msg.text}
              </div>
            )}

            <div style={R.camCard}>
              <div style={R.camHead}>
                <span style={R.camTitle}>Face Capture</span>
                <span style={{ ...R.camBadge, background: live && faceDetected ? '#dcfce7' : live ? '#fef9c3' : '#f1f5f9', color: live && faceDetected ? '#15803d' : live ? '#854d0e' : '#64748b' }}>
                  {live && faceDetected ? '✓ Face detected' : live ? 'No face' : 'Camera off'}
                </span>
              </div>

              <div style={R.videoBox}>
                <video ref={videoRef} muted playsInline style={{ ...R.video, opacity: live ? 1 : 0 }} />
                <canvas ref={canvasRef} style={R.canvas} />
                {!live && (
                  <div style={R.videoPlaceholder}>
                    {camState === 'error'
                      ? <><div style={{ fontSize: '2rem' }}>⚠️</div><p style={{ color: '#ef4444', fontSize: '0.85rem', marginTop: '0.5rem' }}>{camError}</p></>
                      : <><div style={{ fontSize: '2.5rem', opacity: 0.3 }}>📷</div><p style={{ color: '#94a3b8', fontSize: '0.85rem', marginTop: '0.5rem' }}>Open camera to begin</p></>
                    }
                  </div>
                )}
              </div>

              <div style={R.camActions}>
                {!live
                  ? <button type="button" onClick={startCam} style={R.btnSecondary}>📷 Open Camera</button>
                  : <>
                      <button type="button" onClick={capture} disabled={!faceDetected} style={{ ...R.btnCapture, opacity: faceDetected ? 1 : 0.4 }}>
                        ⊕ Capture Sample
                      </button>
                      <button type="button" onClick={stopCam} style={R.btnDanger}>✕ Close</button>
                    </>
                }
              </div>

              <p style={R.hint}>Capture 5 angles: straight · left · right · up · down — minimum 3 required</p>

              {samples.length > 0 && (
                <div style={R.thumbRow}>
                  {samples.map((src, i) => (
                    <div key={i} style={R.thumbWrap}>
                      <img src={src} alt={`Sample ${i + 1}`} style={R.thumb} />
                      <button type="button" onClick={() => removeSample(i)} style={R.thumbDel}>✕</button>
                      <span style={R.thumbNum}>{i + 1}</span>
                    </div>
                  ))}
                </div>
              )}
              {samples.length === 0 && (
                <p style={{ color: '#94a3b8', fontSize: '0.82rem', margin: '0.5rem 0 0', textAlign: 'center' }}>No samples captured yet</p>
              )}
            </div>

            <button type="submit" disabled={registering || samples.length < 3} style={{ ...R.btnPrimary, opacity: (registering || samples.length < 3) ? 0.55 : 1 }}>
              {registering ? 'Registering…' : `Register Student (${samples.length} samples)`}
            </button>
          </form>
        </div>
      </div>

      <div style={R.right}>
        <div style={R.infoCard}>
          <h3 style={R.infoTitle}>How registration works</h3>
          <ol style={R.steps}>
            {[
              'Fill in the student\'s name, roll number, class, section, parent mobile, and parent email.',
              'Open the camera and position the student\'s face in the frame.',
              'Capture 5 face samples from different angles for best accuracy.',
              'Click "Register Student" — face encodings and student info are saved to MongoDB.',
              'The student will now be auto-recognised at the gate camera every day.',
            ].map((step, i) => (
              <li key={i} style={R.step}>
                <span style={R.stepNum}>{i + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
        <div style={{ ...R.infoCard, marginTop: '1rem' }}>
          <h3 style={R.infoTitle}>Tips for best accuracy</h3>
          <ul style={R.tips}>
            {[
              'Good, even lighting — avoid backlight',
              'Face fully visible, no hat or mask',
              'Capture different angles and expressions',
              'At least 5 samples per student recommended',
              'Re-register if recognition accuracy drops',
            ].map((tip, i) => <li key={i} style={R.tip}>✓ {tip}</li>)}
          </ul>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   RECORDS PANEL
═══════════════════════════════════════════════════════════ */
function RecordsPanel() {
  const [filters, setFilters] = useState({ date: today(), className: '', section: '' })
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [fetchError, setFetchError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setFetchError('')
    try {
      const p = new URLSearchParams({ date: filters.date })
      if (filters.className) p.set('className', filters.className)
      if (filters.section)   p.set('section', filters.section)
      const res = await fetch(`${ATTENDANCE_API_URL}/records?${p}`)
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json()
      setRecords(data.records || [])
    } catch (err) {
      setFetchError(err.message)
      setRecords([])
    } finally { setLoading(false) }
  }, [filters])

  useEffect(() => { load() }, [load])

  const mark = async (record, status) => {
    try {
      await fetch(`${ATTENDANCE_API_URL}/records/manual`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: record.studentId, date: filters.date, status }),
      })
      setMsg(`Marked ${record.student?.name} as ${status}`)
      load()
      setTimeout(() => setMsg(''), 3000)
    } catch {
      // ignore
    }
  }

  const present = records.filter(r => r.status === 'present').length
  const absent  = records.filter(r => r.status !== 'present').length

  const [mailing, setMailing] = useState(false)
  const [mailMsg, setMailMsg] = useState(null)

  const sendAbsenceEmails = async () => {
    setMailing(true)
    setMailMsg(null)
    try {
      const body = { date: filters.date }
      if (filters.className) body.className = filters.className
      if (filters.section)   body.section   = filters.section
      const notifyUrl = BACKEND_URL.includes('localhost') || BACKEND_URL.includes('127.0.0.1')
        ? BACKEND_URL
        : 'http://localhost:5000'
      const res = await fetch(`${notifyUrl}/api/attendance/notify-absent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to send emails')
      const failDetail = data.failed?.length
        ? ` | Failed: ${data.failed.map(f => f.error).join('; ')}`
        : ''
      setMailMsg({ type: data.sent > 0 ? 'ok' : 'err', text: data.message + failDetail })
    } catch (err) {
      setMailMsg({ type: 'err', text: err.message })
    } finally {
      setMailing(false)
      setTimeout(() => setMailMsg(null), 6000)
    }
  }

  return (
    <div style={REC.wrap}>
      <div style={REC.stats}>
        <StatBox label="Total"   value={records.length} color="#6366f1" />
        <StatBox label="Present" value={present}        color="#22c55e" />
        <StatBox label="Absent"  value={absent}         color="#ef4444" />
        <StatBox label="Rate" value={records.length ? `${Math.round((present/records.length)*100)}%` : '—'} color="#f59e0b" />
      </div>

      <div style={REC.filters}>
        <label style={REC.filterField}>
          <span style={REC.filterLabel}>Date</span>
          <input type="date" value={filters.date} onChange={e => setFilters(p => ({ ...p, date: e.target.value }))} style={REC.input} />
        </label>
        <label style={REC.filterField}>
          <span style={REC.filterLabel}>Class</span>
          <input type="text" placeholder="10" value={filters.className} onChange={e => setFilters(p => ({ ...p, className: e.target.value }))} style={REC.input} />
        </label>
        <label style={REC.filterField}>
          <span style={REC.filterLabel}>Section</span>
          <input type="text" placeholder="A" value={filters.section} onChange={e => setFilters(p => ({ ...p, section: e.target.value }))} style={REC.input} />
        </label>
        <button onClick={load} style={REC.applyBtn}>Apply</button>
        <button
          onClick={sendAbsenceEmails}
          disabled={mailing || absent === 0}
          style={{
            ...REC.applyBtn,
            background: mailing ? '#94a3b8' : '#ef4444',
            color: '#fff',
            opacity: absent === 0 ? 0.45 : 1,
            display: 'flex', alignItems: 'center', gap: '0.4rem',
          }}
          title={absent === 0 ? 'No absent students' : `Notify parents of ${absent} absent student(s)`}
        >
          {mailing ? 'Sending…' : `✉ Send Mail to Parents${absent > 0 ? ` (${absent})` : ''}`}
        </button>
      </div>

      {mailMsg && (
        <div style={{
          padding: '0.75rem 1rem', borderRadius: 10, fontSize: '0.88rem', fontWeight: 600,
          background: mailMsg.type === 'ok' ? '#f0fdf4' : '#fff1f2',
          color:      mailMsg.type === 'ok' ? '#15803d' : '#be123c',
          border:    `1px solid ${mailMsg.type === 'ok' ? '#86efac' : '#fecdd3'}`,
        }}>
          {mailMsg.text}
        </div>
      )}
      {msg && <div style={REC.toast}>{msg}</div>}
      {fetchError && (
        <div style={{ padding: '0.75rem 1rem', borderRadius: 10, background: '#fff1f2', color: '#be123c', fontWeight: 600, fontSize: '0.88rem', border: '1px solid #fecdd3' }}>
          Failed to load records: {fetchError} — Is the Python backend running at {ATTENDANCE_API_URL}?
        </div>
      )}

      <div style={REC.tableWrap}>
        {loading ? (
          <div style={REC.empty}>Loading…</div>
        ) : records.length === 0 ? (
          <div style={REC.empty}>No records found for the selected filters.</div>
        ) : (
          <table style={REC.table}>
            <thead>
              <tr>
                {['Name', 'Roll No', 'Class', 'Status', 'Time', 'Actions'].map(h => (
                  <th key={h} style={REC.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map(r => (
                <tr key={r.id} style={REC.tr}>
                  <td style={REC.td}><strong>{r.student?.name}</strong></td>
                  <td style={REC.td}>{r.student?.rollNumber}</td>
                  <td style={REC.td}>{r.student?.className}-{r.student?.section}</td>
                  <td style={REC.td}>
                    <span style={{ ...REC.badge, background: r.status === 'present' ? '#dcfce7' : '#fee2e2', color: r.status === 'present' ? '#15803d' : '#be123c' }}>
                      {r.status === 'present' ? '✓ Present' : '✗ Absent'}
                    </span>
                  </td>
                  <td style={REC.td}>{r.markedAt ? new Date(r.markedAt).toLocaleTimeString() : '—'}</td>
                  <td style={REC.td}>
                    <div style={{ display: 'flex', gap: '0.4rem' }}>
                      <button onClick={() => mark(r, 'present')} style={REC.btnP} disabled={r.status === 'present'}>Present</button>
                      <button onClick={() => mark(r, 'absent')}  style={REC.btnA} disabled={r.status === 'absent'}>Absent</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   ROSTER PANEL
═══════════════════════════════════════════════════════════ */
function RosterPanel() {
  const [students, setStudents] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    fetch(`${ATTENDANCE_API_URL}/students`)
      .then(r => r.json())
      .then(d => setStudents(d.students || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filtered = students.filter(s =>
    !search ||
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.rollNumber?.toLowerCase().includes(search.toLowerCase()) ||
    s.className?.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div style={ROS.wrap}>
      <div style={ROS.toolbar}>
        <input
          type="text"
          placeholder="Search by name, roll, or class…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={ROS.search}
        />
        <span style={ROS.count}>{filtered.length} students</span>
      </div>

      {loading ? (
        <div style={ROS.empty}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={ROS.empty}>{search ? 'No students match your search.' : 'No students registered yet.'}</div>
      ) : (
        <div style={ROS.grid}>
          {filtered.map(s => (
            <div key={s.id} style={{ ...ROS.card, outline: selected === s.id ? '2px solid #6366f1' : 'none' }} onClick={() => setSelected(s.id)}>
              <div style={ROS.avatar}>{s.name.charAt(0).toUpperCase()}</div>
              <div style={ROS.info}>
                <strong style={ROS.name}>{s.name}</strong>
                <p style={ROS.meta}>{s.rollNumber} · {s.className}-{s.section}</p>
                {s.parentMobile && <p style={ROS.meta}>📞 {s.parentMobile}</p>}
                <p style={ROS.samples}>{s.sampleImagePaths?.length || 0} face samples</p>
                <p style={{ ...ROS.meta, marginTop: '0.3rem', color: '#94a3b8' }}>
                  Joined {s.registeredAt ? new Date(s.registeredAt).toLocaleDateString() : '—'}
                </p>
              </div>
              <span style={{ ...ROS.badge, background: (s.sampleImagePaths?.length || 0) >= 3 ? '#dcfce7' : '#fef9c3', color: (s.sampleImagePaths?.length || 0) >= 3 ? '#15803d' : '#854d0e' }}>
                {(s.sampleImagePaths?.length || 0) >= 3 ? 'Ready' : 'Needs samples'}
              </span>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <MiniHistory studentId={selected} students={students} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}

/* Mini history drawer shown inside roster */
function MiniHistory({ studentId, students, onClose }) {
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const student = students.find(s => s.id === studentId)

  useEffect(() => {
    let cancelled = false
    fetch(`${ATTENDANCE_API_URL}/students/${studentId}/history?limit=30`)
      .then(r => r.json())
      .then(d => { if (!cancelled) { setHistory(d.history || []); setLoading(false) } })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [studentId])

  const presentDays = history.filter(h => h.status === 'present').length

  return (
    <div style={HIS.drawer}>
      <div style={HIS.drawerHead}>
        <div>
          <strong style={{ fontSize: '1rem', color: '#0f172a' }}>{student?.name}</strong>
          <p style={{ margin: '0.1rem 0 0', color: '#64748b', fontSize: '0.82rem' }}>
            {student?.rollNumber} · {student?.className}-{student?.section}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, color: '#22c55e', fontSize: '0.9rem' }}>{presentDays} / {history.length} days</span>
          <button onClick={onClose} style={HIS.closeBtn}>✕</button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: '1.5rem', textAlign: 'center', color: '#94a3b8' }}>Loading…</div>
      ) : history.length === 0 ? (
        <div style={{ padding: '1.5rem', textAlign: 'center', color: '#94a3b8' }}>No attendance records yet.</div>
      ) : (
        <div style={HIS.drawerBody}>
          {history.map(h => (
            <div key={h.id} style={HIS.histRow}>
              <span style={HIS.histDate}>{h.date}</span>
              <span style={{ ...HIS.histBadge, background: h.status === 'present' ? '#dcfce7' : '#fee2e2', color: h.status === 'present' ? '#15803d' : '#be123c' }}>
                {h.status === 'present' ? '✓ Present' : '✗ Absent'}
              </span>
              <span style={HIS.histTime}>{h.markedAt ? new Date(h.markedAt).toLocaleTimeString() : '—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   HISTORY PANEL — full per-student attendance timeline
═══════════════════════════════════════════════════════════ */
function HistoryPanel() {
  const [students, setStudents] = useState([])
  const [selected, setSelected] = useState('')
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch(`${ATTENDANCE_API_URL}/students`)
      .then(r => r.json())
      .then(d => setStudents(d.students || []))
      .catch(() => {})
  }, [])

  const loadHistory = useCallback(async (id) => {
    if (!id) return
    setLoading(true)
    try {
      const res = await fetch(`${ATTENDANCE_API_URL}/students/${id}/history?limit=60`)
      const data = await res.json()
      setHistory(data.history || [])
    } catch {
      setHistory([])
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { loadHistory(selected) }, [selected, loadHistory])

  const student = students.find(s => s.id === selected)
  const presentDays = history.filter(h => h.status === 'present').length
  const totalDays = history.length
  const pct = totalDays ? Math.round((presentDays / totalDays) * 100) : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* student picker */}
      <div style={HIS.card}>
        <h3 style={HIS.cardTitle}>Select Student</h3>
        <select
          value={selected}
          onChange={e => setSelected(e.target.value)}
          style={HIS.select}
        >
          <option value="">— Choose a student —</option>
          {students.map(s => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.rollNumber}) · {s.className}-{s.section}
            </option>
          ))}
        </select>
      </div>

      {selected && student && (
        <>
          {/* student info + stats */}
          <div style={HIS.profileCard}>
            <div style={HIS.profileAvatar}>{student.name.charAt(0).toUpperCase()}</div>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0, fontWeight: 900, color: '#0f172a', fontSize: '1.4rem' }}>{student.name}</h2>
              <p style={{ margin: '0.2rem 0 0', color: '#64748b', fontSize: '0.88rem' }}>
                Roll: {student.rollNumber} · Class: {student.className}-{student.section}
                {student.parentMobile && ` · 📞 ${student.parentMobile}`}
              </p>
              <p style={{ margin: '0.15rem 0 0', color: '#94a3b8', fontSize: '0.78rem' }}>
                Registered: {student.registeredAt ? new Date(student.registeredAt).toLocaleDateString() : '—'}
              </p>
            </div>
            <div style={HIS.attendanceCircle}>
              <strong style={{ fontSize: '1.6rem', color: pct >= 75 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444', lineHeight: 1 }}>{pct}%</strong>
              <span style={{ fontSize: '0.65rem', color: '#64748b', marginTop: '0.2rem' }}>attendance</span>
            </div>
          </div>

          {/* stats row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '0.75rem' }}>
            <StatBox label="Total Days"  value={totalDays}   color="#6366f1" />
            <StatBox label="Present"     value={presentDays} color="#22c55e" />
            <StatBox label="Absent"      value={totalDays - presentDays} color="#ef4444" />
            <StatBox label="Attendance"  value={`${pct}%`}  color={pct >= 75 ? '#22c55e' : '#f59e0b'} />
          </div>

          {/* timeline */}
          <div style={HIS.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={HIS.cardTitle}>Attendance History</h3>
              <button onClick={() => loadHistory(selected)} style={HIS.refreshBtn}>↺ Refresh</button>
            </div>
            {loading ? (
              <div style={{ textAlign: 'center', padding: '2rem', color: '#94a3b8' }}>Loading…</div>
            ) : history.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '2rem', color: '#94a3b8' }}>No attendance records found.</div>
            ) : (
              <div style={HIS.timeline}>
                {history.map((h, i) => (
                  <div key={h.id || i} style={HIS.timelineRow}>
                    <div style={{ ...HIS.dot, background: h.status === 'present' ? '#22c55e' : '#ef4444' }} />
                    <div style={HIS.timelineContent}>
                      <span style={{ fontWeight: 700, color: '#0f172a', fontSize: '0.9rem' }}>{h.date}</span>
                      <span style={{ ...HIS.histBadge, marginLeft: '0.75rem', background: h.status === 'present' ? '#dcfce7' : '#fee2e2', color: h.status === 'present' ? '#15803d' : '#be123c' }}>
                        {h.status === 'present' ? '✓ Present' : '✗ Absent'}
                      </span>
                      {h.markedAt && (
                        <span style={{ marginLeft: '0.75rem', color: '#94a3b8', fontSize: '0.78rem' }}>
                          {new Date(h.markedAt).toLocaleTimeString()}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {!selected && (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#94a3b8', fontSize: '0.9rem' }}>
          Select a student above to view their full attendance history.
        </div>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   SUMMARY PANEL — date-wise overview from MongoDB
═══════════════════════════════════════════════════════════ */
function SummaryPanel() {
  const [summary, setSummary] = useState([])
  const [loading, setLoading] = useState(true)
  const [totalStudents, setTotalStudents] = useState(0)

  useEffect(() => {
    Promise.all([
      fetch(`${ATTENDANCE_API_URL}/summary`).then(r => r.json()),
      fetch(`${ATTENDANCE_API_URL}/students`).then(r => r.json()),
    ])
      .then(([sum, stu]) => {
        setSummary(sum.summary || [])
        setTotalStudents((stu.students || []).length)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const maxPresent = summary.length ? Math.max(...summary.map(s => s.present), 1) : 1

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '0.75rem' }}>
        <StatBox label="Registered Students" value={totalStudents} color="#6366f1" />
        <StatBox label="Days Recorded"       value={summary.length} color="#0ea5e9" />
        <StatBox label="Avg Present / Day"   value={summary.length ? Math.round(summary.reduce((a, s) => a + s.present, 0) / summary.length) : '—'} color="#22c55e" />
      </div>

      <div style={HIS.card}>
        <h3 style={{ ...HIS.cardTitle, marginBottom: '1.25rem' }}>Daily Attendance Overview</h3>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: '#94a3b8' }}>Loading from MongoDB…</div>
        ) : summary.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: '#94a3b8' }}>No attendance data yet.</div>
        ) : (
          <>
            <div style={SUM.chartWrap}>
              {summary.map(s => {
                const pct = Math.round((s.present / (totalStudents || s.present || 1)) * 100)
                const barH = Math.round((s.present / maxPresent) * 120)
                return (
                  <div key={s.date} style={SUM.bar}>
                    <span style={SUM.barVal}>{s.present}</span>
                    <div style={{ ...SUM.barFill, height: `${barH}px`, background: pct >= 75 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444' }} />
                    <span style={SUM.barDate}>{s.date.slice(5)}</span>
                  </div>
                )
              })}
            </div>

            <table style={{ ...REC.table, marginTop: '1.5rem' }}>
              <thead>
                <tr>
                  {['Date', 'Present', 'Absent', 'Rate'].map(h => <th key={h} style={REC.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {summary.map(s => {
                  const absent = Math.max(0, totalStudents - s.present)
                  const rate = totalStudents ? `${Math.round((s.present / totalStudents) * 100)}%` : `${s.present} present`
                  return (
                    <tr key={s.date} style={REC.tr}>
                      <td style={REC.td}><strong>{s.date}</strong></td>
                      <td style={{ ...REC.td, color: '#15803d', fontWeight: 700 }}>{s.present}</td>
                      <td style={{ ...REC.td, color: '#be123c', fontWeight: 700 }}>{absent}</td>
                      <td style={REC.td}>
                        <span style={{ ...REC.badge, background: parseInt(rate) >= 75 ? '#dcfce7' : '#fee2e2', color: parseInt(rate) >= 75 ? '#15803d' : '#be123c' }}>
                          {rate}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   SHARED SMALL COMPONENTS
═══════════════════════════════════════════════════════════ */
function Field({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <label style={R.field}>
      <span style={R.label}>{label}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} style={R.input} />
    </label>
  )
}

function StatBox({ label, value, color }) {
  return (
    <div style={{ ...REC.statBox, borderColor: `${color}33` }}>
      <strong style={{ fontSize: '2rem', color, fontWeight: 900, lineHeight: 1 }}>{value}</strong>
      <span style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{label}</span>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   STYLES
═══════════════════════════════════════════════════════════ */
const S = {
  page: { padding: '1.5rem', minHeight: '100vh', background: '#f8fafc', fontFamily: "'Segoe UI', system-ui, sans-serif" },
  header: { marginBottom: '1.5rem' },
  eyebrow: { margin: 0, fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#6366f1' },
  title: { margin: '0.3rem 0 0.25rem', fontSize: 'clamp(1.75rem,3vw,2.5rem)', fontWeight: 900, letterSpacing: '-0.03em', color: '#0f172a' },
  subtitle: { margin: 0, color: '#64748b', fontSize: '0.95rem' },
  tabs: { display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', flexWrap: 'wrap' },
  tab: { padding: '0.65rem 1.25rem', borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s' },
  tabActive: { background: '#0f172a', color: '#fff', border: '1px solid #0f172a' },
}

const R = {
  wrap: { display: 'grid', gridTemplateColumns: '1fr 320px', gap: '1.25rem', alignItems: 'start' },
  left: {},
  right: {},
  card: { background: '#fff', borderRadius: 20, border: '1px solid #e2e8f0', padding: '1.5rem', boxShadow: '0 4px 24px rgba(15,23,42,0.06)' },
  cardTitle: { margin: '0 0 0.25rem', fontSize: '1.2rem', fontWeight: 800, color: '#0f172a' },
  cardSub: { margin: '0 0 1.25rem', color: '#64748b', fontSize: '0.88rem' },
  form: { display: 'flex', flexDirection: 'column', gap: '1rem' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' },
  field: { display: 'flex', flexDirection: 'column', gap: '0.35rem' },
  label: { fontWeight: 700, color: '#334155', fontSize: '0.82rem' },
  input: { padding: '0.7rem 0.9rem', borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#0f172a', fontSize: '0.9rem', fontFamily: 'inherit', outline: 'none' },
  msg: { padding: '0.75rem 1rem', borderRadius: 10, border: '1px solid', fontSize: '0.88rem', fontWeight: 600 },
  camCard: { background: '#0f172a', borderRadius: 16, padding: '1.1rem' },
  camHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' },
  camTitle: { color: '#e2e8f0', fontWeight: 700, fontSize: '0.9rem' },
  camBadge: { padding: '0.25rem 0.75rem', borderRadius: 999, fontWeight: 700, fontSize: '0.75rem' },
  videoBox: { position: 'relative', width: '100%', aspectRatio: '4/3', background: '#020617', borderRadius: 12, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  video: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', transition: 'opacity 0.3s' },
  canvas: { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' },
  videoPlaceholder: { display: 'flex', flexDirection: 'column', alignItems: 'center', zIndex: 2 },
  camActions: { display: 'flex', gap: '0.65rem', marginTop: '0.75rem', flexWrap: 'wrap' },
  hint: { color: '#94a3b8', fontSize: '0.78rem', margin: '0.6rem 0 0.5rem' },
  thumbRow: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' },
  thumbWrap: { position: 'relative' },
  thumb: { width: 72, height: 72, borderRadius: 10, objectFit: 'cover', border: '2px solid rgba(125,211,252,0.4)' },
  thumbDel: { position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', background: '#ef4444', color: '#fff', border: 'none', cursor: 'pointer', fontSize: '0.65rem', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 },
  thumbNum: { position: 'absolute', bottom: 2, left: 4, color: '#fff', fontSize: '0.65rem', fontWeight: 700, textShadow: '0 1px 3px rgba(0,0,0,0.8)' },
  btnPrimary: { padding: '0.9rem 1.25rem', borderRadius: 12, border: 'none', background: 'linear-gradient(135deg,#4f46e5,#7c3aed)', color: '#fff', fontWeight: 800, fontSize: '0.9rem', cursor: 'pointer', fontFamily: 'inherit', transition: 'opacity 0.2s' },
  btnSecondary: { padding: '0.65rem 1rem', borderRadius: 10, border: '1px solid rgba(148,163,184,0.3)', background: 'rgba(255,255,255,0.1)', color: '#e2e8f0', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'inherit' },
  btnCapture: { padding: '0.65rem 1rem', borderRadius: 10, border: 'none', background: '#22c55e', color: '#fff', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'inherit', transition: 'opacity 0.2s' },
  btnDanger: { padding: '0.65rem 0.9rem', borderRadius: 10, border: 'none', background: 'rgba(239,68,68,0.2)', color: '#fca5a5', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'inherit' },
  infoCard: { background: '#fff', borderRadius: 18, border: '1px solid #e2e8f0', padding: '1.25rem', boxShadow: '0 2px 12px rgba(15,23,42,0.04)' },
  infoTitle: { margin: '0 0 0.85rem', fontSize: '1rem', fontWeight: 800, color: '#0f172a' },
  steps: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.65rem' },
  step: { display: 'flex', gap: '0.65rem', alignItems: 'flex-start', fontSize: '0.84rem', color: '#475569', lineHeight: 1.5 },
  stepNum: { width: 22, height: 22, borderRadius: '50%', background: '#6366f1', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.72rem', fontWeight: 800, flexShrink: 0, marginTop: '0.05rem' },
  tips: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.45rem' },
  tip: { fontSize: '0.82rem', color: '#475569', paddingLeft: '0.25rem' },
}

const REC = {
  wrap: { display: 'flex', flexDirection: 'column', gap: '1rem' },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem' },
  statBox: { background: '#fff', borderRadius: 16, border: '2px solid', padding: '1rem', display: 'flex', flexDirection: 'column', alignItems: 'center', boxShadow: '0 2px 8px rgba(15,23,42,0.04)' },
  filters: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end', background: '#fff', padding: '1rem', borderRadius: 16, border: '1px solid #e2e8f0' },
  filterField: { display: 'flex', flexDirection: 'column', gap: '0.3rem' },
  filterLabel: { fontSize: '0.78rem', fontWeight: 700, color: '#475569' },
  input: { padding: '0.6rem 0.85rem', borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#0f172a', fontSize: '0.88rem', fontFamily: 'inherit' },
  applyBtn: { padding: '0.65rem 1.25rem', borderRadius: 10, border: 'none', background: '#0f172a', color: '#fff', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', alignSelf: 'flex-end' },
  toast: { padding: '0.7rem 1rem', borderRadius: 10, background: '#f0fdf4', color: '#15803d', fontWeight: 600, fontSize: '0.88rem', border: '1px solid #86efac' },
  tableWrap: { background: '#fff', borderRadius: 20, border: '1px solid #e2e8f0', overflow: 'hidden', boxShadow: '0 4px 24px rgba(15,23,42,0.05)' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { padding: '0.85rem 1rem', textAlign: 'left', fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', background: '#f8fafc', borderBottom: '1px solid #e2e8f0' },
  tr: { borderBottom: '1px solid #f1f5f9' },
  td: { padding: '0.85rem 1rem', color: '#0f172a', fontSize: '0.9rem' },
  badge: { display: 'inline-flex', padding: '0.3rem 0.75rem', borderRadius: 999, fontWeight: 700, fontSize: '0.78rem' },
  btnP: { padding: '0.35rem 0.75rem', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', fontWeight: 700, fontSize: '0.75rem', cursor: 'pointer', fontFamily: 'inherit' },
  btnA: { padding: '0.35rem 0.75rem', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', fontWeight: 700, fontSize: '0.75rem', cursor: 'pointer', fontFamily: 'inherit' },
  empty: { padding: '3rem', textAlign: 'center', color: '#94a3b8' },
}

const ROS = {
  wrap: { display: 'flex', flexDirection: 'column', gap: '1rem' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '1rem' },
  search: { flex: 1, padding: '0.75rem 1rem', borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', color: '#0f172a', fontSize: '0.9rem', fontFamily: 'inherit', outline: 'none', boxShadow: '0 2px 8px rgba(15,23,42,0.04)' },
  count: { color: '#64748b', fontSize: '0.85rem', whiteSpace: 'nowrap' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.85rem' },
  card: { background: '#fff', borderRadius: 16, border: '1px solid #e2e8f0', padding: '1.1rem', display: 'flex', alignItems: 'flex-start', gap: '0.9rem', boxShadow: '0 2px 8px rgba(15,23,42,0.04)', position: 'relative', cursor: 'pointer', transition: 'box-shadow 0.15s' },
  avatar: { width: 44, height: 44, borderRadius: '50%', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', fontWeight: 800, flexShrink: 0 },
  info: { flex: 1, minWidth: 0 },
  name: { display: 'block', color: '#0f172a', fontWeight: 800, fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  meta: { margin: '0.2rem 0 0', color: '#64748b', fontSize: '0.78rem' },
  samples: { margin: '0.3rem 0 0', color: '#94a3b8', fontSize: '0.72rem' },
  badge: { position: 'absolute', top: '0.85rem', right: '0.85rem', padding: '0.2rem 0.6rem', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700 },
  empty: { padding: '3rem', textAlign: 'center', color: '#94a3b8' },
}

const HIS = {
  card: { background: '#fff', borderRadius: 20, border: '1px solid #e2e8f0', padding: '1.5rem', boxShadow: '0 4px 24px rgba(15,23,42,0.06)' },
  cardTitle: { margin: 0, fontSize: '1.1rem', fontWeight: 800, color: '#0f172a' },
  select: { width: '100%', padding: '0.75rem 1rem', borderRadius: 12, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#0f172a', fontSize: '0.9rem', fontFamily: 'inherit', marginTop: '0.75rem', cursor: 'pointer', outline: 'none' },
  profileCard: { background: '#fff', borderRadius: 20, border: '1px solid #e2e8f0', padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1.25rem', boxShadow: '0 4px 24px rgba(15,23,42,0.06)' },
  profileAvatar: { width: 64, height: 64, borderRadius: '50%', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2rem', fontWeight: 900, flexShrink: 0 },
  attendanceCircle: { display: 'flex', flexDirection: 'column', alignItems: 'center', background: '#f8fafc', borderRadius: 16, padding: '0.85rem 1.25rem', border: '1px solid #e2e8f0' },
  refreshBtn: { padding: '0.45rem 1rem', borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#475569', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'inherit' },
  timeline: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  timelineRow: { display: 'flex', alignItems: 'center', gap: '0.85rem', padding: '0.55rem 0', borderBottom: '1px solid #f1f5f9' },
  dot: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0 },
  timelineContent: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.25rem' },
  histBadge: { display: 'inline-flex', padding: '0.2rem 0.6rem', borderRadius: 999, fontWeight: 700, fontSize: '0.75rem' },
  histDate: { fontWeight: 700, color: '#0f172a', fontSize: '0.88rem', minWidth: 90 },
  histTime: { color: '#94a3b8', fontSize: '0.75rem' },
  drawer: { background: '#fff', borderRadius: 20, border: '1px solid #e2e8f0', overflow: 'hidden', boxShadow: '0 8px 32px rgba(15,23,42,0.1)', marginTop: '0.5rem' },
  drawerHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', borderBottom: '1px solid #e2e8f0', background: '#f8fafc' },
  drawerBody: { padding: '0.5rem 0', maxHeight: 320, overflowY: 'auto' },
  histRow: { display: 'flex', alignItems: 'center', gap: '0.85rem', padding: '0.6rem 1.25rem', borderBottom: '1px solid #f8fafc' },
  closeBtn: { width: 28, height: 28, borderRadius: '50%', border: 'none', background: '#f1f5f9', color: '#64748b', cursor: 'pointer', fontWeight: 700, fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center' },
}

const SUM = {
  chartWrap: { display: 'flex', alignItems: 'flex-end', gap: '6px', overflowX: 'auto', paddingBottom: '0.5rem', minHeight: 160 },
  bar: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', minWidth: 44 },
  barVal: { fontSize: '0.72rem', fontWeight: 700, color: '#0f172a' },
  barFill: { width: 32, borderRadius: '6px 6px 0 0', minHeight: 4, transition: 'height 0.4s' },
  barDate: { fontSize: '0.62rem', color: '#94a3b8', transform: 'rotate(-40deg)', transformOrigin: 'top center', marginTop: 4, whiteSpace: 'nowrap' },
}
