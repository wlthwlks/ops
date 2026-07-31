/**
 * Browser-safe Zod schemas for widgets (mirrors server onboarding rules).
 * Kept local so Vite bundles stay self-contained without Node-only imports.
 */
import { z } from "zod";

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

export const locationFormSchema = z.object({
  countryCode: z.string().min(2, "Country is required"),
  cityCode: z.string().min(2, "City is required"),
  availability: z.array(z.string()).min(1, "Select at least one availability slot"),
});

export const businessFormSchema = z.object({
  primaryIndustry: z.string().min(1, "Industry is required"),
  businessStage: z.string().min(1, "Stage is required"),
  annualRevenue: z.string().min(1, "Revenue is required"),
  businessDescription: z
    .string()
    .trim()
    .min(40, "Please write at least 40 characters")
    .max(400, "Keep under 400 characters"),
});

export const goalFormSchema = z.object({
  ninetyDayGoal: z
    .string()
    .trim()
    .min(30, "Please write at least 30 characters")
    .max(300),
});

export const helpFormSchema = z.object({
  helpWanted: z.array(z.string()).max(3),
  helpWantedContext: z.string().trim().max(400).optional(),
});

export const expertiseFormSchema = z.object({
  expertiseOffered: z.array(z.string()).max(5),
  expertiseContext: z.string().trim().max(400).optional(),
});

export const connectionFormSchema = z.object({
  connectionType: z.string().min(1, "Select a connection type"),
});

export type AccountForm = z.infer<typeof accountFormSchema>;
export type LocationForm = z.infer<typeof locationFormSchema>;
export type BusinessForm = z.infer<typeof businessFormSchema>;
