import { z } from "zod";
import {
  AVAILABILITY_OPTIONS,
  BUSINESS_STAGES,
  CONNECTION_TYPES,
  INDUSTRIES,
  REVENUE_BRACKETS,
  isAirtableRecordId,
} from "@/lib/forms/reference-data";
import {
  isValidPostCodeShape,
  normalizePostCode,
  validatePhoneParts,
} from "@/lib/forms/reference-data/country-phone";

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
  .regex(/^\+\d{1,4}$/, "Select a country so we can add the correct calling code");

const nationalPhoneSchema = z
  .string()
  .trim()
  .min(4, "Enter a valid phone number")
  .max(30);

const postCodeSchema = z
  .string()
  .trim()
  .max(32)
  .transform((v) => normalizePostCode(v))
  .refine((v) => isValidPostCodeShape(v), {
    message: "Enter a valid post code",
  });

function withPhoneValidation<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  opts?: { required?: boolean }
) {
  const required = opts?.required !== false;
  return schema.superRefine((raw, ctx) => {
    const data = raw as {
      phone?: string;
      phonePrefix?: string;
      countryIso2?: string;
    };
    if (!required && !data.phone && !data.phonePrefix) return;
    if (required || data.phone || data.phonePrefix) {
      if (!data.phonePrefix || !data.phone) {
        ctx.addIssue({
          code: "custom",
          message: "Phone number is required once a country is selected",
          path: data.phonePrefix ? ["phone"] : ["phonePrefix"],
        });
        return;
      }
      const result = validatePhoneParts(
        data.phonePrefix,
        data.phone,
        data.countryIso2
      );
      if (!result.ok) {
        ctx.addIssue({
          code: "custom",
          message: result.message,
          path: ["phone"],
        });
      }
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
  age: z.string().refine((v) => ["18-24", "25-34", "35-44", "45-54", "55+"].includes(v), {
    message: "Select your age range",
  }),
  email: z
    .string()
    .trim()
    .email()
    .transform((e) => e.toLowerCase()),
  /** Password never logged or stored by our APIs — Memberstack only. */
  password: z.string().min(8).max(128).optional(),
});

export const accountSchema = accountObjectSchema;

const locationObjectSchema = z.object({
  countryCode: airtableId,
  cityCode: airtableId,
  /** Optional ISO2 from reference data — used for phone validation only */
  countryIso2: z.string().trim().length(2).optional().or(z.literal("")),
  postCode: postCodeSchema.optional().or(z.literal("")),
  phone: nationalPhoneSchema,
  phonePrefix: phonePrefixSchema,
  availability: z.array(z.enum(availCodes)).max(21).optional(),
});

export const locationSchema = withPhoneValidation(locationObjectSchema, {
  required: true,
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
    data: accountObjectSchema.omit({ password: true }),
  }),
  z.object({ stage: z.literal("LOCATION"), data: locationSchema }),
  z.object({ stage: z.literal("BUSINESS"), data: businessSchema }),
  z.object({ stage: z.literal("PAYMENT_PENDING"), data: z.object({}).optional() }),
  z.object({
    stage: z.literal("PAYMENT_CONFIRMED"),
    data: z
      .object({
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
  age: z.string().refine((v) => ["18-24", "25-34", "35-44", "45-54", "55+"].includes(v), {
    message: "Select your age range",
  }),
  email: z
    .string()
    .trim()
    .email()
    .transform((e) => e.toLowerCase()),
  attribution: attributionSchema.optional(),
});

export const socialLinkSchema = z.object({
  platform: z.string().trim().min(1).max(20),
  url: z.string().trim().max(500),
});

export const updateProfileSchema = withPhoneValidation(
  z
    .object({
      firstName: z.string().trim().min(1).max(80).optional(),
      lastName: z.string().trim().min(1).max(80).optional(),
      phone: z.string().trim().max(40).optional(),
      phonePrefix: z
        .string()
        .trim()
        .regex(/^\+\d{1,4}$/, "Select a country so we can add the correct calling code")
        .optional()
        .or(z.literal("")),
      countryIso2: z.string().trim().length(2).optional().or(z.literal("")),
      postCode: postCodeSchema.optional().or(z.literal("")),
      businessName: z.string().trim().max(120).optional(),
      businessWebsite: z.string().trim().max(500).optional(),
      professionalHeadline: z.string().trim().max(80).optional(),
      profileBio: z.string().trim().max(500).optional(),
      socialLinks: z.array(socialLinkSchema).optional(),
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
    .superRefine(otherIndustryRefine),
  { required: false }
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
