import { useEffect, useRef, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { BACKEND_URL } from '../utils/backendUrl'
import { createLessonScheduler } from '../utils/LessonScheduler.ts'
import { validateLessonPlan } from '../utils/teachingTemplates.ts'

function DoubtCanvas() {
  const [, setChatMessages] = useState([])
  const [, setLoading] = useState(false)
  const [phase, setPhase] = useState('listening')
  const [currentSpeech, setCurrentSpeech] = useState('')
  const [micDenied, setMicDenied] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [needsTap, setNeedsTap] = useState(false)
  const [speechLog, setSpeechLog] = useState([])
  const [logCollapsed, setLogCollapsed] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(true)
  const [manualQuestion, setManualQuestion] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  const logEndRef = useRef(null)
  const mountedRef = useRef(false)
  const excalidrawAPIRef = useRef(null)
  const schedulerRef = useRef(null)
  const esRef = useRef(null)
  const recognitionRef = useRef(null)
  const recognitionRunningRef = useRef(false)
  const shouldListenRef = useRef(false)
  const activeRequestIdRef = useRef(0)
  const phaseRef = useRef('listening')
  const safetyTimerRef = useRef(null)
  const recognitionBuiltRef = useRef(false)

  const roomName = new URLSearchParams(window.location.search).get('room') || 'Room102'

  const setAssistantPhase = (nextPhase) => {
    phaseRef.current = nextPhase
    if (mountedRef.current) setPhase(nextPhase)
  }

  const appendLogEntry = (entry) => {
    if (!mountedRef.current) return
    setSpeechLog((prev) => [...prev, entry])
  }

  const clearSafetyTimer = () => {
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current)
      safetyTimerRef.current = null
    }
  }

  const waitForScheduler = async (timeoutMs = 5000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const scheduler = ensureScheduler()
      if (scheduler) return scheduler
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return null
  }

  const ensureScheduler = () => {
    if (schedulerRef.current || !excalidrawAPIRef.current) return schedulerRef.current

    schedulerRef.current = createLessonScheduler(excalidrawAPIRef.current, {
      onPhaseChange: (nextPhase) => setAssistantPhase(nextPhase),
      onSpeechStart: (text) => {
        if (!mountedRef.current) return
        setCurrentSpeech(text)
      },
      onSpeechEnd: () => {
        if (!mountedRef.current) return
        setCurrentSpeech('')
      },
      onStepStart: (step) => {
        appendLogEntry({ id: `${Date.now()}-${step.step_number}`, role: 'ai', text: step.speech_text })
      },
    })

    return schedulerRef.current
  }

  const resetBoard = ({ clearLog = false } = {}) => {
    schedulerRef.current?.cancel({ resetBoard: true })
    esRef.current?.close()
    esRef.current = null
    setCurrentSpeech('')
    if (clearLog && mountedRef.current) {
      setSpeechLog([])
    }
  }

  const invalidateActiveRequest = () => {
    activeRequestIdRef.current += 1
    resetBoard()
  }

  const stopRecognition = () => {
    const recognition = recognitionRef.current
    if (!recognition) return
    recognitionRunningRef.current = false
    try { recognition.abort() } catch { /* ignore */ }
  }

  const startRecognition = () => {
    const recognition = recognitionRef.current
    if (!recognition) return
    if (recognitionRunningRef.current) return
    if (!shouldListenRef.current || phaseRef.current !== 'listening') return
    try {
      recognition.start()
    } catch (error) {
      console.warn('[DC] rec.start() threw:', error.message)
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
        if (mountedRef.current) setNeedsTap(true)
      }
    }
  }

  const maybeResumeListening = (requestId) => {
    if (requestId !== activeRequestIdRef.current) return
    clearSafetyTimer()
    shouldListenRef.current = true
    if (mountedRef.current) {
      setCurrentSpeech('')
      setLiveTranscript('')
    }
    setAssistantPhase('listening')
    startRecognition()
  }

  const exitToClassroom = () => {
    shouldListenRef.current = false
    clearSafetyTimer()
    stopRecognition()
    invalidateActiveRequest()
    window.speechSynthesis?.cancel()
    if (mountedRef.current) {
      setLiveTranscript('')
      setCurrentSpeech('')
    }
    window.location.href = `/classroom.html?name=${encodeURIComponent(roomName)}&backend=${encodeURIComponent(BACKEND_URL)}`
  }

  useEffect(() => {
    mountedRef.current = true
    ensureScheduler()

    return () => {
      mountedRef.current = false
      clearSafetyTimer()
      shouldListenRef.current = false
      esRef.current?.close()
      stopRecognition()
      schedulerRef.current?.cancel({ resetBoard: false })
      window.speechSynthesis?.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!logCollapsed) logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [speechLog, logCollapsed])

  function buildRecognition() {
    if (recognitionBuiltRef.current) return
    recognitionBuiltRef.current = true

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      console.warn('[DC] SpeechRecognition not supported')
      if (mountedRef.current) setSpeechSupported(false)
      shouldListenRef.current = false
      setAssistantPhase('listening')
      return
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onstart = () => {
      recognitionRunningRef.current = true
      if (mountedRef.current) setLiveTranscript('')
    }

    recognition.onresult = (event) => {
      if (phaseRef.current !== 'listening') return
      let interimText = ''

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        const text = result[0].transcript.trim()

        if (!result.isFinal) {
          interimText += `${text} `
          continue
        }

        if (mountedRef.current) setLiveTranscript('')
        if (!text || text.length <= 2) continue

        if (/^\s*clear\s*$/i.test(text)) {
          exitToClassroom()
          return
        }

        handleQuestion(text)
        return
      }

      if (mountedRef.current) {
        setLiveTranscript(interimText.trim())
      }
    }

    recognition.onerror = (event) => {
      if (event.error === 'aborted') return

      console.warn('[DC] Recognition error:', event.error)
      recognitionRunningRef.current = false

      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        if (mountedRef.current) setMicDenied(true)
      }

      if (event.error === 'not-allowed') {
        if (mountedRef.current) setNeedsTap(true)
      } else if (shouldListenRef.current && phaseRef.current === 'listening') {
        setTimeout(() => {
          if (mountedRef.current && shouldListenRef.current && phaseRef.current === 'listening') {
            startRecognition()
          }
        }, 700)
      }
    }

    recognition.onend = () => {
      recognitionRunningRef.current = false
      if (!mountedRef.current) return
      if (shouldListenRef.current && phaseRef.current === 'listening') {
        setTimeout(() => {
          if (mountedRef.current && shouldListenRef.current && phaseRef.current === 'listening') {
            startRecognition()
          }
        }, 300)
      }
    }

    recognitionRef.current = recognition
    setAssistantPhase('listening')
    shouldListenRef.current = true
    startRecognition()
  }

  const connectSSE = (question, requestId) =>
    new Promise((resolve, reject) => {
      const url = `${BACKEND_URL}/api/doubt/stream?q=${encodeURIComponent(question)}&feynman=1`
      const eventSource = new EventSource(url)
      esRef.current = eventSource
      let resolved = false
      const seenTypes = new Set()

      const tryResolvePlan = (payload) => {
        const plan = validateLessonPlan(payload)
        if (!plan) return false
        resolved = true
        resolve(plan)
        return true
      }

      const handleSseEvent = (event) => {
        if (requestId !== activeRequestIdRef.current) {
          eventSource.close()
          return
        }

        let msg
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }

        if (!msg || typeof msg !== 'object') return

        if (!msg.type && event.type && event.type !== 'message') {
          msg.type = event.type
        }

        if (msg?.type) {
          seenTypes.add(msg.type)
        }

        const payloadCandidate = msg.payload || msg.data || msg
        if (tryResolvePlan(payloadCandidate)) {
          eventSource.close()
          esRef.current = null
          return
        }

        if (msg.type === 'error') {
          eventSource.close()
          esRef.current = null
          reject(new Error(msg.error || 'SSE stream error'))
          return
        }

        if (msg.type === 'complete') {
          eventSource.close()
          esRef.current = null
          if (!resolved) {
            const typeSummary = Array.from(seenTypes).join(', ') || 'none'
            reject(new Error(`SSE completed without lesson plan (events: ${typeSummary})`))
          }
        }
      }

      eventSource.onmessage = handleSseEvent
      ;[
        'lesson_start',
        'lesson_plan',
        'legacy_lesson',
        'visual_chunk',
        'chat_chunk',
        'algorithm_init',
        'algorithm_advance',
        'complete',
        'error',
      ].forEach((eventName) => {
        eventSource.addEventListener(eventName, handleSseEvent)
      })

      eventSource.onerror = () => {
        eventSource.close()
        esRef.current = null
        reject(new Error('SSE connection failed'))
      }
    })

  const fetchLessonPlan = async (question, requestId) => {
    try {
      const plan = await connectSSE(question, requestId)
      if (requestId !== activeRequestIdRef.current) return null
      return plan
    } catch (sseError) {
      console.warn('[DC] SSE failed, falling back to POST:', sseError.message)
    }

    const response = await fetch(`${BACKEND_URL}/api/doubt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    })
    const data = await response.json()
    if (!data.success) throw new Error(data.error || 'Doubt API error')
    const plan = validateLessonPlan(data.data)
    if (!plan) throw new Error('Backend returned an invalid lesson plan')
    return plan
  }

  const handleQuestion = async (question) => {
    const normalizedQuestion = question.trim()
    if (!normalizedQuestion || normalizedQuestion.length <= 2) return

    shouldListenRef.current = false
    stopRecognition()
    window.speechSynthesis?.cancel()
    clearSafetyTimer()
    invalidateActiveRequest()
    const requestId = activeRequestIdRef.current

    setChatMessages((prev) => [...prev, { role: 'user', content: normalizedQuestion }])
    setLoading(true)
    setAssistantPhase('thinking')
    resetBoard({ clearLog: true })
    setSpeechLog([{ id: `${Date.now()}-user`, role: 'user', text: normalizedQuestion }])
    setLiveTranscript('')
    setManualQuestion('')
    setErrorMessage('')

    safetyTimerRef.current = setTimeout(() => {
      if (requestId === activeRequestIdRef.current && mountedRef.current) {
        console.warn('[DC] Safety timeout - force-resuming listening')
        schedulerRef.current?.cancel({ resetBoard: false })
        setErrorMessage('The explanation took too long, so listening resumed.')
        appendLogEntry({ id: `${Date.now()}-timeout`, role: 'system', text: 'The explanation timed out before playback started.' })
        maybeResumeListening(requestId)
      }
    }, 90000)

    try {
      const plan = await fetchLessonPlan(normalizedQuestion, requestId)
      if (requestId !== activeRequestIdRef.current) return
      if (!plan) throw new Error('Lesson plan unavailable')

      const scheduler = await waitForScheduler()
      if (!scheduler) throw new Error('Canvas scheduler unavailable')

      scheduler.loadPlan(plan)
      setChatMessages((prev) => [...prev, { role: 'assistant', content: plan.timeline.map((step) => step.speech_text).join(' ') }])
      await scheduler.start()

      if (requestId !== activeRequestIdRef.current) return
      maybeResumeListening(requestId)
    } catch (error) {
      if (requestId !== activeRequestIdRef.current) return
      const message = error instanceof Error ? error.message : 'Unknown playback error'
      setChatMessages((prev) => [...prev, { role: 'assistant', content: `Connection error: ${message}` }])
      setErrorMessage(message)
      appendLogEntry({ id: `${Date.now()}-error`, role: 'system', text: `Error: ${message}` })
      maybeResumeListening(requestId)
    } finally {
      setLoading(false)
    }
  }

  const pillLabel =
    micDenied
      ? null
      : phase === 'listening'
        ? (
            liveTranscript
              ? `"${liveTranscript}"`
              : speechSupported
                ? 'Listening...'
                : 'Ask by typing or tap the mic if your browser supports it'
          )
        : phase === 'thinking'
          ? 'Thinking...'
          : currentSpeech || 'Explaining...'

  return (
    <>
      <style>{`
        @keyframes fadeUp {
          from { opacity:0; transform:translateY(14px); }
          to   { opacity:1; transform:translateY(0); }
        }
        @keyframes listeningRing {
          0%  { box-shadow:0 0 0 0 rgba(37,99,235,0.45); }
          70% { box-shadow:0 0 0 12px rgba(37,99,235,0); }
          100%{ box-shadow:0 0 0 0 rgba(37,99,235,0); }
        }
      `}</style>

      <div style={st.container}>
        <div style={st.excalidrawContainer}>
          <Excalidraw
            theme="light"
            excalidrawAPI={(api) => {
              excalidrawAPIRef.current = api
              if (mountedRef.current) {
                setTimeout(() => {
                  if (mountedRef.current) {
                    ensureScheduler()
                    buildRecognition()
                  }
                }, 0)
              }
            }}
            initialData={{ appState: { viewBackgroundColor: '#ffffff' } }}
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                export: false,
                changeViewBackgroundColor: false,
                clearCanvas: false,
              },
            }}
          />
        </div>

        <div style={st.topLeft}>
          <span style={st.roomTag}>{roomName}</span>
          <button title="Clear board" onClick={() => resetBoard({ clearLog: true })} style={st.iconBtn}>Clear</button>
          <button
            title="Start listening"
            onClick={() => {
              setNeedsTap(false)
              setMicDenied(false)
              setErrorMessage('')
              shouldListenRef.current = true
              setAssistantPhase('listening')
              startRecognition()
            }}
            style={st.iconBtn}
          >
            Mic
          </button>
          <span style={st.clearHint}>Say "Clear" to return to class</span>
        </div>

        {micDenied && (
          <div style={st.micDeniedBanner}>
            Microphone access is required for the doubt assistant.
          </div>
        )}

        {errorMessage && !micDenied && (
          <div style={st.errorBanner}>
            {errorMessage}
          </div>
        )}

        {pillLabel && (
          <div
            style={{
              ...st.statusPill,
              ...(phase === 'listening' && !liveTranscript ? st.listeningStyle : {}),
            }}
          >
            {pillLabel}
          </div>
        )}

        {speechLog.length > 0 && (
          <div style={st.logWrapper}>
            <div style={st.logHeader}>
              <span style={st.logTitle}>Transcript</span>
              <button
                style={st.logToggleBtn}
                onClick={() => setLogCollapsed((collapsed) => !collapsed)}
                title={logCollapsed ? 'Expand' : 'Collapse'}
              >
                {logCollapsed ? '^' : 'v'}
              </button>
            </div>
            {!logCollapsed && (
              <div style={st.logScroll}>
                {speechLog.map((entry) => (
                  <div
                    key={entry.id}
                    style={
                      entry.role === 'user'
                        ? st.logUser
                        : entry.role === 'system'
                          ? st.logSystem
                          : st.logAI
                    }
                  >
                    {entry.role === 'user' ? 'Mic ' : entry.role === 'system' ? 'System ' : 'AI '}{entry.text}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            )}
          </div>
        )}

        <form
          style={st.askBar}
          onSubmit={(event) => {
            event.preventDefault()
            if (phase === 'speaking') {
              schedulerRef.current?.cancel({ resetBoard: false })
              setCurrentSpeech('')
            }
            void handleQuestion(manualQuestion)
          }}
        >
          <input
            type="text"
            value={manualQuestion}
            onChange={(event) => setManualQuestion(event.target.value)}
            placeholder="Ask any doubt: Explain DSU, Water Cycle, Newton's Laws..."
            style={st.askInput}
          />
          <button type="submit" style={st.askBtn} disabled={!manualQuestion.trim()}>
            Ask
          </button>
        </form>

        {needsTap && (
          <div
            style={st.tapOverlay}
            onClick={() => {
              setNeedsTap(false)
              setErrorMessage('')
              shouldListenRef.current = true
              setAssistantPhase('listening')
              startRecognition()
            }}
          >
            <div style={st.tapCard}>
              <div style={st.tapIcon}>Mic</div>
              <div style={st.tapTitle}>Tap to start listening</div>
              <div style={st.tapSub}>Browser requires a tap to enable the microphone</div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

const st = {
  container: {
    position: 'relative',
    width: '100vw',
    height: '100vh',
    overflow: 'hidden',
    fontFamily: '"Segoe UI", "Trebuchet MS", sans-serif',
  },
  excalidrawContainer: { position: 'absolute', inset: 0 },
  topLeft: {
    position: 'absolute',
    top: '1rem',
    left: '1rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    zIndex: 30,
  },
  roomTag: {
    fontSize: '0.72rem',
    fontWeight: 700,
    color: '#1d4ed8',
    background: 'rgba(219,234,254,0.92)',
    border: '1px solid #bfdbfe',
    borderRadius: '999px',
    padding: '0.22rem 0.7rem',
    backdropFilter: 'blur(8px)',
  },
  iconBtn: {
    minWidth: '56px',
    height: '38px',
    borderRadius: '12px',
    border: '1px solid rgba(203,213,225,0.7)',
    backgroundColor: 'rgba(255,255,255,0.88)',
    backdropFilter: 'blur(10px)',
    boxShadow: '0 2px 10px rgba(15,23,42,0.08)',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 0.8rem',
  },
  clearHint: { fontSize: '0.68rem', color: '#94a3b8', userSelect: 'none' },
  micDeniedBanner: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
    zIndex: 40,
    background: 'rgba(254,226,226,0.97)',
    border: '1px solid #fca5a5',
    borderRadius: '16px',
    padding: '1rem 1.5rem',
    color: '#991b1b',
    fontWeight: 600,
    fontSize: '1rem',
    boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
    textAlign: 'center',
    maxWidth: '400px',
  },
  errorBanner: {
    position: 'absolute',
    top: '5rem',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 40,
    maxWidth: 'min(680px, 92vw)',
    background: 'rgba(255,241,242,0.97)',
    border: '1px solid #fda4af',
    borderRadius: '14px',
    padding: '0.8rem 1rem',
    color: '#9f1239',
    fontWeight: 600,
    fontSize: '0.92rem',
    boxShadow: '0 10px 24px rgba(15,23,42,0.1)',
    textAlign: 'center',
  },
  statusPill: {
    position: 'absolute',
    bottom: '2rem',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 30,
    maxWidth: 'min(580px, 88vw)',
    background: 'rgba(255,255,255,0.94)',
    backdropFilter: 'blur(12px)',
    border: '1px solid rgba(203,213,225,0.8)',
    borderRadius: '999px',
    padding: '0.7rem 1.6rem',
    boxShadow: '0 8px 32px rgba(15,23,42,0.12)',
    fontSize: '0.95rem',
    color: '#334155',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    animation: 'fadeUp 0.18s ease',
    textAlign: 'center',
  },
  listeningStyle: {
    animation: 'fadeUp 0.18s ease, listeningRing 1.6s ease-in-out infinite',
    border: '1px solid rgba(37,99,235,0.4)',
  },
  tapOverlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 50,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(15,23,42,0.55)',
    backdropFilter: 'blur(6px)',
    cursor: 'pointer',
  },
  tapCard: {
    background: 'rgba(255,255,255,0.97)',
    borderRadius: '20px',
    padding: '2.5rem 3rem',
    textAlign: 'center',
    boxShadow: '0 16px 48px rgba(15,23,42,0.22)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.6rem',
    animation: 'fadeUp 0.25s ease',
  },
  tapIcon: { fontSize: '3rem', lineHeight: 1 },
  tapTitle: { fontSize: '1.25rem', fontWeight: 700, color: '#0f172a' },
  tapSub: { fontSize: '0.85rem', color: '#64748b' },
  logWrapper: {
    position: 'absolute',
    bottom: '5.5rem',
    right: '1rem',
    zIndex: 30,
    width: 'min(360px, 30vw)',
    background: 'transparent',
    overflow: 'hidden',
  },
  askBar: {
    position: 'absolute',
    left: '50%',
    bottom: '6.8rem',
    transform: 'translateX(-50%)',
    zIndex: 35,
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    width: 'min(760px, 78vw)',
    background: 'rgba(255,255,255,0.95)',
    border: '1px solid rgba(203,213,225,0.85)',
    borderRadius: '18px',
    padding: '0.55rem',
    boxShadow: '0 14px 32px rgba(15,23,42,0.12)',
    backdropFilter: 'blur(14px)',
  },
  askInput: {
    flex: 1,
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: '#0f172a',
    fontSize: '0.96rem',
    padding: '0.6rem 0.8rem',
  },
  askBtn: {
    border: 'none',
    borderRadius: '12px',
    background: '#2563eb',
    color: '#ffffff',
    fontWeight: 700,
    fontSize: '0.9rem',
    padding: '0.75rem 1rem',
    cursor: 'pointer',
    minWidth: '88px',
  },
  logHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.45rem 0.75rem',
  },
  logTitle: {
    fontSize: '0.7rem',
    fontWeight: 700,
    color: 'rgba(255,255,255,0.7)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    textShadow: '0 1px 4px rgba(0,0,0,0.5)',
  },
  logToggleBtn: {
    background: 'none',
    border: 'none',
    color: 'rgba(255,255,255,0.5)',
    cursor: 'pointer',
    fontSize: '0.65rem',
    padding: '0 0.2rem',
    lineHeight: 1,
  },
  logScroll: {
    maxHeight: '36vh',
    overflowY: 'auto',
    padding: '0.25rem 0.75rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.3rem',
  },
  logUser: {
    fontSize: '0.82rem',
    color: 'rgba(147,197,253,0.95)',
    lineHeight: 1.5,
    padding: '0.15rem 0',
    wordBreak: 'break-word',
    textShadow: '0 1px 6px rgba(0,0,0,0.6)',
    fontWeight: 500,
  },
  logAI: {
    fontSize: '0.82rem',
    color: 'rgba(255,255,255,0.92)',
    lineHeight: 1.5,
    padding: '0.15rem 0',
    wordBreak: 'break-word',
    textShadow: '0 1px 6px rgba(0,0,0,0.6)',
    fontWeight: 400,
  },
  logSystem: {
    fontSize: '0.8rem',
    color: 'rgba(253,164,175,0.98)',
    lineHeight: 1.5,
    padding: '0.15rem 0',
    wordBreak: 'break-word',
    textShadow: '0 1px 6px rgba(0,0,0,0.6)',
    fontWeight: 600,
  },
}

export default DoubtCanvas
