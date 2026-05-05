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
    { id: 'attendance', label: 'Attendance / Student record', badge: null, iconTone: styles.navIconBlue, icon: 'A' },
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
                  <p style={styles.topbarText}>A cleaner control surface for classes, attendance, media, and monitoring.</p>
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
    background:
      'radial-gradient(circle at top left, rgba(129, 140, 248, 0.08), transparent 18%), radial-gradient(circle at bottom right, rgba(244, 114, 182, 0.08), transparent 22%), #ffffff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  layout: {
    display: 'grid',
    gridTemplateColumns: '280px minmax(0, 1fr)',
    gap: '1.6rem',
    padding: '1.6rem',
    alignItems: 'start',
  },
  sidebar: {
    position: 'sticky',
    top: '6rem',
    backgroundColor: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: '2rem',
    padding: '1.5rem 1.15rem',
    boxShadow: '0 24px 60px rgba(148, 163, 184, 0.14)',
  },
  sidebarBrand: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.9rem',
    marginBottom: '1.5rem',
  },
  sidebarLogo: {
    display: 'grid',
    placeItems: 'center',
    width: '3.25rem',
    height: '3.25rem',
    borderRadius: '1.15rem',
    background: 'linear-gradient(135deg, #7c3aed 0%, #8b5cf6 100%)',
    color: '#ffffff',
    fontWeight: 900,
    fontSize: '1.2rem',
    boxShadow: '0 16px 34px rgba(124, 58, 237, 0.28)',
  },
  sidebarTitle: {
    fontSize: '2rem',
    lineHeight: 1,
    fontWeight: 800,
    color: '#5b21b6',
  },
  sidebarSub: {
    marginTop: '0.35rem',
    fontSize: '0.85rem',
    color: '#64748b',
  },
  sidebarMenu: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.7rem',
  },
  sidebarItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.9rem',
    width: '100%',
    border: 'none',
    borderRadius: '1.25rem',
    background: 'transparent',
    padding: '0.72rem 0.85rem',
    fontFamily: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
    color: '#0f172a',
  },
  sidebarItemActive: {
    backgroundColor: '#f1f5f9',
    boxShadow: 'inset 0 0 0 1px #e2e8f0',
  },
  sidebarIconBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '3.1rem',
    height: '3.1rem',
    borderRadius: '1rem',
    color: '#ffffff',
    fontWeight: 800,
    flexShrink: 0,
  },
  navIconDark: {
    backgroundColor: '#364152',
  },
  navIconViolet: {
    background: 'linear-gradient(135deg, #7c3aed 0%, #8b5cf6 100%)',
  },
  navIconGreen: {
    background: 'linear-gradient(135deg, #16a34a 0%, #22c55e 100%)',
  },
  navIconOrange: {
    background: 'linear-gradient(135deg, #fb923c 0%, #f59e0b 100%)',
  },
  navIconBlue: {
    background: 'linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%)',
  },
  sidebarItemLabel: {
    fontSize: '1rem',
    fontWeight: 700,
    flex: 1,
  },
  sidebarBadge: {
    padding: '0.2rem 0.55rem',
    borderRadius: '999px',
    backgroundColor: '#eef2ff',
    color: '#5b21b6',
    fontSize: '0.72rem',
    fontWeight: 700,
  },
  contentWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    minWidth: 0,
  },
  dashboardTopbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: '1rem',
    padding: '0.5rem 0.25rem 0.25rem',
  },
  topbarEyebrow: {
    fontSize: '0.78rem',
    fontWeight: 800,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    color: '#7c3aed',
  },
  topbarTitle: {
    margin: '0.35rem 0 0.35rem',
    fontSize: '3rem',
    lineHeight: 0.96,
    fontWeight: 900,
    letterSpacing: '-0.06em',
    color: '#172036',
  },
  topbarText: {
    margin: 0,
    maxWidth: '42rem',
    color: '#64748b',
    fontSize: '1rem',
  },
  topbarMeta: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '0.75rem',
  },
  metricRow: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: '0.6rem',
  },
  metricPill: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '2.25rem',
    padding: '0.45rem 0.9rem',
    borderRadius: '999px',
    backgroundColor: 'rgba(255,255,255,0.72)',
    border: '1px solid rgba(203, 213, 225, 0.8)',
    color: '#334155',
    fontSize: '0.84rem',
    fontWeight: 700,
    backdropFilter: 'blur(10px)',
  },
  controlDeck: {
    background: 'rgba(255,255,255,0.82)',
    border: '1px solid rgba(226, 232, 240, 0.9)',
    borderRadius: '1.7rem',
    padding: '1.25rem',
    boxShadow: '0 18px 40px rgba(148, 163, 184, 0.1)',
    backdropFilter: 'blur(16px)',
  },
  controlDeckHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '1rem',
    marginBottom: '1rem',
  },
  commandComposer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.85rem',
  },
  commandInputRow: {
    display: 'grid',
    gridTemplateColumns: '180px minmax(0, 1fr)',
    gap: '0.85rem',
  },
  commandButtonRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.75rem',
  },
  cleanGrid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(320px, 0.92fr) minmax(0, 1.28fr)',
    gap: '1rem',
    alignItems: 'start',
  },
  roomsPanel: {
    background: 'rgba(255,255,255,0.8)',
    border: '1px solid rgba(226, 232, 240, 0.9)',
    borderRadius: '1.7rem',
    padding: '1.15rem',
    boxShadow: '0 18px 40px rgba(148, 163, 184, 0.08)',
    backdropFilter: 'blur(16px)',
  },
  dashboardRail: {
    display: 'grid',
    gap: '1rem',
  },
  focusPanel: {
    background: 'rgba(255,255,255,0.8)',
    border: '1px solid rgba(226, 232, 240, 0.9)',
    borderRadius: '1.7rem',
    padding: '1.15rem',
    boxShadow: '0 18px 40px rgba(148, 163, 184, 0.08)',
    backdropFilter: 'blur(16px)',
  },
  activityPanel: {
    background: 'rgba(255,255,255,0.8)',
    border: '1px solid rgba(226, 232, 240, 0.9)',
    borderRadius: '1.7rem',
    padding: '1.15rem',
    boxShadow: '0 18px 40px rgba(148, 163, 184, 0.08)',
    backdropFilter: 'blur(16px)',
  },
  activityMetaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.65rem',
    marginBottom: '0.9rem',
  },
  heroCard: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '1rem',
    padding: '1.9rem 2rem',
    background: 'linear-gradient(135deg, rgba(255,255,255,0.98), rgba(244,244,255,0.96))',
    border: '1px solid #e2e8f0',
    borderRadius: '2rem',
    boxShadow: '0 24px 60px rgba(148, 163, 184, 0.14)',
  },
  heroChip: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0.45rem 1rem',
    borderRadius: '999px',
    background: 'linear-gradient(135deg, #7c3aed 0%, #ec4899 100%)',
    color: '#ffffff',
    fontWeight: 800,
    fontSize: '0.85rem',
  },
  heroTitle: {
    margin: '1rem 0 0.55rem',
    fontSize: '2.5rem',
    lineHeight: 1.04,
    fontWeight: 900,
    letterSpacing: '-0.05em',
    color: '#172036',
  },
  heroText: {
    margin: 0,
    color: '#64748b',
    fontSize: '1rem',
    maxWidth: '42rem',
  },
  heroMeta: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '0.85rem',
  },
  onlinePill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.6rem',
    padding: '0.7rem 1rem',
    borderRadius: '999px',
    backgroundColor: '#ffffff',
    border: '1px solid #e2e8f0',
    color: '#334155',
    fontWeight: 700,
  },
  onlineDot: {
    width: '0.65rem',
    height: '0.65rem',
    borderRadius: '999px',
  },
  heroMascot: {
    display: 'grid',
    placeItems: 'center',
    width: '5.5rem',
    height: '5.5rem',
    borderRadius: '1.8rem',
    background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.95), rgba(217, 229, 255, 0.92))',
    color: '#7c3aed',
    fontSize: '1.35rem',
    fontWeight: 900,
    boxShadow: '0 18px 34px rgba(129, 140, 248, 0.18)',
  },
  statsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: '1rem',
  },
  statCard: {
    position: 'relative',
    backgroundColor: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: '1.5rem',
    padding: '1.2rem 1.25rem',
    boxShadow: '0 16px 36px rgba(148, 163, 184, 0.1)',
  },
  statValue: {
    marginTop: '0.2rem',
    fontSize: '2rem',
    fontWeight: 900,
    color: '#172036',
  },
  statLabel: {
    marginTop: '0.25rem',
    color: '#64748b',
    fontSize: '0.92rem',
  },
  commandCard: {
    backgroundColor: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: '1.8rem',
    padding: '1.35rem',
    boxShadow: '0 20px 44px rgba(148, 163, 184, 0.1)',
  },
  commandTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '1rem',
    marginBottom: '1rem',
  },
  sectionTitle: {
    margin: 0,
    fontSize: '1.15rem',
    fontWeight: 800,
    color: '#172036',
  },
  sectionSub: {
    margin: '0.35rem 0 0',
    color: '#64748b',
    fontSize: '0.92rem',
  },
  commandActions: {
    display: 'grid',
    gridAutoFlow: 'column',
    gap: '0.65rem',
    justifyContent: 'end',
  },
  commandForm: {
    display: 'grid',
    gridTemplateColumns: '160px minmax(0, 1fr) repeat(4, auto)',
    gap: '1rem',
    alignItems: 'center',
  },
  cleanSelect: {
    height: '3rem',
    borderRadius: '1rem',
    border: '1px solid #dbe4f0',
    backgroundColor: '#f8fafc',
    padding: '0 0.9rem',
    color: '#334155',
    fontSize: '0.92rem',
  },
  cleanInput: {
    height: '3rem',
    borderRadius: '1rem',
    border: '1px solid #dbe4f0',
    backgroundColor: '#f8fafc',
    padding: '0 1rem',
    fontSize: '0.92rem',
  },
  primaryButton: {
    height: '3rem',
    borderRadius: '1rem',
    border: 'none',
    padding: '0 1.1rem',
    background: 'linear-gradient(135deg, #4f46e5 0%, #8b5cf6 100%)',
    color: '#ffffff',
    fontWeight: 800,
    cursor: 'pointer',
  },
  softButton: {
    height: '3rem',
    borderRadius: '1rem',
    border: '1px solid #dbe4f0',
    padding: '0 1rem',
    backgroundColor: '#ffffff',
    color: '#334155',
    fontWeight: 700,
    cursor: 'pointer',
  },
  liveButton: {
    height: '3rem',
    borderRadius: '1rem',
    border: 'none',
    padding: '0 1rem',
    background: 'linear-gradient(135deg, #16a34a 0%, #22c55e 100%)',
    color: '#ffffff',
    fontWeight: 800,
    cursor: 'pointer',
  },
  stopLiveButton: {
    height: '3rem',
    borderRadius: '1rem',
    border: 'none',
    padding: '0 1rem',
    background: 'linear-gradient(135deg, #ef4444 0%, #f97316 100%)',
    color: '#ffffff',
    fontWeight: 800,
    cursor: 'pointer',
  },
  emergencyButton: {
    height: '3rem',
    borderRadius: '1rem',
    border: 'none',
    padding: '0 1rem',
    background: '#fee2e2',
    color: '#b91c1c',
    fontWeight: 800,
    cursor: 'pointer',
  },
  dashboardGrid: {
    display: 'grid',
    gridTemplateColumns: '1.1fr 1.4fr 0.8fr',
    gap: '1rem',
    alignItems: 'start',
  },
  roomsCard: {
    backgroundColor: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: '1.8rem',
    padding: '1.2rem',
    boxShadow: '0 20px 44px rgba(148, 163, 184, 0.1)',
  },
  mainCard: {
    backgroundColor: '#ffffff',
    borderRadius: '1.8rem',
    padding: '1.2rem',
    border: '1px solid #e2e8f0',
    boxShadow: '0 20px 44px rgba(148, 163, 184, 0.1)',
    minHeight: '28rem',
  },
  rightCard: {
    backgroundColor: '#ffffff',
    borderRadius: '1.8rem',
    padding: '1.2rem',
    border: '1px solid #e2e8f0',
    boxShadow: '0 20px 44px rgba(148, 163, 184, 0.1)',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '1rem',
    marginBottom: '1rem',
  },
  cardTitle: {
    margin: 0,
    fontSize: '1.05rem',
    fontWeight: 800,
    color: '#172036',
  },
  cardMeta: {
    color: '#64748b',
    fontSize: '0.84rem',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '16rem',
  },
  roomsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.8rem',
  },
  emptyState: {
    display: 'grid',
    placeItems: 'center',
    minHeight: '12rem',
    color: '#94a3b8',
    backgroundColor: '#f8fafc',
    borderRadius: '1.2rem',
  },
  roomCard: {
    borderRadius: '1.25rem',
    border: '1px solid #e2e8f0',
    backgroundColor: '#ffffff',
    padding: '0.95rem',
  },
  roomCardActive: {
    backgroundColor: '#f5f3ff',
    borderColor: '#c4b5fd',
    boxShadow: '0 16px 28px rgba(139, 92, 246, 0.12)',
  },
  roomHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '0.75rem',
    alignItems: 'center',
    marginBottom: '0.75rem',
  },
  roomCheckWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.65rem',
  },
  checkbox: {
    width: '18px',
    height: '18px',
    cursor: 'pointer',
  },
  roomName: {
    fontSize: '0.95rem',
    fontWeight: 700,
    color: '#172036',
  },
  roomStatus: {
    padding: '0.3rem 0.7rem',
    borderRadius: '999px',
    fontSize: '0.72rem',
    fontWeight: 700,
  },
  inlineControl: {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'center',
  },
  roomInput: {
    flex: 1,
    height: '2.7rem',
    padding: '0 0.85rem',
    fontSize: '0.86rem',
    border: '1px solid #dbe4f0',
    borderRadius: '0.9rem',
    backgroundColor: '#f8fafc',
  },
  iconAction: {
    height: '2.7rem',
    border: 'none',
    borderRadius: '0.9rem',
    padding: '0 0.9rem',
    background: 'linear-gradient(135deg, #4f46e5 0%, #8b5cf6 100%)',
    color: '#ffffff',
    fontWeight: 800,
    cursor: 'pointer',
  },
  iconActionMuted: {
    height: '2.7rem',
    border: 'none',
    borderRadius: '0.9rem',
    padding: '0 0.9rem',
    backgroundColor: '#eef2ff',
    color: '#475569',
    fontWeight: 700,
    cursor: 'pointer',
  },
  roomState: {
    marginTop: '0.7rem',
    padding: '0.5rem 0.75rem',
    borderRadius: '0.9rem',
    backgroundColor: '#eff6ff',
    color: '#2563eb',
    fontSize: '0.8rem',
    fontWeight: 700,
  },
  previewShell: {
    position: 'relative',
    minHeight: '22rem',
    borderRadius: '1.5rem',
    overflow: 'hidden',
    background: '#0f172a',
  },
  liveTag: {
    position: 'absolute',
    top: '1rem',
    left: '1rem',
    zIndex: 1,
    padding: '0.45rem 0.8rem',
    borderRadius: '999px',
    backgroundColor: '#ef4444',
    color: '#ffffff',
    fontWeight: 800,
    fontSize: '0.8rem',
  },
  previewVideo: {
    width: '100%',
    height: '22rem',
    objectFit: 'cover',
    backgroundColor: '#000000',
  },
  previewEmpty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '22rem',
    background:
      'radial-gradient(circle at center, rgba(196, 181, 253, 0.45), rgba(238, 242, 255, 0.85) 42%, rgba(255,255,255,0.96) 72%)',
    borderRadius: '1.5rem',
  },
  previewOrb: {
    width: '9rem',
    height: '9rem',
    borderRadius: '999px',
    background: 'radial-gradient(circle at 35% 35%, rgba(255,255,255,0.95), rgba(192, 132, 252, 0.4), rgba(244, 114, 182, 0.18))',
    boxShadow: '0 28px 54px rgba(192, 132, 252, 0.28)',
    marginBottom: '1.1rem',
  },
  previewText: {
    color: '#64748b',
    textAlign: 'center',
    padding: '0.5rem',
    margin: 0,
    fontSize: '0.875rem',
  },
  presetStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.8rem',
  },
  presetRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '1rem',
    padding: '0.9rem 1rem',
    backgroundColor: '#f8fafc',
    borderRadius: '1.15rem',
    border: '1px solid #e2e8f0',
  },
  presetName: {
    fontSize: '0.95rem',
    fontWeight: 700,
    color: '#172036',
  },
  presetUrl: {
    marginTop: '0.25rem',
    maxWidth: '24rem',
    color: '#64748b',
    fontSize: '0.76rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  presetActions: {
    display: 'flex',
    gap: '0.5rem',
  },
  softButtonSmall: {
    border: '1px solid #dbe4f0',
    backgroundColor: '#ffffff',
    color: '#334155',
    borderRadius: '0.85rem',
    padding: '0.55rem 0.85rem',
    fontWeight: 700,
    cursor: 'pointer',
  },
  deleteButtonSmall: {
    border: 'none',
    backgroundColor: '#fee2e2',
    color: '#b91c1c',
    borderRadius: '0.85rem',
    padding: '0.55rem 0.85rem',
    fontWeight: 700,
    cursor: 'pointer',
  },
  logStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  logRow: {
    display: 'flex',
    gap: '0.9rem',
    alignItems: 'flex-start',
    padding: '0.8rem 0.9rem',
    borderRadius: '1rem',
    backgroundColor: '#f8fafc',
    border: '1px solid #e2e8f0',
  },
  logTime: {
    color: '#64748b',
    flexShrink: 0,
    minWidth: '4.6rem',
    fontSize: '0.76rem',
    fontWeight: 700,
  },
  logText: {
    fontSize: '0.88rem',
    lineHeight: 1.5,
  },
  overviewPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  overviewHighlight: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '14rem',
    borderRadius: '1.5rem',
    backgroundColor: '#f8fafc',
    overflow: 'hidden',
    border: '1px solid #e2e8f0',
  },
  overviewGlow: {
    position: 'absolute',
    width: '15rem',
    height: '15rem',
    borderRadius: '999px',
    background: 'radial-gradient(circle, rgba(167, 139, 250, 0.42), rgba(244, 114, 182, 0.16), transparent 70%)',
    filter: 'blur(12px)',
  },
  overviewValue: {
    position: 'relative',
    fontSize: '3.4rem',
    fontWeight: 900,
    color: '#172036',
  },
  overviewLabel: {
    position: 'relative',
    marginTop: '0.35rem',
    color: '#64748b',
    fontSize: '0.95rem',
  },
  quickGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '0.8rem',
  },
  quickAction: {
    minHeight: '4rem',
    borderRadius: '1.2rem',
    border: '1px solid #e2e8f0',
    backgroundColor: '#ffffff',
    color: '#172036',
    fontWeight: 800,
    cursor: 'pointer',
  },
  healthStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.8rem',
    marginBottom: '1rem',
  },
  healthRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '0.75rem',
    padding: '0.85rem 0.9rem',
    borderRadius: '1rem',
    backgroundColor: '#f8fafc',
    border: '1px solid #e2e8f0',
    color: '#334155',
    fontSize: '0.9rem',
  },
  profileButton: {
    width: '100%',
    height: '3rem',
    borderRadius: '1rem',
    border: 'none',
    background: 'linear-gradient(135deg, #818cf8 0%, #a78bfa 100%)',
    color: '#ffffff',
    fontWeight: 800,
    cursor: 'pointer',
  },
  attendanceShell: {
    overflow: 'hidden',
    borderRadius: '2rem',
    border: '1px solid #e2e8f0',
    backgroundColor: '#ffffff',
    boxShadow: '0 24px 60px rgba(148, 163, 184, 0.14)',
  },
  monitorShell: {
    overflow: 'hidden',
    borderRadius: '2rem',
    border: '1px solid #e2e8f0',
    backgroundColor: '#ffffff',
    boxShadow: '0 24px 60px rgba(148, 163, 184, 0.14)',
  },
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    backgroundColor: '#ffffff',
    borderRadius: '1.25rem',
    padding: '1.5rem',
    width: '400px',
    maxWidth: '90%',
    boxShadow: '0 24px 60px rgba(15, 23, 42, 0.22)',
  },
  modalTitle: {
    margin: '0 0 1rem',
    fontSize: '1.1rem',
    fontWeight: 700,
    color: '#172036',
  },
  modalInput: {
    width: '100%',
    padding: '0.85rem 1rem',
    fontSize: '0.92rem',
    border: '1px solid #dbe4f0',
    borderRadius: '0.9rem',
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
    padding: '0.7rem 1rem',
    fontSize: '0.875rem',
    border: '1px solid #dbe4f0',
    borderRadius: '0.9rem',
    backgroundColor: '#ffffff',
    color: '#334155',
    cursor: 'pointer',
  },
  modalSave: {
    padding: '0.7rem 1rem',
    fontSize: '0.875rem',
    background: 'linear-gradient(135deg, #4f46e5 0%, #8b5cf6 100%)',
    color: '#ffffff',
    border: 'none',
    borderRadius: '0.9rem',
    cursor: 'pointer',
  },
  emergencyModal: {
    border: '2px solid #fecaca',
  },
  emergencyModalTitle: {
    margin: '0 0 0.5rem',
    fontSize: '1.2rem',
    fontWeight: 800,
    color: '#b91c1c',
  },
  emergencyModalSub: {
    fontSize: '0.84rem',
    color: '#64748b',
    marginBottom: '1rem',
  },
  emergencyInput: {
    width: '100%',
    padding: '0.85rem 1rem',
    fontSize: '0.95rem',
    border: '1px solid #fecaca',
    borderRadius: '0.9rem',
    marginBottom: '1rem',
  },
  emergencySendBtn: {
    padding: '0.75rem 1.1rem',
    fontSize: '0.9rem',
    fontWeight: 800,
    backgroundColor: '#dc2626',
    color: '#ffffff',
    border: 'none',
    borderRadius: '0.9rem',
    cursor: 'pointer',
  },
}

export default SuperNode
