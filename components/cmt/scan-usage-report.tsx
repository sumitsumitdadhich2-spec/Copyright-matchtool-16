'use client'

import { useMemo, useState } from 'react'
import {
  Cpu,
  Activity,
  RefreshCw,
  Eye,
  CheckCircle2,
  Layers,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronUp,
  XCircle,
  ShieldCheck,
  ShieldAlert,
} from 'lucide-react'
import type { Scan } from '@/lib/types'
import { computeScanUsage } from '@/lib/scan-usage'
import { displayModelName } from '@/lib/models'

export function ScanUsageReport({ scan }: { scan: Scan }) {
  const usage = useMemo(() => computeScanUsage(scan), [scan])
  const [showDocsInfo, setShowDocsInfo] = useState(false)

  const {
    totalRequests,
    effectiveRequests,
    totalErrors,
    errorBreakdown,
    mainModels,
    byStage,
    byModel,
  } = usage

  const sortedModelKeys = Object.keys(byModel).sort((a, b) => {
    // Keep 3.7, 3.8, 3.6 at top, then others by effective descending
    const rank = (id: string) => (id.includes('3.7') ? 1 : id.includes('3.8') ? 2 : id.includes('3.6') ? 3 : 10)
    const rankDiff = rank(a) - rank(b)
    if (rankDiff !== 0) return rankDiff
    return (byModel[b]?.effective || 0) - (byModel[a]?.effective || 0)
  })

  return (
    <div className="rounded-xl border border-border/80 bg-card p-4 shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Cpu className="size-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              Gemini AI Request & Quota Audit
            </h3>
            <p className="text-xs text-muted-foreground">
              Actual quota usage vs auto-retried error breakdown
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-400">
            <ShieldCheck className="size-3.5" />
            <span>Effective (Kaam Hua): {effectiveRequests} req</span>
          </div>
          {errorBreakdown.prohibitedPolicy > 0 && (
            <div className="flex items-center gap-1.5 rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1 text-xs font-semibold text-purple-400">
              <ShieldAlert className="size-3.5" />
              <span>Prohibited Policy Handled: {errorBreakdown.prohibitedPolicy}</span>
            </div>
          )}
          {totalErrors > 0 && (
            <div className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-400">
              <AlertTriangle className="size-3.5" />
              <span>Errors (No Token Cost): {totalErrors}</span>
            </div>
          )}
        </div>
      </div>

      {/* Top 4 Metric Cards: Real Work vs Policy Handled vs High Demand/429 vs 404 */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Effective Real Work */}
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
              Vastav Me Kaam Hua
            </span>
            <span className="flex size-6 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-300">
              <CheckCircle2 className="size-3.5" />
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-2xl font-bold text-emerald-400">
              {effectiveRequests}
            </span>
            <span className="text-xs font-medium text-emerald-300/80">successful requests</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            In requests ne output generate kiya aur API key se billable tokens / quota deduct hua.
          </p>
        </div>

        {/* Prohibited Policy Handled & Retried */}
        <div className="rounded-xl border border-purple-500/30 bg-purple-500/10 p-3.5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-purple-400">
              Policy Handled & Retried
            </span>
            <span className="flex size-6 items-center justify-center rounded-full bg-purple-500/20 text-purple-300">
              <ShieldAlert className="size-3.5" />
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-2xl font-bold text-purple-400">
              {errorBreakdown.prohibitedPolicy}
            </span>
            <span className="text-xs font-medium text-purple-300/80">policy requests (incl. retry)</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            Google policy par 1 audio-strip sanitized retry hua. Quota bachaane ke liye 1 baar ke baad turant stop hua.
          </p>
        </div>

        {/* High Demand / 429 / Empty Responses (No Cost) */}
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-amber-400">
              High Demand / 429 / Empty
            </span>
            <span className="flex size-6 items-center justify-center rounded-full bg-amber-500/20 text-amber-300">
              <AlertTriangle className="size-3.5" />
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-2xl font-bold text-amber-400">
              {errorBreakdown.highDemandOrRateLimit}
            </span>
            <span className="text-xs font-medium text-amber-300/80">auto-retried attempts</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            Google server 503 load / temporary 429 rate limit. <strong className="text-foreground">Isse API key se koi token cut nahi hota</strong>.
          </p>
        </div>

        {/* 404 / Daily Quota / Other */}
        <div className="rounded-xl border border-border bg-muted/40 p-3.5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              404 & Daily Limit Reached
            </span>
            <span className="flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <XCircle className="size-3.5" />
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-2xl font-bold text-foreground">
              {errorBreakdown.notFound404 + errorBreakdown.dailyExhausted + errorBreakdown.invalidKey}
            </span>
            <span className="text-xs text-muted-foreground">stopped/retired</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            Model 25M daily limit ({errorBreakdown.dailyExhausted}) ya 404 unavailable ({errorBreakdown.notFound404}).
          </p>
        </div>
      </div>

      {/* Google API Billing Rules & Transparency Accordion */}
      <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
        <button
          type="button"
          onClick={() => setShowDocsInfo((prev) => !prev)}
          className="flex w-full items-center justify-between text-left text-xs font-semibold text-primary hover:underline"
        >
          <span className="flex items-center gap-1.5">
            <Info className="size-3.5" />
            <span>Google Gemini API: API Key se kab tokens cut hote hain aur kab nahi?</span>
          </span>
          {showDocsInfo ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>

        {showDocsInfo && (
          <div className="mt-2.5 border-t border-primary/15 pt-2 text-[11px] text-muted-foreground space-y-2 leading-relaxed">
            <div className="rounded-md bg-background/80 p-2.5 border border-border/50">
              <p className="font-semibold text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="size-3" />
                Sach me request / token kab deduct hota hai?
              </p>
              <p className="mt-0.5 text-foreground/90">
                Jab Google Gemini server <strong>HTTP 200 OK</strong> ke sath pura response complete karta hai (Input tokens + Output response tokens). Chahe scene match mile ya na mile, agar model ne visual analysis complete ki to quota use hota hai.
              </p>
            </div>

            <div className="rounded-md bg-background/80 p-2.5 border border-border/50">
              <p className="font-semibold text-purple-400 flex items-center gap-1">
                <ShieldAlert className="size-3" />
                Google Prohibited Content Policy &amp; Sanitized Retry System
              </p>
              <p className="mt-0.5 text-foreground/90 leading-relaxed">
                Jab kisi chunk ya clip me audio/visual safety policy (PROHIBITED_CONTENT) trigger hoti hai, to Google safety filter ke under attempt count hoti hai. Humara system turant clip ka audio strip (-an mute) karke neutral visual forensic prompt ke sath <strong>EXACTLY 1 sanitized retry</strong> karta hai. Dono requests (initial aur retry) key quota aur is audit report me accurately count hoti hain. Agar retry bhi block hoti hai, to <strong>automatic retry turant ruk jaati hai</strong> taaki aapka API keys quota protect rahe aur loop na bane.
              </p>
            </div>

            <div className="rounded-md bg-background/80 p-2.5 border border-border/50">
              <p className="font-semibold text-amber-400 flex items-center gap-1">
                <AlertTriangle className="size-3" />
                Error aane par token ya billing deduct kyu NAHI hota?
              </p>
              <ul className="mt-1 list-disc list-inside space-y-1 text-foreground/90">
                <li>
                  <strong>HTTP 429 (Resource Exhausted)</strong>: Google ne request ko queue me enter hone se pehle hi reject kar diya. Koi output generation nahi hui, isliye 0 tokens charge hote hain.
                </li>
                <li>
                  <strong>HTTP 503 / High Demand / Overloaded</strong>: Google Cloud servers par traffic spike hone par request execute nahi hoti. Koi token deduct nahi hota aur system ise dusre model/lane par auto-retry karta hai.
                </li>
                <li>
                  <strong>HTTP 404 / 500</strong>: Model ya clip unavailable hone par fail hota hai, no token deduction.
                </li>
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* 3 Main Models Summary Cards */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ModelStatCard
          title="3.7-shiva"
          sub="gemini-3.7-flash"
          count={mainModels.gemini37}
          total={effectiveRequests}
          colorClass="text-emerald-500"
          bgClass="bg-emerald-500/10 border-emerald-500/20"
        />
        <ModelStatCard
          title="3.8-shiva"
          sub="gemini-3.8-flash"
          count={mainModels.gemini38}
          total={effectiveRequests}
          colorClass="text-blue-500"
          bgClass="bg-blue-500/10 border-blue-500/20"
        />
        <ModelStatCard
          title="3.6-shiva"
          sub="gemini-3.6-flash"
          count={mainModels.gemini36}
          total={effectiveRequests}
          colorClass="text-purple-500"
          bgClass="bg-purple-500/10 border-purple-500/20"
        />
        <ModelStatCard
          title="Other Models"
          sub="rescan/verify/lite"
          count={mainModels.others}
          total={effectiveRequests}
          colorClass="text-amber-500"
          bgClass="bg-amber-500/10 border-amber-500/20"
        />
      </div>

      {/* Stages / Task Types Totals */}
      <div className="mt-4 rounded-lg border border-border/60 bg-muted/40 p-3">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Effective Tasks Stage Breakdown (Completed Work)
        </h4>
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
          <StageItem
            icon={<Layers className="size-3.5 text-primary" />}
            label="Chunk Mapping"
            count={byStage.chunkScan}
          />
          <StageItem
            icon={<RefreshCw className="size-3.5 text-blue-500" />}
            label="Targeted Rescan"
            count={byStage.rescan}
          />
          <StageItem
            icon={<Eye className="size-3.5 text-emerald-500" />}
            label="24fps Verifier"
            count={byStage.verifier}
          />
          <StageItem
            icon={<Activity className="size-3.5 text-purple-500" />}
            label="Minute Finder"
            count={byStage.minuteFinder}
          />
          <StageItem
            icon={<CheckCircle2 className="size-3.5 text-amber-500" />}
            label="Missing Scene"
            count={byStage.missingScene}
          />
        </div>
      </div>

      {/* Detailed Matrix Table */}
      <div className="mt-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Model × Work & Error Matrix
        </h4>
        <div className="overflow-x-auto rounded-lg border border-border/70">
          <table className="w-full min-w-[620px] text-left text-xs">
            <thead>
              <tr className="border-b border-border/80 bg-muted/60 text-muted-foreground font-medium">
                <th className="px-3 py-2">Model</th>
                <th className="px-2 py-2 text-center text-emerald-400">Effective (Kaam Hua)</th>
                <th className="px-2 py-2 text-center text-purple-400">Policy Blocked &amp; Retried</th>
                <th className="px-2 py-2 text-center text-amber-400">High Demand / 429</th>
                <th className="px-2 py-2 text-center text-muted-foreground">404 / Limits</th>
                <th className="px-2 py-2 text-center">Chunk</th>
                <th className="px-2 py-2 text-center">Rescan</th>
                <th className="px-2 py-2 text-center">Verify</th>
                <th className="px-2 py-2 text-center">Missing</th>
                <th className="px-3 py-2 text-right">Total Attempts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 font-mono">
              {sortedModelKeys.map((modelId) => {
                const data = byModel[modelId]
                if (!data) return null
                const isHighlight = data.total > 0

                return (
                  <tr
                    key={modelId}
                    className={`transition-colors hover:bg-muted/30 ${
                      isHighlight ? 'text-foreground' : 'text-muted-foreground/60'
                    }`}
                  >
                    <td className="px-3 py-2 font-medium font-sans">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-foreground">{displayModelName(modelId)}</span>
                        <span className="text-[10px] text-muted-foreground font-mono">({modelId})</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-center font-bold text-emerald-400 bg-emerald-500/5">
                      {data.effective || '0'}
                    </td>
                    <td className="px-2 py-2 text-center font-medium text-purple-400 bg-purple-500/5">
                      {data.errors.prohibitedPolicy || '—'}
                    </td>
                    <td className="px-2 py-2 text-center font-medium text-amber-400">
                      {data.errors.highDemandOrRateLimit || '—'}
                    </td>
                    <td className="px-2 py-2 text-center text-muted-foreground">
                      {data.errors.notFound404 + data.errors.dailyExhausted || '—'}
                    </td>
                    <td className="px-2 py-2 text-center">{data.chunkScan || '—'}</td>
                    <td className="px-2 py-2 text-center text-blue-400">{data.rescan || '—'}</td>
                    <td className="px-2 py-2 text-center">{data.verifier || '—'}</td>
                    <td className="px-2 py-2 text-center">{data.missingScene || '—'}</td>
                    <td className="px-3 py-2 text-right font-bold text-foreground">{data.total}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-muted/60 font-sans text-xs font-semibold text-foreground">
                <td className="px-3 py-2">Grand Total</td>
                <td className="px-2 py-2 text-center font-mono text-emerald-400 font-bold bg-emerald-500/10">
                  {effectiveRequests}
                </td>
                <td className="px-2 py-2 text-center font-mono text-purple-400 font-bold bg-purple-500/10">
                  {errorBreakdown.prohibitedPolicy || '0'}
                </td>
                <td className="px-2 py-2 text-center font-mono text-amber-400">
                  {errorBreakdown.highDemandOrRateLimit}
                </td>
                <td className="px-2 py-2 text-center font-mono text-muted-foreground">
                  {errorBreakdown.notFound404 + errorBreakdown.dailyExhausted}
                </td>
                <td className="px-2 py-2 text-center font-mono">{byStage.chunkScan}</td>
                <td className="px-2 py-2 text-center font-mono text-blue-400">{byStage.rescan}</td>
                <td className="px-2 py-2 text-center font-mono">{byStage.verifier}</td>
                <td className="px-2 py-2 text-center font-mono">{byStage.missingScene}</td>
                <td className="px-3 py-2 text-right font-mono font-bold text-primary">{totalRequests}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  )
}

function ModelStatCard({
  title,
  sub,
  count,
  total,
  colorClass,
  bgClass,
}: {
  title: string
  sub: string
  count: number
  total: number
  colorClass: string
  bgClass: string
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0

  return (
    <div className={`rounded-xl border p-3 ${bgClass}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-foreground">{title}</span>
        <span className="text-[10px] text-muted-foreground font-mono">{pct}%</span>
      </div>
      <p className="text-[10px] text-muted-foreground truncate">{sub}</p>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className={`text-xl font-bold font-mono ${colorClass}`}>{count}</span>
        <span className="text-[10px] text-muted-foreground">effective</span>
      </div>
    </div>
  )
}

function StageItem({ icon, label, count }: { icon: React.ReactNode; label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/80 px-2.5 py-1.5">
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[10px] text-muted-foreground">{label}</p>
        <p className="font-mono text-xs font-bold text-foreground">{count}</p>
      </div>
    </div>
  )
}
