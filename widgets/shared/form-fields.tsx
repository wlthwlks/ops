import type { ReactNode } from "react";
import { MultiSelectDropdown } from "./MultiSelectDropdown";

export function FieldError({ message }: { message?: string }) {
  return <div className="wlth-error">{message || "\u00a0"}</div>;
}

type Opt = { code: string; label: string };

export function LocationFields(props: {
  countries: Array<{ code: string; label: string }>;
  cities: Array<{ code: string; label: string }>;
  countryRegister: Record<string, unknown>;
  cityRegister: Record<string, unknown>;
  countryError?: string;
  cityError?: string;
  previousCityUnavailable?: boolean;
  previousCityLabel?: string;
}) {
  return (
    <>
      {props.previousCityUnavailable ? (
        <div className="wlth-banner-error" role="status">
          Your previous location
          {props.previousCityLabel ? ` (${props.previousCityLabel})` : ""} is no longer
          available for new selections. Please choose a current city so we can keep your
          introductions local and relevant.
        </div>
      ) : null}
      <div className="wlth-grid-2">
        <div className="wlth-field">
          <label htmlFor="wlth-country">Country</label>
          <select id="wlth-country" aria-invalid={!!props.countryError} {...props.countryRegister}>
            <option value="">Select country</option>
            {props.countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
          <FieldError message={props.countryError} />
        </div>
        <div className="wlth-field">
          <label htmlFor="wlth-city">City</label>
          <select id="wlth-city" aria-invalid={!!props.cityError} {...props.cityRegister}>
            <option value="">Select city</option>
            {props.cities.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
          <FieldError message={props.cityError} />
        </div>
      </div>
    </>
  );
}

export function AvailabilityFields(props: {
  options: Opt[];
  selected: string[];
  onToggle: (code: string) => void;
  error?: string;
}) {
  return (
    <>
      <p className="wlth-muted">When are you generally free to connect?</p>
      <div className="wlth-check-grid">
        {props.options.map((o) => (
          <label key={o.code} className="wlth-check">
            <input
              type="checkbox"
              checked={props.selected.includes(o.code)}
              onChange={() => props.onToggle(o.code)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      <FieldError message={props.error} />
    </>
  );
}

export function BusinessFields(props: {
  industries: Opt[];
  stages: Opt[];
  revenues: Opt[];
  primaryIndustry: string;
  industryRegister: Record<string, unknown>;
  otherIndustryRegister: Record<string, unknown>;
  stageRegister: Record<string, unknown>;
  revenueRegister: Record<string, unknown>;
  descriptionRegister: Record<string, unknown>;
  industryError?: string;
  otherIndustryError?: string;
  stageError?: string;
  revenueError?: string;
  descriptionError?: string;
  showDescription?: boolean;
}) {
  const showOther = props.primaryIndustry === "OTHER";
  return (
    <>
      <div className="wlth-field">
        <label htmlFor="wlth-ind">Primary industry</label>
        <select id="wlth-ind" {...props.industryRegister}>
          <option value="">Select</option>
          {props.industries.map((i) => (
            <option key={i.code} value={i.code}>
              {i.label}
            </option>
          ))}
        </select>
        <FieldError message={props.industryError} />
      </div>
      {showOther ? (
        <div className="wlth-field">
          <label htmlFor="wlth-other-ind">Tell us your industry</label>
          <input
            id="wlth-other-ind"
            maxLength={120}
            placeholder="e.g. Sustainable fashion consultancy"
            {...props.otherIndustryRegister}
          />
          <FieldError message={props.otherIndustryError} />
        </div>
      ) : null}
      <div className="wlth-field">
        <label htmlFor="wlth-stage">Business stage</label>
        <select id="wlth-stage" {...props.stageRegister}>
          <option value="">Select</option>
          {props.stages.map((i) => (
            <option key={i.code} value={i.code}>
              {i.label}
            </option>
          ))}
        </select>
        <FieldError message={props.stageError} />
      </div>
      <div className="wlth-field">
        <label htmlFor="wlth-rev">Approximate annual revenue</label>
        <select id="wlth-rev" {...props.revenueRegister}>
          <option value="">Select</option>
          {props.revenues.map((i) => (
            <option key={i.code} value={i.code}>
              {i.label}
            </option>
          ))}
        </select>
        <FieldError message={props.revenueError} />
      </div>
      {props.showDescription !== false ? (
        <div className="wlth-field">
          <label htmlFor="wlth-desc">What does your business do, and who does it help?</label>
          <textarea id="wlth-desc" rows={4} {...props.descriptionRegister} />
          <FieldError message={props.descriptionError} />
        </div>
      ) : null}
    </>
  );
}

export function MatchingGoalField(props: {
  register: Record<string, unknown>;
  error?: string;
}) {
  return (
    <div className="wlth-field">
      <label htmlFor="wlth-goal">What is your most important goal for the next 90 days?</label>
      <textarea id="wlth-goal" rows={4} {...props.register} />
      <FieldError message={props.error} />
    </div>
  );
}

export function MatchingMultiSelectFields(props: {
  helpOptions: Opt[];
  expertiseOptions: Opt[];
  helpWanted: string[];
  expertiseOffered: string[];
  onHelpChange: (next: string[]) => void;
  onExpertiseChange: (next: string[]) => void;
  helpContextRegister: Record<string, unknown>;
  expertiseContextRegister: Record<string, unknown>;
  helpError?: string;
  expertiseError?: string;
  showHelp?: boolean;
  showExpertise?: boolean;
}) {
  return (
    <>
      {props.showHelp !== false ? (
        <>
          <MultiSelectDropdown
            label="Where would support make the biggest difference?"
            helperText="Choose up to three areas; we'll use these to shape introductions."
            options={props.helpOptions}
            value={props.helpWanted}
            onChange={props.onHelpChange}
            max={3}
            placeholder="Add an area of help"
            error={props.helpError}
          />
          <div className="wlth-field">
            <label htmlFor="wlth-hw-ctx">Anything you’d like to add? (optional)</label>
            <textarea id="wlth-hw-ctx" rows={2} {...props.helpContextRegister} />
          </div>
        </>
      ) : null}
      {props.showExpertise !== false ? (
        <>
          <MultiSelectDropdown
            label="What expertise can you offer others?"
            helperText="Choose up to five strengths you’re happy to share."
            options={props.expertiseOptions}
            value={props.expertiseOffered}
            onChange={props.onExpertiseChange}
            max={5}
            placeholder="Add an area of expertise"
            error={props.expertiseError}
          />
          <div className="wlth-field">
            <label htmlFor="wlth-ex-ctx">Anything you’d like to add? (optional)</label>
            <textarea id="wlth-ex-ctx" rows={2} {...props.expertiseContextRegister} />
          </div>
        </>
      ) : null}
    </>
  );
}

export function ConnectionTypeField(props: {
  options: Opt[];
  register: Record<string, unknown>;
  error?: string;
}) {
  return (
    <div className="wlth-field">
      <label htmlFor="wlth-ct">Which kind of connection would help you most right now?</label>
      <select id="wlth-ct" {...props.register}>
        <option value="">Select</option>
        {props.options.map((c) => (
          <option key={c.code} value={c.code}>
            {c.label}
          </option>
        ))}
      </select>
      <FieldError message={props.error} />
    </div>
  );
}

export function CommunityIntentionCard(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  error?: string;
}): ReactNode {
  return (
    <div className={`wlth-intention${props.error ? " is-invalid" : ""}`}>
      <p className="wlth-intention__lead">
        WLTH WLKS is a community for meaningful relationships, shared experience and mutual
        growth. It is not a lead list or sales channel.
      </p>
      <label className="wlth-intention__check">
        <input
          type="checkbox"
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
        />
        <span>
          I confirm that I'm a woman building, leading, or growing a business, and that I'm
          joining WLTH WLKS to connect, contribute and grow; not to cold-sell or promote
          products to other members.
        </span>
      </label>
      <FieldError message={props.error} />
    </div>
  );
}
