import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { audits } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  done: "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed: "bg-rose-50 text-rose-700 border-rose-200",
  crawling: "bg-amber-50 text-amber-700 border-amber-200",
  analyzing: "bg-amber-50 text-amber-700 border-amber-200",
  queued: "bg-slate-50 text-slate-600 border-slate-200",
};

export default async function AuditsListPage() {
  const all = await db.select().from(audits).orderBy(desc(audits.createdAt)).limit(100);

  return (
    <main className="min-h-screen bg-[#f8fafc] px-6 py-10 text-slate-900" style={{ fontFamily: "var(--font-sans)" }}>
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-1 text-2xl font-semibold">Past Audits</h1>
        <p className="mb-6 text-sm text-slate-500">
          Every scan run from this app, most recent first. Only the last 100 are shown.
        </p>

        {all.length === 0 ? (
          <p className="text-sm text-slate-500">No audits yet — start one from the home page.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-3">Site</th>
                  <th className="px-4 py-3">Client</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Started</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {all.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100 last:border-none">
                    <td className="max-w-xs truncate px-4 py-3 font-mono text-xs text-slate-600">{a.startUrl}</td>
                    <td className="px-4 py-3 text-slate-700">{a.clientName}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[a.status] ?? STATUS_STYLES.queued}`}>
                        {a.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{a.createdAt ? new Date(a.createdAt).toLocaleString() : "—"}</td>
                    <td className="px-4 py-3 text-right">
                      {a.status === "done" ? (
                        <a href={`/report/${a.id}`} className="text-xs font-medium text-slate-700 hover:underline">
                          Open Report →
                        </a>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
