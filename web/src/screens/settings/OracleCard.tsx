import { Check, CircleAlert, TriangleAlert, X } from 'lucide-react'
import type { OracleCost, OracleMeter, OracleReclaimRisk, OracleUsageSnapshot } from '../../api/serverStatus'
import { formatBytes } from '../../offline/storage'

const CARD = 'rounded-card border border-line bg-surface p-4'
const CODE = 'rounded bg-raised px-1.5 py-0.5 font-mono text-xs'
const WARNING_USAGE_RATIO = 0.9

function formatCount(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

function formatPercentValue(value: number | null): string {
  if (value === null) return 'Unavailable'
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}%`
}

function formatCost(cost: OracleCost): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cost.currency }).format(cost.amount)
  } catch {
    return `${cost.amount.toFixed(2)} ${cost.currency}`
  }
}

function meterPercent(meter: OracleMeter): number {
  if (meter.limit <= 0) return 0
  return Math.max(0, Math.min(100, (meter.used / meter.limit) * 100))
}

function isNearLimit(meter: OracleMeter): boolean {
  return meter.limit > 0 && meter.used / meter.limit >= WARNING_USAGE_RATIO
}

function oracleHeaderBadge(oracle: OracleUsageSnapshot): { label: string; tone: string; Icon: typeof Check } {
  if (oracle.state === 'off') return { label: 'Not set up', tone: 'text-muted', Icon: CircleAlert }
  if (oracle.state === 'error') return { label: 'Error', tone: 'text-danger', Icon: X }
  if (oracle.warnings.length > 0) return { label: 'Warning', tone: 'text-warning', Icon: TriangleAlert }
  return { label: 'OK', tone: 'text-success', Icon: Check }
}

function reclaimBadge(risk: OracleReclaimRisk): { label: string; tone: string; Icon: typeof Check } {
  if (risk.status === 'at_risk') return { label: 'At risk', tone: 'text-warning', Icon: TriangleAlert }
  if (risk.status === 'unknown') return { label: 'Unknown', tone: 'text-muted', Icon: CircleAlert }
  return { label: 'OK', tone: 'text-success', Icon: Check }
}

function UsageMeter({
  label,
  value,
  detail,
  percent,
  warn,
}: {
  label: string
  value: string
  detail: string
  percent: number
  warn: boolean
}) {
  return (
    <div className="rounded-control border border-line bg-canvas p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium">{label}</h4>
        <span className={`text-sm font-semibold tabular-nums ${warn ? 'text-warning' : ''}`}>{value}</span>
      </div>
      <div
        role="meter"
        aria-label={`${label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="mt-2 h-2 overflow-hidden rounded-full bg-raised"
      >
        <div
          className={`h-full rounded-full transition-[width] ${warn ? 'bg-warning' : 'bg-accent-ink'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className={`mt-1.5 text-xs ${warn ? 'text-warning' : 'text-muted'}`}>{detail}</p>
    </div>
  )
}

function OracleSetupSteps() {
  return (
    <div className="mt-3 space-y-3">
      <p className="text-sm text-muted">
        Optional. Add a read-only Oracle Cloud user to watch Always Free limits, monthly cost, and 7-day reclaim risk.
      </p>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          In the Oracle Cloud Console, create a dedicated user in its own group with read-only (
          <code className={CODE}>inspect</code> or <code className={CODE}>read</code>) policies in the tenancy for
          compartments, instances, volumes, backups, limits, metrics, and usage reports — never{' '}
          <code className={CODE}>manage</code> or <code className={CODE}>use</code> permissions.
        </li>
        <li>
          Create an API signing key pair for that user and save the private key PEM at{' '}
          <code className={CODE}>data/config/oci_api_key.pem</code> on the host (mounted at{' '}
          <code className={CODE}>/config/oci_api_key.pem</code>).
        </li>
        <li>
          Add <code className={CODE}>PYTHIA_OCI_TENANCY</code>, <code className={CODE}>PYTHIA_OCI_USER</code>,{' '}
          <code className={CODE}>PYTHIA_OCI_FINGERPRINT</code>, <code className={CODE}>PYTHIA_OCI_REGION</code>, and{' '}
          <code className={CODE}>PYTHIA_OCI_KEY_FILE=/config/oci_api_key.pem</code> to <code className={CODE}>.env</code>{' '}
          on the host.
        </li>
        <li>Recreate the app container so the new configuration loads, then press Refresh.</li>
      </ol>
    </div>
  )
}

/** Settings › Server, Oracle Cloud plan card (R21, T83). */
export function OracleCard({ oracle }: { oracle: OracleUsageSnapshot }) {
  const badge = oracleHeaderBadge(oracle)
  const BadgeIcon = badge.Icon
  const usage = oracle.usage

  return (
    <section className={`space-y-3 ${CARD}`} aria-labelledby="oracle-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="oracle-heading" className="text-base font-semibold">
            Oracle Cloud plan
          </h3>
          {oracle.asOf === null ? null : (
            <p className="mt-0.5 text-xs text-muted">
              As of <time dateTime={oracle.asOf}>{new Date(oracle.asOf).toLocaleString()}</time>
            </p>
          )}
        </div>
        <span className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 text-sm font-medium ${badge.tone}`}>
          <BadgeIcon aria-hidden="true" className="size-4" />
          {badge.label}
        </span>
      </div>

      {oracle.state === 'off' ? (
        <OracleSetupSteps />
      ) : (
        <>
          {oracle.state === 'error' ? (
            <p
              role={usage === null ? 'alert' : 'status'}
              className={
                usage === null
                  ? 'rounded-control border border-danger/30 bg-canvas px-3 py-2 text-sm text-danger'
                  : 'rounded-control border border-warning/40 bg-canvas px-3 py-2 text-sm text-warning'
              }
            >
              Couldn’t refresh Oracle usage{oracle.error ? ` (${oracle.error})` : ''}.
              {usage === null ? '' : ' Showing the last good values.'}
            </p>
          ) : null}

          {usage === null ? (
            oracle.state === 'ok' ? (
              <p role="status" className="text-sm text-muted">
                Oracle Cloud usage refreshes every 15 minutes. Waiting for the first reading…
              </p>
            ) : null
          ) : (
            <>
              <p className="text-xs text-muted">
                Whole tenancy usage against Always Free limits. Refreshes every 15 minutes.
              </p>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <UsageMeter
                  label="Ampere A1 OCPUs"
                  value={`${formatCount(usage.a1Ocpus.used)} / ${formatCount(usage.a1Ocpus.limit)}`}
                  percent={meterPercent(usage.a1Ocpus)}
                  warn={oracle.warnings.includes('a1_ocpus_high') || isNearLimit(usage.a1Ocpus)}
                  detail={`${Math.round(meterPercent(usage.a1Ocpus))}% of ${formatCount(usage.a1Ocpus.limit)} OCPUs`}
                />
                <UsageMeter
                  label="A1 memory"
                  value={`${formatCount(usage.a1MemoryGb.used)} / ${formatCount(usage.a1MemoryGb.limit)} GB`}
                  percent={meterPercent(usage.a1MemoryGb)}
                  warn={oracle.warnings.includes('a1_memory_high') || isNearLimit(usage.a1MemoryGb)}
                  detail={`${Math.round(meterPercent(usage.a1MemoryGb))}% of ${formatCount(usage.a1MemoryGb.limit)} GB`}
                />
                <UsageMeter
                  label="Block storage"
                  value={`${formatCount(usage.blockStorageGb.used)} / ${formatCount(usage.blockStorageGb.limit)} GB`}
                  percent={meterPercent(usage.blockStorageGb)}
                  warn={oracle.warnings.includes('block_storage_high') || isNearLimit(usage.blockStorageGb)}
                  detail={`${Math.round(meterPercent(usage.blockStorageGb))}% of ${formatCount(usage.blockStorageGb.limit)} GB`}
                />
                <UsageMeter
                  label="Volume backups"
                  value={`${formatCount(usage.volumeBackups.used)} / ${formatCount(usage.volumeBackups.limit)}`}
                  percent={meterPercent(usage.volumeBackups)}
                  warn={oracle.warnings.includes('volume_backups_high') || isNearLimit(usage.volumeBackups)}
                  detail={`${Math.round(meterPercent(usage.volumeBackups))}% of ${formatCount(usage.volumeBackups.limit)} backups`}
                />
                <UsageMeter
                  label="Outbound data"
                  value={`${formatBytes(usage.outboundDataBytes.used)} / ${formatBytes(usage.outboundDataBytes.limit)}`}
                  percent={meterPercent(usage.outboundDataBytes)}
                  warn={oracle.warnings.includes('outbound_data_high') || isNearLimit(usage.outboundDataBytes)}
                  detail={`${Math.round(meterPercent(usage.outboundDataBytes))}% of ${formatBytes(usage.outboundDataBytes.limit)} this month`}
                />
                <div className="rounded-control border border-line bg-canvas p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <h4 className="text-sm font-medium">Cost this month</h4>
                    <span
                      className={`text-sm font-semibold tabular-nums ${
                        oracle.warnings.includes('cost_above_zero') || usage.costThisMonth.amount > 0
                          ? 'text-warning'
                          : ''
                      }`}
                    >
                      {formatCost(usage.costThisMonth)}
                    </span>
                  </div>
                  <p
                    className={`mt-2 text-xs ${
                      oracle.warnings.includes('cost_above_zero') || usage.costThisMonth.amount > 0
                        ? 'text-warning'
                        : 'text-muted'
                    }`}
                  >
                    {usage.costThisMonth.amount > 0 ? 'Above $0 on Always Free' : 'Expected $0 on Always Free'}
                  </p>
                </div>
              </div>

              <div className="border-t border-line pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold">7-day reclaim risk</h4>
                  {(() => {
                    const risk = reclaimBadge(usage.reclaimRisk)
                    const RiskIcon = risk.Icon
                    return (
                      <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${risk.tone}`}>
                        <RiskIcon aria-hidden="true" className="size-4" />
                        {risk.label}
                      </span>
                    )
                  })()}
                </div>
                <p className="mt-1 text-xs text-muted">
                  {usage.reclaimRisk.status === 'at_risk'
                    ? 'All 7-day values are under 20%, so Oracle may reclaim an idle Always Free instance.'
                    : 'Oracle may reclaim an Always Free instance when 7-day CPU 95th percentile, network, and (A1 only) memory are all under 20%.'}
                </p>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
                  <div className="rounded-control border border-line bg-canvas p-3">
                    <dt className="text-xs text-muted">CPU (95th percentile)</dt>
                    <dd className="mt-0.5 font-semibold tabular-nums">
                      {formatPercentValue(usage.reclaimRisk.cpuP95Percent)}
                    </dd>
                  </div>
                  <div className="rounded-control border border-line bg-canvas p-3">
                    <dt className="text-xs text-muted">Network</dt>
                    <dd className="mt-0.5 font-semibold tabular-nums">
                      {formatPercentValue(usage.reclaimRisk.networkPercent)}
                    </dd>
                  </div>
                  <div className="rounded-control border border-line bg-canvas p-3">
                    <dt className="text-xs text-muted">Memory</dt>
                    <dd className="mt-0.5 font-semibold tabular-nums">
                      {usage.reclaimRisk.hasA1Instance || usage.reclaimRisk.memoryPercent !== null
                        ? formatPercentValue(usage.reclaimRisk.memoryPercent)
                        : 'N/A (non-A1)'}
                    </dd>
                  </div>
                </dl>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
