import { useEffect, useRef, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { animateDiagram, applyViewportToDiagram } from '../utils/DiagramEngine.ts'
import { animateAlgorithm, applyAlgorithmStep, normalizeInstruction } from '../utils/AlgorithmVisualizer.ts'
import { renderVisualsChunk } from '../utils/VisualInstructionEngine.ts'
import { BACKEND_URL } from '../utils/backendUrl'

function DoubtCanvas() {
  const [, setChatMessages] = useState([])
  const [, setLoading] = useState(false)
  const [phase, setPhase] = useState('thinking')
  const [, setCurrentSpeech] = useState('')
  const [micDenied, setMicDenied] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [needsTap, setNeedsTap] = useState(false)
  const [speechLog, setSpeechLog] = useState([])
  const [logCollapsed, setLogCollapsed] = useState(false)

  const logEndRef = useRef(null)
  const mountedRef = useRef(false)
  const excalidrawAPIRef = useRef(null)
  const speechBufferRef = useRef('')
  const esRef = useRef(null)
  const queuedDiagramRef = useRef(null)
  const queuedAlgorithmRef = useRef(null)
  const queuedVisualsRef = useRef([])
  const activeSpeechRef = useRef(0)
  const algoNormalizedRef = useRef(null)
  const algoBoardStateRef = useRef(null)
  const algoStepIndexRef = useRef(0)
  const pendingFractionRef = useRef(null)
  const phaseRef = useRef('thinking')
  const recognitionRef = useRef(null)
  const recognitionRunningRef = useRef(false)
  const shouldListenRef = useRef(false)
  const activeRequestIdRef = useRef(0)
  const pendingUtterancesRef = useRef(0)
  const streamCompleteRef = useRef(false)
  const finalizingResponseRef = useRef(false)
  const safetyTimerRef = useRef(null)

  const roomName = new URLSearchParams(window.location.search).get('room') || 'Room102'

  const setAssistantPhase = (nextPhase) => {
    phaseRef.current = nextPhase
    if (mountedRef.current) setPhase(nextPhase)
    if (nextPhase === 'listening') console.log('[DC] listening started')
    if (nextPhase === 'thinking') console.log('[DC] question sent to backend')
    if (nextPhase === 'speaking') console.log('[DC] speaking started')
  }

  const clearSafetyTimer = () => {
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current)
      safetyTimerRef.current = null
    }
  }

  const resetCanvas = () => {
    excalidrawAPIRef.current?.updateScene({
      elements: [],
      appState: { viewBackgroundColor: '#ffffff' },
    })
    speechBufferRef.current = ''
    queuedDiagramRef.current = null
    queuedAlgorithmRef.current = null
    queuedVisualsRef.current = []
    activeSpeechRef.current = 0
    algoNormalizedRef.current = null
    algoBoardStateRef.current = null
    algoStepIndexRef.current = 0
    pendingFractionRef.current = null
    if (mountedRef.current) {
      setCurrentSpeech('')
      setSpeechLog([])
    }
  }

  const invalidateActiveRequest = () => {
    activeRequestIdRef.current += 1
    pendingUtterancesRef.current = 0
    streamCompleteRef.current = false
    finalizingResponseRef.current = false
    activeSpeechRef.current = 0
    speechBufferRef.current = ''
    pendingFractionRef.current = null
    queuedVisualsRef.current = []
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

  const renderDiagramPayload = async (diagram) => {
    if (!diagram || !excalidrawAPIRef.current) return
    try {
      await animateDiagram(diagram, excalidrawAPIRef.current, { reset: true, duration: 460 })
      applyViewportToDiagram(excalidrawAPIRef.current)
    } catch (error) {
      console.warn('[DC] Diagram render error:', error)
    }
  }

  const renderAlgorithmPayload = async (algorithm) => {
    if (!algorithm || !excalidrawAPIRef.current) return
    try {
      await animateAlgorithm(algorithm, excalidrawAPIRef.current, { reset: true })
      applyViewportToDiagram(excalidrawAPIRef.current)
    } catch (error) {
      console.warn('[DC] Algorithm render error:', error)
    }
  }

  const flushQueuedVisual = () => {
    if (queuedVisualsRef.current.length) {
      const visuals = queuedVisualsRef.current.shift()
      renderVisualsChunk(visuals, excalidrawAPIRef.current, { reset: false })
      applyViewportToDiagram(excalidrawAPIRef.current)
      return
    }

    if (queuedAlgorithmRef.current) {
      const algorithm = queuedAlgorithmRef.current
      queuedAlgorithmRef.current = null
      void renderAlgorithmPayload(algorithm)
      return
    }

    if (queuedDiagramRef.current) {
      const diagram = queuedDiagramRef.current
      queuedDiagramRef.current = null
      void renderDiagramPayload(diagram)
    }
  }

  const maybeResumeListening = (requestId) => {
    if (requestId !== activeRequestIdRef.current) return
    if (!streamCompleteRef.current) return
    if (pendingUtterancesRef.current > 0) return
    if (finalizingResponseRef.current) return

    clearSafetyTimer()
    shouldListenRef.current = true
    if (mountedRef.current) {
      setCurrentSpeech('')
      setLiveTranscript('')
    }
    setAssistantPhase('listening')
    console.log('[DC] recognition restarted')
    startRecognition()
  }

  const exitToClassroom = () => {
    console.log('[DC] "Clear" command detected')
    shouldListenRef.current = false
    clearSafetyTimer()
    stopRecognition()
    esRef.current?.close()
    esRef.current = null
    invalidateActiveRequest()
    window.speechSynthesis.cancel()
    resetCanvas()
    if (mountedRef.current) {
      setLiveTranscript('')
      setCurrentSpeech('')
    }
    window.location.href = `/classroom.html?name=${encodeURIComponent(roomName)}`
  }

  useEffect(() => {
    mountedRef.current = true

    const handleResize = () => {
      if (excalidrawAPIRef.current?.getSceneElements()?.length) {
        applyViewportToDiagram(excalidrawAPIRef.current)
      }
    }

    window.addEventListener('resize', handleResize)
    buildRecognition()

    return () => {
      mountedRef.current = false
      window.removeEventListener('resize', handleResize)
      clearSafetyTimer()
      shouldListenRef.current = false
      esRef.current?.close()
      esRef.current = null
      stopRecognition()
      window.speechSynthesis.cancel()
      activeSpeechRef.current = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!logCollapsed) logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [speechLog, logCollapsed])

  function buildRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      console.warn('[DC] SpeechRecognition not supported')
      return
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = 'en-US'

    recognition.onstart = () => {
      recognitionRunningRef.current = true
      if (mountedRef.current) setLiveTranscript('')
    }

    recognition.onresult = (event) => {
      if (phaseRef.current !== 'listening') return

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (!result.isFinal) continue

        const text = result[0].transcript.trim()
        if (mountedRef.current) setLiveTranscript('')
        if (!text || text.length <= 2) continue

        console.log('[DC] speech detected:', text)

        if (/^\s*clear\s*$/i.test(text)) {
          exitToClassroom()
          return
        }

        handleQuestion(text)
        return
      }
    }

    recognition.onerror = (event) => {
      console.warn('[DC] Recognition error:', event.error)
      recognitionRunningRef.current = false

      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        if (mountedRef.current) setMicDenied(true)
      }

      if (event.error === 'not-allowed') {
        if (mountedRef.current) setNeedsTap(true)
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

  const speakSentence = (text, requestId, onEnd) => {
    if (requestId !== activeRequestIdRef.current) {
      onEnd?.()
      return
    }

    if (!window.speechSynthesis) {
      onEnd?.()
      maybeResumeListening(requestId)
      return
    }

    activeSpeechRef.current += 1
    pendingUtterancesRef.current += 1

    if (mountedRef.current) {
      setCurrentSpeech(text)
      setAssistantPhase('speaking')
      setSpeechLog((prev) => [...prev, { id: Date.now() + Math.random(), role: 'ai', text }])
    }

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 0.95
    utterance.pitch = 1.05

    const done = () => {
      if (requestId !== activeRequestIdRef.current) {
        onEnd?.()
        return
      }

      activeSpeechRef.current = Math.max(0, activeSpeechRef.current - 1)
      pendingUtterancesRef.current = Math.max(0, pendingUtterancesRef.current - 1)

      if (activeSpeechRef.current === 0) {
        if (mountedRef.current) setCurrentSpeech('')
        if (pendingFractionRef.current !== null && algoNormalizedRef.current && excalidrawAPIRef.current) {
          const normalized = algoNormalizedRef.current
          const total = normalized.steps.length
          const target = Math.round(pendingFractionRef.current * total)
          pendingFractionRef.current = null
          for (let i = algoStepIndexRef.current; i < target && i < total; i++) {
            algoBoardStateRef.current = applyAlgorithmStep(
              normalized,
              normalized.steps[i],
              algoBoardStateRef.current,
              excalidrawAPIRef.current,
            )
            algoStepIndexRef.current = i + 1
          }
        } else {
          flushQueuedVisual()
        }
      }

      onEnd?.()
      maybeResumeListening(requestId)
    }

    utterance.onend = done
    utterance.onerror = done
    window.speechSynthesis.speak(utterance)
  }

  const connectSSE = (question, requestId) =>
    new Promise((resolve, reject) => {
      const url = `${BACKEND_URL}/api/doubt/stream?q=${encodeURIComponent(question)}&feynman=1`
      const eventSource = new EventSource(url)
      esRef.current = eventSource
      const msgId = Date.now()
      setChatMessages((prev) => [...prev, { id: msgId, role: 'assistant', content: '' }])

      eventSource.onmessage = (event) => {
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

        if (msg.type === 'algorithm_init') {
          algoNormalizedRef.current = normalizeInstruction(msg.payload)
          algoBoardStateRef.current = null
          algoStepIndexRef.current = 0
          excalidrawAPIRef.current?.updateScene({
            elements: [],
            appState: { viewBackgroundColor: '#ffffff' },
          })
        }

        if (msg.type === 'chat_chunk') {
          const chunk = msg.payload
          setChatMessages((prev) =>
            prev.map((entry) => (entry.id === msgId ? { ...entry, content: entry.content + chunk + ' ' } : entry)),
          )
          speechBufferRef.current += chunk + ' '
          if (/[.!?]\s*$/.test(speechBufferRef.current.trim())) {
            const sentence = speechBufferRef.current.trim()
            speechBufferRef.current = ''
            speakSentence(sentence, requestId)
          }
        }

        if (msg.type === 'algorithm_advance') {
          const fraction = msg.payload.fraction
          const normalized = algoNormalizedRef.current
          if (!normalized || !excalidrawAPIRef.current) return
          const total = normalized.steps.length
          const target = Math.round(fraction * total)
          if (activeSpeechRef.current > 0) {
            pendingFractionRef.current = fraction
          } else {
            for (let i = algoStepIndexRef.current; i < target && i < total; i++) {
              algoBoardStateRef.current = applyAlgorithmStep(
                normalized,
                normalized.steps[i],
                algoBoardStateRef.current,
                excalidrawAPIRef.current,
              )
              algoStepIndexRef.current = i + 1
            }
          }
        }

        if (msg.type === 'visual_chunk') {
          const visuals = Array.isArray(msg.payload?.visuals) ? msg.payload.visuals : []
          if (!visuals.length) return
          if (activeSpeechRef.current > 0) {
            queuedVisualsRef.current.push(visuals)
          } else {
            renderVisualsChunk(visuals, excalidrawAPIRef.current, { reset: false })
            applyViewportToDiagram(excalidrawAPIRef.current)
          }
        }

        if (msg.type === 'diagram') {
          if (activeSpeechRef.current > 0) queuedDiagramRef.current = msg.payload
          else void renderDiagramPayload(msg.payload)
        }

        if (msg.type === 'algorithm') {
          if (activeSpeechRef.current > 0) queuedAlgorithmRef.current = msg.payload
          else void renderAlgorithmPayload(msg.payload)
        }

        if (msg.type === 'complete') {
          console.log('[DC] SSE complete event received')
          streamCompleteRef.current = true
          finalizingResponseRef.current = Boolean(speechBufferRef.current.trim())

          if (speechBufferRef.current.trim()) {
            const remaining = speechBufferRef.current.trim()
            speechBufferRef.current = ''
            speakSentence(remaining, requestId, () => {
              flushQueuedVisual()
              finalizingResponseRef.current = false
              maybeResumeListening(requestId)
            })
          } else {
            flushQueuedVisual()
            finalizingResponseRef.current = false
            maybeResumeListening(requestId)
          }

          eventSource.close()
          esRef.current = null
          resolve()
        }

        if (msg.type === 'error') {
          eventSource.close()
          esRef.current = null
          reject(new Error(msg.error || 'SSE stream error'))
        }
      }

      eventSource.onerror = () => {
        eventSource.close()
        esRef.current = null
        reject(new Error('SSE connection failed'))
      }
    })

  const handleQuestion = async (question) => {
    if (phaseRef.current !== 'listening') return

    const normalizedQuestion = question.trim()
    if (!normalizedQuestion || normalizedQuestion.length <= 2) return

    shouldListenRef.current = false
    stopRecognition()
    window.speechSynthesis.cancel()
    clearSafetyTimer()
    invalidateActiveRequest()
    const requestId = activeRequestIdRef.current

    setChatMessages((prev) => [...prev, { role: 'user', content: normalizedQuestion }])
    setLoading(true)
    setAssistantPhase('thinking')
    resetCanvas()
    setSpeechLog([{ id: Date.now(), role: 'user', text: normalizedQuestion }])
    setLiveTranscript('')

    safetyTimerRef.current = setTimeout(() => {
      if (requestId === activeRequestIdRef.current && mountedRef.current) {
        console.warn('[DC] Safety timeout - force-resuming listening')
        window.speechSynthesis.cancel()
        pendingUtterancesRef.current = 0
        streamCompleteRef.current = true
        finalizingResponseRef.current = false
        activeSpeechRef.current = 0
        maybeResumeListening(requestId)
      }
    }, 60000)

    let sseSucceeded = false
    try {
      await connectSSE(normalizedQuestion, requestId)
      sseSucceeded = true
    } catch (sseError) {
      console.warn('[DC] SSE failed, falling back to POST:', sseError.message)
    }

    if (!sseSucceeded) {
      try {
        const response = await fetch(`${BACKEND_URL}/api/doubt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: normalizedQuestion }),
        })
        const data = await response.json()
        if (requestId !== activeRequestIdRef.current) return

        streamCompleteRef.current = true

        if (data.success) {
          setChatMessages((prev) => [...prev, { role: 'assistant', content: data.data.chat }])
          if (Array.isArray(data.data.visuals) && data.data.visuals.length) {
            renderVisualsChunk(data.data.visuals, excalidrawAPIRef.current, { reset: true })
            applyViewportToDiagram(excalidrawAPIRef.current)
          } else if (data.data.algorithm) {
            await renderAlgorithmPayload(data.data.algorithm)
          } else {
            await renderDiagramPayload(data.data.diagram)
          }

          if (typeof data.data.chat === 'string' && data.data.chat.trim()) {
            const sentences = data.data.chat
              .split(/(?<=[.!?])\s+/)
              .map((sentence) => sentence.trim())
              .filter(Boolean)

            if (sentences.length) {
              for (const sentence of sentences) {
                speakSentence(sentence, requestId)
              }
            } else {
              maybeResumeListening(requestId)
            }
          } else {
            maybeResumeListening(requestId)
          }
        } else {
          setChatMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${data.error}` }])
          maybeResumeListening(requestId)
        }
      } catch (error) {
        if (requestId !== activeRequestIdRef.current) return
        streamCompleteRef.current = true
        setChatMessages((prev) => [...prev, { role: 'assistant', content: `Connection error: ${error.message}` }])
        maybeResumeListening(requestId)
      }
    }

    setLoading(false)

    if (requestId === activeRequestIdRef.current && pendingUtterancesRef.current === 0) {
      maybeResumeListening(requestId)
    }
  }

  const pillLabel =
    micDenied
      ? null
      : phase === 'listening'
        ? (liveTranscript ? `"${liveTranscript}"` : 'Listening...')
        : phase === 'thinking'
          ? 'Thinking...'
          : null

  return (
    <>
      <style>{`
        @keyframes fadeUp {
          from { opacity:0; transform:translateY(14px); }
          to   { opacity:1; transform:translateY(0); }
        }
        @keyframes speechPulse {
          0%,100% { opacity:1; }
          50%     { opacity:0.72; }
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
          <button title="Clear board" onClick={resetCanvas} style={st.iconBtn}>Clear</button>
          <span style={st.clearHint}>Say "Clear" to return to class</span>
        </div>

        {micDenied && (
          <div style={st.micDeniedBanner}>
            Microphone access is required for the doubt assistant.
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
                  <div key={entry.id} style={entry.role === 'user' ? st.logUser : st.logAI}>
                    {entry.role === 'user' ? 'Mic ' : 'AI '}{entry.text}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            )}
          </div>
        )}

        {needsTap && (
          <div
            style={st.tapOverlay}
            onClick={() => {
              setNeedsTap(false)
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
  speechBubble: {
    position: 'absolute',
    bottom: '5.5rem',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 30,
    maxWidth: 'min(660px, 82vw)',
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.6rem',
    background: 'rgba(15,23,42,0.84)',
    backdropFilter: 'blur(14px)',
    border: '1px solid rgba(99,102,241,0.3)',
    borderRadius: '18px',
    padding: '0.75rem 1.25rem',
    boxShadow: '0 8px 32px rgba(15,23,42,0.2)',
    animation: 'fadeUp 0.2s ease',
    pointerEvents: 'none',
  },
  speechDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: '#818cf8',
    flexShrink: 0,
    marginTop: '0.4rem',
    animation: 'speechPulse 1.4s ease-in-out infinite',
  },
  speechText: { color: '#e2e8f0', fontSize: '1rem', lineHeight: 1.55, fontWeight: 500 },
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
}

export default DoubtCanvas
