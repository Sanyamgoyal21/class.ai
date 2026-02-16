import { useState, useEffect, useRef } from 'react'
import { io } from 'socket.io-client'

const SUPERNODE_URL = 'http://localhost:5000'

function CameraMonitor() {
  const [devices, setDevices] = useState([])
  const [connected, setConnected] = useState(false)
  const [socket, setSocket] = useState(null)
  const [cameraFeeds, setCameraFeeds] = useState({})
  const [displayFeeds, setDisplayFeeds] = useState({})
  const [activeStreams, setActiveStreams] = useState(new Set())
  const [activeDisplayStreams, setActiveDisplayStreams] = useState(new Set())
  const [selectedView, setSelectedView] = useState('grid') // 'grid' or 'single'
  const [focusedDevice, setFocusedDevice] = useState(null)
  const [showDisplay, setShowDisplay] = useState(true) // Toggle display stream visibility

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
      s.emit('device:register', {
        deviceId: `camera-monitor-${Date.now()}`,
        type: 'dashboard',
        name: 'Camera Monitor',
        capabilities: ['view'],
      })
    })

    s.on('disconnect', () => {
      setConnected(false)
    })

    s.on('device:registered', (data) => {
      if (data.success) {
        s.emit('devices:list')
      }
    })

    s.on('devices:list', (deviceList) => {
      setDevices(deviceList.filter(d => d.type === 'classroom'))
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

    // Receive camera frames
    s.on('camera:frame', (data) => {
      setCameraFeeds(prev => ({
        ...prev,
        [data.deviceId]: {
          frame: `data:image/jpeg;base64,${data.frame}`,
          timestamp: data.timestamp,
          lastUpdate: Date.now(),
        },
      }))
      setActiveStreams(prev => new Set([...prev, data.deviceId]))
    })

    // Receive display/screen frames
    s.on('display:frame', (data) => {
      setDisplayFeeds(prev => ({
        ...prev,
        [data.deviceId]: {
          frame: `data:image/jpeg;base64,${data.frame}`,
          timestamp: data.timestamp,
          lastUpdate: Date.now(),
        },
      }))
      setActiveDisplayStreams(prev => new Set([...prev, data.deviceId]))
    })

    // Control command acknowledgments
    s.on('control:ack', (data) => {
      console.log('Control ack:', data)
    })

    return () => {
      s.disconnect()
    }
  }, [])

  // Clear stale feeds (no update in 5 seconds)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      // Clear stale camera feeds
      setCameraFeeds(prev => {
        const updated = { ...prev }
        for (const [deviceId, feed] of Object.entries(updated)) {
          if (now - feed.lastUpdate > 5000) {
            setActiveStreams(prev => {
              const newSet = new Set(prev)
              newSet.delete(deviceId)
              return newSet
            })
          }
        }
        return updated
      })
      // Clear stale display feeds
      setDisplayFeeds(prev => {
        const updated = { ...prev }
        for (const [deviceId, feed] of Object.entries(updated)) {
          if (now - feed.lastUpdate > 5000) {
            setActiveDisplayStreams(prev => {
              const newSet = new Set(prev)
              newSet.delete(deviceId)
              return newSet
            })
          }
        }
        return updated
      })
    }, 2000)

    return () => clearInterval(interval)
  }, [])

  // Start camera on a device
  const startCamera = (deviceId) => {
    if (socket && connected) {
      socket.emit('control:command', {
        targetDeviceId: deviceId,
        action: 'start-camera',
        commandId: `cam-start-${Date.now()}`,
      })
    }
  }

  // Stop camera on a device
  const stopCamera = (deviceId) => {
    if (socket && connected) {
      socket.emit('control:command', {
        targetDeviceId: deviceId,
        action: 'stop-camera',
        commandId: `cam-stop-${Date.now()}`,
      })
    }
  }

  // Start display stream on a device
  const startDisplay = (deviceId) => {
    if (socket && connected) {
      socket.emit('control:command', {
        targetDeviceId: deviceId,
        action: 'start-display',
        commandId: `disp-start-${Date.now()}`,
      })
    }
  }

  // Stop display stream on a device
  const stopDisplay = (deviceId) => {
    if (socket && connected) {
      socket.emit('control:command', {
        targetDeviceId: deviceId,
        action: 'stop-display',
        commandId: `disp-stop-${Date.now()}`,
      })
    }
  }

  // Start all cameras
  const startAllCameras = () => {
    devices.filter(d => d.status === 'online').forEach(d => startCamera(d.deviceId))
  }

  // Stop all cameras
  const stopAllCameras = () => {
    devices.forEach(d => stopCamera(d.deviceId))
  }

  // Start all displays
  const startAllDisplays = () => {
    devices.filter(d => d.status === 'online').forEach(d => startDisplay(d.deviceId))
  }

  // Stop all displays
  const stopAllDisplays = () => {
    devices.forEach(d => stopDisplay(d.deviceId))
  }

  const onlineDevices = devices.filter(d => d.status === 'online')

  return (
    <div style={styles.container}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <h1 style={styles.title}>Camera Monitor</h1>
          <span style={styles.deviceCount}>
            {activeStreams.size} streaming / {onlineDevices.length} online / {devices.length} total
          </span>
        </div>
        <div style={styles.headerRight}>
          <button style={styles.controlBtn} onClick={startAllCameras}>
            Start Cameras
          </button>
          <button style={{ ...styles.controlBtn, ...styles.displayStartBtn }} onClick={startAllDisplays}>
            Start Displays
          </button>
          <button style={{ ...styles.controlBtn, ...styles.stopBtn }} onClick={() => { stopAllCameras(); stopAllDisplays(); }}>
            Stop All
          </button>
          <div style={styles.viewToggle}>
            <button
              style={selectedView === 'grid' ? styles.viewBtnActive : styles.viewBtn}
              onClick={() => setSelectedView('grid')}
            >
              Grid
            </button>
            <button
              style={selectedView === 'single' ? styles.viewBtnActive : styles.viewBtn}
              onClick={() => { setSelectedView('single'); setFocusedDevice(null) }}
            >
              Single
            </button>
          </div>
          <button
            style={showDisplay ? styles.displayBtnActive : styles.displayBtn}
            onClick={() => setShowDisplay(!showDisplay)}
          >
            {showDisplay ? '🖥️ Display ON' : '🖥️ Display OFF'}
          </button>
          <div style={styles.connectionStatus}>
            <span style={{ ...styles.statusDot, backgroundColor: connected ? '#22c55e' : '#ef4444' }} />
            {connected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div style={styles.main}>
        {selectedView === 'grid' ? (
          // Grid View - All cameras
          <div style={styles.cameraGrid}>
            {devices.length === 0 ? (
              <div style={styles.emptyState}>
                <div style={styles.emptyIcon}>📷</div>
                <h2>No Classrooms Connected</h2>
                <p>Classroom devices will appear here when they connect</p>
              </div>
            ) : (
              devices.map(device => (
                <div
                  key={device.deviceId}
                  style={{
                    ...styles.cameraCard,
                    borderColor: activeStreams.has(device.deviceId) ? '#22c55e' : '#374151',
                  }}
                  onClick={() => {
                    setFocusedDevice(device.deviceId)
                    setSelectedView('single')
                  }}
                >
                  <div style={styles.cameraHeader}>
                    <span style={styles.cameraName}>{device.name || device.deviceId}</span>
                    <span style={{
                      ...styles.statusBadge,
                      backgroundColor: device.status === 'online' ? '#22c55e' : '#ef4444'
                    }}>
                      {device.status}
                    </span>
                  </div>

                  <div style={styles.feedsContainer}>
                    {/* Camera Feed */}
                    <div style={styles.cameraFeed}>
                      <div style={styles.feedLabel}>📷 Camera</div>
                      {cameraFeeds[device.deviceId] && activeStreams.has(device.deviceId) ? (
                        <img
                          src={cameraFeeds[device.deviceId].frame}
                          alt={`Camera from ${device.name}`}
                          style={styles.feedImage}
                        />
                      ) : (
                        <div style={styles.noFeed}>
                          <span style={styles.noFeedIcon}>📷</span>
                          <span>No feed</span>
                        </div>
                      )}
                      {activeStreams.has(device.deviceId) && (
                        <div style={styles.liveIndicator}>LIVE</div>
                      )}
                    </div>

                    {/* Display/Screen Feed */}
                    {showDisplay && (
                      <div style={styles.displayFeed}>
                        <div style={styles.feedLabel}>🖥️ Display</div>
                        {displayFeeds[device.deviceId] && activeDisplayStreams.has(device.deviceId) ? (
                          <img
                            src={displayFeeds[device.deviceId].frame}
                            alt={`Display from ${device.name}`}
                            style={styles.feedImage}
                          />
                        ) : (
                          <div style={styles.noFeed}>
                            <span style={styles.noFeedIcon}>🖥️</span>
                            <span>No display</span>
                          </div>
                        )}
                        {activeDisplayStreams.has(device.deviceId) && (
                          <div style={styles.liveIndicatorDisplay}>LIVE</div>
                        )}
                      </div>
                    )}
                  </div>

                  <div style={styles.cameraControls}>
                    {!activeStreams.has(device.deviceId) ? (
                      <button
                        style={styles.startBtn}
                        onClick={(e) => { e.stopPropagation(); startCamera(device.deviceId) }}
                        disabled={device.status !== 'online'}
                      >
                        📷 Start
                      </button>
                    ) : (
                      <button
                        style={styles.stopCamBtn}
                        onClick={(e) => { e.stopPropagation(); stopCamera(device.deviceId) }}
                      >
                        📷 Stop
                      </button>
                    )}
                    {showDisplay && (
                      !activeDisplayStreams.has(device.deviceId) ? (
                        <button
                          style={styles.startDisplayBtn}
                          onClick={(e) => { e.stopPropagation(); startDisplay(device.deviceId) }}
                          disabled={device.status !== 'online'}
                        >
                          🖥️ Start
                        </button>
                      ) : (
                        <button
                          style={styles.stopDisplayBtn}
                          onClick={(e) => { e.stopPropagation(); stopDisplay(device.deviceId) }}
                        >
                          🖥️ Stop
                        </button>
                      )
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          // Single View - Focused camera
          <div style={styles.singleView}>
            {/* Sidebar with device list */}
            <div style={styles.sidebar}>
              <h3 style={styles.sidebarTitle}>Classrooms</h3>
              {devices.map(device => (
                <div
                  key={device.deviceId}
                  style={{
                    ...styles.sidebarItem,
                    backgroundColor: focusedDevice === device.deviceId ? '#3b82f6' : 'transparent',
                    color: focusedDevice === device.deviceId ? 'white' : '#e2e8f0',
                  }}
                  onClick={() => setFocusedDevice(device.deviceId)}
                >
                  <span>{device.name || device.deviceId}</span>
                  {activeStreams.has(device.deviceId) && (
                    <span style={styles.sidebarLive}>LIVE</span>
                  )}
                </div>
              ))}
            </div>

            {/* Main feed */}
            <div style={styles.mainFeed}>
              {focusedDevice ? (
                <>
                  <div style={styles.mainFeedHeader}>
                    <h2>{devices.find(d => d.deviceId === focusedDevice)?.name || focusedDevice}</h2>
                    <div style={styles.mainFeedControls}>
                      {!activeStreams.has(focusedDevice) ? (
                        <button style={styles.startBtn} onClick={() => startCamera(focusedDevice)}>
                          Start Camera
                        </button>
                      ) : (
                        <button style={styles.stopCamBtn} onClick={() => stopCamera(focusedDevice)}>
                          Stop Camera
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={styles.mainFeedContent}>
                    <div style={styles.mainFeedsRow}>
                      {/* Camera Feed */}
                      <div style={styles.mainFeedPanel}>
                        <div style={styles.mainFeedPanelHeader}>📷 Camera</div>
                        {cameraFeeds[focusedDevice] && activeStreams.has(focusedDevice) ? (
                          <div style={styles.mainFeedImageContainer}>
                            <img
                              src={cameraFeeds[focusedDevice].frame}
                              alt="Camera feed"
                              style={styles.mainFeedImage}
                            />
                            <div style={styles.mainLiveIndicator}>LIVE</div>
                          </div>
                        ) : (
                          <div style={styles.mainNoFeed}>
                            <span style={styles.mainNoFeedIcon}>📷</span>
                            <p>Camera not streaming</p>
                          </div>
                        )}
                      </div>

                      {/* Display Feed */}
                      {showDisplay && (
                        <div style={styles.mainFeedPanel}>
                          <div style={styles.mainFeedPanelHeader}>🖥️ Display</div>
                          {displayFeeds[focusedDevice] && activeDisplayStreams.has(focusedDevice) ? (
                            <div style={styles.mainFeedImageContainer}>
                              <img
                                src={displayFeeds[focusedDevice].frame}
                                alt="Display feed"
                                style={styles.mainFeedImage}
                              />
                              <div style={styles.mainLiveIndicatorDisplay}>LIVE</div>
                            </div>
                          ) : (
                            <div style={styles.mainNoFeed}>
                              <span style={styles.mainNoFeedIcon}>🖥️</span>
                              <p>Display not streaming</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div style={styles.selectPrompt}>
                  <span style={styles.selectIcon}>👈</span>
                  <p>Select a classroom from the sidebar</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#0f172a',
    color: 'white',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1rem 2rem',
    backgroundColor: '#1e293b',
    borderBottom: '1px solid #334155',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.5rem',
  },
  title: {
    margin: 0,
    fontSize: '1.5rem',
    fontWeight: '600',
  },
  deviceCount: {
    fontSize: '0.875rem',
    color: '#94a3b8',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  controlBtn: {
    padding: '0.5rem 1rem',
    fontSize: '0.875rem',
    fontWeight: '500',
    backgroundColor: '#22c55e',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  stopBtn: {
    backgroundColor: '#ef4444',
  },
  displayStartBtn: {
    backgroundColor: '#3b82f6',
  },
  viewToggle: {
    display: 'flex',
    backgroundColor: '#334155',
    borderRadius: '6px',
    overflow: 'hidden',
  },
  viewBtn: {
    padding: '0.5rem 1rem',
    fontSize: '0.8rem',
    backgroundColor: 'transparent',
    color: '#94a3b8',
    border: 'none',
    cursor: 'pointer',
  },
  viewBtnActive: {
    padding: '0.5rem 1rem',
    fontSize: '0.8rem',
    backgroundColor: '#3b82f6',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
  },
  displayBtn: {
    padding: '0.5rem 1rem',
    fontSize: '0.8rem',
    backgroundColor: '#475569',
    color: '#94a3b8',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  displayBtnActive: {
    padding: '0.5rem 1rem',
    fontSize: '0.8rem',
    backgroundColor: '#3b82f6',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  connectionStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.875rem',
    color: '#94a3b8',
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
  },
  main: {
    padding: '1rem',
    height: 'calc(100vh - 80px)',
    overflow: 'auto',
  },
  cameraGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: '1rem',
  },
  emptyState: {
    gridColumn: '1 / -1',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '4rem',
    color: '#64748b',
  },
  emptyIcon: {
    fontSize: '4rem',
    marginBottom: '1rem',
  },
  cameraCard: {
    backgroundColor: '#1e293b',
    borderRadius: '12px',
    border: '2px solid #374151',
    overflow: 'hidden',
    cursor: 'pointer',
    transition: 'border-color 0.2s, transform 0.2s',
  },
  cameraHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem 1rem',
    backgroundColor: '#0f172a',
  },
  cameraName: {
    fontWeight: '600',
    fontSize: '0.9rem',
  },
  statusBadge: {
    padding: '0.2rem 0.6rem',
    borderRadius: '9999px',
    fontSize: '0.7rem',
    fontWeight: '500',
  },
  feedsContainer: {
    display: 'flex',
    gap: '4px',
  },
  cameraFeed: {
    position: 'relative',
    flex: 1,
    aspectRatio: '4/3',
    backgroundColor: '#000',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  displayFeed: {
    position: 'relative',
    flex: 1,
    aspectRatio: '16/9',
    backgroundColor: '#111',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  feedLabel: {
    position: 'absolute',
    top: '4px',
    left: '4px',
    backgroundColor: 'rgba(0,0,0,0.7)',
    color: '#fff',
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '0.6rem',
    zIndex: 10,
  },
  feedImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  noFeed: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.5rem',
    color: '#64748b',
  },
  noFeedIcon: {
    fontSize: '2rem',
  },
  liveIndicator: {
    position: 'absolute',
    top: '24px',
    right: '6px',
    backgroundColor: '#ef4444',
    color: 'white',
    padding: '3px 8px',
    borderRadius: '4px',
    fontSize: '0.6rem',
    fontWeight: '700',
  },
  liveIndicatorDisplay: {
    position: 'absolute',
    top: '24px',
    right: '6px',
    backgroundColor: '#3b82f6',
    color: 'white',
    padding: '3px 8px',
    borderRadius: '4px',
    fontSize: '0.6rem',
    fontWeight: '700',
  },
  cameraControls: {
    padding: '0.75rem 1rem',
    display: 'flex',
    justifyContent: 'center',
    gap: '0.5rem',
  },
  startBtn: {
    padding: '0.5rem 1rem',
    fontSize: '0.75rem',
    fontWeight: '600',
    backgroundColor: '#22c55e',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  stopCamBtn: {
    padding: '0.5rem 1rem',
    fontSize: '0.75rem',
    fontWeight: '600',
    backgroundColor: '#ef4444',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  startDisplayBtn: {
    padding: '0.5rem 1rem',
    fontSize: '0.75rem',
    fontWeight: '600',
    backgroundColor: '#3b82f6',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  stopDisplayBtn: {
    padding: '0.5rem 1rem',
    fontSize: '0.75rem',
    fontWeight: '600',
    backgroundColor: '#6366f1',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },

  // Single view styles
  singleView: {
    display: 'flex',
    height: '100%',
    gap: '1rem',
  },
  sidebar: {
    width: '250px',
    backgroundColor: '#1e293b',
    borderRadius: '12px',
    padding: '1rem',
    overflowY: 'auto',
  },
  sidebarTitle: {
    margin: '0 0 1rem 0',
    fontSize: '0.9rem',
    color: '#94a3b8',
    fontWeight: '500',
  },
  sidebarItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem 1rem',
    borderRadius: '8px',
    cursor: 'pointer',
    marginBottom: '0.5rem',
    transition: 'background-color 0.2s',
  },
  sidebarLive: {
    backgroundColor: '#ef4444',
    color: 'white',
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '0.6rem',
    fontWeight: '700',
  },
  mainFeed: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderRadius: '12px',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  mainFeedHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1rem 1.5rem',
    borderBottom: '1px solid #334155',
  },
  mainFeedControls: {
    display: 'flex',
    gap: '0.5rem',
  },
  mainFeedContent: {
    flex: 1,
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
    padding: '1rem',
  },
  mainFeedsRow: {
    display: 'flex',
    gap: '1rem',
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mainFeedPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '100%',
    backgroundColor: '#111',
    borderRadius: '8px',
    overflow: 'hidden',
  },
  mainFeedPanelHeader: {
    padding: '0.5rem 1rem',
    backgroundColor: '#1e293b',
    color: '#e2e8f0',
    fontSize: '0.85rem',
    fontWeight: '600',
  },
  mainFeedImageContainer: {
    position: 'relative',
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mainFeedImage: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
  },
  mainLiveIndicator: {
    position: 'absolute',
    top: '10px',
    right: '10px',
    backgroundColor: '#ef4444',
    color: 'white',
    padding: '4px 12px',
    borderRadius: '4px',
    fontSize: '0.75rem',
    fontWeight: '700',
  },
  mainLiveIndicatorDisplay: {
    position: 'absolute',
    top: '10px',
    right: '10px',
    backgroundColor: '#3b82f6',
    color: 'white',
    padding: '4px 12px',
    borderRadius: '4px',
    fontSize: '0.75rem',
    fontWeight: '700',
  },
  mainNoFeed: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '1rem',
    color: '#64748b',
  },
  mainNoFeedIcon: {
    fontSize: '4rem',
  },
  mainNoFeedSub: {
    fontSize: '0.875rem',
    color: '#475569',
  },
  selectPrompt: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '1rem',
    color: '#64748b',
  },
  selectIcon: {
    fontSize: '3rem',
  },
}

export default CameraMonitor
