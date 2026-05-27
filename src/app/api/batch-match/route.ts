import { NextRequest, NextResponse } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createPineconeClient } from "@/lib/integrations/pinecone";
import { CITIES } from "@/lib/constants";

export const maxDuration = 300;

/**
 * GET /api/batch-match?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *
 * Fetches new members (active+paid) added within the date range,
 * then for each one that exists in Pinecone, returns their top 10 matches.
 * Results are grouped by city.
 */
export async function GET(request: NextRequest) {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const pineconeKey = process.env.PINECONE_API_KEY;
  const pineconeIndex = process.env.PINECONE_INDEX_NAME;

  if (!token || !baseId) {
    return NextResponse.json({ success: false, error: "Missing Airtable credentials" }, { status: 500 });
  }
  if (!pineconeKey || !pineconeIndex) {
    return NextResponse.json({ success: false, error: "Missing Pinecone credentials" }, { status: 500 });
  }

  const startDate = request.nextUrl.searchParams.get("startDate");
  const endDate = request.nextUrl.searchParams.get("endDate");

  if (!startDate || !endDate) {
    return NextResponse.json({ success: false, error: "startDate and endDate are required" }, { status: 400 });
  }

  const airtable = createAirtableClient({ apiKey: token, baseId });
  const pinecone = createPineconeClient({ apiKey: pineconeKey, indexName: pineconeIndex });

  // Date filter — same logic as get-daily-new-customers
  const dateFilter =
    startDate === endDate
      ? `IS_SAME(CREATED_TIME(), "${startDate}", "day")`
      : `AND(IS_AFTER(CREATED_TIME(), DATEADD("${startDate}", -1, "days")), IS_BEFORE(CREATED_TIME(), DATEADD("${endDate}", 1, "days")))`;

  const formula = `AND({Membership} = "Active", {Payment} = "Paid", ${dateFilter})`;

  const records = await airtable.listRecords("Members", {
    filterByFormula: formula,
    sort: [{ field: "Date joined", direction: "desc" }],
  });

  // Group by city
  interface NewMember {
    id: string;
    name: string;
    email: string;
    city: string;
    postcode: string;
    industry: string;
    traction: string;
    dateAdded: string;
    inPinecone: boolean;
    profile: {
      nearbyLocation: string;
      availability: string;
      priorityTopic: string;
      businessStage: string;
      hasBusinessDomain: boolean;
      active: boolean;
    } | null;
    matches: Array<{
      id: string;
      name: string;
      email: string;
      city: string;
      postcode: string;
      industry: string;
      traction: string;
      businessStage: string;
      priorityTopic: string;
      availability: string;
      nearbyLocation: string;
      hasBusinessDomain: boolean;
      active: boolean;
      similarityScore: number;
    }>;
  }

  // Determine city label for each member
  function detectCity(memberCity: string): string {
    const lower = (memberCity || "").toLowerCase();
    for (const group of CITIES) {
      for (const alt of [group.label, ...group.alternatives]) {
        if (lower.includes(alt.toLowerCase())) return group.label;
      }
    }
    return "Other";
  }

  const members: NewMember[] = [];

  for (const r of records) {
    const email = r.fields["email"] as string;
    if (!email) continue;

    members.push({
      id: r.id,
      name: String(r.fields["Name"] || `${r.fields["First Name"] || ""} ${r.fields["Last Name"] || ""}`).trim(),
      email,
      city: String(r.fields["City"] || ""),
      postcode: String(r.fields["post code"] || ""),
      industry: String(r.fields["Industry"] || ""),
      traction: String(r.fields["Traction"] || ""),
      dateAdded: String(r.fields["Date joined"] || r.createdTime || ""),
      inPinecone: false,
      profile: null,
      matches: [],
    });
  }

  // For each member, try to find their matches in Pinecone
  for (const member of members) {
    // Look up by email filter
    const emailLookup = await pinecone.queryByVector(
      new Array(1536).fill(0),
      1,
      { email: { $eq: member.email.toLowerCase() } }
    );

    if (emailLookup.length === 0) continue;

    member.inPinecone = true;
    const memberId = emailLookup[0].id;

    const memberRecord = await pinecone.fetchById(memberId);
    if (!memberRecord || memberRecord.values.length === 0) continue;

    member.profile = {
      nearbyLocation: String(memberRecord.metadata.nearbyLocation || ""),
      availability: String(memberRecord.metadata.availability || ""),
      priorityTopic: String(memberRecord.metadata.priorityTopic || ""),
      businessStage: String(memberRecord.metadata.businessStage || ""),
      hasBusinessDomain: Boolean(memberRecord.metadata.hasBusinessDomain),
      active: Boolean(memberRecord.metadata.active),
    };

    const matchResults = await pinecone.queryByVector(
      memberRecord.values,
      9,
      { active: { $eq: true } }
    );

    member.matches = matchResults
      .filter((m) => m.id !== memberId)
      .slice(0, 8)
      .map((m) => ({
        id: m.id,
        name: String(m.metadata.name || ""),
        email: String(m.metadata.email || ""),
        city: String(m.metadata.city || ""),
        postcode: String(m.metadata.postcode || ""),
        industry: String(m.metadata.industry || ""),
        traction: String(m.metadata.traction || ""),
        businessStage: String(m.metadata.businessStage || ""),
        priorityTopic: String(m.metadata.priorityTopic || ""),
        availability: String(m.metadata.availability || ""),
        nearbyLocation: String(m.metadata.nearbyLocation || ""),
        hasBusinessDomain: Boolean(m.metadata.hasBusinessDomain),
        active: Boolean(m.metadata.active),
        similarityScore: Math.round(m.score * 100) / 100,
      }));
  }

  // Group by city
  const cityMap = new Map<string, NewMember[]>();
  for (const member of members) {
    const cityLabel = detectCity(member.city);
    const arr = cityMap.get(cityLabel) ?? [];
    arr.push(member);
    cityMap.set(cityLabel, arr);
  }

  const grouped = Array.from(cityMap.entries())
    .map(([city, members]) => ({ city, members, count: members.length }))
    .sort((a, b) => b.count - a.count);

  return NextResponse.json({
    success: true,
    startDate,
    endDate,
    totalNewMembers: members.length,
    totalWithMatches: members.filter((m) => m.inPinecone).length,
    cities: grouped,
  });
}
