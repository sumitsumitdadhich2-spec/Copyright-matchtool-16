'use client'

import { useEffect, useRef } from 'react'
import { X, Settings } from 'lucide-react'
import { ApiKeyPanel } from './api-key-panel'
import { EngineBadge } from './engine-badge'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/40 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={(e) => {
        if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
      }}
    >
      <div
        ref={panelRef}
        className="panel flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden !p-0 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Settings className="size-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold">Settings — API Keys</h2>
          <EngineBadge className="ml-2 hidden sm:inline-flex" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="btn-press ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          <ApiKeyPanel />
        </div>
      </div>
    </div>
  )
}
