import { useEffect, useRef, useState } from 'react'

function Voice() {
  const [loading, setLoading] = useState(false)
  const [chatMessages, setChatMessages] = useState([])
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(true)
  const [ttsSupported, setTtsSupported] = useState(true)
  const [voiceReady, setVoiceReady] = useState(false)
  const [status, setStatus] = useState('Tap Start Voice to enable microphone and speech.')

  const recognitionRef = useRef(null)
  const voicesRef = useRef([])
  const sessionEnabledRef = useRef(false)
  const isSpeakingRef = useRef(false)

  useEffect(() => {
    const recognitionSupported = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window
    const synthesisSupported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window

    setSpeechSupported(recognitionSupported)
    setTtsSupported(synthesisSupported)

    if (recognitionSupported) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
      const recognition = new SpeechRecognition()
      recognition.continuous = true
      recognition.interimResults = false
      recognition.lang = 'en-US'

      recognition.onresult = (event) => {
        const transcript = event.results[event.results.length - 1][0].transcript.trim()
        if (!transcript) return
        void handleUserMessage(transcript)
      }

      recognition.onend = () => {
        setIsListening(false)
        if (sessionEnabledRef.current && !isSpeakingRef.current) {
          try {
            recognition.start()
            setIsListening(true)
          } catch {
            // Browser can throw if start is called too quickly after stop.
          }
        }
      }

      recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error)
        setStatus(`Microphone error: ${event.error}`)
      }

      recognitionRef.current = recognition
    }

    if (synthesisSupported) {
      const syncVoices = () => {
        voicesRef.current = window.speechSynthesis.getVoices()
        if (voicesRef.current.length > 0) {
          setVoiceReady(true)
        }
      }

      syncVoices()
      window.speechSynthesis.onvoiceschanged = syncVoices

      return () => {
        window.speechSynthesis.onvoiceschanged = null
        window.speechSynthesis.cancel()
        recognitionRef.current?.stop()
      }
    }

    return () => {
      recognitionRef.current?.stop()
    }
  }, [])

  const pickVoice = () => {
    const voices = voicesRef.current
    if (!voices.length) return null

    return (
      voices.find((voice) => /en(-|_)?(IN|US|GB)/i.test(voice.lang)) ||
      voices.find((voice) => /english/i.test(voice.name)) ||
      voices[0]
    )
  }

  const speakText = (text) =>
    new Promise((resolve, reject) => {
      if (!ttsSupported || !window.speechSynthesis) {
        reject(new Error('Text to speech is not supported in this browser.'))
        return
      }

      window.speechSynthesis.cancel()

      const utterance = new SpeechSynthesisUtterance(text)
      const selectedVoice = pickVoice()
      if (selectedVoice) {
        utterance.voice = selectedVoice
        utterance.lang = selectedVoice.lang
      }
      utterance.rate = 0.95
      utterance.pitch = 1.05

      utterance.onstart = () => {
        isSpeakingRef.current = true
        setIsSpeaking(true)
        setStatus('Speaking response...')
      }

      utterance.onend = () => {
        isSpeakingRef.current = false
        setIsSpeaking(false)
        setStatus('Listening...')
        if (sessionEnabledRef.current) {
          try {
            recognitionRef.current?.start()
            setIsListening(true)
          } catch {
            // Ignore duplicate start attempts.
          }
        }
        resolve()
      }

      utterance.onerror = (event) => {
        isSpeakingRef.current = false
        setIsSpeaking(false)
        reject(new Error(event.error || 'Speech synthesis failed'))
      }

      window.speechSynthesis.speak(utterance)
    })

  const handleUserMessage = async (text) => {
    if (!text) return

    setLoading(true)
    setStatus('Thinking...')

    try {
      recognitionRef.current?.stop()
      setIsListening(false)
    } catch {
      // Ignore stop failures.
    }

    setChatMessages((prev) => [...prev, { role: 'user', content: text }])

    try {
      const response = await fetch('http://localhost:5000/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...chatMessages, { role: 'user', content: text }],
        }),
      })

      const data = await response.json()
      const assistantMessage = data?.choices?.[0]?.message
      if (!assistantMessage?.content) {
        throw new Error('Invalid response from backend')
      }

      setChatMessages((prev) => [...prev, assistantMessage])
      setLoading(false)
      await speakText(assistantMessage.content)
    } catch (error) {
      console.error(error)
      setLoading(false)
      setStatus(`Voice failed: ${error.message}`)
    }
  }

  const handleStartVoice = async () => {
    if (!speechSupported || !ttsSupported) return

    sessionEnabledRef.current = true

    // Warm up speech synthesis under a user gesture so later AI speech is allowed.
    try {
      await speakText('Voice session started.')
    } catch (error) {
      console.error(error)
      setStatus(`Could not start voice output: ${error.message}`)
      return
    }

    try {
      recognitionRef.current?.start()
      setIsListening(true)
      setStatus('Listening...')
    } catch (error) {
      setStatus(`Could not start microphone: ${error.message}`)
    }
  }

  const handleStopVoice = () => {
    sessionEnabledRef.current = false
    window.speechSynthesis?.cancel()
    recognitionRef.current?.stop()
    isSpeakingRef.current = false
    setIsSpeaking(false)
    setIsListening(false)
    setStatus('Voice session stopped.')
  }

  return (
    <div className="app" style={styles.container}>
      <h1 style={styles.title}>Voice Assistant</h1>
      <p style={styles.subtitle}>Microphone input plus AI text-to-speech reply.</p>

      <div style={styles.controls}>
        <button
          onClick={handleStartVoice}
          disabled={!speechSupported || !ttsSupported}
          style={styles.primaryButton}
        >
          Start Voice
        </button>
        <button onClick={handleStopVoice} style={styles.secondaryButton}>
          Stop
        </button>
      </div>

      <div style={styles.statusBox}>
        <div>Speech recognition: {speechSupported ? 'available' : 'not supported'}</div>
        <div>Text to speech: {ttsSupported ? 'available' : 'not supported'}</div>
        <div>Voices loaded: {voiceReady ? 'yes' : 'waiting'}</div>
        <div>Listening: {isListening ? 'yes' : 'no'}</div>
        <div>Speaking: {isSpeaking ? 'yes' : 'no'}</div>
        <div>Status: {loading ? 'Thinking...' : status}</div>
      </div>

      <div style={styles.chatBox}>
        {chatMessages.map((msg, index) => (
          <div key={index} style={msg.role === 'user' ? styles.userMessage : styles.aiMessage}>
            <strong>{msg.role === 'user' ? 'You' : 'AI'}:</strong> {msg.content}
          </div>
        ))}
      </div>
    </div>
  )
}

const styles = {
  container: {
    padding: '1.5rem',
    color: '#0f172a',
  },
  title: {
    marginBottom: '0.25rem',
  },
  subtitle: {
    color: '#475569',
    marginTop: 0,
  },
  controls: {
    display: 'flex',
    gap: '0.75rem',
    marginBottom: '1rem',
  },
  primaryButton: {
    padding: '0.75rem 1rem',
    border: 'none',
    borderRadius: '8px',
    backgroundColor: '#2563eb',
    color: '#fff',
    fontWeight: 700,
  },
  secondaryButton: {
    padding: '0.75rem 1rem',
    border: '1px solid #cbd5e1',
    borderRadius: '8px',
    backgroundColor: '#fff',
    color: '#0f172a',
    fontWeight: 700,
  },
  statusBox: {
    padding: '1rem',
    borderRadius: '12px',
    backgroundColor: '#f8fafc',
    border: '1px solid #e2e8f0',
    lineHeight: 1.8,
    marginBottom: '1rem',
  },
  chatBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  userMessage: {
    padding: '0.75rem 1rem',
    borderRadius: '12px',
    backgroundColor: '#dbeafe',
  },
  aiMessage: {
    padding: '0.75rem 1rem',
    borderRadius: '12px',
    backgroundColor: '#ecfeff',
  },
}

export default Voice
