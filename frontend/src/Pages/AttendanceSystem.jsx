import React from 'react'
import FaceCapturePanel from '../components/attendance/FaceCapturePanel.jsx'
import { ATTENDANCE_API_URL } from '../utils/backendUrl'

const today = new Date().toISOString().slice(0, 10)

function AttendanceSystem({ teacherMode = false }) {
  const [students, setStudents] = React.useState([])
  const [records, setRecords] = React.useState([])
  const [live, setLive] = React.useState({ running: false, recentDetections: [] })
  const [loading, setLoading] = React.useState(true)
  const [message, setMessage] = React.useState('')
  const [registering, setRegistering] = React.useState(false)
  const [cameraReady, setCameraReady] = React.useState(false)
  const backendConnected = true
  const [samples, setSamples] = React.useState([])
  const [registerForm, setRegisterForm] = React.useState({
    name: '',
    rollNumber: '',
    className: '',
    section: '',
  })
  
  const [filters, setFilters] = React.useState({
    date: today,
    className: '',
    section: '',
  })

  const videoRef = React.useRef(null)
  const streamRef = React.useRef(null)
  const canvasRef = React.useRef(null)
  const detectionIntervalRef = React.useRef(null)
  const isDetectingRef = React.useRef(false)
  const liveCameraOpenRef = React.useRef(false)
  const [faceDetected, setFaceDetected] = React.useState(false)

  const loadStudents = React.useCallback(async () => {
    const response = await fetch(`${ATTENDANCE_API_URL}/students`)
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.detail || payload.error || 'Failed to load students')
    setStudents(payload.students || [])
  }, [])

  const loadLiveStatus = React.useCallback(async () => {
    const response = await fetch(`${ATTENDANCE_API_URL}/live/status`)
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.detail || payload.error || 'Failed to load live status')
    const liveData = payload.live || { running: false, recentDetections: [] }
    liveCameraOpenRef.current = !!liveData.cameraOpen
    setLive(liveData)
  }, [])

  const loadRecords = React.useCallback(async () => {
    const params = new URLSearchParams()
    if (filters.date) params.set('date', filters.date)
    if (filters.className) params.set('className', filters.className)
    if (filters.section) params.set('section', filters.section)

    const response = await fetch(`${ATTENDANCE_API_URL}/records?${params.toString()}`)
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.detail || payload.error || 'Failed to load attendance records')
    setRecords(payload.records || [])
  }, [filters.className, filters.date, filters.section])

  const loadDashboard = React.useCallback(async () => {
    setLoading(true)
    try {
      await Promise.all([loadStudents(), loadLiveStatus(), loadRecords()])
      setMessage('')
    } catch (error) {
      setMessage(error.message)
    } finally {
      setLoading(false)
    }
  }, [loadLiveStatus, loadRecords, loadStudents])

  React.useEffect(() => {
    loadDashboard()
  }, [loadDashboard])

  React.useEffect(() => {
    return () => {
      /* no socket connection required for agentic backend */
    }
  }, [])

  React.useEffect(() => {
    const interval = window.setInterval(() => {
      Promise.all([loadLiveStatus(), loadRecords()]).catch(() => {})
    }, 10000)
    return () => window.clearInterval(interval)
  }, [loadLiveStatus, loadRecords])

  React.useEffect(() => {
    return () => stopCamera()
  }, [])

  const startFaceDetectionLoop = React.useCallback(() => {
    detectionIntervalRef.current = setInterval(async () => {
      if (isDetectingRef.current || !videoRef.current || !canvasRef.current) return
      const video = videoRef.current
      if (!video.videoWidth || !video.videoHeight) return
      // don't call detect-face while live attendance has the camera open — they share the same physical webcam
      if (liveCameraOpenRef.current) return
      isDetectingRef.current = true
      try {
        const tmp = document.createElement('canvas')
        tmp.width = video.videoWidth
        tmp.height = video.videoHeight
        tmp.getContext('2d').drawImage(video, 0, 0)
        const frameData = tmp.toDataURL('image/jpeg', 0.5)
        const res = await fetch(`${ATTENDANCE_API_URL}/detect-face`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: frameData }),
        })
        const data = await res.json()
        const overlay = canvasRef.current
        if (!overlay) return
        overlay.width = video.videoWidth
        overlay.height = video.videoHeight
        const ctx = overlay.getContext('2d')
        ctx.clearRect(0, 0, overlay.width, overlay.height)
        if (data.face) {
          const { top, right, bottom, left } = data.face
          ctx.strokeStyle = '#00ff00'
          ctx.lineWidth = 3
          ctx.strokeRect(left, top, right - left, bottom - top)
          setFaceDetected(true)
        } else {
          setFaceDetected(false)
        }
      } catch (_) {
        // ignore network errors during detection
      } finally {
        isDetectingRef.current = false
      }
    }, 700)
  }, [])

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
      }
      setCameraReady(true)
      setMessage('')
      startFaceDetectionLoop()
    } catch (error) {
      setMessage(`Could not open camera: ${error.message}`)
    }
  }

  const stopCamera = () => {
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current)
      detectionIntervalRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d')
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
    }
    setFaceDetected(false)
    setCameraReady(false)
  }

  const captureSample = () => {
    if (!videoRef.current) return
    const canvas = document.createElement('canvas')
    canvas.width = videoRef.current.videoWidth || 640
    canvas.height = videoRef.current.videoHeight || 480
    const context = canvas.getContext('2d')
    context.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height)
    const image = canvas.toDataURL('image/jpeg', 0.92)
    setSamples(prev => [...prev, image])
  }

  const registerStudent = async (event) => {
    event.preventDefault()
    const trimmedForm = {
      name: registerForm.name.trim(),
      rollNumber: registerForm.rollNumber.trim(),
      className: registerForm.className.trim(),
      section: registerForm.section.trim(),
    }

    if (!trimmedForm.name || !trimmedForm.rollNumber || !trimmedForm.className || !trimmedForm.section) {
      setMessage('Enter name, roll number, class, and section before registering.')
      return
    }

    if (samples.length < 3) {
      setMessage('Capture at least 3 face samples before registering.')
      return
    }

    setRegistering(true)
    try {
      const response = await fetch(`${ATTENDANCE_API_URL}/students/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedForm.name,
          rollNumber: trimmedForm.rollNumber,
          className: trimmedForm.className,
          section: trimmedForm.section,
          images: samples,
        }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || payload.error || 'Failed to register student')

      setRegisterForm({ name: '', rollNumber: '', className: '', section: '' })
      setSamples([])
      stopCamera()
      setMessage(
        `Registered ${payload.student?.name || 'student'} successfully. `
        + `Saved details: ${payload.student?.rollNumber || trimmedForm.rollNumber}, `
        + `${payload.student?.className || trimmedForm.className}, `
        + `${payload.student?.section || trimmedForm.section}.`
      )
      await Promise.all([loadStudents(), loadRecords(), loadLiveStatus()])
    } catch (error) {
      setMessage(error.message)
    } finally {
      setRegistering(false)
    }
  }

  const reloadEncodings = async () => {
    try {
      const response = await fetch(`${ATTENDANCE_API_URL}/reload-encodings`, { method: 'POST' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || 'Failed to reload encodings')
      setLive(prev => ({ ...prev, encodingCount: payload.encodingCount }))
      setMessage(`Encodings reloaded: ${payload.encodingCount} face(s) loaded.`)
    } catch (error) {
      setMessage(error.message)
    }
  }

  const toggleLiveAttendance = async () => {
    try {
      const endpoint = live.running ? 'stop' : 'start'
      const response = await fetch(`${ATTENDANCE_API_URL}/live/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || payload.error || `Failed to ${endpoint} live attendance`)
      setLive(payload.live || { running: endpoint === 'start' })
      setMessage(live.running ? 'Live attendance stopped.' : 'Live attendance started.')
    } catch (error) {
      setMessage(error.message)
    }
  }

  const setAttendanceStatus = async (record, status) => {
    try {
      const response = await fetch(`${ATTENDANCE_API_URL}/records/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId: record.studentId,
          date: record.date || filters.date || today,
          status,
        }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || payload.error || 'Failed to update attendance')
      setMessage(`Marked ${payload.record?.student?.name || record.student?.name} as ${status}.`)
      await loadRecords()
    } catch (error) {
      setMessage(error.message)
    }
  }

  const presentCount = records.filter(record => record.status === 'present').length
  const absentCount = records.filter(record => record.status !== 'present').length
  const lastRecognized = live.recentDetections?.find(entry => entry.match)

  return (
    <div style={styles.page}>
      <section style={styles.hero}>
        <div>
          <p style={styles.eyebrow}>{teacherMode ? 'SuperNode Attendance Console' : 'Attendance System'}</p>
          <h1 style={styles.title}>Real-time face attendance with backend sync</h1>
          <p style={styles.subtitle}>
            Any recognized face is matched with student details, sent through the backend flow, and marked present for the day.
          </p>
        </div>
        <div style={styles.heroActions}>
          <button type="button" style={{ ...styles.primaryButton, ...(live.running ? styles.stopButton : null) }} onClick={toggleLiveAttendance}>
            {live.running ? 'Stop Live Attendance' : 'Start Live Attendance'}
          </button>
          <button type="button" style={styles.secondaryButton} onClick={loadDashboard}>
            Refresh
          </button>
          <button type="button" style={styles.secondaryButton} onClick={reloadEncodings}>
            Reload Encodings
          </button>
        </div>
      </section>

      <section style={styles.statusRow}>
        <div style={styles.connectionCard}>
          <span style={{ ...styles.connectionDot, backgroundColor: backendConnected ? '#16a34a' : '#dc2626' }} />
          <div>
            <strong style={styles.connectionTitle}>{backendConnected ? 'Local backend connected' : 'Local backend disconnected'}</strong>
            <p style={styles.connectionText}>Attendance data is loaded from the local agentic backend on port 8000.</p>
          </div>
        </div>
        <div style={styles.metricStrip}>
          <MetricCard label="Students" value={students.length} accent="#0f766e" />
          <MetricCard label="Present today" value={presentCount} accent="#16a34a" />
          <MetricCard label="Absent today" value={absentCount} accent="#dc2626" />
          <MetricCard label="Recent detections" value={live.recentDetections?.length || 0} accent="#1d4ed8" />
        </div>
      </section>

      {message ? <div style={styles.banner}>{message}</div> : null}

      <section style={styles.grid}>
        <article style={styles.panel}>
          <div style={styles.panelHeader}>
            <div>
              <h2 style={styles.panelTitle}>Live recognition</h2>
              <p style={styles.panelText}>The FastAPI attendance camera confirms matches, fetches student metadata, and pushes the update in real time.</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', alignItems: 'flex-end' }}>
              <span style={{ ...styles.statusPill, backgroundColor: live.cameraOpen ? '#dcfce7' : live.running ? '#fef9c3' : '#e2e8f0', color: live.cameraOpen ? '#166534' : live.running ? '#854d0e' : '#475569' }}>
                {live.cameraOpen ? 'Camera open' : live.running ? 'Opening camera…' : 'Camera stopped'}
              </span>
              <span style={{ ...styles.statusPill, backgroundColor: (live.encodingCount || 0) > 0 ? '#dbeafe' : '#fee2e2', color: (live.encodingCount || 0) > 0 ? '#1d4ed8' : '#991b1b', fontSize: '0.75rem' }}>
                {live.encodingCount || 0} face encoding{live.encodingCount !== 1 ? 's' : ''} loaded
              </span>
            </div>
          </div>

          <div style={styles.highlightCard}>
            <span style={styles.highlightLabel}>Latest confirmed match</span>
            <strong style={styles.highlightName}>{lastRecognized?.match?.name || 'Waiting for a face'}</strong>
            <p style={styles.highlightMeta}>
              {lastRecognized?.match
                ? `${lastRecognized.match.rollNumber} | ${lastRecognized.match.className}-${lastRecognized.match.section}`
                : 'Start live attendance and place a registered student in front of the attendance camera.'}
            </p>
          </div>

          <div style={styles.timeline}>
            {(live.recentDetections || []).length === 0 ? (
              <p style={styles.emptyText}>No detections yet.</p>
            ) : (
              live.recentDetections.map((entry, index) => (
                <div key={`${entry.detectedAt}-${index}`} style={styles.timelineItem}>
                  <div>
                    <strong style={styles.timelineName}>{entry.match?.name || 'Unknown face'}</strong>
                    <p style={styles.timelineMeta}>
                      {new Date(entry.detectedAt).toLocaleString()}
                    </p>
                    {entry.match ? (
                      <p style={styles.timelineSubMeta}>
                        Roll {entry.match.rollNumber} | {entry.match.className}-{entry.match.section}
                      </p>
                    ) : null}
                  </div>
                  <span style={{ ...styles.recordBadge, backgroundColor: entry.match ? '#dcfce7' : '#fee2e2', color: entry.match ? '#166534' : '#991b1b' }}>
                    {entry.match ? `${((entry.confidence || 0) * 100).toFixed(1)}% match` : 'Unmatched'}
                  </span>
                </div>
              ))
            )}
          </div>
        </article>

        <article style={styles.panel}>
          <div style={styles.panelHeader}>
            <div>
              <h2 style={styles.panelTitle}>Daily attendance dashboard</h2>
              <p style={styles.panelText}>Filter by date, class, or section, then correct records from the same screen.</p>
            </div>
          </div>

          <div style={styles.filters}>
            <label style={styles.filterField}>
              <span style={styles.filterLabel}>Date</span>
              <input type="date" value={filters.date} onChange={(event) => setFilters(prev => ({ ...prev, date: event.target.value }))} style={styles.input} />
            </label>
            <label style={styles.filterField}>
              <span style={styles.filterLabel}>Class</span>
              <input type="text" value={filters.className} placeholder="10" onChange={(event) => setFilters(prev => ({ ...prev, className: event.target.value }))} style={styles.input} />
            </label>
            <label style={styles.filterField}>
              <span style={styles.filterLabel}>Section</span>
              <input type="text" value={filters.section} placeholder="A" onChange={(event) => setFilters(prev => ({ ...prev, section: event.target.value }))} style={styles.input} />
            </label>
            <button type="button" style={styles.secondaryButton} onClick={loadRecords}>Apply</button>
          </div>

          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Student</th>
                  <th style={styles.th}>Roll</th>
                  <th style={styles.th}>Class</th>
                  <th style={styles.th}>Status</th>
                  <th style={styles.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {records.map(record => (
                  <tr key={record.id} style={styles.row}>
                    <td style={styles.td}>
                      <strong>{record.student?.name}</strong>
                    </td>
                    <td style={styles.td}>{record.student?.rollNumber}</td>
                    <td style={styles.td}>{record.student?.className}-{record.student?.section}</td>
                    <td style={styles.td}>
                      <span style={{ ...styles.recordBadge, backgroundColor: record.status === 'present' ? '#dcfce7' : '#fee2e2', color: record.status === 'present' ? '#166534' : '#991b1b' }}>
                        {record.status}
                      </span>
                    </td>
                    <td style={styles.td}>
                      <div style={styles.rowActions}>
                        <button type="button" style={styles.presentButton} onClick={() => setAttendanceStatus(record, 'present')}>
                          Present
                        </button>
                        <button type="button" style={styles.absentButton} onClick={() => setAttendanceStatus(record, 'absent')}>
                          Absent
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && records.length === 0 ? (
                  <tr>
                    <td colSpan="5" style={styles.emptyCell}>No attendance records found for the selected filters.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </article>

        <article style={styles.panel}>
          <div style={styles.panelHeader}>
            <div>
              <h2 style={styles.panelTitle}>Student roster</h2>
              <p style={styles.panelText}>Registered faces available to the recognition engine.</p>
            </div>
          </div>
          <div style={styles.rosterList}>
            {students.length === 0 ? (
              <p style={styles.emptyText}>No students registered yet.</p>
            ) : (
              students.map(student => (
                <div key={student.id} style={styles.rosterItem}>
                  <div>
                    <strong style={styles.rosterName}>{student.name}</strong>
                    <p style={styles.rosterMeta}>
                      Roll {student.rollNumber} | {student.className}-{student.section}
                    </p>
                  </div>
                  <span style={styles.sampleCount}>{student.sampleImagePaths?.length || 0} samples</span>
                </div>
              ))
            )}
          </div>
        </article>
      </section>

      <section style={styles.captureSection}>
        <FaceCapturePanel
          teacherMode={teacherMode}
          registerForm={registerForm}
          setRegisterForm={setRegisterForm}
          registerStudent={registerStudent}
          registering={registering}
          cameraReady={cameraReady}
          samples={samples}
          startCamera={startCamera}
          stopCamera={stopCamera}
          captureSample={captureSample}
          videoRef={videoRef}
          canvasRef={canvasRef}
          faceDetected={faceDetected}
        />
      </section>
    </div>
  )
}

function MetricCard({ label, value, accent }) {
  return (
    <div style={{ ...styles.metricCard, borderColor: `${accent}22` }}>
      <span style={styles.metricLabel}>{label}</span>
      <strong style={{ ...styles.metricValue, color: accent }}>{value}</strong>
    </div>
  )
}

const styles = {
  page: {
    padding: '1.5rem',
    background: 'radial-gradient(circle at top left, rgba(59,130,246,0.08), transparent 32%), radial-gradient(circle at bottom right, rgba(16,185,129,0.08), transparent 28%)',
  },
  hero: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: '1rem',
    marginBottom: '1.25rem',
    flexWrap: 'wrap',
  },
  eyebrow: {
    margin: 0,
    fontSize: '0.78rem',
    fontWeight: 800,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    color: '#0f766e',
  },
  title: {
    margin: '0.35rem 0 0',
    fontSize: 'clamp(2rem, 3vw, 3.25rem)',
    lineHeight: 1,
    letterSpacing: '-0.04em',
    color: '#0f172a',
  },
  subtitle: {
    maxWidth: '820px',
    margin: '0.75rem 0 0',
    color: '#475569',
    lineHeight: 1.7,
  },
  heroActions: {
    display: 'flex',
    gap: '0.75rem',
    flexWrap: 'wrap',
  },
  primaryButton: {
    minHeight: '48px',
    padding: '0.9rem 1.2rem',
    border: 'none',
    borderRadius: '14px',
    background: 'linear-gradient(135deg, #0f766e 0%, #0f172a 100%)',
    color: '#ffffff',
    fontWeight: 700,
  },
  stopButton: {
    background: 'linear-gradient(135deg, #b91c1c 0%, #7f1d1d 100%)',
  },
  secondaryButton: {
    minHeight: '48px',
    padding: '0.85rem 1.05rem',
    borderRadius: '14px',
    border: '1px solid rgba(148, 163, 184, 0.35)',
    background: 'rgba(255, 255, 255, 0.92)',
    color: '#0f172a',
    fontWeight: 600,
  },
  statusRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(280px, 1fr) 2fr',
    gap: '1rem',
    marginBottom: '1rem',
  },
  connectionCard: {
    display: 'flex',
    gap: '0.85rem',
    alignItems: 'center',
    padding: '1rem',
    borderRadius: '22px',
    background: 'rgba(255,255,255,0.92)',
    border: '1px solid rgba(148, 163, 184, 0.2)',
  },
  connectionDot: {
    width: '14px',
    height: '14px',
    borderRadius: '999px',
    flexShrink: 0,
  },
  connectionTitle: {
    display: 'block',
    color: '#0f172a',
  },
  connectionText: {
    margin: '0.15rem 0 0',
    color: '#64748b',
    lineHeight: 1.5,
  },
  metricStrip: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: '0.75rem',
  },
  metricCard: {
    padding: '1rem',
    borderRadius: '20px',
    border: '1px solid rgba(148, 163, 184, 0.18)',
    background: 'rgba(255,255,255,0.94)',
  },
  metricLabel: {
    display: 'block',
    color: '#64748b',
    fontSize: '0.8rem',
  },
  metricValue: {
    display: 'block',
    marginTop: '0.35rem',
    fontSize: '1.55rem',
  },
  banner: {
    marginBottom: '1rem',
    padding: '0.9rem 1rem',
    borderRadius: '16px',
    background: 'rgba(15, 118, 110, 0.08)',
    color: '#115e59',
    fontWeight: 600,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1.15fr 1.55fr 1fr',
    gap: '1rem',
    alignItems: 'start',
  },
  panel: {
    padding: '1.2rem',
    borderRadius: '24px',
    border: '1px solid rgba(148, 163, 184, 0.2)',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.96), rgba(248,250,252,0.9))',
    boxShadow: '0 18px 48px rgba(15, 23, 42, 0.08)',
  },
  panelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '1rem',
    marginBottom: '1rem',
    alignItems: 'flex-start',
  },
  panelTitle: {
    margin: 0,
    fontSize: '1.2rem',
    color: '#0f172a',
  },
  panelText: {
    margin: '0.35rem 0 0',
    color: '#64748b',
    lineHeight: 1.6,
  },
  statusPill: {
    padding: '0.4rem 0.8rem',
    borderRadius: '999px',
    fontWeight: 700,
    fontSize: '0.85rem',
  },
  highlightCard: {
    padding: '1rem',
    borderRadius: '18px',
    marginBottom: '1rem',
    background: 'linear-gradient(135deg, #0f172a 0%, #115e59 100%)',
    color: '#e2e8f0',
  },
  highlightLabel: {
    display: 'block',
    color: '#93c5fd',
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    fontSize: '0.74rem',
    fontWeight: 700,
  },
  highlightName: {
    display: 'block',
    marginTop: '0.5rem',
    fontSize: '1.5rem',
    color: '#ffffff',
  },
  highlightMeta: {
    margin: '0.45rem 0 0',
    color: '#cbd5e1',
    lineHeight: 1.6,
  },
  timeline: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.7rem',
  },
  timelineItem: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '1rem',
    alignItems: 'center',
    padding: '0.85rem 0.95rem',
    borderRadius: '16px',
    background: '#f8fafc',
  },
  timelineName: {
    color: '#0f172a',
  },
  timelineMeta: {
    margin: '0.25rem 0 0',
    color: '#64748b',
    fontSize: '0.86rem',
  },
  timelineSubMeta: {
    margin: '0.2rem 0 0',
    color: '#0f766e',
    fontSize: '0.82rem',
    fontWeight: 600,
  },
  emptyText: {
    margin: 0,
    color: '#64748b',
  },
  filters: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
    gap: '0.75rem',
    marginBottom: '1rem',
    alignItems: 'end',
  },
  filterField: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.4rem',
  },
  filterLabel: {
    fontWeight: 700,
    color: '#334155',
    fontSize: '0.84rem',
  },
  input: {
    minHeight: '46px',
    padding: '0.8rem 0.9rem',
    borderRadius: '14px',
    border: '1px solid rgba(148, 163, 184, 0.34)',
    background: '#ffffff',
    color: '#0f172a',
  },
  tableWrap: {
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  th: {
    textAlign: 'left',
    padding: '0.85rem 0.7rem',
    color: '#475569',
    fontSize: '0.82rem',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  td: {
    padding: '0.85rem 0.7rem',
    borderTop: '1px solid #e2e8f0',
    color: '#0f172a',
  },
  row: {
    background: 'transparent',
  },
  rowActions: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  presentButton: {
    padding: '0.55rem 0.8rem',
    borderRadius: '12px',
    border: 'none',
    background: '#16a34a',
    color: '#ffffff',
    fontWeight: 700,
  },
  absentButton: {
    padding: '0.55rem 0.8rem',
    borderRadius: '12px',
    border: 'none',
    background: '#dc2626',
    color: '#ffffff',
    fontWeight: 700,
  },
  recordBadge: {
    display: 'inline-flex',
    padding: '0.35rem 0.65rem',
    borderRadius: '999px',
    fontWeight: 700,
    textTransform: 'capitalize',
    fontSize: '0.8rem',
  },
  emptyCell: {
    padding: '1rem',
    textAlign: 'center',
    color: '#64748b',
  },
  rosterList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    maxHeight: '640px',
    overflowY: 'auto',
  },
  rosterItem: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '1rem',
    alignItems: 'center',
    padding: '0.9rem 1rem',
    borderRadius: '16px',
    background: '#f8fafc',
  },
  rosterName: {
    color: '#0f172a',
  },
  rosterMeta: {
    margin: '0.25rem 0 0',
    color: '#64748b',
  },
  sampleCount: {
    padding: '0.32rem 0.65rem',
    borderRadius: '999px',
    background: '#e0f2fe',
    color: '#0369a1',
    fontWeight: 700,
    fontSize: '0.78rem',
    whiteSpace: 'nowrap',
  },
  captureSection: {
    marginTop: '1rem',
  },
}

export default AttendanceSystem
