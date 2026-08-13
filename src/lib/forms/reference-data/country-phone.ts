/**
 * Country label → ISO2 + calling code helpers.
 * Airtable country codes are record IDs; dial codes come from libphonenumber-js via ISO2.
 */
import {
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/max";

/** Normalize country labels for lookup (lowercase, collapse whitespace/punctuation). */
export function normalizeCountryLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Known Airtable / common alias labels → ISO 3166-1 alpha-2.
 * Never invent mappings at call sites — extend this table deliberately.
 */
const COUNTRY_LABEL_TO_ISO2: Record<string, CountryCode> = {
  "new zealand": "NZ",
  nz: "NZ",
  aotearoa: "NZ",
  australia: "AU",
  au: "AU",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  ireland: "IE",
  "republic of ireland": "IE",
  eire: "IE",
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  america: "US",
  canada: "CA",
  "united arab emirates": "AE",
  uae: "AE",
  emirates: "AE",
  dubai: "AE",
  germany: "DE",
  france: "FR",
  spain: "ES",
  portugal: "PT",
  netherlands: "NL",
  holland: "NL",
  italy: "IT",
  mexico: "MX",
  brazil: "BR",
  "south africa": "ZA",
  singapore: "SG",
  japan: "JP",
  india: "IN",
  malaysia: "MY",
  vietnam: "VN",
  "viet nam": "VN",
  nigeria: "NG",
  argentina: "AR",
  qatar: "QA",
};

/** Explicit list required by product — must resolve. */
export const REQUIRED_PHONE_COUNTRY_LABELS = [
  "New Zealand",
  "Australia",
  "United Kingdom",
  "Ireland",
  "United States",
  "Canada",
  "United Arab Emirates",
  "UAE",
  "Germany",
  "France",
  "Spain",
  "Portugal",
  "Netherlands",
  "Italy",
  "Mexico",
  "Brazil",
  "South Africa",
  "Singapore",
  "Japan",
  "India",
  "Malaysia",
  "Vietnam",
  "Nigeria",
  "Argentina",
  "Qatar",
] as const;

export function resolveCountryIso2(label: string): CountryCode | null {
  const key = normalizeCountryLabel(label);
  if (!key) return null;
  if (COUNTRY_LABEL_TO_ISO2[key]) return COUNTRY_LABEL_TO_ISO2[key];
  // Direct ISO2 if already provided
  if (/^[a-z]{2}$/i.test(label.trim())) {
    const iso = label.trim().toUpperCase() as CountryCode;
    try {
      getCountryCallingCode(iso);
      return iso;
    } catch {
      return null;
    }
  }
  return null;
}

export function dialCodeForIso2(iso2: CountryCode | string | null | undefined): string | null {
  if (!iso2) return null;
  try {
    const cc = getCountryCallingCode(iso2.toUpperCase() as CountryCode);
    return `+${cc}`;
  } catch {
    return null;
  }
}

export function resolveCountryDialCode(label: string): {
  iso2: CountryCode | null;
  dialCode: string | null;
} {
  const iso2 = resolveCountryIso2(label);
  return { iso2, dialCode: dialCodeForIso2(iso2) };
}

export type CountryPhoneMeta = {
  code: string;
  label: string;
  iso2: string | null;
  dialCode: string | null;
};

export function enrichCountriesWithPhoneMeta(
  countries: Array<{ code: string; label: string }>
): CountryPhoneMeta[] {
  return countries.map((c) => {
    const { iso2, dialCode } = resolveCountryDialCode(c.label);
    return {
      code: c.code,
      label: c.label,
      iso2: iso2 ?? null,
      dialCode,
    };
  });
}

/**
 * Normalize national digits: strip spaces/hyphens/parens.
 * Leading trunk 0 is stripped by libphonenumber when parsing with country.
 */
export function normalizeNationalDigits(nationalNumber: string): string {
  return (nationalNumber || "").trim().replace(/[\s().-]/g, "");
}

let displayNames: Intl.DisplayNames | null | undefined;
/** Best-effort human country name from ISO2 (e.g. "US" → "United States"). */
export function countryNameForIso2(iso2: string | null | undefined): string | null {
  const code = (iso2 || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  try {
    if (displayNames === undefined) {
      displayNames =
        typeof Intl !== "undefined" && "DisplayNames" in Intl
          ? new Intl.DisplayNames(["en"], { type: "region" })
          : null;
    }
    const name = displayNames?.of(code);
    return name || null;
  } catch {
    return null;
  }
}

/** Validate national number + dial prefix; returns E.164 parts or error. */
export function validatePhoneParts(
  phonePrefix: string,
  nationalNumber: string,
  iso2?: string | null
): { ok: true; e164: string; national: string; prefix: string } | { ok: false; message: string } {
  const prefix = (phonePrefix || "").trim();
  if (!prefix || !/^\+\d{1,4}$/.test(prefix)) {
    return { ok: false, message: "Select a country so we can add the correct calling code" };
  }

  const expectedIso2 = (iso2 || "").trim().toUpperCase() as CountryCode | "";

  // Preserve a leading "+" exactly once; strip formatting noise (spaces, parens, hyphens).
  const raw = (nationalNumber || "").trim();
  if (!raw) {
    return { ok: false, message: "Enter a valid phone number" };
  }
  // Real letters (other than a leading "+") are never part of a phone number.
  if (/[a-zA-Z]/.test(raw)) {
    return { ok: false, message: "Enter a valid phone number" };
  }
  const isInternational = raw.startsWith("+");
  const digitsBody = isInternational ? raw.slice(1) : raw;
  const digits = digitsBody.replace(/[\s().\-]/g, "");
  if (!/^\d+$/.test(digits)) {
    return { ok: false, message: "Phone number should contain digits only" };
  }
  if (digits.length < 4) {
    return { ok: false, message: "Enter a valid phone number" };
  }
  const parseInput = isInternational ? `+${digits}` : digits;

  // When the selected country is known, parse strictly with that country and
  // verify the parsed number actually belongs to it (handles shared calling
  // codes such as US/CA on +1 by checking libphonenumber’s resolved country).
  // Without an iso2 (legacy / test paths), fall back to parsing the full number
  // (international if the user included a "+", otherwise the prefix + digits).
  let parsed: ReturnType<typeof parsePhoneNumberFromString>;
  if (expectedIso2) {
    parsed = isInternational
      ? parsePhoneNumberFromString(parseInput)
      : parsePhoneNumberFromString(parseInput, expectedIso2);
  } else {
    parsed =
      (isInternational
        ? parsePhoneNumberFromString(parseInput)
        : parsePhoneNumberFromString(`${prefix}${digits}`)) ??
      parsePhoneNumberFromString(parseInput);
  }

  if (!parsed || !parsed.isValid()) {
    return {
      ok: false,
      message: "That phone number doesn’t look valid for the selected country",
    };
  }

  const parsedPrefix = `+${parsed.countryCallingCode}`;

  // For shared calling codes (e.g. +1 covers US and CA), the calling code alone
  // can’t tell us which country the number belongs to — libphonenumber does.
  // Resolve the country first and surface a clear "wrong country" message.
  if (expectedIso2) {
    if (!parsed.country) {
      return {
        ok: false,
        message: "Phone number does not match the selected country’s calling code",
      };
    }
    if (parsed.country !== expectedIso2) {
      const belong = countryNameForIso2(parsed.country);
      return {
        ok: false,
        message: belong
          ? `This phone number belongs to ${belong}, not the selected country`
          : "That phone number doesn’t look valid for the selected country",
      };
    }
  }

  if (parsedPrefix !== prefix) {
    return {
      ok: false,
      message: "Phone number does not match the selected country’s calling code",
    };
  }

  return {
    ok: true,
    e164: parsed.format("E.164"),
    national: parsed.nationalNumber,
    prefix: parsedPrefix,
  };
}

export function normalizePostCode(value: string | undefined | null): string {
  return (value || "").trim().replace(/\s+/g, " ").slice(0, 32);
}

export function isValidPostCodeShape(value: string): boolean {
  if (!value) return true; // optional
  if (value.length > 32) return false;
  return /^[A-Za-z0-9][A-Za-z0-9 \-]*$/.test(value);
}

/**
 * Split a stored phone for display.
 * Prefer separate prefix column; fall back to parsing a full international number.
 */
export function splitStoredPhone(
  phone: string,
  phonePrefix?: string | null
): { phonePrefix: string; phone: string; legacyUnparsed: boolean } {
  const prefixCol = (phonePrefix || "").trim();
  const raw = (phone || "").trim();

  if (prefixCol && /^\+\d{1,4}$/.test(prefixCol)) {
    let national = raw;
    if (national.startsWith(prefixCol)) {
      national = national.slice(prefixCol.length).trim();
    }
    national = national.replace(/^\+/, "").replace(/[\s().-]/g, "");
    return { phonePrefix: prefixCol, phone: national, legacyUnparsed: false };
  }

  if (raw.startsWith("+")) {
    const parsed = parsePhoneNumberFromString(raw);
    if (parsed?.isValid()) {
      return {
        phonePrefix: `+${parsed.countryCallingCode}`,
        phone: parsed.nationalNumber,
        legacyUnparsed: false,
      };
    }
  }

  return {
    phonePrefix: "",
    phone: raw,
    legacyUnparsed: Boolean(raw),
  };
}

/** Default dial code from browser locale (navigator.language). */
export function defaultDialCodeFromLocale(locale?: string | null): {
  iso2: CountryCode | null;
  dialCode: string | null;
} {
  const loc = (locale || "").trim();
  if (!loc) return { iso2: null, dialCode: null };
  const region = loc.includes("-")
    ? loc.split("-").pop()?.toUpperCase()
    : loc.length === 2
      ? loc.toUpperCase()
      : "";
  if (!region || region.length !== 2) return { iso2: null, dialCode: null };
  const iso2 = region as CountryCode;
  const dialCode = dialCodeForIso2(iso2);
  return { iso2: dialCode ? iso2 : null, dialCode };
}

export function auditCountryPhoneMappings(
  countries: Array<{ code: string; label: string }>
): {
  mapped: CountryPhoneMeta[];
  unmapped: Array<{ code: string; label: string }>;
} {
  const mapped: CountryPhoneMeta[] = [];
  const unmapped: Array<{ code: string; label: string }> = [];
  for (const c of countries) {
    const meta = enrichCountriesWithPhoneMeta([c])[0];
    if (meta.iso2 && meta.dialCode) mapped.push(meta);
    else unmapped.push({ code: c.code, label: c.label });
  }
  return { mapped, unmapped };
}
