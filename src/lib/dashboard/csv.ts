// src/lib/dashboard/csv.ts
//
// Tiny CSV helpers for the dashboard's export buttons. Zero deps.

function escapeCell(value: unknown): string {
  if (value == null) return "";
  const s =
    typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(
  rows: Array<Record<string, unknown>>,
  columns?: string[],
): string {
  if (rows.length === 0) return "";
  const cols =
    columns ??
    Array.from(
      rows.reduce((acc, r) => {
        for (const k of Object.keys(r)) acc.add(k);
        return acc;
      }, new Set<string>()),
    );
  const header = cols.map(escapeCell).join(",");
  const body = rows
    .map((r) => cols.map((c) => escapeCell(r[c])).join(","))
    .join("\n");
  return header + "\n" + body;
}

export function downloadCsv(filename: string, csv: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
