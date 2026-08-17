"use client";

import { useState } from "react";
import { AuditStatusPanel } from "./components/AuditStatusPanel";

export default function Home() {
  const [startUrl, setStartUrl] = useState("");
  const [clientName, setClientName] = useState("");
  const [maxPages, setMaxPages] = useState(50);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [activeAuditId, setActiveAuditId] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/audits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startUrl,
          clientName: clientName.trim() || new URL(startUrl).hostname,
          maxPages,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ? JSON.stringify(data.error) : `Request failed (${res.status})`);
      }
      setActiveAuditId(data.auditId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to start scan");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ padding: "2rem", maxWidth: 560, fontFamily: "system-ui, sans-serif" }}>
      <h1>UX Audit Crawler</h1>
      <p style={{ color: "#666" }}>Enter a site to start a crawl and audit.</p>

      {!activeAuditId ? (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <label>
            Website URL
            <input
              type="url"
              required
              placeholder="https://example.com"
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
              style={inputStyle}
            />
          </label>

          <label>
            Client name <span style={{ color: "#999" }}>(optional)</span>
            <input
              type="text"
              placeholder="Acme Corp"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              style={inputStyle}
            />
          </label>

          <label>
            Max pages
            <input
              type="number"
              min={1}
              max={5000}
              value={maxPages}
              onChange={(e) => setMaxPages(Number(e.target.value))}
              style={inputStyle}
            />
          </label>

          <button type="submit" disabled={submitting} style={{ marginTop: "0.5rem", padding: "0.6rem" }}>
            {submitting ? "Starting…" : "Start scan"}
          </button>

          {submitError && <p style={{ color: "#c00" }}>{submitError}</p>}
        </form>
      ) : (
        <AuditStatusPanel auditId={activeAuditId} onReset={() => setActiveAuditId(null)} />
      )}
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "0.5rem",
  marginTop: "0.25rem",
  boxSizing: "border-box",
};

