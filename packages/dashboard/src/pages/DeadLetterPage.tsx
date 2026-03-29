import { useEffect, useMemo, useState } from 'react'
import { ApiError, busApi, getBusBaseUrl, type DeadLetterMessage } from '../lib/api'
import { EmptyPanel, MetricCard, PageHeader, StatusPill } from '../components/Observability'
import { formatDateTime, formatNumber } from '../lib/utils'

function formatBusTimestamp(value?: number | null): string {
  if (value == null) {
    return '—'
  }

  return formatDateTime(new Date(value * 1000).toISOString())
}

function previewPayload(payload: Record<string, unknown>): string {
  const serialized = JSON.stringify(payload)
  if (serialized.length <= 120) {
    return serialized
  }

  return `${serialized.slice(0, 117)}…`
}

export default function DeadLetterPage() {
  const [messages, setMessages] = useState<DeadLetterMessage[]>([])
  const [count, setCount] = useState(0)
  const [limit, setLimit] = useState(100)
  const [sender, setSender] = useState('')
  const [recipient, setRecipient] = useState('')
  const [intent, setIntent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [requeueingId, setRequeueingId] = useState<string | null>(null)

  async function load() {
    try {
      setLoading(true)
      const response = await busApi.listDeadLetters({
        sender: sender.trim() || undefined,
        recipient: recipient.trim() || undefined,
        intent: intent.trim() || undefined,
        limit,
      })
      setMessages(response.messages)
      setCount(response.count)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load dead-letter messages')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [limit, sender, recipient, intent])

  const summary = useMemo(() => {
    const uniqueSenders = new Set(messages.map((message) => message.sender)).size
    const uniqueRecipients = new Set(messages.map((message) => message.recipient)).size
    const maxRetryCount = messages.reduce((max, message) => Math.max(max, message.retry_count), 0)

    return {
      uniqueSenders,
      uniqueRecipients,
      maxRetryCount,
    }
  }, [messages])

  async function handleRequeue(messageId: string) {
    try {
      setRequeueingId(messageId)
      const response = await busApi.requeueDeadLetter(messageId)
      setStatus(`Requeued ${response.nonce} as ${response.status}.`)
      await load()
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : 'Failed to requeue dead-letter message')
    } finally {
      setRequeueingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dead Letters"
        description={`Terminal message-bus failures from ${getBusBaseUrl()}. Operators can inspect and requeue stable nonces here.`}
        actions={(
          <button className="btn-secondary" onClick={() => void load()} type="button">
            Refresh
          </button>
        )}
      />

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {status ? (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          {status}
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Dead letters" value={loading ? '—' : formatNumber(count)} tone={count > 0 ? 'critical' : 'default'} />
        <MetricCard label="Unique senders" value={loading ? '—' : formatNumber(summary.uniqueSenders)} />
        <MetricCard label="Unique recipients" value={loading ? '—' : formatNumber(summary.uniqueRecipients)} />
        <MetricCard label="Max retry count" value={loading ? '—' : formatNumber(summary.maxRetryCount)} />
      </section>

      <section className="panel space-y-4">
        <div className="panel-title">Filters</div>
        <div className="grid gap-3 md:grid-cols-4">
          <input
            className="input-field"
            placeholder="Sender beam ID"
            type="text"
            value={sender}
            onChange={(event) => setSender(event.target.value)}
          />
          <input
            className="input-field"
            placeholder="Recipient beam ID"
            type="text"
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
          />
          <input
            className="input-field"
            placeholder="Intent type"
            type="text"
            value={intent}
            onChange={(event) => setIntent(event.target.value)}
          />
          <select className="input-field" value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
            <option value={25}>25 rows</option>
            <option value={50}>50 rows</option>
            <option value={100}>100 rows</option>
            <option value={250}>250 rows</option>
          </select>
        </div>
      </section>

      <section className="panel overflow-hidden p-0">
        <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="panel-title">Terminal Failures</div>
        </div>

        {loading ? (
          <div className="p-5">
            <EmptyPanel label="Loading dead-letter queue…" />
          </div>
        ) : messages.length === 0 ? (
          <div className="p-5">
            <EmptyPanel label="No dead-lettered messages match the current filters." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-950">
                <tr>
                  <th className="table-head">Nonce</th>
                  <th className="table-head">Route</th>
                  <th className="table-head">Intent</th>
                  <th className="table-head">Retries</th>
                  <th className="table-head">Error</th>
                  <th className="table-head">Failed</th>
                  <th className="table-head">Payload</th>
                  <th className="table-head">Action</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((message) => (
                  <tr key={message.id} className="border-t border-slate-200 align-top dark:border-slate-800">
                    <td className="table-cell font-mono text-xs">{message.nonce}</td>
                    <td className="table-cell">
                      <div className="font-medium">{message.sender}</div>
                      <div className="text-slate-500 dark:text-slate-400">{message.recipient}</div>
                    </td>
                    <td className="table-cell">
                      <div className="font-medium">{message.intent}</div>
                      <div className="mt-2">
                        <StatusPill label={message.status.replace('_', ' ')} tone="critical" />
                      </div>
                    </td>
                    <td className="table-cell">{message.retry_count} / {message.max_retries}</td>
                    <td className="table-cell">{message.error ?? '—'}</td>
                    <td className="table-cell">
                      <div>{formatBusTimestamp(message.failed_at)}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">Created {formatBusTimestamp(message.created_at)}</div>
                    </td>
                    <td className="table-cell font-mono text-xs text-slate-500 dark:text-slate-400">{previewPayload(message.payload)}</td>
                    <td className="table-cell">
                      <button
                        className="btn-secondary"
                        disabled={requeueingId === message.id}
                        onClick={() => void handleRequeue(message.id)}
                        type="button"
                      >
                        {requeueingId === message.id ? 'Requeueing…' : 'Requeue'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
