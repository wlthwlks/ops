/**
 * Browser-safe Zod schemas for widgets (mirrors server onboarding rules).
 * Kept local so Vite bundles stay self-contained without Node-only imports.
 */
import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js";

function validatePhonePair(
  data: { phone?: string; phonePrefix?: string; countryIso2?: string },
  ctx: z.RefinementCtx,
  required: boolean
) {
  const prefix = (data.phonePrefix || "").trim();
  const phone = (data.phone || "").trim().replace(/[\s().-]/g, "");
  if (!required && !prefix && !phone) return;
  if (!prefix || !/^\+\d{1,4}$/.test(prefix)) {
    ctx.addIssue({
      code: "custom",
      message: "Select a country so we can add the correct calling code",
      path: ["phonePrefix"],
    });
    return;
  }
  if (!phone || phone.length < 4) {
    ctx.addIssue({
      code: "custom",
      message: "Enter a valid phone number",
      path: ["phone"],
    });
    return;
  }
  if (!/^\d+$/.test(phone)) {
    ctx.addIssue({
      code: "custom",
      message: "Phone number should contain digits only",
      path: ["phone"],
    });
    return;
  }
  const iso = (data.countryIso2 || "").trim().toUpperCase();
  let parsed = iso
    ? parsePhoneNumberFromString(phone, iso as never)
    : parsePhoneNumberFromString(`${prefix}${phone}`);
  if (!parsed?.isValid()) {
    parsed = parsePhoneNumberFromString(`${prefix}${phone}`);
  }
  if (!parsed?.isValid()) {
    ctx.addIssue({
      code: "custom",
      message: "That phone number doesn’t look valid for the selected country",
      path: ["phone"],
    });
    return;
  }
  if (`+${parsed.countryCallingCode}` !== prefix) {
    ctx.addIssue({
      code: "custom",
      message: "Phone number does not match the selected country’s calling code",
      path: ["phone"],
    });
  }
}

function otherIndustryRefine(
  data: { primaryIndustry?: string; otherIndustry?: string },
  ctx: z.RefinementCtx
) {
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
}

const postCodeField = z
  .string()
  .trim()
  .max(32)
  .optional()
  .or(z.literal(""))
  .refine((v) => !v || /^[A-Za-z0-9][A-Za-z0-9 \-]*$/.test(v), {
    message: "Enter a valid post code",
  });

/** Account step: name / email / password only (no phone). */
export const accountFormSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(80),
  lastName: z.string().trim().min(1, "Last name is required").max(80),
  email: z
    .string()
    .trim()
    .email("Enter a valid email")
    .transform((e) => e.toLowerCase()),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

/** Location: Country → City → Post code → Phone (prefix fixed from country). */
export const locationFormSchema = z
  .object({
    countryCode: z.string().min(10, "Country is required").max(64),
    cityCode: z.string().min(10, "City is required").max(64),
    countryIso2: z.string().trim().max(2).optional().or(z.literal("")),
    postCode: postCodeField,
    phone: z.string().trim().min(1, "Phone number is required").max(30),
    phonePrefix: z
      .string()
      .trim()
      .regex(/^\+\d{1,4}$/, "Select a country so we can add the correct calling code"),
    availability: z.array(z.string()).min(1, "Select at least one availability slot"),
  })
  .superRefine((d, ctx) => validatePhonePair(d, ctx, true));

export const businessFormSchema = z
  .object({
    primaryIndustry: z.string().min(1, "Industry is required"),
    otherIndustry: z.string().trim().max(120).optional(),
    businessStage: z.string().min(1, "Stage is required"),
    annualRevenue: z.string().min(1, "Revenue is required"),
    businessDescription: z
      .string()
      .trim()
      .min(40, "Please write at least 40 characters")
      .max(400, "Keep under 400 characters"),
  })
  .superRefine(otherIndustryRefine);

export const goalFormSchema = z.object({
  ninetyDayGoal: z
    .string()
    .trim()
    .min(30, "Please write at least 30 characters")
    .max(300),
});

export const helpFormSchema = z.object({
  helpWanted: z.array(z.string()).max(3, "Select up to 3 areas"),
  helpWantedContext: z.string().trim().max(400).optional(),
});

export const expertiseFormSchema = z.object({
  expertiseOffered: z.array(z.string()).max(5, "Select up to 5 areas"),
  expertiseContext: z.string().trim().max(400).optional(),
});

export const connectionFormSchema = z.object({
  connectionType: z.string().min(1, "Select a connection type"),
});

export const communityIntentionSchema = z.object({
  communityIntention: z.literal(true, {
    message: "Please confirm you’re joining to connect and grow — not to cold-sell",
  }),
});

export const profileFormSchema = z
  .object({
    firstName: z.string().trim().min(1, "Required").max(80),
    lastName: z.string().trim().min(1, "Required").max(80),
    email: z
      .string()
      .trim()
      .email()
      .transform((e) => e.toLowerCase()),
    phone: z.string().trim().max(40).optional(),
    phonePrefix: z.string().trim().optional(),
    countryIso2: z.string().trim().max(2).optional().or(z.literal("")),
    postCode: postCodeField,
    countryCode: z.string().min(10).max(64).optional().or(z.literal("")),
    cityCode: z.string().max(64).optional(),
    availability: z.array(z.string()).max(21).optional(),
    primaryIndustry: z.string().optional(),
    otherIndustry: z.string().trim().max(120).optional(),
    businessStage: z.string().optional(),
    annualRevenue: z.string().optional(),
    businessDescription: z.string().trim().max(400).optional(),
    ninetyDayGoal: z.string().trim().max(300).optional(),
    helpWanted: z.array(z.string()).max(3).optional(),
    helpWantedContext: z.string().trim().max(400).optional(),
    expertiseOffered: z.array(z.string()).max(5).optional(),
    expertiseContext: z.string().trim().max(400).optional(),
    connectionType: z.string().optional(),
    topicsToDiscuss: z.string().trim().max(1000).optional(),
  })
  .superRefine((d, ctx) => {
    otherIndustryRefine(d, ctx);
    if (d.phone || d.phonePrefix) validatePhonePair(d, ctx, false);
  });

export type AccountForm = z.infer<typeof accountFormSchema>;
export type LocationForm = z.infer<typeof locationFormSchema>;
export type BusinessForm = z.infer<typeof businessFormSchema>;
export type ProfileForm = z.infer<typeof profileFormSchema>;
