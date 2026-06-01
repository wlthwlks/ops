export interface MessageMember {
  name: string;
  email: string;
  industry: string;
  businessStage: string;
  nearbyLocation: string;
}

export type MessageFormat = "plaintext" | "slack";

export interface GeneratedMessage {
  body: string;
  recipients: string[];
}
