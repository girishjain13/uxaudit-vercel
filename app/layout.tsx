export const metadata = {
  title: "UX Audit Crawler",
  description: "Website audit crawler — API-only, no UI yet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>{children}</body>
    </html>
  );
}
