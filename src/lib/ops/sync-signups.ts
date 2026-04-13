import type { Op } from "../types";
import { createAirtableClient } from "../integrations/airtable";
import { createSlackClient } from "../integrations/slack";
import { createStrapiClient } from "../integrations/strapi";

export const syncSignups: Op = {
  slug: "sync-signups",
  name: "Sync Signups",
  description: "Fetch new Airtable signups, add to Slack channels, update Strapi",
  schedule: "0 * * * *",

  run: async (ctx) => {
    const airtable = createAirtableClient({
      apiKey: process.env.AIRTABLE_API_KEY!,
      baseId: process.env.AIRTABLE_BASE_ID!,
    });
    const slack = createSlackClient({ botToken: process.env.SLACK_BOT_TOKEN! });
    const strapi = createStrapiClient({
      baseUrl: process.env.STRAPI_URL!,
      token: process.env.STRAPI_TOKEN!,
    });

    ctx.log("Fetching new signups from Airtable...");

    const records = await airtable.listRecords("Signups", {
      filterByFormula: "{Status} = 'New'",
    });

    ctx.log(`Found ${records.length} new signup(s)`);

    if (records.length === 0) {
      return { success: true, summary: "No new signups", recordsProcessed: 0 };
    }

    for (const record of records) {
      const name = record.fields.Name as string;
      const email = record.fields.Email as string;

      ctx.log(`Processing: ${name} (${email})`);

      await slack.postMessage("#new-members", `Welcome ${name} (${email}) to the community!`);
      await strapi.create("members", { name, email, airtableId: record.id });
      await airtable.updateRecords("Signups", [
        { id: record.id, fields: { Status: "Processed" } },
      ]);
    }

    return {
      success: true,
      summary: `Synced ${records.length} new signup(s)`,
      recordsProcessed: records.length,
    };
  },
};
