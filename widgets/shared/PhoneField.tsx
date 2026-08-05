import { useMemo } from "react";
import type { FieldError, UseFormRegisterReturn } from "react-hook-form";

export type PhoneCountryOption = {
  code: string;
  label: string;
  iso2?: string | null;
  dialCode?: string | null;
};

type Props = {
  countries: PhoneCountryOption[];
  phonePrefix: string;
  phoneRegister: UseFormRegisterReturn;
  onPrefixChange: (dialCode: string, meta?: { manual?: boolean }) => void;
  prefixError?: FieldError;
  phoneError?: FieldError;
  disabled?: boolean;
  idPrefix?: string;
};

/**
 * Compound phone control: country calling-code selector + national number.
 * Prefix values are international dial codes only (+64), never city area codes.
 */
export function PhoneField({
  countries,
  phonePrefix,
  phoneRegister,
  onPrefixChange,
  prefixError,
  phoneError,
  disabled,
  idPrefix = "ph",
}: Props) {
  const dialOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: Array<{ dialCode: string; label: string }> = [];
    for (const c of countries) {
      const dial = (c.dialCode || "").trim();
      if (!dial || !/^\+\d{1,4}$/.test(dial)) continue;
      const key = `${dial}|${c.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      opts.push({ dialCode: dial, label: c.label });
    }
    opts.sort((a, b) => a.label.localeCompare(b.label));
    return opts;
  }, [countries]);

  const uniqueDial = useMemo(() => {
    const byDial = new Map<string, { dialCode: string; labels: string[] }>();
    for (const o of dialOptions) {
      const cur = byDial.get(o.dialCode);
      if (cur) cur.labels.push(o.label);
      else byDial.set(o.dialCode, { dialCode: o.dialCode, labels: [o.label] });
    }
    return [...byDial.values()].sort((a, b) => {
      const la = a.labels[0] || a.dialCode;
      const lb = b.labels[0] || b.dialCode;
      return la.localeCompare(lb);
    });
  }, [dialOptions]);

  return (
    <div className="wlth-field">
      <label htmlFor={`${idPrefix}-number`}>Phone number</label>
      <div className="wlth-phone">
        <div className="wlth-phone__prefix">
          <label className="wlth-sr-only" htmlFor={`${idPrefix}-prefix`}>
            Country calling code
          </label>
          <select
            id={`${idPrefix}-prefix`}
            value={phonePrefix || ""}
            disabled={disabled}
            aria-invalid={!!prefixError}
            onChange={(e) => onPrefixChange(e.target.value, { manual: true })}
          >
            <option value="">Code</option>
            {uniqueDial.map((o) => (
              <option key={o.dialCode} value={o.dialCode}>
                {o.labels[0]} ({o.dialCode})
              </option>
            ))}
          </select>
        </div>
        <div className="wlth-phone__number">
          <input
            id={`${idPrefix}-number`}
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            placeholder="Phone number"
            aria-invalid={!!phoneError}
            disabled={disabled}
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

/** Prefer locale dial code; otherwise empty (member must choose). */
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
