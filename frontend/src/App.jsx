import { useState, useEffect } from 'react'
import './App.css'

function App() {
  const [recognition, setRecognition] = useState(null)
  const [loading, setLoading] = useState(false)

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
        if (transcript.includes('doubt') || transcript.includes('i have a doubt')) {
          // Extract the question part, remove the trigger
          let question = transcript.replace(/i have a doubt|doubt/gi, '').trim()
          if (!question) question = transcript // if nothing left, use full
          handleUserMessage(question)
        }
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

    try {
      const response = await fetch('http://localhost:5000/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: text }]
        })
      })

      const data = await response.json()
      const assistantMessage = data?.choices?.[0]?.message

      if (!assistantMessage) throw new Error('Invalid response')

      setLoading(false)

      // Stop previous speech
      window.speechSynthesis.cancel()

      const utterance = new SpeechSynthesisUtterance(
        assistantMessage.content
      )
      utterance.rate = 0.95
      utterance.pitch = 1.1
      window.speechSynthesis.speak(utterance)

    } catch (err) {
      console.error(err)
      setLoading(false)
      // Speak error
      const utterance = new SpeechSynthesisUtterance('Something went wrong')
      window.speechSynthesis.speak(utterance)
    }
  }

  return (
    <div className="app">
      <h1>🎧 Voice Assistant</h1>
      <p>Always listening... Say "I have a doubt" or "doubt" to ask a question</p>
      {loading && <p>Thinking...</p>}
    </div>
  )
}

export default App
