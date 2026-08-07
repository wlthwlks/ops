import type { FieldError, UseFormRegisterReturn } from "react-hook-form";

export type PhoneCountryOption = {
  code: string;
  label: string;
  iso2?: string | null;
  dialCode?: string | null;
};

type Props = {
  /** Fixed calling code from selected country (not user-editable). */
  phonePrefix: string;
  phoneRegister: UseFormRegisterReturn;
  prefixError?: FieldError;
  phoneError?: FieldError;
  disabled?: boolean;
  idPrefix?: string;
  /** Shown when no country selected yet */
  emptyPrefixHint?: string;
};

/**
 * Phone control: fixed country calling-code prefix + national number.
 * Prefix is derived from Location country — never a free-choice dial selector.
 */
export function PhoneField({
  phonePrefix,
  phoneRegister,
  prefixError,
  phoneError,
  disabled,
  idPrefix = "ph",
  emptyPrefixHint = "Select country first",
}: Props) {
  const prefix = (phonePrefix || "").trim();
  const hasPrefix = /^\+\d{1,4}$/.test(prefix);

  return (
    <div className="wlth-field">
      <label htmlFor={`${idPrefix}-number`}>Phone number</label>
      <div className="wlth-phone">
        <div
          className="wlth-phone__prefix wlth-phone__prefix--fixed"
          aria-label="Country calling code"
          title={
            hasPrefix
              ? `Calling code ${prefix} (from your country)`
              : emptyPrefixHint
          }
        >
          <span className="wlth-phone__prefix-value" id={`${idPrefix}-prefix`}>
            {hasPrefix ? prefix : "—"}
          </span>
        </div>
        <div className="wlth-phone__number">
          <input
            id={`${idPrefix}-number`}
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            placeholder={hasPrefix ? "Phone number" : emptyPrefixHint}
            aria-invalid={!!phoneError || !!prefixError}
            disabled={disabled || !hasPrefix}
            {...phoneRegister}
          />
        </div>
      </div>
      <div className="wlth-error">
        {prefixError?.message || phoneError?.message || "\u00a0"}
      </div>
    </div>
  );
}

/** Prefer locale dial code; otherwise empty (member must choose country). */
export function resolveDefaultPhonePrefix(
  countries: PhoneCountryOption[],
  locale?: string | null
): string {
  try {
    const loc =
      locale ||
      (typeof navigator !== "undefined" ? navigator.language : "") ||
      "";
    const region = loc.includes("-")
      ? loc.split("-").pop()?.toUpperCase()
      : loc.length === 2
        ? loc.toUpperCase()
        : "";
    if (region) {
      const hit = countries.find(
        (c) => (c.iso2 || "").toUpperCase() === region && c.dialCode
      );
      if (hit?.dialCode) return hit.dialCode;
    }
  } catch {
    /* ignore */
  }
  return "";
}

export function dialCodeForCountryCode(
  countries: PhoneCountryOption[],
  countryCode: string
): string | null {
  const c = countries.find((x) => x.code === countryCode);
  return c?.dialCode || null;
}

export function iso2ForCountryCode(
  countries: PhoneCountryOption[],
  countryCode: string
): string | null {
  const c = countries.find((x) => x.code === countryCode);
  const iso = (c?.iso2 || "").trim().toUpperCase();
  return iso.length === 2 ? iso : null;
}
