export interface MessageMember {
  name: string;
  email: string;
  industry: string;
  businessStage: string;
  nearbyLocation: string;
  /** Free-text Airtable "Availability" — sparsely populated, optional. */
  availability?: string;
  /** Free-text Airtable "Topics to Discuss" — sparsely populated, optional. */
  topics?: string;
}

export type MessageFormat = "plaintext" | "slack" | "html";

export interface GeneratedMessage {
  body: string;
  recipients: string[];
}
