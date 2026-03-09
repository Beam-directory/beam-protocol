import { FormEvent, useMemo, useState } from 'react'
import { ApiError, directoryApi, type DirectoryAgent } from '../lib/api'
import { toBase64 } from '../lib/utils'

const STORAGE_KEY_PREFIX = 'beam-dashboard-private-key:'

export default function RegisterPage() {
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [capabilities, setCapabilities] = useState('')
  const [description, setDescription] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [result, setResult] = useState<DirectoryAgent | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const capabilityList = useMemo(
    () => capabilities.split(',').map((value) => value.trim()).filter(Boolean),
    [capabilities],
  )

  async function generateKeypair() {
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const [spki, pkcs8] = await Promise.all([
      crypto.subtle.exportKey('spki', keyPair.publicKey),
      crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
    ])

    setPublicKey(toBase64(spki))
    setPrivateKey(toBase64(pkcs8))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    try {
      setLoading(true)
      setError(null)

      let currentPublicKey = publicKey
      let currentPrivateKey = privateKey
      if (!currentPublicKey || !currentPrivateKey) {
        const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
        const [spki, pkcs8] = await Promise.all([
          crypto.subtle.exportKey('spki', keyPair.publicKey),
          crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
        ])
        currentPublicKey = toBase64(spki)
        currentPrivateKey = toBase64(pkcs8)
        setPublicKey(currentPublicKey)
        setPrivateKey(currentPrivateKey)
      }

      const response = await directoryApi.registerAgent({
        display_name: displayName,
        email,
        capabilities: capabilityList,
        description,
        logo_url: logoUrl,
        public_key: currentPublicKey,
      })

      localStorage.setItem(`${STORAGE_KEY_PREFIX}${response.beamId}`, currentPrivateKey)
      localStorage.setItem('beam-dashboard-last-agent', JSON.stringify({ beamId: response.beamId, displayName: response.displayName, email: response.email }))
      setResult(response)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to register agent')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1.2fr,0.8fr]">
      <section className="panel">
        <h1 className="text-2xl font-semibold tracking-tight">Register an agent</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Create an Ed25519 keypair in the browser, store the private key locally, and register directly with the directory API.</p>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name">
              <input className="input-field" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
            </Field>
            <Field label="Email">
              <input className="input-field" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </Field>
          </div>

          <Field label="Capabilities">
            <input
              className="input-field"
              placeholder="chat, retrieval, payment"
              value={capabilities}
              onChange={(event) => setCapabilities(event.target.value)}
              required
            />
          </Field>

          <Field label="Description">
            <textarea className="input-field min-h-28" value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>

          <Field label="Logo URL">
            <input className="input-field" type="url" value={logoUrl} onChange={(event) => setLogoUrl(event.target.value)} />
          </Field>

          <div className="flex flex-col gap-3 sm:flex-row">
            <button className="btn-secondary" type="button" onClick={() => void generateKeypair()}>
              Generate Ed25519 keypair
            </button>
            <button className="btn-primary" type="submit" disabled={loading}>
              {loading ? 'Registering…' : 'Register agent'}
            </button>
          </div>
        </form>
      </section>

      <section className="space-y-4">
        <div className="panel">
          <div className="panel-title">Public key</div>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">The private key is stored only in this browser after a successful registration.</p>
          <textarea className="input-field mt-4 min-h-44 font-mono text-xs" readOnly value={publicKey || 'Generate a keypair to preview the public key.'} />
        </div>

        <div className="panel">
          <div className="panel-title">Registration result</div>
          {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
          {!result ? (
            <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">Complete the form to receive a real Beam-ID from the API.</p>
          ) : (
            <div className="mt-4 space-y-3 text-sm">
              <InfoRow label="Beam-ID" value={result.beamId} />
              <InfoRow label="Public key" value={`${result.publicKey.slice(0, 24)}…`} />
              <InfoRow label="Verification tier" value={result.verificationTier} />
              <div>
                <div className="text-slate-500 dark:text-slate-400">Email verification</div>
                <div className="mt-1 inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                  {result.emailVerified ? 'Verified' : 'Pending verification'}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 break-all font-medium">{value}</div>
    </div>
  )
}
