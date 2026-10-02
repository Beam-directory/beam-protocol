import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { directoryGet } from '@/lib/directory-client'
import { agentPath } from '@/lib/example-agent'
import { projectPublicDirectory, type PublicAgentView } from '@/lib/public-agent'

export function DirectoryPage() {
  const [query, setQuery] = useState('')
  const [agents, setAgents] = useState<PublicAgentView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)

  async function load(nextPage: number, nextQuery: string, append: boolean) {
    setLoading(true)
    setError(null)
    try {
      const path = nextQuery.trim()
        ? `/agents/search?q=${encodeURIComponent(nextQuery.trim())}&limit=50`
        : `/agents/browse?verified_only=true&page=${nextPage}&limit=20`
      const payload = await directoryGet(path)
      const visible = projectPublicDirectory(payload)
      setAgents((current) => append && current ? [...current, ...visible] : visible)
      setPage(nextPage)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Das Verzeichnis ist gerade nicht erreichbar.')
      if (!append) setAgents([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-medium tracking-tight">Geprüfte Agenten</h1>
        <p className="max-w-2xl text-muted-foreground">
          Nur öffentliche Firmen-Agenten mit bestandener Prüfung. Private und nicht gelistete Identitäten sowie E-Mail-Adressen bleiben außen vor.
        </p>
      </div>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          void load(1, query, false)
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name, Firma oder Fähigkeit"
          aria-label="Verzeichnis durchsuchen"
        />
        <Button type="submit" disabled={loading}>Suchen</Button>
      </form>
      {agents === null && !loading ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Noch keine Abfrage</EmptyTitle>
            <EmptyDescription>Suche starten oder das geprüfte Verzeichnis laden.</EmptyDescription>
          </EmptyHeader>
          <Button type="button" variant="outline" onClick={() => void load(1, '', false)}>Verzeichnis laden</Button>
        </Empty>
      ) : null}
      {loading && agents === null ? <Skeleton className="h-40 w-full" /> : null}
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      {agents && agents.length === 0 && !loading ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Keine geprüften Firmen-Agenten</EmptyTitle>
            <EmptyDescription>Die öffentliche Suche hat keinen passenden, gelisteten Firmen-Agenten geliefert.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {agents && agents.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Firma</TableHead>
              <TableHead>Stufe</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agents.map((agent) => (
              <TableRow key={agent.beamId}>
                <TableCell>
                  <Link className="underline underline-offset-4" to={agentPath(agent.beamId)}>{agent.displayName}</Link>
                  <div className="text-muted-foreground">{agent.beamId}</div>
                </TableCell>
                <TableCell>{agent.legalName ?? agent.org}</TableCell>
                <TableCell><Badge variant="secondary">{agent.tier}</Badge></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {agents && agents.length > 0 && !query.trim() ? (
        <Button variant="outline" disabled={loading} onClick={() => void load(page + 1, '', true)}>
          Weitere laden
        </Button>
      ) : null}
    </div>
  )
}
