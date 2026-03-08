import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'

export default function AuthCallbackPage() {
  const [searchParams] = useSearchParams()
  const { verify } = useAuth()
  const navigate = useNavigate()
  const [error, setError] = useState('')

  useEffect(() => {
    const token = searchParams.get('token')
    if (!token) {
      setError('No token found in URL')
      return
    }

    verify(token).then(success => {
      if (success) {
        navigate('/', { replace: true })
      } else {
        setError('Invalid or expired magic link. Please request a new one.')
      }
    })
  }, [searchParams, verify, navigate])

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
        maxWidth: '400px',
        width: '100%',
        textAlign: 'center',
      }}>
        {error ? (
          <>
            <div style={{ fontSize: '3rem', marginBottom: '16px' }}>❌</div>
            <h2 style={{ fontSize: '1.2rem', marginBottom: '8px' }}>Login Failed</h2>
            <p style={{ color: '#52525B', fontSize: '0.9rem', marginBottom: '20px' }}>{error}</p>
            <a href="/login" style={{
              display: 'inline-block',
              padding: '12px 24px',
              background: '#F75C03',
              color: 'white',
              borderRadius: '10px',
              textDecoration: 'none',
              fontWeight: 600,
              fontSize: '0.9rem',
            }}>
              Try Again →
            </a>
          </>
        ) : (
          <>
            <div style={{
              width: '32px',
              height: '32px',
              border: '3px solid #E4E4E7',
              borderTopColor: '#F75C03',
              borderRadius: '50%',
              animation: 'spin 0.6s linear infinite',
              margin: '0 auto 16px',
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <p style={{ color: '#52525B', fontSize: '0.9rem' }}>Verifying your magic link...</p>
          </>
        )}
      </div>
    </div>
  )
}
