import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const login = useAuthStore((s) => s.login)
  const navigate = useNavigate()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      await login(username, password)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-surface rounded-xl p-8 shadow-lg shadow-black/30"
      >
        {/* Title */}
        <div className="flex flex-col items-center mb-8">
          <img
            src="/fungal_horror.png"
            alt="Mycelium"
            className="w-20 h-20 rounded-xl object-cover mb-3"
            style={{ filter: 'drop-shadow(0 0 12px rgba(212,168,71,0.3))' }}
          />
          <h1 className="font-mono text-accent text-2xl tracking-widest font-bold">
            MYCELIUM
          </h1>
          <p className="text-text-dim text-sm mt-1.5">
            Distributed Development Hub
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 px-3 py-2 rounded-sm bg-red/10 border border-red/20 text-red text-sm">
            {error}
          </div>
        )}

        {/* Username */}
        <label className="block mb-4">
          <span className="text-text-dim text-xs font-semibold uppercase tracking-wider mb-1.5 block">
            Username
          </span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
            autoComplete="username"
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-text text-sm placeholder:text-text-muted focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20 transition-colors"
            placeholder="Enter username"
          />
        </label>

        {/* Password */}
        <label className="block mb-6">
          <span className="text-text-dim text-xs font-semibold uppercase tracking-wider mb-1.5 block">
            Password
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-text text-sm placeholder:text-text-muted focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20 transition-colors"
            placeholder="Enter password"
          />
        </label>

        {/* Submit */}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-accent text-bg rounded py-2.5 font-semibold text-sm hover:bg-accent-light focus:outline-none focus:ring-2 focus:ring-accent/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Connecting...' : 'Enter Mycelium'}
        </button>
      </form>
    </div>
  )
}
