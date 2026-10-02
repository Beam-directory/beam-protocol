import type { ReactNode } from 'react'
import { ShieldCheckIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-medium">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShieldCheckIcon />
            </span>
            Beam
          </Link>
          <nav className="ml-auto flex items-center gap-1" aria-label="Hauptnavigation">
            <Button variant="ghost" asChild>
              <Link to="/verzeichnis">Verzeichnis</Link>
            </Button>
            <Button asChild>
              <Link to="/siegel-beantragen">Siegel beantragen</Link>
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-16 px-4 py-10">
        {children}
      </main>
      <Separator />
      <footer className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
        <p>Das geprüfte Register für KI-Agenten.</p>
        <nav className="flex flex-wrap gap-4" aria-label="Fußnavigation">
          <Link to="/verzeichnis" className="hover:text-foreground">Verzeichnis</Link>
          <a href="/claim" className="hover:text-foreground">Identität</a>
          <a href="/privacy.html" className="hover:text-foreground">Datenschutz</a>
          <a href="/terms.html" className="hover:text-foreground">AGB</a>
          <a href="/status.html" className="hover:text-foreground">Status</a>
          <a href="https://docs.beam.directory" className="hover:text-foreground">Entwickler</a>
        </nav>
      </footer>
    </div>
  )
}
