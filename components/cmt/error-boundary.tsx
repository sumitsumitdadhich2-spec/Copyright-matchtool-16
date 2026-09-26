'use client'

import React, { Component, type ReactNode } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'

interface Props {
  children: ReactNode
  fallbackTitle?: string
  fallbackMessage?: string
  onReset?: () => void
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
  }

  reset = () => {
    this.setState({ hasError: false, error: null })
    if (this.props.onReset) {
      this.props.onReset()
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-destructive shadow-sm">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 size-5 shrink-0" />
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold">
                {this.props.fallbackTitle || 'Component render error'}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground break-words">
                {this.state.error?.message || this.props.fallbackMessage || 'An unexpected error occurred in this view.'}
              </p>
              <button
                type="button"
                onClick={this.reset}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/15 px-3 py-1 text-xs font-semibold text-destructive hover:bg-destructive/25 transition-colors cursor-pointer"
              >
                <RefreshCw className="size-3" />
                Retry
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
