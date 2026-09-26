'use client'

import { AuthGate } from '@/components/auth/auth-gate'
import { Dashboard } from '@/components/cmt/dashboard'

export default function Page() {
  return (
    <main>
      <AuthGate>
        <Dashboard />
      </AuthGate>
    </main>
  )
}
