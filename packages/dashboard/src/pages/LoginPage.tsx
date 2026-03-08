import { useState } from 'react'
import { useAuth } from '../lib/auth'

export default function LoginPage() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [devUrl, setDevUrl] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    
    try {
      const result = await login(email)
      if (result.ok) {
        setSent(true)
        if ((result as any).url) {
          setDevUrl((result as any).url)
        }
      } else {
        setError(result.error || 'Something went wrong')
      }
    } catch (err) {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#FAFAFA',
      padding: '24px',
    }}>
      <div style={{
        background: 'white',
        borderRadius: '20px',
        border: '1px solid #E4E4E7',
        boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
        padding: '40px',
        maxWidth: '420px',
        width: '100%',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: '1.3rem', fontWeight: 800, marginBottom: '8px' }}>
          📡 beam<span style={{ color: '#F75C03' }}>.directory</span>
        </div>
        
        {!sent ? (
          <>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '8px' }}>
              Welcome Back
            </h1>
            <p style={{ color: '#52525B', fontSize: '0.9rem', marginBottom: '24px' }}>
              Sign in to manage your agents.
            </p>

            <form onSubmit={handleSubmit}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                style={{
                  width: '100%',
                  padding: '14px 16px',
                  borderRadius: '10px',
                  border: '1.5px solid #E4E4E7',
                  fontSize: '0.95rem',
                  fontFamily: 'inherit',
                  outline: 'none',
                  marginBottom: '12px',
                  boxSizing: 'border-box',
                }}
              />
              
              {error && (
                <div style={{
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: '8px',
                  padding: '10px',
                  color: '#EF4444',
                  fontSize: '0.85rem',
                  marginBottom: '12px',
                }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !email}
                style={{
                  width: '100%',
                  padding: '14px',
                  borderRadius: '10px',
                  background: '#F75C03',
                  color: 'white',
                  border: 'none',
                  fontSize: '0.95rem',
                  fontWeight: 600,
                  cursor: loading ? 'wait' : 'pointer',
                  opacity: loading || !email ? 0.5 : 1,
                  fontFamily: 'inherit',
                }}
              >
                {loading ? 'Sending...' : 'Send Magic Link ✨'}
              </button>
            </form>

            <p style={{ marginTop: '24px', fontSize: '0.82rem', color: '#A1A1AA' }}>
              We'll send a login link to your email.<br />
              No password needed.
            </p>
          </>
        ) : (
          <>
            <div style={{ fontSize: '3rem', marginBottom: '16px' }}>✉️</div>
            <h1 style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: '8px' }}>
              Check Your Email
            </h1>
            <p style={{ color: '#52525B', fontSize: '0.9rem', marginBottom: '20px' }}>
              We sent a magic link to<br />
              <strong>{email}</strong>
            </p>
            <p style={{ color: '#A1A1AA', fontSize: '0.82rem' }}>
              Didn't receive it? Check spam or{' '}
              <button
                onClick={() => { setSent(false); setDevUrl('') }}
                style={{ color: '#F75C03', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', textDecoration: 'underline' }}
              >
                try again
              </button>
            </p>

            {devUrl && (
              <div style={{
                marginTop: '20px',
                padding: '12px',
                background: '#FFF7ED',
                border: '1px solid #FDBA74',
                borderRadius: '8px',
                fontSize: '0.82rem',
              }}>
                <strong>🔧 Dev Mode</strong><br />
                <a href={devUrl} style={{ color: '#F75C03', wordBreak: 'break-all' }}>
                  Click to login →
                </a>
              </div>
            )}
          </>
        )}

        <div style={{ marginTop: '32px', borderTop: '1px solid #E4E4E7', paddingTop: '16px' }}>
          <p style={{ fontSize: '0.82rem', color: '#A1A1AA' }}>
            Don't have an agent yet?{' '}
            <a href="https://beam.directory/register.html" style={{ color: '#F75C03' }}>
              Register one →
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}
