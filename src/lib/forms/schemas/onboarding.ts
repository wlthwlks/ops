import { z } from "zod";
import {
  AVAILABILITY_OPTIONS,
  BUSINESS_STAGES,
  CONNECTION_TYPES,
  INDUSTRIES,
  REVENUE_BRACKETS,
  isAirtableRecordId,
} from "@/lib/forms/reference-data";
import { validatePhoneParts } from "@/lib/forms/reference-data/country-phone";

const stageCodes = BUSINESS_STAGES.map((s) => s.code) as [string, ...string[]];
const revenueCodes = REVENUE_BRACKETS.map((s) => s.code) as [string, ...string[]];
const industryCodes = INDUSTRIES.map((s) => s.code) as [string, ...string[]];
const availCodes = AVAILABILITY_OPTIONS.map((s) => s.code) as [string, ...string[]];
const connectionCodes = CONNECTION_TYPES.map((s) => s.code) as [string, ...string[]];

/** Airtable record ids (rec…) used as country/city codes from live catalogue. */
const airtableId = z
  .string()
  .trim()
  .min(10)
  .max(64)
  .refine((v) => isAirtableRecordId(v), { message: "Invalid Airtable record id" });

/** Matching option value: Airtable record id or legacy static code. */
const matchingOptionCode = z.string().trim().min(1).max(64);

const phonePrefixSchema = z
  .string()
  .trim()
  .regex(/^\+\d{1,4}$/, "Choose a country calling code");

const nationalPhoneSchema = z
  .string()
  .trim()
  .min(4, "Enter a valid phone number")
  .max(30);

function withPhoneValidation<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return schema.superRefine((raw, ctx) => {
    const data = raw as { phone?: string; phonePrefix?: string };
    if (data.phone == null && data.phonePrefix == null) return;
    if (!data.phonePrefix || !data.phone) {
      if (data.phone || data.phonePrefix) {
        ctx.addIssue({
          code: "custom",
          message: "Phone number and country calling code are both required",
          path: data.phonePrefix ? ["phone"] : ["phonePrefix"],
        });
      }
      return;
    }
    const result = validatePhoneParts(data.phonePrefix, data.phone);
    if (!result.ok) {
      ctx.addIssue({
        code: "custom",
        message: result.message,
        path: ["phone"],
      });
    }
  });
}

const otherIndustryRefine = (
  data: { primaryIndustry?: string; otherIndustry?: string },
  ctx: z.RefinementCtx
) => {
  if (data.primaryIndustry !== "OTHER") return;
  const custom = (data.otherIndustry || "").trim();
  if (!custom) {
    ctx.addIssue({
      code: "custom",
      message: "Tell us your industry",
      path: ["otherIndustry"],
    });
    return;
  }
  if (/^other$/i.test(custom)) {
    ctx.addIssue({
      code: "custom",
      message: "Please describe your industry more specifically",
      path: ["otherIndustry"],
    });
  }
};

const accountObjectSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z
    .string()
    .trim()
    .email()
    .transform((e) => e.toLowerCase()),
  /** Password never logged or stored by our APIs — Memberstack only. */
  password: z.string().min(8).max(128).optional(),
  phone: nationalPhoneSchema.optional(),
  phonePrefix: phonePrefixSchema.optional(),
});

export const accountSchema = withPhoneValidation(accountObjectSchema);

export const locationSchema = z.object({
  countryCode: airtableId,
  cityCode: airtableId,
  availability: z.array(z.enum(availCodes)).min(1).max(21),
});

export const businessSchema = z
  .object({
    primaryIndustry: z.enum(industryCodes),
    otherIndustry: z.string().trim().max(120).optional(),
    businessStage: z.enum(stageCodes),
    annualRevenue: z.enum(revenueCodes),
    businessDescription: z.string().trim().min(40).max(400),
    businessName: z.string().trim().max(120).optional(),
    businessWebsite: z.string().trim().url().optional().or(z.literal("")),
  })
  .superRefine(otherIndustryRefine);

export const goalSchema = z.object({
  ninetyDayGoal: z.string().trim().min(30).max(300),
});

export const helpWantedSchema = z.object({
  helpWanted: z.array(matchingOptionCode).max(3),
  helpWantedContext: z.string().trim().max(400).optional(),
});

export const expertiseSchema = z.object({
  expertiseOffered: z.array(matchingOptionCode).max(5),
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
  z.object({
    stage: z.literal("ACCOUNT"),
    data: withPhoneValidation(accountObjectSchema.omit({ password: true })),
  }),
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

export const bootstrapSchema = withPhoneValidation(
  z.object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z
      .string()
      .trim()
      .email()
      .transform((e) => e.toLowerCase()),
    phone: nationalPhoneSchema,
    phonePrefix: phonePrefixSchema,
    attribution: attributionSchema.optional(),
  })
);

export const updateProfileSchema = withPhoneValidation(
  z
    .object({
      firstName: z.string().trim().min(1).max(80).optional(),
      lastName: z.string().trim().min(1).max(80).optional(),
      phone: z.string().trim().max(40).optional(),
      phonePrefix: z
        .string()
        .trim()
        .regex(/^\+\d{1,4}$/, "Choose a country calling code")
        .optional()
        .or(z.literal("")),
      businessName: z.string().trim().max(120).optional(),
      businessWebsite: z.string().trim().max(500).optional(),
      socialUrl: z.string().trim().max(500).optional(),
      countryCode: airtableId.optional(),
      cityCode: airtableId.optional(),
      availability: z.array(z.enum(availCodes)).max(21).optional(),
      primaryIndustry: z.enum(industryCodes).optional(),
      otherIndustry: z.string().trim().max(120).optional(),
      businessStage: z.enum(stageCodes).optional(),
      annualRevenue: z.enum(revenueCodes).optional(),
      businessDescription: z.string().trim().min(40).max(400).optional(),
      ninetyDayGoal: z.string().trim().min(30).max(300).optional(),
      helpWanted: z.array(matchingOptionCode).max(3).optional(),
      helpWantedContext: z.string().trim().max(400).optional(),
      expertiseOffered: z.array(matchingOptionCode).max(5).optional(),
      expertiseContext: z.string().trim().max(400).optional(),
      connectionType: z.enum(connectionCodes).optional(),
      topicsToDiscuss: z.string().trim().max(1000).optional(),
      hobbies: z.string().trim().max(1000).optional(),
    })
    .superRefine(otherIndustryRefine)
);

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
