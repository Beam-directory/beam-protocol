import { AgentCheck } from '@/components/agent-check'

export function VerifyPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col px-4 py-14 sm:px-6 sm:py-20">
      <AgentCheck variant="page" />
    </div>
  )
}
