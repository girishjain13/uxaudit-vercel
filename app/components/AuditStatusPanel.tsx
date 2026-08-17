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
  queued: "Queued…",
  crawling: "Crawling",
  analyzing: "Analyzing results",
  done: "Done",
  failed: "Failed",
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
        // Stop polling once the audit reaches a terminal state.
        if (data.status !== "done" && data.status !== "failed") {
          timer = setTimeout(poll, 3000);
        }
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? err.message : "Failed to check status");
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
    return <p>Loading status…</p>;
  }

  const isActive = audit.status === "queued" || audit.status === "crawling" || audit.status === "analyzing";

  return (
    <div
      style={{
        border: "1px solid #333",
        borderRadius: 8,
        padding: "1.25rem",
        marginTop: "1.5rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        {isActive && <Spinner />}
        <strong>{STATUS_LABEL[audit.status]}</strong>
      </div>
      <p style={{ color: "#666", margin: "0.5rem 0" }}>{audit.startUrl}</p>
      <div style={{ display: "flex", gap: "1.5rem", fontSize: "0.9rem" }}>
        <span>Pages crawled: {audit.pageCount}</span>
        <span>Findings: {audit.findingCount}</span>
      </div>
      {audit.status === "failed" && audit.errorMessage && (
        <p style={{ color: "#c00", marginTop: "0.75rem" }}>Error: {audit.errorMessage}</p>
      )}
      {pollError && <p style={{ color: "#c60", marginTop: "0.75rem" }}>{pollError} — retrying…</p>}
      {(audit.status === "done" || audit.status === "failed") && (
        <button onClick={onReset} style={{ marginTop: "1rem" }}>
          Start another scan
        </button>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 14,
        height: 14,
        border: "2px solid #ccc",
        borderTopColor: "#333",
        borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
      }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}
