import { describe, it, expect } from "vitest";
import {
  buildAssignedCustomerIds,
  canStillApply,
  classifyCandidate,
  groupByNormalizedEmail,
  isManualReviewStatus,
  isValidEmail,
  normalizeEmailStrict,
  parseReconcileArgs,
  rowsToCsv,
  type AirtableMemberCandidate,
  type StripeCustomerCandidate,
} from "@/lib/billing/reconcile-stripe-customers";

function member(partial: Partial<AirtableMemberCandidate> & { recordId: string }): AirtableMemberCandidate {
  const email = partial.email ?? "";
  return {
    recordId: partial.recordId,
    name: partial.name ?? "Test",
    email,
    normalizedEmail: email ? normalizeEmailStrict(email) : "",
    slackEmail: partial.slackEmail ?? "",
    existingStripeCustomerId: partial.existingStripeCustomerId ?? "",
    serviceAccessUntil: partial.serviceAccessUntil ?? "",
  };
}

function stripe(partial: Partial<StripeCustomerCandidate> & { id: string }): StripeCustomerCandidate {
  const email = partial.email ?? "a@ex.com";
  return {
    id: partial.id,
    email,
    normalizedEmail: normalizeEmailStrict(email),
    created: partial.created ?? 1,
    livemode: partial.livemode ?? false,
  };
}

const billingOk = {
  ok: true,
  hasPaidInvoices: true,
  hasQualifyingMembership: true,
  latestPaidThroughIso: "2026-10-01T00:00:00.000Z",
  periodValid: true,
};

describe("normalizeEmailStrict / isValidEmail", () => {
  it("trims and lowercases only", () => {
    expect(normalizeEmailStrict("  Person@Example.COM ")).toBe("person@example.com");
  });
  it("does not remove plus aliases", () => {
    expect(normalizeEmailStrict("a+tag@gmail.com")).toBe("a+tag@gmail.com");
  });
  it("does not remove gmail dots", () => {
    expect(normalizeEmailStrict("a.b@gmail.com")).toBe("a.b@gmail.com");
  });
  it("rejects blank and malformed", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("ok@ex.com")).toBe(true);
  });
});

describe("parseReconcileArgs", () => {
  it("defaults to dry-run", () => {
    expect(parseReconcileArgs([]).dryRun).toBe(true);
    expect(parseReconcileArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseReconcileArgs(["--apply"]).dryRun).toBe(false);
  });
  it("parses filters", () => {
    const a = parseReconcileArgs([
      "--email=a@b.com",
      "--airtable-record-id=rec1",
      "--limit=5",
      "--output=tmp/out.csv",
    ]);
    expect(a.email).toBe("a@b.com");
    expect(a.airtableRecordId).toBe("rec1");
    expect(a.limit).toBe(5);
    expect(a.output).toBe("tmp/out.csv");
  });
});

describe("classifyCandidate", () => {
  it("already_has_customer_id", () => {
    const r = classifyCandidate({
      member: member({ recordId: "r1", email: "a@ex.com", existingStripeCustomerId: "cus_1" }),
      airtableRecordsForEmail: 1,
      stripeCandidates: [],
      assignedElsewhere: new Set(),
    });
    expect(r.matchStatus).toBe("already_has_customer_id");
    expect(r.wouldUpdate).toBe(false);
  });

  it("slack_email_only", () => {
    const r = classifyCandidate({
      member: member({ recordId: "r1", email: "", slackEmail: "s@ex.com" }),
      airtableRecordsForEmail: 0,
      stripeCandidates: [],
      assignedElsewhere: new Set(),
    });
    expect(r.matchStatus).toBe("slack_email_only");
  });

  it("duplicate_airtable_email is ambiguous", () => {
    const r = classifyCandidate({
      member: member({ recordId: "r1", email: "a@ex.com" }),
      airtableRecordsForEmail: 2,
      stripeCandidates: [stripe({ id: "cus_1", email: "a@ex.com" })],
      assignedElsewhere: new Set(),
      billing: billingOk,
    });
    expect(r.matchStatus).toBe("duplicate_airtable_email");
    expect(r.wouldUpdate).toBe(false);
  });

  it("multiple_stripe_customers is ambiguous", () => {
    const r = classifyCandidate({
      member: member({ recordId: "r1", email: "a@ex.com" }),
      airtableRecordsForEmail: 1,
      stripeCandidates: [
        stripe({ id: "cus_1", email: "a@ex.com" }),
        stripe({ id: "cus_2", email: "a@ex.com" }),
      ],
      assignedElsewhere: new Set(),
      billing: billingOk,
    });
    expect(r.matchStatus).toBe("multiple_stripe_customers");
    expect(r.candidateStripeCustomerIds).toContain("cus_1");
    expect(r.candidateStripeCustomerIds).toContain("cus_2");
  });

  it("blocks already assigned stripe customer", () => {
    const r = classifyCandidate({
      member: member({ recordId: "r1", email: "a@ex.com" }),
      airtableRecordsForEmail: 1,
      stripeCandidates: [stripe({ id: "cus_1", email: "a@ex.com" })],
      assignedElsewhere: new Set(["cus_1"]),
      billing: billingOk,
    });
    expect(r.matchStatus).toBe("stripe_customer_already_assigned");
  });

  it("auto_match when all rules pass", () => {
    const r = classifyCandidate({
      member: member({ recordId: "r1", email: "a@ex.com" }),
      airtableRecordsForEmail: 1,
      stripeCandidates: [stripe({ id: "cus_1", email: "a@ex.com" })],
      assignedElsewhere: new Set(),
      billing: billingOk,
    });
    expect(r.matchStatus).toBe("auto_match");
    expect(r.wouldUpdate).toBe(true);
    expect(r.suggestedStripeCustomerId).toBe("cus_1");
  });

  it("no_paid_invoices", () => {
    const r = classifyCandidate({
      member: member({ recordId: "r1", email: "a@ex.com" }),
      airtableRecordsForEmail: 1,
      stripeCandidates: [stripe({ id: "cus_1", email: "a@ex.com" })],
      assignedElsewhere: new Set(),
      billing: {
        ok: true,
        hasPaidInvoices: false,
        hasQualifyingMembership: false,
        latestPaidThroughIso: null,
        periodValid: false,
      },
    });
    expect(r.matchStatus).toBe("no_paid_invoices");
  });

  it("no_qualifying_membership_invoice", () => {
    const r = classifyCandidate({
      member: member({ recordId: "r1", email: "a@ex.com" }),
      airtableRecordsForEmail: 1,
      stripeCandidates: [stripe({ id: "cus_1", email: "a@ex.com" })],
      assignedElsewhere: new Set(),
      billing: {
        ok: true,
        hasPaidInvoices: true,
        hasQualifyingMembership: false,
        latestPaidThroughIso: null,
        periodValid: false,
      },
    });
    expect(r.matchStatus).toBe("no_qualifying_membership_invoice");
  });

  it("stripe_error not treated as no match silently", () => {
    const r = classifyCandidate({
      member: member({ recordId: "r1", email: "a@ex.com" }),
      airtableRecordsForEmail: 1,
      stripeCandidates: [stripe({ id: "cus_1", email: "a@ex.com" })],
      assignedElsewhere: new Set(),
      billing: {
        ok: false,
        error: "timeout",
        hasPaidInvoices: false,
        hasQualifyingMembership: false,
        latestPaidThroughIso: null,
        periodValid: false,
      },
    });
    expect(r.matchStatus).toBe("stripe_error");
    expect(r.reason).toContain("timeout");
  });
});

describe("canStillApply", () => {
  const row = classifyCandidate({
    member: member({ recordId: "r1", email: "a@ex.com" }),
    airtableRecordsForEmail: 1,
    stripeCandidates: [stripe({ id: "cus_1", email: "a@ex.com" })],
    assignedElsewhere: new Set(),
    billing: billingOk,
  });

  it("allows clean apply", () => {
    expect(
      canStillApply({
        row,
        currentExistingId: "",
        assignedElsewhere: new Set(),
        currentNormalizedEmail: "a@ex.com",
      }).ok
    ).toBe(true);
  });

  it("blocks if id already set", () => {
    const r = canStillApply({
      row,
      currentExistingId: "cus_other",
      assignedElsewhere: new Set(),
      currentNormalizedEmail: "a@ex.com",
    });
    expect(r.ok).toBe(false);
  });
});

describe("groupByNormalizedEmail / buildAssignedCustomerIds", () => {
  it("groups case-insensitively via normalized field", () => {
    const map = groupByNormalizedEmail([
      member({ recordId: "r1", email: "A@Ex.com" }),
      member({ recordId: "r2", email: "a@ex.com" }),
    ]);
    // both normalize to a@ex.com
    expect(map.get("a@ex.com")?.length).toBe(2);
  });

  it("collects assigned cus ids", () => {
    const set = buildAssignedCustomerIds([
      { existingStripeCustomerId: "cus_1" },
      { existingStripeCustomerId: "" },
      { existingStripeCustomerId: "not_cus" },
    ]);
    expect(set.has("cus_1")).toBe(true);
    expect(set.size).toBe(1);
  });
});

describe("rowsToCsv", () => {
  it("includes headers and escapes", () => {
    const csv = rowsToCsv([
      {
        airtableRecordId: "rec1",
        memberName: 'Name, "x"',
        airtableEmail: "a@ex.com",
        slackEmail: "",
        existingStripeCustomerId: "",
        suggestedStripeCustomerId: "cus_1",
        stripeEmail: "a@ex.com",
        matchStatus: "auto_match",
        reason: "ok",
        stripeCustomerCountForEmail: 1,
        airtableRecordCountForEmail: 1,
        latestQualifyingPaidThrough: "2026-01-01T00:00:00.000Z",
        currentServiceAccessUntil: "",
        wouldUpdate: true,
        updated: false,
        candidateStripeCustomerIds: "cus_1",
      },
    ]);
    expect(csv).toContain("airtableRecordId");
    expect(csv).toContain("auto_match");
    expect(csv).not.toMatch(/sk_live|whsec_|pat/);
  });
});

describe("isManualReviewStatus", () => {
  it("flags ambiguous statuses", () => {
    expect(isManualReviewStatus("multiple_stripe_customers")).toBe(true);
    expect(isManualReviewStatus("auto_match")).toBe(false);
    expect(isManualReviewStatus("already_has_customer_id")).toBe(false);
  });
});
