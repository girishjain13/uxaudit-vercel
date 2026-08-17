export default function Home() {
  return (
    <main style={{ padding: "2rem", maxWidth: 640 }}>
      <h1>UX Audit Crawler</h1>
      <p>
        This deployment is API-only — there's no dashboard UI yet. The crawler
        is reachable through these endpoints:
      </p>
      <ul>
        <li>
          <code>POST /api/audits</code> — create a new audit and start crawling
        </li>
        <li>
          <code>GET /api/audits</code> — list all audits
        </li>
        <li>
          <code>POST /api/crawl/page</code> — internal, called by QStash per page
        </li>
        <li>
          <code>POST /api/analyze/[auditId]</code> — internal, called by QStash
          once a crawl finishes
        </li>
      </ul>
      <p>
        To start an audit, POST to <code>/api/audits</code> with a JSON body
        like:
      </p>
      <pre
        style={{
          background: "#111",
          color: "#eee",
          padding: "1rem",
          borderRadius: 6,
          overflowX: "auto",
        }}
      >
{`{
  "clientName": "Acme Corp",
  "startUrl": "https://example.com",
  "maxPages": 50
}`}
      </pre>
    </main>
  );
}
