import { useState, useEffect, useRef } from 'react'
import { io } from 'socket.io-client'

const SUPERNODE_URL = 'http://localhost:5000'

// Load saved presets from localStorage
const loadSavedPresets = () => {
  try {
    const saved = localStorage.getItem('videoPresets')
    return saved ? JSON.parse(saved) : [
      { id: 1, name: 'Morning Assembly', url: 'https://www.youtube.com/watch?v=example1' },
      { id: 2, name: 'National Anthem', url: 'https://www.youtube.com/watch?v=example2' },
    ]
  } catch {
    return []
  }
}

function SuperNode() {
  // Connection state
  const [devices, setDevices] = useState([])
  const [connected, setConnected] = useState(false)
  const [socket, setSocket] = useState(null)
  const [messages, setMessages] = useState([])
  const [health, setHealth] = useState(null)

  // Video control state
  const [selectedDevices, setSelectedDevices] = useState([])
  const [globalVideoUrl, setGlobalVideoUrl] = useState('')
  const [deviceVideoUrls, setDeviceVideoUrls] = useState({})
  const [videoStates, setVideoStates] = useState({})

  // Saved presets
  const [savedPresets, setSavedPresets] = useState(loadSavedPresets)
  const [newPresetName, setNewPresetName] = useState('')
  const [showPresetModal, setShowPresetModal] = useState(false)

  // Announcement (WebRTC) state
  const [isAnnouncing, setIsAnnouncing] = useState(false)
  const [announcementSession, setAnnouncementSession] = useState(null)
  const [localStream, setLocalStream] = useState(null)
  const localVideoRef = useRef(null)
  const peerConnectionsRef = useRef({})

  // Emergency broadcast state
  const [emergencyMessage, setEmergencyMessage] = useState('')
  const [showEmergencyModal, setShowEmergencyModal] = useState(false)

  // Save presets to localStorage when changed
  useEffect(() => {
    localStorage.setItem('videoPresets', JSON.stringify(savedPresets))
  }, [savedPresets])

  // Initialize socket connection
  useEffect(() => {
    const s = io(SUPERNODE_URL, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
    })
    setSocket(s)

    s.on('connect', () => {
      setConnected(true)
      addMessage('Connected to Supernode', 'success')
      s.emit('device:register', {
        deviceId: `dashboard-${Date.now()}`,
        type: 'dashboard',
        name: 'Teacher Dashboard',
        capabilities: ['view', 'control'],
      })
    })

    s.on('disconnect', () => {
      setConnected(false)
      addMessage('Disconnected from Supernode', 'error')
    })

    s.on('device:registered', (data) => {
      if (data.success) {
        addMessage('Registered as Dashboard', 'success')
        s.emit('devices:list')
      }
    })

    s.on('devices:list', (deviceList) => {
      setDevices(deviceList.filter(d => d.type !== 'dashboard'))
    })

    s.on('device:status', (data) => {
      setDevices(prev => prev.map(d =>
        d.deviceId === data.deviceId ? { ...d, status: data.status } : d
      ))
    })

    s.on('device:heartbeat-ack', (data) => {
      setDevices(prev => prev.map(d =>
        d.deviceId === data.deviceId ? { ...d, status: data.status, metrics: data.metrics } : d
      ))
    })

    // Video events
    s.on('video:state-changed', (data) => {
      setVideoStates(prev => ({
        ...prev,
        [data.deviceId]: {
          state: data.state,
          url: data.url,
          currentTime: data.currentTime,
        },
      }))
    })

    s.on('video:play-sent', (data) => {
      addMessage(`Video sent to ${data.targetCount} device(s)`, 'success')
    })

    s.on('video:stop-sent', (data) => {
      addMessage(`Video stopped on ${data.targetCount} device(s)`, 'success')
    })

    // Announcement events
    s.on('announcement:started', (data) => {
      setAnnouncementSession(data)
      addMessage(`Announcement started - ${data.targetCount} device(s)`, 'success')
    })

    s.on('announcement:ended', () => {
      setAnnouncementSession(null)
      setIsAnnouncing(false)
      addMessage('Announcement ended', 'info')
    })

    s.on('announcement:device-ready', (data) => {
      addMessage(`${data.deviceName} ready`, 'info')
    })

    // WebRTC signaling
    s.on('webrtc:answer', async (data) => {
      const pc = peerConnectionsRef.current[data.from]
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
        } catch (err) {
          console.error('WebRTC error:', err)
        }
      }
    })

    s.on('webrtc:ice-candidate', (data) => {
      const pc = peerConnectionsRef.current[data.from]
      if (pc && data.candidate) {
        pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(console.error)
      }
    })

    fetchHealth()
    const healthInterval = setInterval(fetchHealth, 30000)

    return () => {
      clearInterval(healthInterval)
      s.disconnect()
    }
  }, [])

  const addMessage = (text, type = 'info') => {
    setMessages(prev => [{ text, type, timestamp: new Date().toLocaleTimeString() }, ...prev].slice(0, 30))
  }

  const fetchHealth = async () => {
    try {
      const res = await fetch(`${SUPERNODE_URL}/health`)
      setHealth(await res.json())
    } catch {
      setHealth(null)
    }
  }

  // =================== DEVICE SELECTION ===================

  const toggleDeviceSelection = (deviceId) => {
    setSelectedDevices(prev =>
      prev.includes(deviceId) ? prev.filter(id => id !== deviceId) : [...prev, deviceId]
    )
  }

  const selectAllClassrooms = () => {
    const ids = devices.filter(d => d.type === 'classroom' && d.status === 'online').map(d => d.deviceId)
    setSelectedDevices(ids)
  }

  const deselectAll = () => setSelectedDevices([])

  // =================== VIDEO CONTROL ===================

  // Play to selected devices (global)
  const playToSelected = () => {
    if (socket && connected && globalVideoUrl.trim() && selectedDevices.length > 0) {
      socket.emit('video:play', {
        targetDeviceIds: selectedDevices,
        url: globalVideoUrl.trim(),
        autoPlay: true,
        volume: 1.0,
      })
    }
  }

  // Play to single device
  const playToDevice = (deviceId) => {
    const url = deviceVideoUrls[deviceId]?.trim()
    if (socket && connected && url) {
      socket.emit('video:play', {
        targetDeviceIds: [deviceId],
        url: url,
        autoPlay: true,
        volume: 1.0,
      })
      addMessage(`Playing on ${deviceId}`, 'info')
    }
  }

  // Stop single device
  const stopDevice = (deviceId) => {
    if (socket && connected) {
      socket.emit('video:stop', { targetDeviceIds: [deviceId] })
    }
  }

  // Stop all selected
  const stopAllSelected = () => {
    if (socket && connected && selectedDevices.length > 0) {
      socket.emit('video:stop', { targetDeviceIds: selectedDevices })
    }
  }

  // =================== PRESETS ===================

  const saveCurrentAsPreset = () => {
    if (globalVideoUrl.trim() && newPresetName.trim()) {
      const newPreset = {
        id: Date.now(),
        name: newPresetName.trim(),
        url: globalVideoUrl.trim(),
      }
      setSavedPresets(prev => [...prev, newPreset])
      setNewPresetName('')
      setShowPresetModal(false)
      addMessage(`Preset "${newPreset.name}" saved`, 'success')
    }
  }

  const loadPreset = (preset) => {
    setGlobalVideoUrl(preset.url)
  }

  const deletePreset = (id) => {
    setSavedPresets(prev => prev.filter(p => p.id !== id))
  }

  // =================== ANNOUNCEMENT ===================

  const startAnnouncement = async () => {
    if (selectedDevices.length === 0) {
      addMessage('Select classroom devices first', 'error')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      setLocalStream(stream)
      setIsAnnouncing(true)

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }

      socket.emit('announcement:start', {
        targetDeviceIds: selectedDevices,
        type: 'audio_video',
      })

      setTimeout(() => {
        selectedDevices.forEach(deviceId => createOfferForDevice(deviceId, stream))
      }, 500)

    } catch (error) {
      addMessage(`Camera/mic denied: ${error.message}`, 'error')
      setIsAnnouncing(false)
    }
  }

  const createOfferForDevice = async (deviceId, stream) => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    })
    peerConnectionsRef.current[deviceId] = pc

    stream.getTracks().forEach(track => pc.addTrack(track, stream))

    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('webrtc:ice-candidate', { to: deviceId, candidate: event.candidate })
      }
    }

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      socket.emit('webrtc:offer', { to: deviceId, sdp: offer })
    } catch (error) {
      console.error('Offer error:', error)
    }
  }

  const endAnnouncement = () => {
    if (announcementSession && socket) {
      socket.emit('announcement:end', {
        sessionId: announcementSession.sessionId,
        targetDeviceIds: announcementSession.targetDeviceIds,
      })
    }
    cleanupWebRTC()
  }

  const cleanupWebRTC = () => {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop())
      setLocalStream(null)
    }
    Object.values(peerConnectionsRef.current).forEach(pc => pc?.close())
    peerConnectionsRef.current = {}
    setIsAnnouncing(false)
    setAnnouncementSession(null)
    if (localVideoRef.current) localVideoRef.current.srcObject = null
  }

  useEffect(() => () => cleanupWebRTC(), [])

  // =================== EMERGENCY BROADCAST ===================

  const sendEmergencyBroadcast = () => {
    if (socket && connected && emergencyMessage.trim()) {
      // Send to ALL classroom devices (not just selected)
      const allClassrooms = devices.filter(d => d.type === 'classroom').map(d => d.deviceId)

      socket.emit('emergency:broadcast', {
        message: emergencyMessage.trim(),
        targetDeviceIds: allClassrooms,
      })

      addMessage(`EMERGENCY: ${emergencyMessage}`, 'error')
      setEmergencyMessage('')
      setShowEmergencyModal(false)
    }
  }

  // =================== RENDER ===================

  const classroomDevices = devices.filter(d => d.type === 'classroom')
  const onlineCount = classroomDevices.filter(d => d.status === 'online').length

  return (
    <div style={styles.container}>
      {/* Header */}
      <header style={styles.header}>
        <h1 style={styles.title}>Classroom Control Center</h1>
        <div style={styles.headerRight}>
          <span style={styles.deviceCount}>{onlineCount} / {classroomDevices.length} online</span>
          <div style={styles.connectionStatus}>
            <span style={{ ...styles.statusDot, backgroundColor: connected ? '#22c55e' : '#ef4444' }} />
            {connected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
      </header>

      {/* Control Bar - Always Visible */}
      <div style={styles.controlBar}>
        {/* Selection Controls */}
        <div style={styles.controlGroup}>
          <button style={styles.selectBtn} onClick={selectAllClassrooms}>
            Select All ({onlineCount})
          </button>
          <button style={styles.selectBtn} onClick={deselectAll}>
            Deselect
          </button>
          <span style={styles.selectedCount}>{selectedDevices.length} selected</span>
        </div>

        {/* Global Video Controls */}
        <div style={styles.controlGroup}>
          <select
            style={styles.presetSelect}
            onChange={(e) => {
              const preset = savedPresets.find(p => p.id === parseInt(e.target.value))
              if (preset) loadPreset(preset)
            }}
            value=""
          >
            <option value="">Load Preset...</option>
            {savedPresets.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="YouTube or video URL..."
            value={globalVideoUrl}
            onChange={(e) => setGlobalVideoUrl(e.target.value)}
            style={styles.urlInput}
          />
          <button
            style={{ ...styles.actionBtn, ...styles.playBtn }}
            onClick={playToSelected}
            disabled={!globalVideoUrl.trim() || selectedDevices.length === 0}
          >
            Play to Selected
          </button>
          <button
            style={{ ...styles.actionBtn, ...styles.stopBtn }}
            onClick={stopAllSelected}
            disabled={selectedDevices.length === 0}
          >
            Stop All
          </button>
          <button style={styles.savePresetBtn} onClick={() => setShowPresetModal(true)}>
            Save
          </button>
        </div>

        {/* Announcement */}
        <div style={styles.controlGroup}>
          {!isAnnouncing ? (
            <button
              style={{ ...styles.actionBtn, ...styles.announceBtn }}
              onClick={startAnnouncement}
              disabled={selectedDevices.length === 0}
            >
              Start Live
            </button>
          ) : (
            <button
              style={{ ...styles.actionBtn, ...styles.stopBtn }}
              onClick={endAnnouncement}
            >
              End Live
            </button>
          )}
        </div>

        {/* Emergency */}
        <button
          style={styles.emergencyBtn}
          onClick={() => setShowEmergencyModal(true)}
        >
          EMERGENCY
        </button>
      </div>

      {/* Main Content */}
      <div style={styles.mainContent}>
        {/* Left Panel - Devices */}
        <div style={styles.panel}>
          <h2 style={styles.panelTitle}>Classrooms</h2>
          <div style={styles.deviceList}>
            {classroomDevices.length === 0 ? (
              <p style={styles.noDevices}>No classrooms connected</p>
            ) : (
              classroomDevices.map(device => (
                <div
                  key={device.deviceId}
                  style={{
                    ...styles.deviceCard,
                    borderColor: selectedDevices.includes(device.deviceId) ? '#8b5cf6' : '#e5e7eb',
                    backgroundColor: selectedDevices.includes(device.deviceId) ? '#faf5ff' : 'white',
                    opacity: device.status === 'online' ? 1 : 0.5,
                  }}
                >
                  {/* Device Header */}
                  <div style={styles.deviceHeader}>
                    <input
                      type="checkbox"
                      checked={selectedDevices.includes(device.deviceId)}
                      onChange={() => toggleDeviceSelection(device.deviceId)}
                      disabled={device.status !== 'online'}
                      style={styles.checkbox}
                    />
                    <span style={styles.deviceName}>{device.name || device.deviceId}</span>
                    <span style={{
                      ...styles.statusBadge,
                      backgroundColor: device.status === 'online' ? '#22c55e' : '#ef4444'
                    }}>
                      {device.status}
                    </span>
                  </div>

                  {/* Per-Device Video Control */}
                  {device.status === 'online' && (
                    <div style={styles.deviceVideoControl}>
                      <input
                        type="text"
                        placeholder="Video URL for this classroom..."
                        value={deviceVideoUrls[device.deviceId] || ''}
                        onChange={(e) => setDeviceVideoUrls(prev => ({
                          ...prev,
                          [device.deviceId]: e.target.value
                        }))}
                        style={styles.deviceUrlInput}
                      />
                      <button
                        style={styles.devicePlayBtn}
                        onClick={() => playToDevice(device.deviceId)}
                        disabled={!deviceVideoUrls[device.deviceId]?.trim()}
                        title="Play"
                      >
                        ▶
                      </button>
                      <button
                        style={styles.deviceStopBtn}
                        onClick={() => stopDevice(device.deviceId)}
                        title="Stop"
                      >
                        ⏹
                      </button>
                    </div>
                  )}

                  {/* Video Status */}
                  {videoStates[device.deviceId] && (
                    <div style={{
                      ...styles.videoStatus,
                      backgroundColor: videoStates[device.deviceId].state === 'playing' ? '#dcfce7' : '#f1f5f9',
                    }}>
                      <span style={styles.videoStatusText}>
                        {videoStates[device.deviceId].state === 'playing' ? '▶ Playing' : videoStates[device.deviceId].state}
                      </span>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Center Panel - Preview */}
        <div style={styles.panel}>
          <h2 style={styles.panelTitle}>Live Preview</h2>
          {isAnnouncing ? (
            <div style={styles.previewContainer}>
              <div style={styles.liveLabel}>LIVE</div>
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                style={styles.previewVideo}
              />
              <p style={styles.previewText}>Broadcasting to {announcementSession?.targetCount || selectedDevices.length} classroom(s)</p>
            </div>
          ) : (
            <div style={styles.previewPlaceholder}>
              <div style={styles.placeholderIcon}>📺</div>
              <p>Start a live announcement to preview here</p>
              <p style={styles.placeholderSub}>Select classrooms and click "Start Live"</p>
            </div>
          )}

          {/* Saved Presets List */}
          <div style={styles.presetsSection}>
            <h3 style={styles.subTitle}>Saved Video Presets</h3>
            <div style={styles.presetsList}>
              {savedPresets.map(preset => (
                <div key={preset.id} style={styles.presetItem}>
                  <span style={styles.presetName}>{preset.name}</span>
                  <button
                    style={styles.presetLoadBtn}
                    onClick={() => loadPreset(preset)}
                  >
                    Load
                  </button>
                  <button
                    style={styles.presetDeleteBtn}
                    onClick={() => deletePreset(preset.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Panel - Logs */}
        <div style={styles.panel}>
          <h2 style={styles.panelTitle}>Activity Log</h2>
          <div style={styles.logList}>
            {messages.map((msg, i) => (
              <div key={i} style={{
                ...styles.logEntry,
                color: msg.type === 'error' ? '#ef4444' :
                       msg.type === 'success' ? '#22c55e' : '#64748b'
              }}>
                <small style={styles.logTime}>[{msg.timestamp}]</small>
                <span>{msg.text}</span>
              </div>
            ))}
          </div>

          {/* Health Status */}
          {health && (
            <div style={styles.healthSection}>
              <h3 style={styles.subTitle}>System Status</h3>
              <div style={styles.healthGrid}>
                <div style={styles.healthItem}>
                  <span>AI (Ollama)</span>
                  <span style={{ color: health.components?.ollama?.healthy ? '#22c55e' : '#ef4444' }}>
                    {health.components?.ollama?.healthy ? '✓ Online' : '✗ Offline'}
                  </span>
                </div>
                <div style={styles.healthItem}>
                  <span>Devices</span>
                  <span>{health.components?.devices?.online || 0} online</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Save Preset Modal */}
      {showPresetModal && (
        <div style={styles.modalOverlay} onClick={() => setShowPresetModal(false)}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <h3 style={styles.modalTitle}>Save as Preset</h3>
            <input
              type="text"
              placeholder="Preset name..."
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              style={styles.modalInput}
            />
            <p style={styles.modalUrl}>URL: {globalVideoUrl}</p>
            <div style={styles.modalButtons}>
              <button style={styles.modalCancel} onClick={() => setShowPresetModal(false)}>Cancel</button>
              <button style={styles.modalSave} onClick={saveCurrentAsPreset}>Save Preset</button>
            </div>
          </div>
        </div>
      )}

      {/* Emergency Broadcast Modal */}
      {showEmergencyModal && (
        <div style={styles.modalOverlay} onClick={() => setShowEmergencyModal(false)}>
          <div style={{ ...styles.modal, ...styles.emergencyModal }} onClick={e => e.stopPropagation()}>
            <h3 style={styles.emergencyModalTitle}>EMERGENCY BROADCAST</h3>
            <p style={styles.emergencyModalSub}>This will send an alert to ALL classroom displays</p>
            <input
              type="text"
              placeholder="Enter emergency message..."
              value={emergencyMessage}
              onChange={(e) => setEmergencyMessage(e.target.value)}
              style={styles.emergencyInput}
              autoFocus
            />
            <div style={styles.modalButtons}>
              <button style={styles.modalCancel} onClick={() => setShowEmergencyModal(false)}>Cancel</button>
              <button
                style={styles.emergencySendBtn}
                onClick={sendEmergencyBroadcast}
                disabled={!emergencyMessage.trim()}
              >
                SEND EMERGENCY ALERT
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#f1f5f9',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1rem 2rem',
    backgroundColor: '#1e293b',
    color: 'white',
  },
  title: {
    margin: 0,
    fontSize: '1.5rem',
    fontWeight: '600',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.5rem',
  },
  deviceCount: {
    fontSize: '0.875rem',
    color: '#94a3b8',
  },
  connectionStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.875rem',
  },
  statusDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
  },

  // Control Bar
  controlBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    padding: '0.75rem 2rem',
    backgroundColor: 'white',
    borderBottom: '1px solid #e2e8f0',
    flexWrap: 'wrap',
  },
  controlGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  selectBtn: {
    padding: '0.5rem 1rem',
    fontSize: '0.8rem',
    border: '1px solid #cbd5e1',
    borderRadius: '6px',
    backgroundColor: 'white',
    cursor: 'pointer',
  },
  selectedCount: {
    fontSize: '0.8rem',
    color: '#64748b',
    marginLeft: '0.5rem',
  },
  presetSelect: {
    padding: '0.5rem',
    fontSize: '0.8rem',
    border: '1px solid #cbd5e1',
    borderRadius: '6px',
    backgroundColor: 'white',
    minWidth: '140px',
  },
  urlInput: {
    padding: '0.5rem 1rem',
    fontSize: '0.875rem',
    border: '1px solid #cbd5e1',
    borderRadius: '6px',
    width: '280px',
  },
  actionBtn: {
    padding: '0.5rem 1rem',
    fontSize: '0.8rem',
    fontWeight: '600',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'opacity 0.2s',
  },
  playBtn: {
    backgroundColor: '#22c55e',
    color: 'white',
  },
  stopBtn: {
    backgroundColor: '#ef4444',
    color: 'white',
  },
  announceBtn: {
    backgroundColor: '#8b5cf6',
    color: 'white',
  },
  savePresetBtn: {
    padding: '0.5rem 0.75rem',
    fontSize: '0.8rem',
    border: '1px solid #cbd5e1',
    borderRadius: '6px',
    backgroundColor: 'white',
    cursor: 'pointer',
  },
  emergencyBtn: {
    padding: '0.5rem 1.5rem',
    fontSize: '0.8rem',
    fontWeight: '700',
    backgroundColor: '#dc2626',
    color: 'white',
    border: '2px solid #991b1b',
    borderRadius: '6px',
    cursor: 'pointer',
    marginLeft: 'auto',
  },

  // Main Content
  mainContent: {
    display: 'grid',
    gridTemplateColumns: '1fr 1.2fr 1fr',
    gap: '1rem',
    padding: '1rem',
    height: 'calc(100vh - 140px)',
  },
  panel: {
    backgroundColor: 'white',
    borderRadius: '12px',
    padding: '1rem',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    overflow: 'auto',
  },
  panelTitle: {
    margin: '0 0 1rem 0',
    fontSize: '1rem',
    fontWeight: '600',
    color: '#1e293b',
  },

  // Device List
  deviceList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  noDevices: {
    color: '#94a3b8',
    textAlign: 'center',
    padding: '2rem',
  },
  deviceCard: {
    border: '2px solid #e5e7eb',
    borderRadius: '10px',
    padding: '0.75rem',
    transition: 'all 0.2s',
  },
  deviceHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.5rem',
  },
  checkbox: {
    width: '18px',
    height: '18px',
    cursor: 'pointer',
  },
  deviceName: {
    fontWeight: '600',
    flex: 1,
    fontSize: '0.9rem',
  },
  statusBadge: {
    padding: '0.2rem 0.6rem',
    borderRadius: '9999px',
    fontSize: '0.7rem',
    color: 'white',
    fontWeight: '500',
  },
  deviceVideoControl: {
    display: 'flex',
    gap: '0.4rem',
    marginTop: '0.5rem',
  },
  deviceUrlInput: {
    flex: 1,
    padding: '0.4rem 0.6rem',
    fontSize: '0.75rem',
    border: '1px solid #e2e8f0',
    borderRadius: '4px',
  },
  devicePlayBtn: {
    padding: '0.4rem 0.6rem',
    backgroundColor: '#22c55e',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.75rem',
  },
  deviceStopBtn: {
    padding: '0.4rem 0.6rem',
    backgroundColor: '#ef4444',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.75rem',
  },
  videoStatus: {
    marginTop: '0.5rem',
    padding: '0.3rem 0.6rem',
    borderRadius: '4px',
    fontSize: '0.7rem',
  },
  videoStatusText: {
    fontWeight: '500',
  },

  // Preview
  previewContainer: {
    position: 'relative',
    backgroundColor: '#000',
    borderRadius: '8px',
    overflow: 'hidden',
  },
  liveLabel: {
    position: 'absolute',
    top: '10px',
    left: '10px',
    backgroundColor: '#ef4444',
    color: 'white',
    padding: '4px 12px',
    borderRadius: '4px',
    fontSize: '0.75rem',
    fontWeight: '700',
    zIndex: 10,
  },
  previewVideo: {
    width: '100%',
    maxHeight: '300px',
    backgroundColor: '#000',
  },
  previewText: {
    color: 'white',
    textAlign: 'center',
    padding: '0.5rem',
    margin: 0,
    fontSize: '0.875rem',
  },
  previewPlaceholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '3rem',
    backgroundColor: '#f8fafc',
    borderRadius: '8px',
    color: '#64748b',
  },
  placeholderIcon: {
    fontSize: '3rem',
    marginBottom: '1rem',
  },
  placeholderSub: {
    fontSize: '0.75rem',
    color: '#94a3b8',
    marginTop: '0.5rem',
  },

  // Presets
  presetsSection: {
    marginTop: '1.5rem',
    paddingTop: '1rem',
    borderTop: '1px solid #e2e8f0',
  },
  subTitle: {
    margin: '0 0 0.75rem 0',
    fontSize: '0.875rem',
    fontWeight: '600',
    color: '#475569',
  },
  presetsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  presetItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem',
    backgroundColor: '#f8fafc',
    borderRadius: '6px',
  },
  presetName: {
    flex: 1,
    fontSize: '0.8rem',
    fontWeight: '500',
  },
  presetLoadBtn: {
    padding: '0.25rem 0.5rem',
    fontSize: '0.7rem',
    backgroundColor: '#3b82f6',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  presetDeleteBtn: {
    padding: '0.25rem 0.5rem',
    fontSize: '0.8rem',
    backgroundColor: 'transparent',
    color: '#94a3b8',
    border: 'none',
    cursor: 'pointer',
  },

  // Logs
  logList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.4rem',
    maxHeight: '300px',
    overflow: 'auto',
  },
  logEntry: {
    fontSize: '0.75rem',
    padding: '0.3rem 0',
    borderBottom: '1px solid #f1f5f9',
    display: 'flex',
    gap: '0.5rem',
  },
  logTime: {
    color: '#94a3b8',
    flexShrink: 0,
  },
  healthSection: {
    marginTop: '1.5rem',
    paddingTop: '1rem',
    borderTop: '1px solid #e2e8f0',
  },
  healthGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  healthItem: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.8rem',
    padding: '0.4rem 0',
  },

  // Modals
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    backgroundColor: 'white',
    borderRadius: '12px',
    padding: '1.5rem',
    width: '400px',
    maxWidth: '90%',
  },
  modalTitle: {
    margin: '0 0 1rem 0',
    fontSize: '1.1rem',
    fontWeight: '600',
  },
  modalInput: {
    width: '100%',
    padding: '0.75rem',
    fontSize: '0.9rem',
    border: '1px solid #e2e8f0',
    borderRadius: '6px',
    marginBottom: '0.75rem',
  },
  modalUrl: {
    fontSize: '0.75rem',
    color: '#64748b',
    marginBottom: '1rem',
    wordBreak: 'break-all',
  },
  modalButtons: {
    display: 'flex',
    gap: '0.75rem',
    justifyContent: 'flex-end',
  },
  modalCancel: {
    padding: '0.5rem 1rem',
    fontSize: '0.875rem',
    border: '1px solid #e2e8f0',
    borderRadius: '6px',
    backgroundColor: 'white',
    cursor: 'pointer',
  },
  modalSave: {
    padding: '0.5rem 1rem',
    fontSize: '0.875rem',
    backgroundColor: '#3b82f6',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  emergencyModal: {
    borderColor: '#dc2626',
    border: '3px solid #dc2626',
  },
  emergencyModalTitle: {
    margin: '0 0 0.5rem 0',
    fontSize: '1.2rem',
    fontWeight: '700',
    color: '#dc2626',
  },
  emergencyModalSub: {
    fontSize: '0.8rem',
    color: '#64748b',
    marginBottom: '1rem',
  },
  emergencyInput: {
    width: '100%',
    padding: '0.75rem',
    fontSize: '1rem',
    border: '2px solid #fecaca',
    borderRadius: '6px',
    marginBottom: '1rem',
  },
  emergencySendBtn: {
    padding: '0.75rem 1.5rem',
    fontSize: '0.9rem',
    fontWeight: '700',
    backgroundColor: '#dc2626',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
}

export default SuperNode
