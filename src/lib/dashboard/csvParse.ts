// src/lib/dashboard/csvParse.ts
//
// Minimal CSV parser for the bulk-invite flow. Zero deps.
// Handles quoted cells with embedded commas + escaped quotes.
// Header row is required; missing columns return null entries.

export interface CsvRow {
  [key: string]: string;
}

/** Parse a CSV string. First row = headers (trimmed + lowercased). */
export function parseCsv(text: string): CsvRow[] {
  const lines = splitLines(text);
  if (lines.length === 0) return [];
  const headers = parseLine(lines[0]).map((h) => h.trim().toLowerCase());
  const out: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue; // skip blank rows
    const cells = parseLine(line);
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cells[j] ?? "").trim();
    }
    out.push(row);
  }
  return out;
}

function splitLines(text: string): string[] {
  // Handles CRLF / CR / LF.
  return text.split(/\r\n|\r|\n/);
}

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1; // escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === ",") {
        out.push(cur);
        cur = "";
      } else if (c === '"' && cur === "") {
        inQuotes = true;
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}
