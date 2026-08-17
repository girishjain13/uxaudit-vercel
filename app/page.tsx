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
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) {
        throw new Error(
          data?.error ? JSON.stringify(data.error) : `Scan could not start (${res.status}). Check the server logs.`,
        );
      }
      setActiveAuditId(data.auditId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Scan could not start.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "4rem 1.5rem",
      }}
    >
      <div style={{ width: "100%", maxWidth: 520 }}>
        <div style={{ marginBottom: "2rem" }}>
          <div className="eyebrow" style={{ marginBottom: "0.5rem" }}>
            Site Audit / New Scan
          </div>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1.9rem",
              fontWeight: 600,
              margin: 0,
              letterSpacing: "-0.01em",
            }}
          >
            Audit a site
          </h1>
        </div>

        {!activeAuditId ? (
          <form
            onSubmit={handleSubmit}
            className="panel"
            style={{ padding: "1.75rem", display: "flex", flexDirection: "column", gap: "1.25rem" }}
          >
            <div className="field">
              <label className="eyebrow" htmlFor="startUrl">
                Website URL
              </label>
              <input
                id="startUrl"
                type="url"
                required
                placeholder="https://example.com"
                value={startUrl}
                onChange={(e) => setStartUrl(e.target.value)}
                className="field-input"
              />
            </div>

            <div className="field">
              <label className="eyebrow" htmlFor="clientName">
                Client name — optional
              </label>
              <input
                id="clientName"
                type="text"
                placeholder="Derived from the URL if left blank"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                className="field-input"
              />
            </div>

            <div className="field">
              <label className="eyebrow" htmlFor="maxPages">
                Max pages
              </label>
              <input
                id="maxPages"
                type="number"
                min={1}
                max={5000}
                value={maxPages}
                onChange={(e) => setMaxPages(Number(e.target.value))}
                className="field-input"
                style={{ maxWidth: 140 }}
              />
            </div>

            <button type="submit" disabled={submitting} className="btn-primary" style={{ marginTop: "0.5rem" }}>
              {submitting ? "Starting scan…" : "Start scan"}
            </button>

            {submitError && (
              <p
                style={{
                  color: "var(--signal-coral)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.85rem",
                  margin: 0,
                }}
              >
                {submitError}
              </p>
            )}
          </form>
        ) : (
          <AuditStatusPanel auditId={activeAuditId} onReset={() => setActiveAuditId(null)} />
        )}
      </div>
    </main>
  );
}
