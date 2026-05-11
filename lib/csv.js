import { readFileSync } from "fs";
import { parse } from "csv-parse/sync";

export function readCsv(filePath, options = {}) {
  const raw = readFileSync(filePath, "utf-8");
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    ...options,
  });
}
