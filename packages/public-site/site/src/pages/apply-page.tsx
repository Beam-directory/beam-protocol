import { SignupForm } from '@/components/signup-form'

export function ApplyPage() {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-medium tracking-tight">Siegel beantragen</h1>
        <p className="text-muted-foreground">
          Der Antrag wird gespeichert. Zahlung und Bestätigungsmail sind bewusst noch nicht angebunden.
        </p>
      </div>
      <SignupForm />
    </div>
  )
}
