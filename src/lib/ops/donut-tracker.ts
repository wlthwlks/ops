import type { Op } from "../types";
import { createSlackClient } from "../integrations/slack";
import { createStrapiClient } from "../integrations/strapi";
import { createAirtableClient } from "../integrations/airtable";

function extractPairings(messages: Array<{ text: string; ts: string }>): Array<{ person1: string; person2: string; ts: string }> {
  const pairings: Array<{ person1: string; person2: string; ts: string }> = [];
  for (const msg of messages) {
    const match = msg.text.match(/Paired:\s*(.+?)\s+and\s+(.+)/i);
    if (match) {
      pairings.push({ person1: match[1].trim(), person2: match[2].trim(), ts: msg.ts });
    }
  }
  return pairings;
}

export const donutTracker: Op = {
  slug: "donut-tracker",
  name: "Donut Tracker",
  description: "Read Donut channel history, extract pairing data, push to Strapi/Airtable",
  schedule: "0 9 * * 1",

  run: async (ctx) => {
    const slack = createSlackClient({ botToken: process.env.SLACK_BOT_TOKEN! });
    const strapi = createStrapiClient({ baseUrl: process.env.STRAPI_URL!, token: process.env.STRAPI_TOKEN! });
    const airtable = createAirtableClient({ apiKey: process.env.AIRTABLE_API_KEY!, baseId: process.env.AIRTABLE_BASE_ID! });

    const donutChannel = process.env.SLACK_DONUT_CHANNEL || "donut-pairings";
    ctx.log(`Fetching Donut channel history from #${donutChannel}...`);

    const messages = await slack.getChannelHistory(donutChannel, { limit: 200 });
    ctx.log(`Fetched ${messages.length} messages`);

    const pairings = extractPairings(messages);
    ctx.log(`Found ${pairings.length} pairing(s)`);

    if (pairings.length === 0) {
      return { success: true, summary: "No new pairings found", recordsProcessed: 0 };
    }

    for (const pairing of pairings) {
      ctx.log(`Recording pairing: ${pairing.person1} <> ${pairing.person2}`);
      await strapi.create("donut-pairings", {
        person1: pairing.person1,
        person2: pairing.person2,
        pairedAt: new Date(parseFloat(pairing.ts) * 1000).toISOString(),
      });
      await airtable.createRecords("Donut Pairings", [{
        fields: {
          Person1: pairing.person1,
          Person2: pairing.person2,
          "Paired At": new Date(parseFloat(pairing.ts) * 1000).toISOString(),
        },
      }]);
    }

    return {
      success: true,
      summary: `Tracked ${pairings.length} donut pairing(s)`,
      recordsProcessed: pairings.length,
    };
  },
};
