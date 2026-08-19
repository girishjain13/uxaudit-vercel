"use client";

import { useState } from "react";
import { AuditStatusPanel } from "./components/AuditStatusPanel";

export default function Home() {
  const [startUrl, setStartUrl] = useState("");
  const [clientName, setClientName] = useState("");
  const [maxPages, setMaxPages] = useState(500);
  const [maxDepth, setMaxDepth] = useState(12);
  const [maxConcurrency, setMaxConcurrency] = useState(4);
  const [respectRobots, setRespectRobots] = useState(true);
  const [clientStatedPageCount, setClientStatedPageCount] = useState("");
  const [selectedPersonas, setSelectedPersonas] = useState<string[]>(["ux", "content", "business"]);
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
          maxDepth,
          maxConcurrency,
          respectRobots,
          selectedPersonas,
          ...(clientStatedPageCount ? { clientStatedPageCount: Number(clientStatedPageCount) } : {}),
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
    <>
      <div className="masthead">
        <div className="kicker">Run an Audit</div>
        <h1>UX &amp; Information Architecture Audit</h1>
        <div className="sub">
          Type a URL, run it, and get back a heuristic evaluation — scored, prioritized, and readable in a design
          review.
        </div>
      </div>

      <div className="wrap narrow">
        {!activeAuditId ? (
          <div className="section">
            <div className="card">
              <form onSubmit={handleSubmit}>
                <div className="field">
                  <label className="field-label">Audit as</label>
                  <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
                    {(
                      [
                        { id: "ux", label: "UX Lead" },
                        { id: "content", label: "Content Strategist" },
                        { id: "business", label: "Business Analyst" },
                      ] as const
                    ).map((role) => (
                      <label key={role.id} className="checkline">
                        <input
                          type="checkbox"
                          checked={selectedPersonas.includes(role.id)}
                          onChange={(e) => {
                            setSelectedPersonas((prev) =>
                              e.target.checked ? [...prev, role.id] : prev.filter((p) => p !== role.id),
                            );
                          }}
                        />
                        {role.label}
                      </label>
                    ))}
                  </div>
                  {selectedPersonas.length === 0 && (
                    <p className="small-dim" style={{ color: "var(--coral)", marginTop: 6 }}>
                      Select at least one role.
                    </p>
                  )}
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="start_url">
                    Target URL
                  </label>
                  <input
                    id="start_url"
                    type="url"
                    required
                    placeholder="https://example.com"
                    value={startUrl}
                    onChange={(e) => setStartUrl(e.target.value)}
                  />
                </div>

                <details style={{ marginBottom: 18 }}>
                  <summary>Advanced options</summary>
                  <div className="field-row" style={{ marginTop: 14 }}>
                    <div className="field">
                      <label className="field-label" htmlFor="max_pages">
                        Max Pages (cap 5000)
                      </label>
                      <input
                        id="max_pages"
                        type="number"
                        min={1}
                        max={5000}
                        value={maxPages}
                        onChange={(e) => setMaxPages(Number(e.target.value))}
                      />
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor="max_depth">
                        Max Crawl Depth
                      </label>
                      <input
                        id="max_depth"
                        type="number"
                        min={1}
                        max={50}
                        value={maxDepth}
                        onChange={(e) => setMaxDepth(Number(e.target.value))}
                      />
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor="concurrency">
                        Concurrency
                      </label>
                      <input
                        id="concurrency"
                        type="number"
                        min={1}
                        max={20}
                        value={maxConcurrency}
                        onChange={(e) => setMaxConcurrency(Number(e.target.value))}
                      />
                    </div>
                  </div>

                  <div className="field-row" style={{ gridTemplateColumns: "1fr" }}>
                    <label className="checkline">
                      <input type="checkbox" checked={respectRobots} onChange={(e) => setRespectRobots(e.target.checked)} />
                      Respect robots.txt
                    </label>
                  </div>

                  <div className="field" style={{ marginTop: 10 }}>
                    <label className="field-label" htmlFor="client_name">
                      Client name — optional
                    </label>
                    <input
                      id="client_name"
                      type="text"
                      placeholder="Derived from the URL if left blank"
                      value={clientName}
                      onChange={(e) => setClientName(e.target.value)}
                    />
                  </div>

                  <div className="field" style={{ marginTop: 10 }}>
                    <label className="field-label" htmlFor="client_stated_page_count">
                      Client-stated page count — optional
                    </label>
                    <input
                      id="client_stated_page_count"
                      type="number"
                      placeholder="e.g. 500"
                      value={clientStatedPageCount}
                      onChange={(e) => setClientStatedPageCount(e.target.value)}
                    />
                    <p className="small-dim" style={{ marginTop: 6 }}>
                      If the client told you roughly how many pages the site has, enter it here for a variance
                      reference against what's actually crawled.
                    </p>
                  </div>
                </details>

                <button type="submit" disabled={submitting || selectedPersonas.length === 0} className="btn">
                  {submitting ? "Starting…" : "Run Audit →"}
                </button>
                {submitError && <div className="small-dim" style={{ color: "var(--coral)", marginTop: 10 }}>{submitError}</div>}
              </form>
            </div>
          </div>
        ) : (
          <div className="section">
            <div className="section-head">
              <h2>Run status</h2>
            </div>
            <AuditStatusPanel auditId={activeAuditId} onReset={() => setActiveAuditId(null)} />
          </div>
        )}
      </div>
    </>
  );
}
