import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { directoryGet } from '@/lib/directory-client'
import { agentPath } from '@/lib/example-agent'
import { projectPublicDirectory, type PublicAgentView } from '@/lib/public-agent'
import { REGISTER_AS_OF } from '@/lib/register'

function formatDate(value: string | null): string {
  if (!value) return 'im Profil'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'im Profil'
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(date)
}

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

  useEffect(() => {
    void load(1, '', false)
    // The register opens on the verified listing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild><Link to="/">Register</Link></BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Verzeichnis</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-col gap-2">
        <p className="text-xs tracking-wide text-muted-foreground">Stand: {REGISTER_AS_OF}</p>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Verzeichnis geprüfter Agenten</h1>
        <p className="max-w-3xl text-muted-foreground">
          Öffentliche Firmenagenten mit bestandener Prüfung. Die Tabelle nennt Beam-ID, Status und, soweit die Liste ihn führt, das Prüfdatum. Der Prüfumfang steht im Profil.
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
      {loading && agents === null ? <Skeleton className="h-40 w-full" /> : null}
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      {agents && agents.length === 0 && !loading ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Keine geprüften Firmenagenten</EmptyTitle>
            <EmptyDescription>Die öffentliche Suche hat keinen passenden, gelisteten Firmenagenten geliefert.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {agents && agents.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Beam-ID</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Firma</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Prüfdatum</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agents.map((agent) => (
              <TableRow key={agent.beamId}>
                <TableCell className="whitespace-normal">
                  <Link className="underline underline-offset-4" to={agentPath(agent.beamId)}>{agent.beamId}</Link>
                </TableCell>
                <TableCell className="whitespace-normal">{agent.displayName}</TableCell>
                <TableCell className="whitespace-normal">{agent.legalName ?? agent.org}</TableCell>
                <TableCell><Badge variant="secondary">{agent.tier}</Badge></TableCell>
                <TableCell>{formatDate(agent.verifiedAt)}</TableCell>
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
