import { useState, useCallback, useRef, useEffect } from 'react'
import { Mic, MicOff, Volume2 } from 'lucide-react'
import { apiPost } from '../../api/client'

// ─── Types ──────────────────────────────────────────────────────────────────

interface CommandResult {
  action: string
  response: string
}

// ─── Web Speech API types ───────────────────────────────────────────────────

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList
  resultIndex: number
}

interface SpeechRecognitionResultList {
  length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionResult {
  isFinal: boolean
  length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognition
    webkitSpeechRecognition?: new () => SpeechRecognition
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function VoiceCommand() {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [response, setResponse] = useState('')
  const [processing, setProcessing] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [supported, setSupported] = useState(true)
  const recognitionRef = useRef<SpeechRecognition | null>(null)

  // Check browser support
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) setSupported(false)
  }, [])

  // Send command to server
  const processCommand = useCallback(async (text: string) => {
    setProcessing(true)
    try {
      const result = await apiPost<CommandResult>('/voice/command', { text })
      setResponse(result.response)

      // TTS response
      if ('speechSynthesis' in window && result.response) {
        const utterance = new SpeechSynthesisUtterance(result.response)
        utterance.rate = 1.1
        utterance.pitch = 0.9
        utterance.onstart = () => setSpeaking(true)
        utterance.onend = () => setSpeaking(false)
        speechSynthesis.speak(utterance)
      }
    } catch (err) {
      setResponse('Error processing command')
    }
    setProcessing(false)
  }, [])

  // Start listening
  const startListening = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return

    const recognition = new SR()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let final = ''
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          final += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }
      if (final) {
        setTranscript(final)
        processCommand(final)
      } else {
        setTranscript(interim)
      }
    }

    recognition.onend = () => {
      setListening(false)
      recognitionRef.current = null
    }

    recognition.onerror = (event: { error: string }) => {
      if (event.error !== 'no-speech') {
        console.error('[voice] Recognition error:', event.error)
      }
      setListening(false)
    }

    recognitionRef.current = recognition
    recognition.start()
    setListening(true)
    setTranscript('')
    setResponse('')
  }, [processCommand])

  // Stop listening
  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
    }
    setListening(false)
  }, [])

  if (!supported) return null

  return (
    <div className="flex items-center gap-2">
      {/* Mic button */}
      <button
        onClick={listening ? stopListening : startListening}
        disabled={processing}
        className={[
          'flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-200',
          listening
            ? 'bg-red/20 text-red animate-pulse ring-2 ring-red/30'
            : speaking
              ? 'bg-accent/20 text-accent'
              : 'bg-surface-raised text-text-muted hover:text-accent hover:bg-accent/10',
          processing ? 'opacity-50 cursor-wait' : '',
        ].join(' ')}
        title={listening ? 'Stop listening' : 'Hey Mycelium (voice command)'}
      >
        {speaking ? (
          <Volume2 size={14} strokeWidth={1.5} />
        ) : listening ? (
          <Mic size={14} strokeWidth={1.5} />
        ) : (
          <MicOff size={14} strokeWidth={1.5} />
        )}
      </button>

      {/* Transcript / Response overlay */}
      {(transcript || response) && (
        <div className="text-xs text-text-dim max-w-xs truncate">
          {processing ? (
            <span className="text-text-muted">Processing...</span>
          ) : response ? (
            <span>{response}</span>
          ) : transcript ? (
            <span className="text-text-muted italic">{transcript}</span>
          ) : null}
        </div>
      )}
    </div>
  )
}
