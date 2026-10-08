import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { SealBadge } from '@/components/seal-badge'
import { Badge } from '@/components/ui/badge'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { directoryApiBase, directoryGet } from '@/lib/directory-client'
import { fingerprintPublicKey, projectPublicAgent, sealSnippet, type PublicAgentDecision, type PublicAgentView } from '@/lib/public-agent'
import { REGISTER_AS_OF } from '@/lib/register'

const reasons: Record<Exclude<PublicAgentDecision, { ok: true }>['reason'], string> = {
  invalid: 'Diese Kennung ist kein öffentlicher Agenteneintrag.',
  'not-public': 'Dieser Agent ist nicht im öffentlichen Register.',
  personal: 'Private Identitäten werden nicht angezeigt.',
  'email-present': 'Der Eintrag enthält Kontaktdaten und wird deshalb nicht angezeigt.',
  unverified: 'Dieser Agent ist nicht geprüft.',
}

function scopeOf(agent: PublicAgentView): string {
  const parts = ['öffentlicher Firmenagent']
  if (agent.domainVerified) parts.push('Domain per DNS')
  if (agent.legalName) parts.push('Firma nach Registerprüfung')
  return parts.join(', ')
}

function formatDate(value: string | null): string {
  if (!value) return 'nicht angegeben'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'nicht angegeben'
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'long' }).format(date)
}

export function AgentPage() {
  const params = useParams()
  const beamId = params.beamId ? decodeURIComponent(params.beamId) : ''
  const [decision, setDecision] = useState<PublicAgentDecision | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function verify() {
    if (!beamId) {
      setDecision({ ok: false, reason: 'invalid' })
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const encoded = encodeURIComponent(beamId)
      const agent = await directoryGet(`/agents/${encoded}`)
      const [business, domain] = await Promise.all([
        directoryGet(`/agents/${encoded}/business-status`).catch(() => null),
        directoryGet(`/agents/${encoded}/domain-status`).catch(() => null),
      ])
      const next = projectPublicAgent(agent, { business, domain })
      setDecision(next)
      setCheckedAt(new Date().toISOString())
      if (next.ok && next.agent.publicKey) {
        setFingerprint(await fingerprintPublicKey(next.agent.publicKey))
      } else {
        setFingerprint(null)
      }
    } catch (verifyError) {
      setDecision({ ok: false, reason: 'invalid' })
      setError(verifyError instanceof Error ? verifyError.message : 'Die Prüfung ist fehlgeschlagen.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Deferred so the effect body sets no state synchronously.
    queueMicrotask(() => void verify())
    // beamId is the only input that should reload the public record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beamId])

  if (loading && !decision) {
    return <Skeleton className="h-64 w-full" />
  }

  if (!decision?.ok) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Kein öffentlicher Eintrag</EmptyTitle>
          <EmptyDescription>{decision ? reasons[decision.reason] : 'Der Agent ist nicht verfügbar.'}</EmptyDescription>
        </EmptyHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button asChild variant="outline"><Link to="/verzeichnis">Zum Verzeichnis</Link></Button>
      </Empty>
    )
  }

  const agent = decision.agent
  const snippet = sealSnippet(window.location.origin, directoryApiBase(), agent.beamId)

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild><Link to="/">Register</Link></BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild><Link to="/verzeichnis">Verzeichnis</Link></BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{agent.displayName}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-col gap-2">
        <p className="text-xs tracking-wide text-muted-foreground">Stand der Abfrage: {checkedAt ? formatDate(checkedAt) : REGISTER_AS_OF}</p>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">{agent.displayName}</h1>
          {agent.verified ? <SealBadge label={agent.tier} /> : <Badge variant="outline">nicht geprüft</Badge>}
        </div>
        <p className="text-muted-foreground">{agent.beamId}</p>
      </div>
      <Tabs defaultValue="seal">
        <TabsList>
          <TabsTrigger value="seal">Siegel</TabsTrigger>
          <TabsTrigger value="check">Prüfen</TabsTrigger>
          <TabsTrigger value="embed">Einbetten</TabsTrigger>
        </TabsList>
        <TabsContent value="seal">
          <Card>
            <CardHeader>
              <CardTitle>{agent.legalName ?? agent.org}</CardTitle>
              <CardDescription>Öffentlicher Prüfstatus ohne Kontaktdaten.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Feld</TableHead>
                    <TableHead>Angabe</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>Beam-ID</TableCell>
                    <TableCell className="whitespace-normal">{agent.beamId}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Status</TableCell>
                    <TableCell>{agent.verified ? agent.tier : 'nicht geprüft'}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Prüfdatum</TableCell>
                    <TableCell>{formatDate(agent.verifiedAt)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Prüfumfang</TableCell>
                    <TableCell className="whitespace-normal">{scopeOf(agent)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Firma</TableCell>
                    <TableCell className="whitespace-normal">{agent.legalName ?? agent.org}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Registernummer</TableCell>
                    <TableCell>{agent.registrationNumber ?? 'nicht öffentlich'}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Land</TableCell>
                    <TableCell>{agent.country ?? 'nicht öffentlich'}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Domain</TableCell>
                    <TableCell>{agent.domainVerified ? agent.domain : 'nicht verifiziert'}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>DID</TableCell>
                    <TableCell className="whitespace-normal">{agent.did}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Schlüssel</TableCell>
                    <TableCell>{agent.keyStatus === 'active' ? 'aktiv' : agent.keyStatus === 'revoked' ? 'widerrufen' : 'unbekannt'}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Fingerabdruck</TableCell>
                    <TableCell className="whitespace-normal">{fingerprint ?? 'nicht verfügbar'}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="check">
          <Card>
            <CardHeader>
              <CardTitle>Diesen Agenten prüfen</CardTitle>
              <CardDescription>
                {checkedAt ? `Zuletzt abgefragt ${formatDate(checkedAt)}.` : 'Noch nicht geprüft.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">Die Abfrage nutzt das öffentliche Verzeichnis und zeigt keine E-Mail.</p>
              <ul className="flex flex-col gap-1 text-sm">
                <li>Öffentlich gelistet</li>
                <li>Firma: {agent.legalName ?? agent.org}</li>
                <li>Domain: {agent.domainVerified ? 'verifiziert' : 'nicht verifiziert'}</li>
                <li>Stufe: {agent.tier}</li>
                <li>E-Mail-Adresse: nicht angezeigt</li>
              </ul>
              <Button type="button" onClick={() => void verify()} disabled={loading}>
                {loading ? 'Wird geprüft' : 'Diesen Agenten prüfen'}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="embed">
          <Card>
            <CardHeader>
              <CardTitle>Siegel einbetten</CardTitle>
              <CardDescription>SVG vom Verzeichnis, nur für geprüfte öffentliche Firmen-Agenten.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {agent.verified ? (
                <img src={snippet.svgUrl} width={360} height={96} alt={`Beam Siegel für ${agent.displayName}`} />
              ) : (
                <p className="text-sm text-muted-foreground">Ohne bestandene Prüfung gibt es kein Siegel zum Einbetten.</p>
              )}
              <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">{snippet.html}</pre>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
