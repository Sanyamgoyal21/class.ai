import React from 'react'
import { BACKEND_URL } from '../utils/backendUrl'

const initialLiveState = {
  running: false,
  recentDetections: [],
  lastError: null,
  knownFaces: 0,
  cameraIndex: 0,
}

export default function GateAttendance() {
  const [liveStatus, setLiveStatus] = React.useState(initialLiveState)
  const [message, setMessage] = React.useState('')
  const [loading, setLoading] = React.useState(false)

  const fetchHealth = React.useCallback(async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/health`)
      if (!response.ok) throw new Error('Failed to fetch backend health')
      const payload = await response.json()
      setLiveStatus(payload.live || initialLiveState)
      setMessage('')
    } catch (error) {
      setMessage(error.message)
    }
  }, [])

  React.useEffect(() => {
    fetchHealth()
    const interval = window.setInterval(fetchHealth, 5000)
    return () => window.clearInterval(interval)
  }, [fetchHealth])

  const runGate = async (action) => {
    setLoading(true)
    try {
      const response = await fetch(`${BACKEND_URL}/attendance/live/${action}`, {
        method: 'POST',
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || payload.error || `Failed to ${action} gate attendance`)
      setLiveStatus(payload.live || { ...initialLiveState, running: action === 'start' })
      setMessage(
        action === 'start'
          ? 'Gate camera opened and attendance recognition started.'
          : 'Gate attendance stopped.'
      )
      await fetchHealth()
    } catch (error) {
      setMessage(error.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <p style={styles.eyebrow}>Gate Attendance</p>
          <h1 style={styles.title}>Capture student faces and mark attendance at the gate</h1>
          <p style={styles.subtitle}>
            Open the gate camera once and the face-recognition attendance flow will keep detecting students and marking them present automatically.
          </p>
        </div>
      </header>

      <section style={styles.statusGrid}>
        <article style={styles.card}>
          <h2 style={styles.cardTitle}>Gate camera</h2>
          <p style={styles.cardText}>This starts the local camera and live attendance recognition together.</p>
          <div style={styles.statusBadgeRow}>
            <span style={{ ...styles.statusBadge, backgroundColor: liveStatus.running ? '#dcfce7' : '#fee2e2', color: liveStatus.running ? '#166534' : '#991b1b' }}>
              {liveStatus.running ? 'Running' : 'Stopped'}
            </span>
          </div>
          <div style={styles.actionsRow}>
            <button style={styles.startButton} onClick={() => runGate('start')} disabled={loading || liveStatus.running}>Start Gate Attendance</button>
            <button style={styles.stopButton} onClick={() => runGate('stop')} disabled={loading || !liveStatus.running}>Stop Gate Attendance</button>
          </div>
        </article>

        <article style={styles.card}>
          <h2 style={styles.cardTitle}>Recognition details</h2>
          <p style={styles.cardText}>Students are matched by face sample name and their dashboard details are shown during attendance.</p>
          <div style={styles.infoStack}>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>Known faces</span>
              <strong style={styles.infoValue}>{liveStatus.knownFaces || 0}</strong>
            </div>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>Camera index</span>
              <strong style={styles.infoValue}>{liveStatus.cameraIndex ?? 0}</strong>
            </div>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>Status</span>
              <strong style={styles.infoValue}>{liveStatus.running ? 'Recognizing' : 'Idle'}</strong>
            </div>
          </div>
        </article>
      </section>

      <section style={styles.panel}>
        <div style={styles.panelHeader}>
          <h2 style={styles.panelTitle}>Recent detections</h2>
          <p style={styles.panelText}>Latest recognized faces with name, roll number, class, and section.</p>
        </div>
        <div style={styles.detectionList}>
          {liveStatus.recentDetections?.length ? (
            liveStatus.recentDetections.slice(0, 10).map((entry, index) => (
              <div key={`${entry.detectedAt || 'unknown'}-${index}`} style={styles.detectionItem}>
                <div>
                  <strong>{entry.match?.name || 'Unknown student'}</strong>
                  <p style={styles.detectionMeta}>
                    {entry.match
                      ? `${entry.match.rollNumber || 'No roll'} | ${entry.match.className || '-'} | ${entry.match.section || '-'}`
                      : 'Face not matched with a registered student'}
                  </p>
                </div>
                <span style={styles.detectionTime}>{new Date(entry.detectedAt || Date.now()).toLocaleTimeString()}</span>
              </div>
            ))
          ) : (
            <div style={styles.emptyState}>No detections yet. Start gate attendance to begin.</div>
          )}
        </div>
      </section>

      {liveStatus.lastError ? <div style={styles.errorBanner}>{liveStatus.lastError}</div> : null}
      {message ? <div style={styles.banner}>{message}</div> : null}
    </div>
  )
}

const styles = {
  page: {
    padding: '1.5rem',
    maxWidth: '1100px',
    margin: '0 auto',
    color: '#111827',
  },
  header: {
    marginBottom: '1.5rem',
  },
  eyebrow: {
    textTransform: 'uppercase',
    letterSpacing: '0.2em',
    fontSize: '0.8rem',
    color: '#6366f1',
    marginBottom: '0.75rem',
  },
  title: {
    fontSize: '2rem',
    margin: 0,
    lineHeight: 1.1,
  },
  subtitle: {
    maxWidth: '760px',
    marginTop: '0.75rem',
    color: '#4b5563',
  },
  statusGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '1rem',
    marginBottom: '1.5rem',
  },
  card: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: '1rem',
    padding: '1.25rem',
    boxShadow: '0 1px 2px rgba(15, 23, 42, 0.05)',
  },
  cardTitle: {
    margin: 0,
    fontSize: '1.1rem',
  },
  cardText: {
    color: '#6b7280',
    margin: '0.75rem 0',
  },
  infoStack: {
    display: 'grid',
    gap: '0.75rem',
  },
  infoRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '1rem',
    padding: '0.85rem 0.95rem',
    borderRadius: '0.75rem',
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
  },
  infoLabel: {
    color: '#6b7280',
  },
  infoValue: {
    color: '#111827',
  },
  statusBadgeRow: {
    marginBottom: '1rem',
  },
  statusBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0.35rem 0.75rem',
    borderRadius: '9999px',
    fontSize: '0.85rem',
    fontWeight: 600,
  },
  actionsRow: {
    display: 'flex',
    gap: '0.75rem',
    flexWrap: 'wrap',
  },
  startButton: {
    flex: 1,
    border: 'none',
    background: '#4f46e5',
    color: '#fff',
    padding: '0.85rem 1rem',
    borderRadius: '0.75rem',
    cursor: 'pointer',
  },
  stopButton: {
    flex: 1,
    border: '1px solid #d1d5db',
    background: '#f9fafb',
    color: '#111827',
    padding: '0.85rem 1rem',
    borderRadius: '0.75rem',
    cursor: 'pointer',
  },
  panel: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: '1rem',
    padding: '1.25rem',
  },
  panelHeader: {
    marginBottom: '1rem',
  },
  panelTitle: {
    margin: 0,
    fontSize: '1.125rem',
  },
  panelText: {
    color: '#6b7280',
    marginTop: '0.5rem',
  },
  detectionList: {
    display: 'grid',
    gap: '0.75rem',
  },
  detectionItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '1rem',
    padding: '1rem',
    borderRadius: '0.75rem',
    border: '1px solid #e5e7eb',
    background: '#f9fafb',
  },
  detectionMeta: {
    margin: '0.25rem 0 0',
    color: '#6b7280',
  },
  detectionTime: {
    color: '#6b7280',
    whiteSpace: 'nowrap',
  },
  emptyState: {
    padding: '1.5rem',
    borderRadius: '0.75rem',
    border: '1px dashed #d1d5db',
    color: '#6b7280',
    textAlign: 'center',
  },
  banner: {
    marginTop: '1rem',
    borderRadius: '0.75rem',
    padding: '1rem',
    background: '#f8fafc',
    color: '#111827',
    border: '1px solid #e5e7eb',
  },
  errorBanner: {
    marginTop: '1rem',
    borderRadius: '0.75rem',
    padding: '1rem',
    background: '#fef2f2',
    color: '#991b1b',
    border: '1px solid #fecaca',
  },
}
