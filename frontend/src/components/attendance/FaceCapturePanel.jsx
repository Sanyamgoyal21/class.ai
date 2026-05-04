import React from 'react'

function FaceCapturePanel({
  teacherMode = false,
  registerForm,
  setRegisterForm,
  registerStudent,
  registering,
  cameraReady,
  samples,
  startCamera,
  stopCamera,
  captureSample,
  videoRef,
}) {
  if (!teacherMode) return null

  return (
    <article style={styles.panel}>
      <div style={styles.panelHeader}>
        <div>
          <h2 style={styles.panelTitle}>Capture face samples</h2>
          <p style={styles.panelText}>
            Register students from the SuperNode dashboard by saving 3 to 5 clear face angles.
          </p>
          <p style={styles.panelSubText}>
            Face samples are saved under the student name, while roll number, class, and section stay linked in the dashboard attendance data.
          </p>
        </div>
        <span style={styles.panelBadge}>SuperNode capture</span>
      </div>

      <form onSubmit={registerStudent} style={styles.form}>
        <div style={styles.formGrid}>
          <label style={styles.field}>
            <span style={styles.label}>Name</span>
            <input
              type="text"
              value={registerForm.name}
              onChange={(event) => setRegisterForm(prev => ({ ...prev, name: event.target.value }))}
              style={styles.input}
              required
            />
          </label>
          <label style={styles.field}>
            <span style={styles.label}>Roll Number</span>
            <input
              type="text"
              value={registerForm.rollNumber}
              onChange={(event) => setRegisterForm(prev => ({ ...prev, rollNumber: event.target.value }))}
              style={styles.input}
              required
            />
          </label>
          <label style={styles.field}>
            <span style={styles.label}>Class</span>
            <input
              type="text"
              value={registerForm.className}
              onChange={(event) => setRegisterForm(prev => ({ ...prev, className: event.target.value }))}
              style={styles.input}
              required
            />
          </label>
          <label style={styles.field}>
            <span style={styles.label}>Section</span>
            <input
              type="text"
              value={registerForm.section}
              onChange={(event) => setRegisterForm(prev => ({ ...prev, section: event.target.value }))}
              style={styles.input}
              required
            />
          </label>
        </div>

        <div style={styles.cameraCard}>
          <video ref={videoRef} autoPlay playsInline muted style={styles.video} />
          <div style={styles.cameraActions}>
            {!cameraReady ? (
              <button type="button" style={styles.secondaryButton} onClick={startCamera}>Open Camera</button>
            ) : (
              <>
                <button type="button" style={styles.secondaryButton} onClick={captureSample}>Capture Sample</button>
                <button type="button" style={styles.secondaryButton} onClick={stopCamera}>Stop Camera</button>
              </>
            )}
          </div>
          <p style={styles.helperText}>Capture straight, left, right, slightly up, and slightly down. At least 3 samples are required.</p>
          <div style={styles.sampleStrip}>
            {samples.map((image, index) => (
              <img key={`${image}-${index}`} src={image} alt={`Sample ${index + 1}`} style={styles.sampleImage} />
            ))}
            {samples.length === 0 ? <p style={styles.emptyState}>No face samples captured yet.</p> : null}
          </div>
        </div>

        <button type="submit" style={styles.primaryButton} disabled={registering}>
          {registering ? 'Registering...' : 'Register Student Face'}
        </button>
      </form>
    </article>
  )
}

const styles = {
  panel: {
    padding: '1.25rem',
    borderRadius: '28px',
    border: '1px solid rgba(15, 23, 42, 0.08)',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.96), rgba(240,249,255,0.92))',
    boxShadow: '0 20px 60px rgba(15, 23, 42, 0.08)',
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
    color: '#475569',
    lineHeight: 1.6,
  },
  panelSubText: {
    margin: '0.35rem 0 0',
    color: '#64748b',
    lineHeight: 1.6,
    fontSize: '0.92rem',
  },
  panelBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0.4rem 0.75rem',
    borderRadius: '999px',
    background: '#dbeafe',
    color: '#1d4ed8',
    fontWeight: 700,
    fontSize: '0.82rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: '0.75rem',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.45rem',
  },
  label: {
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
  cameraCard: {
    padding: '1rem',
    borderRadius: '22px',
    background: 'linear-gradient(160deg, #0f172a 0%, #134e4a 100%)',
    color: '#e2e8f0',
  },
  video: {
    width: '100%',
    maxHeight: '340px',
    borderRadius: '18px',
    background: '#020617',
    objectFit: 'cover',
  },
  cameraActions: {
    display: 'flex',
    gap: '0.75rem',
    flexWrap: 'wrap',
    marginTop: '0.85rem',
  },
  helperText: {
    color: '#cbd5e1',
    marginBottom: '0.85rem',
  },
  sampleStrip: {
    display: 'flex',
    gap: '0.75rem',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  sampleImage: {
    width: '92px',
    height: '92px',
    borderRadius: '16px',
    objectFit: 'cover',
    border: '2px solid rgba(125, 211, 252, 0.3)',
  },
  emptyState: {
    margin: 0,
    color: '#cbd5e1',
  },
  primaryButton: {
    minHeight: '48px',
    padding: '0.95rem 1.2rem',
    border: 'none',
    borderRadius: '14px',
    background: 'linear-gradient(135deg, #0f766e 0%, #0f172a 100%)',
    color: '#ffffff',
    fontWeight: 700,
  },
  secondaryButton: {
    minHeight: '44px',
    padding: '0.75rem 1rem',
    borderRadius: '12px',
    border: '1px solid rgba(148, 163, 184, 0.24)',
    background: 'rgba(255,255,255,0.12)',
    color: '#ffffff',
    fontWeight: 700,
  },
}

export default FaceCapturePanel
