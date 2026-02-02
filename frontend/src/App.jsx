import { useState, useEffect } from 'react'
import './App.css'

function App() {
  const [count, setCount] = useState(0)
  const [recognition, setRecognition] = useState(null)
  const [loading, setLoading] = useState(false)
  const [chatMessages, setChatMessages] = useState([])

  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition

      const rec = new SpeechRecognition()
      rec.continuous = true
      rec.interimResults = false
      rec.lang = 'en-US'

      rec.onresult = (event) => {
        const transcript = event.results[event.results.length - 1][0].transcript.toLowerCase()
        console.log('Heard:', transcript)
        handleUserMessage(transcript)
      }

      rec.onend = () => {
        // Restart listening if it stops
        if (recognition) {
          recognition.start()
        }
      }

      rec.onerror = (event) => {
        console.error('Speech recognition error:', event.error)
        // Try to restart
        setTimeout(() => {
          if (recognition) {
            recognition.start()
          }
        }, 1000)
      }

      setRecognition(rec)
      rec.start()
    } else {
      alert('Speech Recognition not supported.')
    }
  }, [])

  const handleUserMessage = async (text) => {
    console.log('User said:', text)
    setLoading(true)

    // Stop listening while processing
    if (recognition) {
      recognition.stop()
    }

    // Add user message
    setChatMessages(prev => [...prev, { role: 'user', content: text }])

    try {
      const response = await fetch('http://localhost:5000/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...chatMessages, { role: 'user', content: text }]
        })
      })

      const data = await response.json()
      const assistantMessage = data?.choices?.[0]?.message

      if (!assistantMessage) throw new Error('Invalid response')

      // Add assistant message
      setChatMessages(prev => [...prev, assistantMessage])

      setLoading(false)

      // Stop previous speech
      window.speechSynthesis.cancel()

      const utterance = new SpeechSynthesisUtterance(
        assistantMessage.content
      )
      utterance.rate = 0.95
      utterance.pitch = 1.1

      utterance.onend = () => {
        // Restart listening after speaking
        if (recognition) {
          recognition.start()
        }
      }

      window.speechSynthesis.speak(utterance)

    } catch (err) {
      console.error(err)
      setLoading(false)
      // Speak error
      const utterance = new SpeechSynthesisUtterance('Something went wrong')
      utterance.onend = () => {
        if (recognition) {
          recognition.start()
        }
      }
      window.speechSynthesis.speak(utterance)
    }
  }

  return (
    <div className="app">
      <h1>🎧 Voice Assistant</h1>
      <p>Always listening... Speak to chat with the AI</p>
      {loading && <p>Thinking...</p>}
      <div className="chat-messages">
        {chatMessages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <strong>{msg.role === 'user' ? 'You' : 'AI'}:</strong> {msg.content}
          </div>
        ))}
      </div>
    </div>
  )
}

export default App