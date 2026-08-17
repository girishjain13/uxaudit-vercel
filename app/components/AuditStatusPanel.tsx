"use client";

import { useEffect, useState } from "react";

type AuditStatus = {
  id: string;
  clientName: string;
  startUrl: string;
  status: "queued" | "crawling" | "analyzing" | "done" | "failed";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  pageCount: number;
  findingCount: number;
};

const STATUS_LABEL: Record<AuditStatus["status"], string> = {
  queued: "Queued",
  crawling: "Crawling",
  analyzing: "Analyzing",
  done: "Done",
  failed: "Failed",
};

const STATUS_BADGE_CLASS: Record<AuditStatus["status"], string> = {
  queued: "status-badge status-badge--amber",
  crawling: "status-badge status-badge--amber",
  analyzing: "status-badge status-badge--amber",
  done: "status-badge status-badge--teal",
  failed: "status-badge status-badge--coral",
};

export function AuditStatusPanel({ auditId, onReset }: { auditId: string; onReset: () => void }) {
  const [audit, setAudit] = useState<AuditStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch(`/api/audits/${auditId}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Status check failed (${res.status})`);
        const data: AuditStatus = await res.json();
        if (cancelled) return;
        setAudit(data);
        setPollError(null);
        if (data.status !== "done" && data.status !== "failed") {
          timer = setTimeout(poll, 3000);
        }
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? err.message : "Could not reach the server.");
        timer = setTimeout(poll, 5000);
      }
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [auditId]);

  if (!audit) {
    return (
      <div className="panel" style={{ padding: "1.75rem" }}>
        <span className="eyebrow">Connecting…</span>
      </div>
    );
  }

  const isActive = audit.status === "queued" || audit.status === "crawling" || audit.status === "analyzing";
  const isTerminal = audit.status === "done" || audit.status === "failed";

  return (
    <div className="panel" style={{ padding: "1.75rem" }}>
      {/* Signature element: a scan-line track. Sweeps amber while a scan
          is active, settles into a solid teal or coral bar on completion. */}
      <div className="scan-line-track" style={{ marginBottom: "1.25rem" }}>
        {isActive && <div className="scan-line-track__sweep" />}
        {isTerminal && (
          <div
            className="scan-line-track__fill"
            style={{ background: audit.status === "done" ? "var(--signal-teal)" : "var(--signal-coral)" }}
          />
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.35rem" }}>
        <span className={STATUS_BADGE_CLASS[audit.status]}>{STATUS_LABEL[audit.status]}</span>
      </div>

      <p
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.85rem",
          color: "var(--paper-dim)",
          margin: "0.5rem 0 1.5rem",
          wordBreak: "break-all",
        }}
      >
        {audit.startUrl}
      </p>

      <div style={{ display: "flex", gap: "2rem", marginBottom: audit.errorMessage || pollError ? "1.25rem" : 0 }}>
        <div className="stat">
          <span className="stat-value">{audit.pageCount}</span>
          <span className="stat-label">Pages crawled</span>
        </div>
        <div className="stat">
          <span className="stat-value">{audit.findingCount}</span>
          <span className="stat-label">Findings</span>
        </div>
      </div>

      {audit.status === "failed" && audit.errorMessage && (
        <p style={{ color: "var(--signal-coral)", fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
          {audit.errorMessage}
        </p>
      )}
      {pollError && (
        <p style={{ color: "var(--signal-amber)", fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>
          {pollError} — retrying…
        </p>
      )}

      {isTerminal && (
        <button onClick={onReset} className="btn-secondary" style={{ marginTop: "1.5rem" }}>
          Start another scan
        </button>
      )}
    </div>
  );
}
