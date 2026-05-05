import { useState, useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import { BACKEND_URL } from '../utils/backendUrl'
import AttendanceSystem from './AttendanceSystem.jsx'
import CameraMonitor from './CameraMonitor.jsx'

const SUPERNODE_URL = BACKEND_URL

const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/
const BARE_DOMAIN_PATTERN = /^(?:www\.|[\w-]+(?:\.[\w-]+)+)/

const loadSavedPresets = () => {
  try {
    const saved = localStorage.getItem('videoPresets')
    return saved
      ? JSON.parse(saved)
      : [
          { id: 1, name: 'Morning Assembly', url: 'https://www.youtube.com/watch?v=example1' },
          { id: 2, name: 'National Anthem', url: 'https://www.youtube.com/watch?v=example2' },
        ]
  } catch {
    return []
  }
}

const normalizeVideoUrl = (value) => {
  const trimmed = value.trim()
  if (!trimmed) return null

  if (URL_SCHEME_PATTERN.test(trimmed)) return trimmed
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (BARE_DOMAIN_PATTERN.test(trimmed)) return `https://${trimmed}`

  return null
}

const getPlayableVideoUrl = (value) => {
  const normalized = normalizeVideoUrl(value)
  if (!normalized) return null

  try {
    const parsed = new URL(normalized)
    return ['http:', 'https:'].includes(parsed.protocol) ? normalized : null
  } catch {
    return null
  }
}

function SuperNode() {
  const [devices, setDevices] = useState([])
  const [connected, setConnected] = useState(false)
  const [socket, setSocket] = useState(null)
  const [messages, setMessages] = useState([])
  const [health, setHealth] = useState(null)

  const [selectedDevices, setSelectedDevices] = useState([])
  const [globalVideoUrl, setGlobalVideoUrl] = useState('')
  const [deviceVideoUrls, setDeviceVideoUrls] = useState({})
  const [videoStates, setVideoStates] = useState({})

  const [savedPresets, setSavedPresets] = useState(loadSavedPresets)
  const [newPresetName, setNewPresetName] = useState('')
  const [showPresetModal, setShowPresetModal] = useState(false)

  const [isAnnouncing, setIsAnnouncing] = useState(false)
  const [announcementSession, setAnnouncementSession] = useState(null)
  const [localStream, setLocalStream] = useState(null)
  const localVideoRef = useRef(null)
  const peerConnectionsRef = useRef({})

  const [emergencyMessage, setEmergencyMessage] = useState('')
  const [showEmergencyModal, setShowEmergencyModal] = useState(false)
  const [activePanel, setActivePanel] = useState('dashboard')

  useEffect(() => {
    localStorage.setItem('videoPresets', JSON.stringify(savedPresets))
  }, [savedPresets])

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
      setDevices(deviceList.filter((device) => device.type !== 'dashboard'))
    })

    s.on('device:status', (data) => {
      setDevices((prev) =>
        prev.map((device) => (device.deviceId === data.deviceId ? { ...device, status: data.status } : device))
      )
    })

    s.on('device:heartbeat-ack', (data) => {
      setDevices((prev) =>
        prev.map((device) =>
          device.deviceId === data.deviceId ? { ...device, status: data.status, metrics: data.metrics } : device
        )
      )
    })

    s.on('video:state-changed', (data) => {
      setVideoStates((prev) => ({
        ...prev,
        [data.deviceId]: {
          state: data.state,
          url: data.url,
          currentTime: data.currentTime,
        },
      }))

      if (data.state === 'error') {
        addMessage(
          `${data.deviceName || data.deviceId} could not play that media. Paste a full YouTube or direct video URL.`,
          'error'
        )
      }
    })

    s.on('video:play-sent', (data) => {
      addMessage(`Video sent to ${data.targetCount} device(s)`, 'success')
    })

    s.on('video:stop-sent', (data) => {
      addMessage(`Video stopped on ${data.targetCount} device(s)`, 'success')
    })

    s.on('video:error', (data) => {
      addMessage(data.error || 'Video command failed', 'error')
    })

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
    setMessages((prev) => [{ text, type, timestamp: new Date().toLocaleTimeString() }, ...prev].slice(0, 30))
  }

  const fetchHealth = async () => {
    try {
      const res = await fetch(`${SUPERNODE_URL}/health`)
      setHealth(await res.json())
    } catch {
      setHealth(null)
    }
  }

  const toggleDeviceSelection = (deviceId) => {
    setSelectedDevices((prev) =>
      prev.includes(deviceId) ? prev.filter((id) => id !== deviceId) : [...prev, deviceId]
    )
  }

  const selectAllClassrooms = () => {
    const ids = devices
      .filter((device) => device.type === 'classroom' && device.status === 'online')
      .map((device) => device.deviceId)
    setSelectedDevices(ids)
  }

  const deselectAll = () => setSelectedDevices([])

  const playToSelected = () => {
    const playableUrl = getPlayableVideoUrl(globalVideoUrl)

    if (!playableUrl) {
      addMessage('Paste a full YouTube or direct video URL. Search text alone cannot be played.', 'error')
      return
    }

    if (socket && connected && selectedDevices.length > 0) {
      setGlobalVideoUrl(playableUrl)
      socket.emit('video:play', {
        targetDeviceIds: selectedDevices,
        url: playableUrl,
        autoPlay: true,
        volume: 1.0,
      })
    }
  }

  const playToDevice = (deviceId) => {
    const url = getPlayableVideoUrl(deviceVideoUrls[deviceId] || '')

    if (!url) {
      addMessage('Paste a full YouTube or direct video URL. Search text alone cannot be played.', 'error')
      return
    }

    if (socket && connected) {
      setDeviceVideoUrls((prev) => ({
        ...prev,
        [deviceId]: url,
      }))
      socket.emit('video:play', {
        targetDeviceIds: [deviceId],
        url,
        autoPlay: true,
        volume: 1.0,
      })
      addMessage(`Playing on ${deviceId}`, 'info')
    }
  }

  const stopDevice = (deviceId) => {
    if (socket && connected) {
      socket.emit('video:stop', { targetDeviceIds: [deviceId] })
    }
  }

  const stopAllSelected = () => {
    if (socket && connected && selectedDevices.length > 0) {
      socket.emit('video:stop', { targetDeviceIds: selectedDevices })
    }
  }

  const saveCurrentAsPreset = () => {
    const playableUrl = getPlayableVideoUrl(globalVideoUrl)

    if (!playableUrl && globalVideoUrl.trim()) {
      addMessage('Only full YouTube or direct video URLs can be saved as presets.', 'error')
      return
    }

    if (playableUrl && newPresetName.trim()) {
      const newPreset = {
        id: Date.now(),
        name: newPresetName.trim(),
        url: playableUrl,
      }
      setSavedPresets((prev) => [...prev, newPreset])
      setGlobalVideoUrl(playableUrl)
      setNewPresetName('')
      setShowPresetModal(false)
      addMessage(`Preset "${newPreset.name}" saved`, 'success')
    }
  }

  const loadPreset = (preset) => {
    setGlobalVideoUrl(preset.url)
  }

  const deletePreset = (id) => {
    setSavedPresets((prev) => prev.filter((preset) => preset.id !== id))
  }

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
        selectedDevices.forEach((deviceId) => createOfferForDevice(deviceId, stream))
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

    stream.getTracks().forEach((track) => pc.addTrack(track, stream))

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
      localStream.getTracks().forEach((track) => track.stop())
      setLocalStream(null)
    }
    Object.values(peerConnectionsRef.current).forEach((pc) => pc?.close())
    peerConnectionsRef.current = {}
    setIsAnnouncing(false)
    setAnnouncementSession(null)
    if (localVideoRef.current) localVideoRef.current.srcObject = null
  }

  useEffect(() => () => cleanupWebRTC(), [])

  const sendEmergencyBroadcast = () => {
    if (socket && connected && emergencyMessage.trim()) {
      const allClassrooms = devices.filter((device) => device.type === 'classroom').map((device) => device.deviceId)

      socket.emit('emergency:broadcast', {
        message: emergencyMessage.trim(),
        targetDeviceIds: allClassrooms,
      })

      addMessage(`EMERGENCY: ${emergencyMessage}`, 'error')
      setEmergencyMessage('')
      setShowEmergencyModal(false)
    }
  }

  const classroomDevices = devices.filter((device) => device.type === 'classroom')
  const onlineCount = classroomDevices.filter((device) => device.status === 'online').length
  const playingCount = Object.values(videoStates).filter((state) => state?.state === 'playing').length
  const recentMessages = messages.slice(0, 8)
  const selectedClassroomNames = classroomDevices
    .filter((device) => selectedDevices.includes(device.deviceId))
    .map((device) => device.name || device.deviceId)

  const sidebarSections = [
    { id: 'dashboard', label: 'Dashboard', badge: `${onlineCount}`, iconTone: styles.navIconDark, icon: 'D' },
    { id: 'attendance', label: 'Attendance', badge: null, iconTone: styles.navIconBlue, icon: 'A' },
    { id: 'monitor', label: 'Monitor', badge: `${classroomDevices.length}`, iconTone: styles.navIconGreen, icon: 'M' },
  ]

  return (
    <div style={styles.container}>
      <div style={styles.layout}>
        <aside style={styles.sidebar}>
          <div style={styles.sidebarBrand}>
            <div style={styles.sidebarLogo}>S</div>
            <div>
              <div style={styles.sidebarTitle}>Setu</div>
              <div style={styles.sidebarSub}>Supernode</div>
            </div>
          </div>

          <div style={styles.sidebarMenu}>
            {sidebarSections.map((section) => {
              const active = activePanel === section.id
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActivePanel(section.id)}
                  style={{
                    ...styles.sidebarItem,
                    ...(active ? styles.sidebarItemActive : null),
                  }}
                >
                  <span style={{ ...styles.sidebarIconBox, ...section.iconTone }}>{section.icon}</span>
                  <span style={styles.sidebarItemLabel}>{section.label}</span>
                  {section.badge ? <span style={styles.sidebarBadge}>{section.badge}</span> : null}
                </button>
              )
            })}
          </div>
        </aside>

        <div style={styles.contentWrap}>
          {activePanel === 'attendance' ? (
            <div style={styles.attendanceShell}>
              <AttendanceSystem teacherMode />
            </div>
          ) : activePanel === 'monitor' ? (
            <div style={styles.monitorShell}>
              <CameraMonitor />
            </div>
          ) : (
            <>
              <section style={styles.dashboardTopbar}>
                <div>
                  <div style={styles.topbarEyebrow}>Supernode</div>
                  <h1 style={styles.topbarTitle}>Dashboard</h1>
                  <p style={styles.topbarText}>Your classroom command center.</p>
                </div>
                <div style={styles.topbarMeta}>
                  <span style={styles.onlinePill}>
                    <span style={{ ...styles.onlineDot, backgroundColor: connected ? '#22c55e' : '#ef4444' }} />
                    {connected ? 'Connected' : 'Disconnected'}
                  </span>
                  <div style={styles.metricRow}>
                    <span style={styles.metricPill}>{onlineCount}/{classroomDevices.length} online</span>
                    <span style={styles.metricPill}>{selectedDevices.length} selected</span>
                    <span style={styles.metricPill}>{playingCount} playing</span>
                  </div>
                </div>
              </section>

              <div style={styles.statsRow}>
                {[
                  { value: onlineCount, label: 'Rooms Online', color: '#7c3aed' },
                  { value: selectedDevices.length, label: 'Selected', color: '#2563eb' },
                  { value: playingCount, label: 'Now Playing', color: '#16a34a' },
                ].map((s) => (
                  <div key={s.label} style={styles.statCard}>
                    <div style={{ ...styles.statValue, color: s.color }}>{s.value}</div>
                    <div style={styles.statLabel}>{s.label}</div>
                  </div>
                ))}
              </div>

              <section style={styles.controlDeck}>
                <div style={styles.controlDeckHead}>
                  <div>
                    <h2 style={styles.sectionTitle}>Command Center</h2>
                    <p style={styles.sectionSub}>Run class display actions without the clutter.</p>
                  </div>
                  <div style={styles.commandActions}>
                    <button type="button" style={styles.softButton} onClick={selectAllClassrooms}>
                      Select All
                    </button>
                    <button type="button" style={styles.softButton} onClick={deselectAll}>
                      Clear
                    </button>
                    <button type="button" style={styles.emergencyButton} onClick={() => setShowEmergencyModal(true)}>
                      Emergency
                    </button>
                  </div>
                </div>

                <div style={styles.commandComposer}>
                  <div style={styles.commandInputRow}>
                    <select
                      style={styles.cleanSelect}
                      onChange={(e) => {
                        const preset = savedPresets.find((item) => item.id === parseInt(e.target.value))
                        if (preset) loadPreset(preset)
                      }}
                      value=""
                    >
                      <option value="">Presets</option>
                      {savedPresets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="Paste video URL"
                      value={globalVideoUrl}
                      onChange={(e) => setGlobalVideoUrl(e.target.value)}
                      style={styles.cleanInput}
                    />
                  </div>
                  <div style={styles.commandButtonRow}>
                    <button
                      type="button"
                      style={styles.primaryButton}
                      onClick={playToSelected}
                      disabled={!globalVideoUrl.trim() || selectedDevices.length === 0}
                    >
                      Play
                    </button>
                    <button
                      type="button"
                      style={styles.softButton}
                      onClick={stopAllSelected}
                      disabled={selectedDevices.length === 0}
                    >
                      Stop
                    </button>
                    <button type="button" style={styles.softButton} onClick={() => setShowPresetModal(true)}>
                      Save
                    </button>
                    {!isAnnouncing ? (
                      <button
                        type="button"
                        style={styles.liveButton}
                        onClick={startAnnouncement}
                        disabled={selectedDevices.length === 0}
                      >
                        Start Live
                      </button>
                    ) : (
                      <button type="button" style={styles.stopLiveButton} onClick={endAnnouncement}>
                        End Live
                      </button>
                    )}
                  </div>
                </div>
              </section>

              <div style={styles.cleanGrid}>
                <section style={styles.roomsPanel}>
                  <div style={styles.cardHeader}>
                    <h3 style={styles.cardTitle}>Rooms</h3>
                    <span style={styles.cardMeta}>{selectedDevices.length} selected</span>
                  </div>

                  <div style={styles.roomsList}>
                    {classroomDevices.length === 0 ? (
                      <div style={styles.emptyState}>No classrooms connected.</div>
                    ) : (
                      classroomDevices.map((device) => {
                        const isSelected = selectedDevices.includes(device.deviceId)
                        const isOnline = device.status === 'online'
                        const roomState = videoStates[device.deviceId]

                        return (
                          <div
                            key={device.deviceId}
                            style={{
                              ...styles.roomCard,
                              ...(isSelected ? styles.roomCardActive : null),
                              opacity: isOnline ? 1 : 0.65,
                            }}
                          >
                            <div style={styles.roomHeader}>
                              <label style={styles.roomCheckWrap}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleDeviceSelection(device.deviceId)}
                                  disabled={!isOnline}
                                  style={styles.checkbox}
                                />
                                <span style={styles.roomName}>{device.name || device.deviceId}</span>
                              </label>
                              <span
                                style={{
                                  ...styles.roomStatus,
                                  backgroundColor: isOnline ? '#dcfce7' : '#fee2e2',
                                  color: isOnline ? '#15803d' : '#b91c1c',
                                }}
                              >
                                {device.status}
                              </span>
                            </div>

                            {isOnline ? (
                              <div style={styles.inlineControl}>
                                <input
                                  type="text"
                                  placeholder="Room URL"
                                  value={deviceVideoUrls[device.deviceId] || ''}
                                  onChange={(e) =>
                                    setDeviceVideoUrls((prev) => ({
                                      ...prev,
                                      [device.deviceId]: e.target.value,
                                    }))
                                  }
                                  style={styles.roomInput}
                                />
                                <button type="button" style={styles.iconAction} onClick={() => playToDevice(device.deviceId)}>
                                  Go
                                </button>
                                <button type="button" style={styles.iconActionMuted} onClick={() => stopDevice(device.deviceId)}>
                                  Stop
                                </button>
                              </div>
                            ) : null}

                            {roomState ? <div style={styles.roomState}>{roomState.state === 'playing' ? 'Playing now' : roomState.state}</div> : null}
                          </div>
                        )
                      })
                    )}
                  </div>
                </section>

                <div style={styles.dashboardRail}>
                  <section style={styles.focusPanel}>
                    <div style={styles.cardHeader}>
                      <h3 style={styles.cardTitle}>Live Focus</h3>
                      <span style={styles.cardMeta}>
                        {selectedClassroomNames.length ? selectedClassroomNames.join(', ') : 'No class selected'}
                      </span>
                    </div>
                    {isAnnouncing ? (
                      <div style={styles.previewShell}>
                        <div style={styles.liveTag}>Live</div>
                        <video ref={localVideoRef} autoPlay muted playsInline style={styles.previewVideo} />
                      </div>
                    ) : (
                      <div style={styles.previewEmpty}>
                        <div style={styles.previewOrb} />
                        <p style={styles.previewText}>Choose a class and start media or a live session when needed.</p>
                      </div>
                    )}
                  </section>

                  <section style={styles.activityPanel}>
                    <div style={styles.cardHeader}>
                      <h3 style={styles.cardTitle}>Recent Activity</h3>
                      <span style={styles.cardMeta}>{recentMessages.length} recent</span>
                    </div>

                    <div style={styles.activityMetaRow}>
                      <span style={styles.metricPill}>AI {health?.components?.qwen?.available ? 'ready' : 'offline'}</span>
                      <span style={styles.metricPill}>{health?.components?.devices?.online || 0} devices</span>
                    </div>

                    <div style={styles.logStack}>
                      {recentMessages.length === 0 ? (
                        <div style={styles.emptyState}>No activity yet.</div>
                      ) : (
                        recentMessages.map((msg, index) => (
                          <div key={`${msg.timestamp}-${index}`} style={styles.logRow}>
                            <div style={styles.logTime}>{msg.timestamp}</div>
                            <div
                              style={{
                                ...styles.logText,
                                color: msg.type === 'error' ? '#dc2626' : msg.type === 'success' ? '#059669' : '#475569',
                              }}
                            >
                              {msg.text}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </section>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {showPresetModal && (
        <div style={styles.modalOverlay} onClick={() => setShowPresetModal(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={styles.modalTitle}>Save as Preset</h3>
            <input
              type="text"
              placeholder="Preset name"
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              style={styles.modalInput}
            />
            <p style={styles.modalUrl}>URL: {globalVideoUrl}</p>
            <div style={styles.modalButtons}>
              <button type="button" style={styles.modalCancel} onClick={() => setShowPresetModal(false)}>
                Cancel
              </button>
              <button type="button" style={styles.modalSave} onClick={saveCurrentAsPreset}>
                Save Preset
              </button>
            </div>
          </div>
        </div>
      )}

      {showEmergencyModal && (
        <div style={styles.modalOverlay} onClick={() => setShowEmergencyModal(false)}>
          <div style={{ ...styles.modal, ...styles.emergencyModal }} onClick={(e) => e.stopPropagation()}>
            <h3 style={styles.emergencyModalTitle}>Emergency Broadcast</h3>
            <p style={styles.emergencyModalSub}>This message will be sent to every classroom display.</p>
            <input
              type="text"
              placeholder="Enter emergency message"
              value={emergencyMessage}
              onChange={(e) => setEmergencyMessage(e.target.value)}
              style={styles.emergencyInput}
              autoFocus
            />
            <div style={styles.modalButtons}>
              <button type="button" style={styles.modalCancel} onClick={() => setShowEmergencyModal(false)}>
                Cancel
              </button>
              <button
                type="button"
                style={styles.emergencySendBtn}
                onClick={sendEmergencyBroadcast}
                disabled={!emergencyMessage.trim()}
              >
                Send Alert
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
    background: '#f8f9fb',
    fontFamily: '"Nunito", "Segoe UI", system-ui, sans-serif',
    color: '#111827',
  },
  layout: {
    display: 'grid',
    gridTemplateColumns: '220px minmax(0, 1fr)',
    minHeight: '100vh',
  },

  /* ── Sidebar ──────────────────────────────────────────── */
  sidebar: {
    position: 'sticky',
    top: 0,
    height: '100vh',
    backgroundColor: '#ffffff',
    borderRight: '1px solid #f0f0f5',
    padding: '1.5rem 0.85rem',
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    overflowY: 'auto',
  },
  sidebarBrand: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.65rem',
    padding: '0 0.6rem',
    marginBottom: '2rem',
  },
  sidebarLogo: {
    display: 'grid',
    placeItems: 'center',
    width: '2.2rem',
    height: '2.2rem',
    borderRadius: '0.65rem',
    background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
    color: '#fff',
    fontWeight: 900,
    fontSize: '0.9rem',
    flexShrink: 0,
  },
  sidebarTitle: {
    fontSize: '1.25rem',
    fontWeight: 900,
    color: '#111827',
    letterSpacing: '-0.02em',
  },
  sidebarSub: { display: 'none' },
  sidebarMenu: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  sidebarItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    width: '100%',
    border: 'none',
    borderRadius: '0.85rem',
    background: 'transparent',
    padding: '0.7rem 0.9rem',
    fontFamily: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
    color: '#6b7280',
    fontSize: '0.92rem',
    fontWeight: 700,
    transition: 'background 120ms, color 120ms',
  },
  sidebarItemActive: {
    backgroundColor: '#f3f0ff',
    color: '#7c3aed',
  },
  sidebarIconBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '2.1rem',
    height: '2.1rem',
    borderRadius: '0.65rem',
    flexShrink: 0,
    fontSize: '1rem',
    color: '#ffffff',
    fontWeight: 800,
  },
  navIconDark:   { backgroundColor: '#374151' },
  navIconViolet: { background: 'linear-gradient(135deg,#7c3aed,#a855f7)' },
  navIconGreen:  { background: 'linear-gradient(135deg,#16a34a,#22c55e)' },
  navIconOrange: { background: 'linear-gradient(135deg,#ea580c,#f97316)' },
  navIconBlue:   { background: 'linear-gradient(135deg,#2563eb,#60a5fa)' },
  sidebarItemLabel: {
    flex: 1,
    fontSize: '0.92rem',
    fontWeight: 700,
  },
  sidebarBadge: {
    padding: '0.15rem 0.5rem',
    borderRadius: '999px',
    backgroundColor: '#f3f0ff',
    color: '#7c3aed',
    fontSize: '0.7rem',
    fontWeight: 800,
  },

  /* ── Content ──────────────────────────────────────────── */
  contentWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.1rem',
    padding: '1.75rem',
    minWidth: 0,
  },

  /* ── Top bar ──────────────────────────────────────────── */
  dashboardTopbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '1rem',
    paddingBottom: '0.25rem',
  },
  topbarEyebrow: {
    fontSize: '0.72rem',
    fontWeight: 800,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: '#7c3aed',
    marginBottom: '0.2rem',
  },
  topbarTitle: {
    margin: '0 0 0.15rem',
    fontSize: '1.85rem',
    lineHeight: 1.1,
    fontWeight: 900,
    letterSpacing: '-0.03em',
    color: '#111827',
  },
  topbarText: {
    margin: 0,
    color: '#9ca3af',
    fontSize: '0.88rem',
    fontWeight: 600,
  },
  topbarMeta: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '0.5rem',
  },
  metricRow: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  metricPill: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0.35rem 0.85rem',
    borderRadius: '999px',
    backgroundColor: '#f3f4f6',
    color: '#374151',
    fontSize: '0.8rem',
    fontWeight: 700,
    border: '1px solid #e5e7eb',
  },
  onlinePill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.45rem',
    padding: '0.4rem 0.9rem',
    borderRadius: '999px',
    backgroundColor: '#f0fdf4',
    border: '1px solid #bbf7d0',
    color: '#15803d',
    fontWeight: 700,
    fontSize: '0.84rem',
  },
  onlineDot: {
    width: '0.5rem',
    height: '0.5rem',
    borderRadius: '50%',
  },

  /* ── Stat strip ───────────────────────────────────────── */
  statsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: '0.85rem',
  },
  statCard: {
    backgroundColor: '#ffffff',
    border: '1px solid #f0f0f5',
    borderRadius: '1rem',
    padding: '1.1rem 1.2rem',
    boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
  },
  statValue: {
    fontSize: '2rem',
    fontWeight: 900,
    color: '#111827',
    letterSpacing: '-0.03em',
    lineHeight: 1,
    marginBottom: '0.25rem',
  },
  statLabel: {
    color: '#6b7280',
    fontSize: '0.8rem',
    fontWeight: 700,
  },

  /* ── Command Center ───────────────────────────────────── */
  controlDeck: {
    background: '#ffffff',
    border: '1px solid #f0f0f5',
    borderRadius: '1.1rem',
    padding: '1.25rem 1.35rem',
    boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
  },
  controlDeckHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '1rem',
    marginBottom: '1rem',
  },
  sectionTitle: {
    margin: 0,
    fontSize: '1rem',
    fontWeight: 800,
    color: '#111827',
  },
  sectionSub: {
    margin: '0.25rem 0 0',
    color: '#9ca3af',
    fontSize: '0.84rem',
    fontWeight: 600,
  },
  commandActions: {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'center',
  },
  commandComposer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.8rem',
  },
  commandInputRow: {
    display: 'grid',
    gridTemplateColumns: '170px minmax(0,1fr)',
    gap: '0.75rem',
  },
  commandButtonRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.6rem',
  },

  /* ── Inputs ───────────────────────────────────────────── */
  cleanSelect: {
    height: '2.75rem',
    borderRadius: '0.75rem',
    border: '1.5px solid #e5e7eb',
    backgroundColor: '#f9fafb',
    padding: '0 0.85rem',
    color: '#374151',
    fontSize: '0.88rem',
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    outline: 'none',
  },
  cleanInput: {
    height: '2.75rem',
    borderRadius: '0.75rem',
    border: '1.5px solid #e5e7eb',
    backgroundColor: '#f9fafb',
    padding: '0 1rem',
    fontSize: '0.88rem',
    fontWeight: 600,
    fontFamily: 'inherit',
    outline: 'none',
    color: '#111827',
    width: '100%',
    boxSizing: 'border-box',
  },

  /* ── Buttons ──────────────────────────────────────────── */
  primaryButton: {
    height: '2.75rem',
    borderRadius: '0.75rem',
    border: 'none',
    padding: '0 1.25rem',
    background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
    color: '#fff',
    fontWeight: 800,
    fontSize: '0.9rem',
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: '0 2px 8px rgba(124,58,237,0.3)',
  },
  softButton: {
    height: '2.75rem',
    borderRadius: '0.75rem',
    border: '1.5px solid #e5e7eb',
    padding: '0 1rem',
    backgroundColor: '#ffffff',
    color: '#374151',
    fontWeight: 700,
    fontSize: '0.88rem',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  liveButton: {
    height: '2.75rem',
    borderRadius: '0.75rem',
    border: 'none',
    padding: '0 1.25rem',
    background: 'linear-gradient(135deg, #16a34a, #22c55e)',
    color: '#fff',
    fontWeight: 800,
    fontSize: '0.9rem',
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: '0 2px 8px rgba(22,163,74,0.3)',
  },
  stopLiveButton: {
    height: '2.75rem',
    borderRadius: '0.75rem',
    border: 'none',
    padding: '0 1.25rem',
    background: 'linear-gradient(135deg, #ef4444, #f97316)',
    color: '#fff',
    fontWeight: 800,
    fontSize: '0.9rem',
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: '0 2px 8px rgba(239,68,68,0.3)',
  },
  emergencyButton: {
    height: '2.75rem',
    borderRadius: '0.75rem',
    border: '1.5px solid #fecaca',
    padding: '0 1rem',
    backgroundColor: '#fff1f2',
    color: '#dc2626',
    fontWeight: 800,
    fontSize: '0.88rem',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },

  /* ── Grid ─────────────────────────────────────────────── */
  cleanGrid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(280px, 0.9fr) minmax(0, 1.3fr)',
    gap: '1rem',
    alignItems: 'start',
  },

  /* ── Panels ───────────────────────────────────────────── */
  roomsPanel: {
    background: '#ffffff',
    border: '1px solid #f0f0f5',
    borderRadius: '1.1rem',
    padding: '1.15rem',
    boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
  },
  dashboardRail: {
    display: 'grid',
    gap: '1rem',
  },
  focusPanel: {
    background: '#ffffff',
    border: '1px solid #f0f0f5',
    borderRadius: '1.1rem',
    padding: '1.15rem',
    boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
  },
  activityPanel: {
    background: '#ffffff',
    border: '1px solid #f0f0f5',
    borderRadius: '1.1rem',
    padding: '1.15rem',
    boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
  },
  activityMetaRow: {
    display: 'flex',
    gap: '0.5rem',
    marginBottom: '0.85rem',
    flexWrap: 'wrap',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.9rem',
    gap: '0.75rem',
  },
  cardTitle: {
    margin: 0,
    fontSize: '0.95rem',
    fontWeight: 800,
    color: '#111827',
  },
  cardMeta: {
    color: '#9ca3af',
    fontSize: '0.78rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '14rem',
  },

  /* ── Rooms ────────────────────────────────────────────── */
  roomsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.6rem',
  },
  emptyState: {
    display: 'grid',
    placeItems: 'center',
    minHeight: '9rem',
    color: '#d1d5db',
    backgroundColor: '#fafafa',
    borderRadius: '0.85rem',
    border: '1.5px dashed #e5e7eb',
    fontSize: '0.88rem',
    fontWeight: 600,
  },
  roomCard: {
    borderRadius: '0.85rem',
    border: '1.5px solid #f0f0f5',
    backgroundColor: '#fafafa',
    padding: '0.85rem',
  },
  roomCardActive: {
    backgroundColor: '#faf8ff',
    borderColor: '#ddd6fe',
  },
  roomHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.65rem',
    gap: '0.5rem',
  },
  roomCheckWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.55rem',
  },
  checkbox: {
    width: '16px',
    height: '16px',
    cursor: 'pointer',
    accentColor: '#7c3aed',
  },
  roomName: {
    fontSize: '0.9rem',
    fontWeight: 700,
    color: '#111827',
  },
  roomStatus: {
    padding: '0.2rem 0.55rem',
    borderRadius: '999px',
    fontSize: '0.7rem',
    fontWeight: 700,
  },
  inlineControl: {
    display: 'flex',
    gap: '0.45rem',
    alignItems: 'center',
  },
  roomInput: {
    flex: 1,
    height: '2.35rem',
    padding: '0 0.75rem',
    fontSize: '0.82rem',
    border: '1.5px solid #e5e7eb',
    borderRadius: '0.65rem',
    backgroundColor: '#ffffff',
    fontFamily: 'inherit',
    color: '#111827',
    outline: 'none',
    fontWeight: 600,
  },
  iconAction: {
    height: '2.35rem',
    border: 'none',
    borderRadius: '0.65rem',
    padding: '0 0.85rem',
    background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
    color: '#fff',
    fontWeight: 800,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '0.82rem',
  },
  iconActionMuted: {
    height: '2.35rem',
    border: '1.5px solid #e5e7eb',
    borderRadius: '0.65rem',
    padding: '0 0.85rem',
    backgroundColor: '#ffffff',
    color: '#6b7280',
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '0.82rem',
  },
  roomState: {
    marginTop: '0.55rem',
    padding: '0.3rem 0.6rem',
    borderRadius: '0.5rem',
    backgroundColor: '#f0fdf4',
    color: '#15803d',
    fontSize: '0.75rem',
    fontWeight: 700,
    display: 'inline-block',
  },

  /* ── Live Focus ───────────────────────────────────────── */
  previewShell: {
    position: 'relative',
    minHeight: '16rem',
    borderRadius: '0.9rem',
    overflow: 'hidden',
    background: '#0f172a',
  },
  liveTag: {
    position: 'absolute',
    top: '0.75rem',
    left: '0.75rem',
    zIndex: 1,
    padding: '0.3rem 0.65rem',
    borderRadius: '999px',
    backgroundColor: '#ef4444',
    color: '#fff',
    fontWeight: 800,
    fontSize: '0.72rem',
    letterSpacing: '0.06em',
  },
  previewVideo: {
    width: '100%',
    height: '16rem',
    objectFit: 'cover',
  },
  previewEmpty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '16rem',
    background: 'radial-gradient(ellipse at center, #f5f3ff 0%, #fafafa 70%)',
    borderRadius: '0.9rem',
  },
  previewOrb: {
    width: '5.5rem',
    height: '5.5rem',
    borderRadius: '999px',
    background: 'radial-gradient(circle at 35% 35%, #ede9fe, #c4b5fd 60%, #a78bfa)',
    boxShadow: '0 8px 28px rgba(139,92,246,0.22)',
    marginBottom: '0.9rem',
  },
  previewText: {
    color: '#9ca3af',
    textAlign: 'center',
    padding: '0 1.5rem',
    margin: 0,
    fontSize: '0.82rem',
    fontWeight: 600,
    maxWidth: '18rem',
  },

  /* ── Activity log ─────────────────────────────────────── */
  logStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  logRow: {
    display: 'flex',
    gap: '0.65rem',
    alignItems: 'flex-start',
    padding: '0.6rem 0.75rem',
    borderRadius: '0.7rem',
    backgroundColor: '#fafafa',
    border: '1px solid #f0f0f5',
  },
  logTime: {
    color: '#d1d5db',
    flexShrink: 0,
    minWidth: '4.2rem',
    fontSize: '0.7rem',
    fontWeight: 700,
  },
  logText: {
    fontSize: '0.82rem',
    lineHeight: 1.5,
    fontWeight: 600,
  },

  /* ── Shells ───────────────────────────────────────────── */
  attendanceShell: {
    overflow: 'hidden',
    borderRadius: '1.1rem',
    border: '1px solid #f0f0f5',
    backgroundColor: '#ffffff',
    boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
  },
  monitorShell: {
    overflow: 'hidden',
    borderRadius: '1.1rem',
    border: '1px solid #f0f0f5',
    backgroundColor: '#ffffff',
    boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
  },

  /* ── Modals ───────────────────────────────────────────── */
  modalOverlay: {
    position: 'fixed',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(17,24,39,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    backdropFilter: 'blur(3px)',
  },
  modal: {
    backgroundColor: '#ffffff',
    borderRadius: '1.15rem',
    padding: '1.5rem',
    width: '400px',
    maxWidth: '92%',
    boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
    border: '1px solid #f0f0f5',
  },
  modalTitle: {
    margin: '0 0 1rem',
    fontSize: '1.05rem',
    fontWeight: 800,
    color: '#111827',
  },
  modalInput: {
    width: '100%',
    padding: '0.8rem 0.95rem',
    fontSize: '0.9rem',
    border: '1.5px solid #e5e7eb',
    borderRadius: '0.75rem',
    marginBottom: '0.75rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#111827',
    outline: 'none',
    boxSizing: 'border-box',
  },
  modalUrl: {
    fontSize: '0.74rem',
    color: '#9ca3af',
    marginBottom: '1rem',
    wordBreak: 'break-all',
    fontWeight: 600,
    backgroundColor: '#f9fafb',
    padding: '0.45rem 0.7rem',
    borderRadius: '0.55rem',
    border: '1px solid #e5e7eb',
  },
  modalButtons: {
    display: 'flex',
    gap: '0.65rem',
    justifyContent: 'flex-end',
  },
  modalCancel: {
    padding: '0.65rem 1.1rem',
    fontSize: '0.88rem',
    fontWeight: 700,
    border: '1.5px solid #e5e7eb',
    borderRadius: '0.75rem',
    backgroundColor: '#ffffff',
    color: '#374151',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  modalSave: {
    padding: '0.65rem 1.25rem',
    fontSize: '0.88rem',
    fontWeight: 800,
    background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
    color: '#ffffff',
    border: 'none',
    borderRadius: '0.75rem',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  emergencyModal: {
    border: '1.5px solid #fecaca',
  },
  emergencyModalTitle: {
    margin: '0 0 0.4rem',
    fontSize: '1.1rem',
    fontWeight: 800,
    color: '#dc2626',
  },
  emergencyModalSub: {
    fontSize: '0.84rem',
    color: '#9ca3af',
    marginBottom: '1rem',
    fontWeight: 600,
  },
  emergencyInput: {
    width: '100%',
    padding: '0.8rem 0.95rem',
    fontSize: '0.92rem',
    border: '1.5px solid #fecaca',
    borderRadius: '0.75rem',
    marginBottom: '1rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#111827',
    outline: 'none',
    boxSizing: 'border-box',
  },
  emergencySendBtn: {
    padding: '0.65rem 1.25rem',
    fontSize: '0.88rem',
    fontWeight: 800,
    background: 'linear-gradient(135deg, #dc2626, #ef4444)',
    color: '#ffffff',
    border: 'none',
    borderRadius: '0.75rem',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },

  /* ── Unused legacy keys kept to avoid runtime errors ─── */
  heroCard: {}, heroChip: {}, heroTitle: {}, heroText: {}, heroMeta: {}, heroMascot: {},
  commandCard: {}, commandTop: {}, commandForm: {}, dashboardGrid: {},
  roomsCard: {}, mainCard: {}, rightCard: {},
  overviewPanel: {}, overviewHighlight: {}, overviewGlow: {}, overviewValue: {}, overviewLabel: {},
  quickGrid: {}, quickAction: {}, healthStack: {}, healthRow: {}, profileButton: {},
  presetStack: { display: 'flex', flexDirection: 'column', gap: '0.6rem' },
  presetRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '0.75rem', padding: '0.75rem 0.9rem',
    backgroundColor: '#fafafa', borderRadius: '0.75rem', border: '1px solid #f0f0f5',
  },
  presetName: { fontSize: '0.88rem', fontWeight: 700, color: '#111827' },
  presetUrl: {
    marginTop: '0.15rem', maxWidth: '20rem', color: '#9ca3af',
    fontSize: '0.72rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600,
  },
  presetActions: { display: 'flex', gap: '0.4rem' },
  softButtonSmall: {
    border: '1.5px solid #e5e7eb', backgroundColor: '#ffffff', color: '#374151',
    borderRadius: '0.6rem', padding: '0.4rem 0.75rem', fontWeight: 700,
    fontSize: '0.8rem', cursor: 'pointer', fontFamily: 'inherit',
  },
  deleteButtonSmall: {
    border: '1.5px solid #fecaca', backgroundColor: '#fff1f2', color: '#dc2626',
    borderRadius: '0.6rem', padding: '0.4rem 0.75rem', fontWeight: 700,
    fontSize: '0.8rem', cursor: 'pointer', fontFamily: 'inherit',
  },
}

export default SuperNode
