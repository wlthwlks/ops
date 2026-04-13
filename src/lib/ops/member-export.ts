import type { Op } from "../types";
import { createAirtableClient } from "../integrations/airtable";
import fs from "fs";
import path from "path";

function toCsv(records: Array<{ fields: Record<string, unknown> }>, columns: string[]): string {
  const header = columns.join(",");
  const rows = records.map((r) =>
    columns.map((col) => {
      const val = String(r.fields[col] ?? "");
      if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    }).join(",")
  );
  return [header, ...rows].join("\n");
}

export const memberExport: Op = {
  slug: "member-export",
  name: "Member Export",
  description: "Export member list from Airtable to downloadable CSV",

  run: async (ctx) => {
    const airtable = createAirtableClient({
      apiKey: process.env.AIRTABLE_API_KEY!,
      baseId: process.env.AIRTABLE_BASE_ID!,
    });

    ctx.log("Fetching all members from Airtable...");
    const records = await airtable.listRecords("Members");
    ctx.log(`Fetched ${records.length} member(s)`);

    if (records.length === 0) {
      return { success: true, summary: "No members to export", recordsProcessed: 0 };
    }

    const allFields = new Set<string>();
    for (const r of records) {
      Object.keys(r.fields).forEach((k) => allFields.add(k));
    }
    const columns = Array.from(allFields).sort();

    const csv = toCsv(records, columns);

    const exportDir = path.join(process.cwd(), "data", "exports");
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const filename = `members-${new Date().toISOString().slice(0, 10)}.csv`;
    const filepath = path.join(exportDir, filename);
    fs.writeFileSync(filepath, csv, "utf-8");

    ctx.log(`Exported to ${filepath}`);

    return {
      success: true,
      summary: `Exported ${records.length} member(s) to ${filename}`,
      recordsProcessed: records.length,
    };
  },
};
