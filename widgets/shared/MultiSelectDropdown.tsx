import { useEffect, useId, useMemo, useRef, useState } from "react";

export type MultiSelectOption = { code: string; label: string };

type Props = {
  id?: string;
  label: string;
  options: MultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  max: number;
  placeholder?: string;
  helperText?: string;
  disabled?: boolean;
  error?: string;
};

export function MultiSelectDropdown({
  id: idProp,
  label,
  options,
  value,
  onChange,
  max,
  placeholder = "Select an option",
  helperText,
  disabled,
  error,
}: Props) {
  const autoId = useId();
  const id = idProp || autoId;
  const listId = `${id}-listbox`;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selectedSet = useMemo(() => new Set(value), [value]);
  const available = useMemo(
    () => options.filter((o) => !selectedSet.has(o.code)),
    [options, selectedSet]
  );
  const labelByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of options) m.set(o.code, o.label);
    return m;
  }, [options]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const atMax = value.length >= max;

  const add = (code: string) => {
    if (atMax || selectedSet.has(code)) return;
    onChange([...value, code]);
    setOpen(false);
  };

  const remove = (code: string) => {
    onChange(value.filter((c) => c !== code));
  };

  return (
    <div className="wlth-field wlth-ms" ref={rootRef}>
      <label id={`${id}-label`} htmlFor={id}>
        {label}
      </label>
      {helperText ? <p className="wlth-muted">{helperText}</p> : null}
      <p className="wlth-ms__count" aria-live="polite">
        {value.length} of {max} selected
        {atMax ? " · maximum reached" : ""}
      </p>
      <div className="wlth-ms__control">
        <button
          type="button"
          id={id}
          className="wlth-ms__trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-labelledby={`${id}-label`}
          disabled={disabled || atMax}
          onClick={() => setOpen((o) => !o)}
        >
          {atMax ? "Maximum selections reached" : placeholder}
          <span className="wlth-ms__chevron" aria-hidden>
            ▾
          </span>
        </button>
        {open && !atMax ? (
          <ul
            id={listId}
            className="wlth-ms__list"
            role="listbox"
            aria-labelledby={`${id}-label`}
            aria-multiselectable="true"
          >
            {available.length === 0 ? (
              <li className="wlth-ms__empty">No more options</li>
            ) : (
              available.map((o) => (
                <li key={o.code} role="option" aria-selected="false">
                  <button
                    type="button"
                    className="wlth-ms__option"
                    onClick={() => add(o.code)}
                  >
                    {o.label}
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>
      {value.length > 0 ? (
        <ul className="wlth-ms__chips" aria-label={`${label} selected`}>
          {value.map((code) => (
            <li key={code} className="wlth-ms__chip">
              <span>{labelByCode.get(code) || code}</span>
              <button
                type="button"
                className="wlth-ms__chip-remove"
                aria-label={`Remove ${labelByCode.get(code) || code}`}
                onClick={() => remove(code)}
                disabled={disabled}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <div className="wlth-error">{error}</div> : null}
    </div>
  );
}
