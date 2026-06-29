import { NextRequest, NextResponse } from "next/server";
import { createPineconeClient } from "@/lib/integrations/pinecone";
import { CITIES } from "@/lib/constants";

export async function GET(request: NextRequest) {
  const pineconeKey = process.env.PINECONE_API_KEY;
  const pineconeIndex = process.env.PINECONE_INDEX_NAME;

  if (!pineconeKey || !pineconeIndex) {
    return NextResponse.json(
      { success: false, error: "Missing Pinecone credentials" },
      { status: 500 }
    );
  }

  const email = request.nextUrl.searchParams.get("email")?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json(
      { success: false, error: "Email parameter is required" },
      { status: 400 }
    );
  }

  const pinecone = createPineconeClient({ apiKey: pineconeKey, indexName: pineconeIndex });

  // Find the member's vector by querying metadata (email)
  // Pinecone doesn't support fetch-by-metadata, so we query with a dummy vector
  // and filter by email to get the record ID first
  const emailLookup = await pinecone.queryByVector(
    new Array(1536).fill(0), // dummy vector — we only care about the filter
    1,
    { email: { $eq: email } }
  );

  if (emailLookup.length === 0) {
    return NextResponse.json(
      { success: false, error: "Member not found in index. Has the sync been run?" },
      { status: 404 }
    );
  }

  const memberId = emailLookup[0].id;

  // Fetch the actual vector for this member
  const memberRecord = await pinecone.fetchById(memberId);
  if (!memberRecord || memberRecord.values.length === 0) {
    return NextResponse.json(
      { success: false, error: "Member vector not found" },
      { status: 404 }
    );
  }

  // Resolve city group for same-city filtering
  const memberCity = String(memberRecord.metadata.city || "");
  const cityNameSet = new Set<string>();
  const cityLower = memberCity.toLowerCase();
  for (const group of CITIES) {
    for (const alt of [group.label, ...group.alternatives]) {
      if (cityLower.includes(alt.toLowerCase())) {
        cityNameSet.add(group.label);
        for (const a of group.alternatives) cityNameSet.add(a);
        break;
      }
    }
    if (cityNameSet.size > 0) break;
  }
  if (memberCity) cityNameSet.add(memberCity);
  const cityNames = Array.from(cityNameSet);

  const cityFilter = cityNames.length > 0
    ? { $and: [{ active: { $eq: true } }, { city: { $in: cityNames } }] }
    : { active: { $eq: true } };

  // Query for top 9 similar (member itself will be #1, so we get 8 others)
  const matches = await pinecone.queryByVector(
    memberRecord.values,
    9,
    cityFilter
  );

  // Exclude the member themselves
  const filtered = matches.filter((m) => m.id !== memberId).slice(0, 8);

  return NextResponse.json({
    success: true,
    email,
    member: {
      name: memberRecord.metadata.name,
      email: memberRecord.metadata.email,
      postcode: memberRecord.metadata.postcode,
      city: memberRecord.metadata.city,
      nearbyLocation: memberRecord.metadata.nearbyLocation,
      active: memberRecord.metadata.active,
      industry: memberRecord.metadata.industry,
      traction: memberRecord.metadata.traction,
      hasBusinessDomain: memberRecord.metadata.hasBusinessDomain,
      businessStage: memberRecord.metadata.businessStage,
      availability: memberRecord.metadata.availability ?? "",
      topics: memberRecord.metadata.topics ?? "",
    },
    matches: filtered.map((m) => ({
      id: m.id,
      name: m.metadata.name,
      email: m.metadata.email,
      postcode: m.metadata.postcode,
      city: m.metadata.city,
      nearbyLocation: m.metadata.nearbyLocation,
      active: m.metadata.active,
      industry: m.metadata.industry,
      traction: m.metadata.traction,
      hasBusinessDomain: m.metadata.hasBusinessDomain,
      businessStage: m.metadata.businessStage,
      availability: m.metadata.availability ?? "",
      topics: m.metadata.topics ?? "",
      similarityScore: Math.round(m.score * 100) / 100,
    })),
  });
}
