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
  queued: "QUEUED",
  crawling: "CRAWLING",
  analyzing: "ANALYZING",
  done: "DONE",
  failed: "FAILED",
};

const STATUS_DETAIL: Record<AuditStatus["status"], string> = {
  queued: "Waiting for the run to start…",
  crawling: "Crawling the site page by page…",
  analyzing: "Crawl finished — rolling findings up into the report…",
  done: "Finished — the report is ready below.",
  failed: "The run hit an error.",
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
      <div className="card">
        <span className="small-dim">Connecting…</span>
      </div>
    );
  }

  const isActive = audit.status === "queued" || audit.status === "crawling" || audit.status === "analyzing";
  const isTerminal = audit.status === "done" || audit.status === "failed";
  const badgeClass = audit.status === "done" ? "done" : audit.status === "failed" ? "failed" : "";

  return (
    <div className="card">
      <span className={`badge-status ${badgeClass}`}>{STATUS_LABEL[audit.status]}</span>
      <p className="small-dim" style={{ marginTop: 14 }}>
        {STATUS_DETAIL[audit.status]}
      </p>
      <p className="small-dim" style={{ fontFamily: "var(--font-mono)", marginTop: 4, wordBreak: "break-all" }}>
        {audit.startUrl}
      </p>

      <div className="progress-outer" style={{ marginTop: 16 }}>
        <div
          className={`progress-inner ${isActive ? "indeterminate" : ""}`}
          style={{
            width: isTerminal ? "100%" : undefined,
            background: audit.status === "failed" ? "var(--coral)" : audit.status === "done" ? "var(--sage)" : undefined,
          }}
        />
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="v">{audit.pageCount}</div>
          <div className="l">Pages crawled</div>
        </div>
        <div className="stat">
          <div className="v">{audit.findingCount}</div>
          <div className="l">Findings</div>
        </div>
      </div>

      {audit.status === "failed" && audit.errorMessage && (
        <p className="small-dim" style={{ color: "var(--coral)" }}>
          {audit.errorMessage}
        </p>
      )}
      {pollError && (
        <p className="small-dim" style={{ color: "var(--amber)" }}>
          {pollError} — retrying…
        </p>
      )}

      {isTerminal && (
        <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
          {audit.status === "done" && (
            <>
              <a href={`/report/${auditId}`} className="btn">
                Open Report →
              </a>
              <a href={`/api/audits/${auditId}/export`} className="btn secondary">
                Download Excel →
              </a>
              <a href={`/api/audits/${auditId}/payload`} className="btn secondary">
                Download JSON →
              </a>
            </>
          )}
          <button onClick={onReset} className="btn secondary">
            Start another scan
          </button>
        </div>
      )}
    </div>
  );
}
