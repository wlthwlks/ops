/**
 * Browser-safe Zod schemas for widgets (mirrors server onboarding rules).
 * Kept local so Vite bundles stay self-contained without Node-only imports.
 */
import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";

function validatePhonePair(
  data: { phone?: string; phonePrefix?: string; countryIso2?: string },
  ctx: z.RefinementCtx,
  required: boolean
) {
  const prefix = (data.phonePrefix || "").trim();
  const iso = (data.countryIso2 || "").trim().toUpperCase();
  const raw = (data.phone || "").trim();
  if (!required && !prefix && !raw) return;
  if (!prefix || !/^\+\d{1,4}$/.test(prefix)) {
    ctx.addIssue({
      code: "custom",
      message: "Select a country so we can add the correct calling code",
      path: ["phonePrefix"],
    });
    return;
  }
  if (!raw) {
    ctx.addIssue({ code: "custom", message: "Enter a valid phone number", path: ["phone"] });
    return;
  }
  if (/[a-zA-Z]/.test(raw)) {
    ctx.addIssue({ code: "custom", message: "Enter a valid phone number", path: ["phone"] });
    return;
  }
  const isInternational = raw.startsWith("+");
  const digitsBody = isInternational ? raw.slice(1) : raw;
  const digits = digitsBody.replace(/[\s().\-]/g, "");
  if (!/^\d+$/.test(digits)) {
    ctx.addIssue({
      code: "custom",
      message: "Phone number should contain digits only",
      path: ["phone"],
    });
    return;
  }
  if (digits.length < 4) {
    ctx.addIssue({ code: "custom", message: "Enter a valid phone number", path: ["phone"] });
    return;
  }
  const parseInput = isInternational ? `+${digits}` : digits;
  // Strict: when ISO2 known, parse with the selected country (local form) or as
  // international (pasted full number) and verify it actually belongs to it.
  // Without ISO2 (legacy/test path) parse the leading-+ international input or
  // fall back to prefix+national digits.
  const parsed = iso
    ? isInternational
      ? parsePhoneNumberFromString(parseInput)
      : parsePhoneNumberFromString(parseInput, iso as never)
    : isInternational
      ? parsePhoneNumberFromString(parseInput)
      : parsePhoneNumberFromString(`${prefix}${digits}`);
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
    return;
  }
  // Shared calling codes (e.g. US/CA on +1): resolved country must match the
  // selected one; reject when a pasted number belongs to a different country.
  if (iso && parsed.country && parsed.country !== iso) {
    let belong = "";
    try {
      belong =
        typeof Intl !== "undefined" && "DisplayNames" in Intl
          ? new Intl.DisplayNames(["en"], { type: "region" }).of(parsed.country) || ""
          : "";
    } catch {
      belong = "";
    }
    ctx.addIssue({
      code: "custom",
      message: belong
        ? `This phone number belongs to ${belong}, not the selected country`
        : "That phone number doesn’t look valid for the selected country",
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
    message: "Enter a valid Zip code",
  });

const AGE_RANGES = ["18-24", "25-34", "35-44", "45-54", "55+"] as const;

const ageSchema = z.string().refine((v) => AGE_RANGES.includes(v as (typeof AGE_RANGES)[number]), {
  message: "Select your age range",
});

export { AGE_RANGES };

/** Account step: name / email / password only (no phone). Age is personal info, placed before email. */
export const accountFormSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(80),
  lastName: z.string().trim().min(1, "Last name is required").max(80),
  age: ageSchema,
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
    availability: z.array(z.string()).max(21).optional(),
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
    socialLinks: z
      .array(
        z.object({
          platform: z.string().trim().min(1).max(20),
          url: z.string().trim().max(500),
        })
      )
      .optional(),
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
  socialLinks: z
    .array(
      z.object({
        platform: z.string().trim().min(1).max(20),
        url: z.string().trim().max(500),
      })
    )
    .optional(),
});

export const communityIntentionSchema = z.object({
  communityIntention: z.literal(true, {
    message: "Please confirm you're joining to connect and grow; not to cold-sell",
  }),
});

export const profileFormSchema = z
  .object({
    firstName: z.string().trim().min(1, "Required").max(80),
    lastName: z.string().trim().min(1, "Required").max(80),
    age: z.string().optional(),
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
    cityCode: z.string().min(10).max(64).optional(),
    availability: z.array(z.string()).max(21).optional(),
    professionalHeadline: z.string().trim().max(80).optional(),
    profileBio: z.string().trim().max(500).optional(),
    businessName: z.string().trim().max(120).optional(),
    businessWebsite: z.string().trim().max(500).optional(),
    primaryIndustry: z.string().min(1, "Select an industry").optional(),
    otherIndustry: z.string().trim().max(120).optional(),
    businessStage: z.string().min(1, "Select a business stage").optional(),
    annualRevenue: z.string().min(1, "Select a revenue bracket").optional(),
    businessDescription: z
      .string()
      .trim()
      .min(40, "Please write at least 40 characters")
      .max(400, "Keep under 400 characters")
      .optional(),
    ninetyDayGoal: z
      .string()
      .trim()
      .min(30, "Please write at least 30 characters")
      .max(300, "Keep under 300 characters")
      .optional(),
    helpWanted: z.array(z.string()).max(3).optional(),
    helpWantedContext: z.string().trim().max(400).optional(),
    expertiseOffered: z.array(z.string()).max(5).optional(),
    expertiseContext: z.string().trim().max(400).optional(),
    connectionType: z.string().min(1, "Select a connection type").optional(),
    topicsToDiscuss: z.string().trim().max(1000).optional(),
    socialLinks: z
      .array(
        z.object({
          platform: z.string().trim().min(1).max(20),
          url: z.string().trim().max(500),
        })
      )
      .optional(),
  })
  .superRefine((d, ctx) => {
    otherIndustryRefine(d, ctx);
    if (d.phone || d.phonePrefix) validatePhonePair(d, ctx, false);
  });

export type AccountForm = z.infer<typeof accountFormSchema>;
export type LocationForm = z.infer<typeof locationFormSchema>;
export type BusinessForm = z.infer<typeof businessFormSchema>;
export type ProfileForm = z.infer<typeof profileFormSchema>;
