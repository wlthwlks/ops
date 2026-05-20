import { NextRequest, NextResponse } from "next/server";
import { createPineconeClient } from "@/lib/integrations/pinecone";

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

  // Query for top 9 similar (member itself will be #1, so we get 8 others)
  const matches = await pinecone.queryByVector(
    memberRecord.values,
    9,
    { active: { $eq: true } }
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
      availability: memberRecord.metadata.availability,
      priorityTopic: memberRecord.metadata.priorityTopic,
      businessStage: memberRecord.metadata.businessStage,
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
      availability: m.metadata.availability,
      priorityTopic: m.metadata.priorityTopic,
      businessStage: m.metadata.businessStage,
      similarityScore: Math.round(m.score * 100) / 100,
    })),
  });
}
