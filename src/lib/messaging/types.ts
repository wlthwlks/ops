export interface MessageMember {
  name: string;
  email: string;
  industry: string;
  businessStage: string;
  nearbyLocation: string;
}

export type MessageFormat = "plaintext" | "slack" | "html";

export interface GeneratedMessage {
  body: string;
  recipients: string[];
}
