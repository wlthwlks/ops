import { z } from "zod";
import {
  AVAILABILITY_OPTIONS,
  BUSINESS_STAGES,
  CONNECTION_TYPES,
  EXPERTISE_OPTIONS,
  HELP_WANTED_OPTIONS,
  INDUSTRIES,
  REVENUE_BRACKETS,
  isAirtableRecordId,
} from "@/lib/forms/reference-data";

const stageCodes = BUSINESS_STAGES.map((s) => s.code) as [string, ...string[]];
const revenueCodes = REVENUE_BRACKETS.map((s) => s.code) as [string, ...string[]];
const industryCodes = INDUSTRIES.map((s) => s.code) as [string, ...string[]];
const availCodes = AVAILABILITY_OPTIONS.map((s) => s.code) as [string, ...string[]];
const helpCodes = HELP_WANTED_OPTIONS.map((s) => s.code) as [string, ...string[]];
const expertiseCodes = EXPERTISE_OPTIONS.map((s) => s.code) as [string, ...string[]];
const connectionCodes = CONNECTION_TYPES.map((s) => s.code) as [string, ...string[]];

/** Airtable record ids (rec…) used as country/city codes from live catalogue. */
const airtableId = z
  .string()
  .trim()
  .min(10)
  .max(64)
  .refine((v) => isAirtableRecordId(v), { message: "Invalid Airtable record id" });

export const accountSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z
    .string()
    .trim()
    .email()
    .transform((e) => e.toLowerCase()),
  /** Password never logged or stored by our APIs — Memberstack only. */
  password: z.string().min(8).max(128).optional(),
});

export const locationSchema = z.object({
  countryCode: airtableId,
  cityCode: airtableId,
  availability: z.array(z.enum(availCodes)).min(1).max(21),
});

export const businessSchema = z.object({
  primaryIndustry: z.enum(industryCodes),
  businessStage: z.enum(stageCodes),
  annualRevenue: z.enum(revenueCodes),
  businessDescription: z.string().trim().min(40).max(400),
  businessName: z.string().trim().max(120).optional(),
  businessWebsite: z.string().trim().url().optional().or(z.literal("")),
});

export const goalSchema = z.object({
  ninetyDayGoal: z.string().trim().min(30).max(300),
});

export const helpWantedSchema = z.object({
  helpWanted: z.array(z.enum(helpCodes)).max(3),
  helpWantedContext: z.string().trim().max(400).optional(),
});

export const expertiseSchema = z.object({
  expertiseOffered: z.array(z.enum(expertiseCodes)).max(5),
  expertiseContext: z.string().trim().max(400).optional(),
});

export const connectionSchema = z.object({
  connectionType: z.enum(connectionCodes),
});

export const attributionSchema = z.object({
  utm_source: z.string().max(200).optional(),
  utm_medium: z.string().max(200).optional(),
  utm_campaign: z.string().max(200).optional(),
  utm_content: z.string().max(200).optional(),
  utm_term: z.string().max(200).optional(),
  gclid: z.string().max(200).optional(),
  fbclid: z.string().max(200).optional(),
  initialLandingPage: z.string().max(2000).optional(),
  initialReferrer: z.string().max(2000).optional(),
  firstAttributionAt: z.string().optional(),
});

export const onboardingStepSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("ACCOUNT"), data: accountSchema.omit({ password: true }) }),
  z.object({ stage: z.literal("LOCATION"), data: locationSchema }),
  z.object({ stage: z.literal("BUSINESS"), data: businessSchema }),
  z.object({ stage: z.literal("PAYMENT_PENDING"), data: z.object({}).optional() }),
  z.object({
    stage: z.literal("PAYMENT_CONFIRMED"),
    data: z
      .object({
        /** Optional Stripe cus_… from Memberstack after checkout */
        stripeCustomerId: z.string().trim().max(80).optional(),
      })
      .optional(),
  }),
  z.object({ stage: z.literal("GOAL"), data: goalSchema }),
  z.object({ stage: z.literal("HELP_WANTED"), data: helpWantedSchema }),
  z.object({ stage: z.literal("EXPERTISE"), data: expertiseSchema }),
  z.object({ stage: z.literal("CONNECTION"), data: connectionSchema }),
]);

export const bootstrapSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z
    .string()
    .trim()
    .email()
    .transform((e) => e.toLowerCase()),
  attribution: attributionSchema.optional(),
});

export const updateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().max(40).optional(),
  businessName: z.string().trim().max(120).optional(),
  businessWebsite: z.string().trim().max(500).optional(),
  socialUrl: z.string().trim().max(500).optional(),
  countryCode: airtableId.optional(),
  cityCode: airtableId.optional(),
  availability: z.array(z.enum(availCodes)).max(21).optional(),
  primaryIndustry: z.enum(industryCodes).optional(),
  businessStage: z.enum(stageCodes).optional(),
  annualRevenue: z.enum(revenueCodes).optional(),
  businessDescription: z.string().trim().min(40).max(400).optional(),
  ninetyDayGoal: z.string().trim().min(30).max(300).optional(),
  helpWanted: z.array(z.enum(helpCodes)).max(3).optional(),
  helpWantedContext: z.string().trim().max(400).optional(),
  expertiseOffered: z.array(z.enum(expertiseCodes)).max(5).optional(),
  expertiseContext: z.string().trim().max(400).optional(),
  connectionType: z.enum(connectionCodes).optional(),
  topicsToDiscuss: z.string().trim().max(1000).optional(),
  hobbies: z.string().trim().max(1000).optional(),
});

export type OnboardingStage =
  | "ACCOUNT"
  | "LOCATION"
  | "BUSINESS"
  | "PAYMENT_PENDING"
  | "PAYMENT_CONFIRMED"
  | "GOAL"
  | "HELP_WANTED"
  | "EXPERTISE"
  | "CONNECTION"
  | "COMPLETE";
