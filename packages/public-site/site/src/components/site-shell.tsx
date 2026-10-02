import type { ReactNode } from 'react'
import { ShieldCheckIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { CONTACT_EMAIL, REGISTER_AS_OF } from '@/lib/register'

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-sm bg-primary text-primary-foreground">
              <ShieldCheckIcon className="size-4" />
            </span>
            <span className="flex flex-col leading-none">
              <span className="font-heading text-base font-semibold">Beam</span>
              <span className="text-[11px] tracking-wide text-muted-foreground">Register</span>
            </span>
          </Link>
          <nav className="ml-auto flex flex-wrap items-center justify-end gap-1" aria-label="Hauptnavigation">
            <Button variant="ghost" asChild>
              <Link to="/verzeichnis">Verzeichnis</Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link to="/pruefrichtlinien">Prüfrichtlinien</Link>
            </Button>
            <Button asChild>
              <Link to="/siegel-beantragen">Siegel beantragen</Link>
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-8">
        {children}
      </main>
      <Separator />
      <footer className="border-t bg-card">
        <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-8 text-sm md:grid-cols-[1.2fr_1fr]">
          <div className="flex flex-col gap-2">
            <p className="font-heading text-base text-foreground">Das geprüfte Register für KI-Agenten.</p>
            <p className="max-w-md text-muted-foreground">
              Privates Register von Beam. Keine Behörde und kein Zeichen der Europäischen Union.
            </p>
            <p className="text-muted-foreground">Stand: {REGISTER_AS_OF}</p>
          </div>
          <nav className="flex flex-col gap-2" aria-label="Fußnavigation">
            <Link className="hover:text-foreground" to="/impressum">Impressum</Link>
            <a className="hover:text-foreground" href="/privacy.html">Datenschutz</a>
            <a className="hover:text-foreground" href="/terms.html">AGB</a>
            <Link className="hover:text-foreground" to="/pruefrichtlinien">Prüfrichtlinien</Link>
            <a className="hover:text-foreground" href={`mailto:${CONTACT_EMAIL}`}>Kontakt</a>
            <a className="hover:text-foreground" href="/status.html">Status</a>
            <a className="hover:text-foreground" href="https://docs.beam.directory">Entwickler</a>
          </nav>
        </div>
      </footer>
    </div>
  )
}
