export type CityLinkCondition =
  | "MEMBER_CITY_LINK_MISSING"
  | "MEMBER_CITY_VALUE_UNRESOLVED"
  | "CITY_SLACK_CHANNEL_LINK_MISSING"
  | "CITY_CHANNEL_PAUSED"
  | "CITY_CHANNEL_CLOSED"
  | "ACTIVE_CHANNEL_MISSING_SLACK_ID"
  | "ACTIVE_CHANNEL_READY"
  | "VIRTUAL_FALLBACK_CHANNEL"
  | "LEGACY_CITY_FALLBACK";

export type MemberCityProposal = {
  airtableRecordId: string;
  memberName: string;
  email: string;
  legacyCity: string;
  currentLinkIds: string[];
  proposedCanonical: string;
  proposedCityRecordId: string;
  proposedChannelName: string;
  confidence: "high" | "medium" | "low";
  reason: string;
  via: string;
  safeToAutoApply: boolean;
  manualReviewReason: string;
  wouldUpdate: boolean;
};

export type CityRecordProposal = {
  action: "create" | "rename" | "country_override" | "merge_duplicate" | "noop";
  recordId: string;
  beforeName: string;
  afterName: string;
  country: string;
  reason: string;
  safeToAutoApply: boolean;
};

export type ChannelRelationProposal = {
  channelRecordId: string;
  channelName: string;
  status: string;
  slackChannelId: string;
  beforeCityIds: string[];
  afterCityIds: string[];
  addedCityNames: string[];
  reason: string;
  wouldUpdate: boolean;
};
