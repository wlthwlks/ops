# Extraction Methodology

Generated 2026-09-17.

## 1. Data sources (all read-only)

- Neon/Postgres (`introduction_runs`, `introduction_groups`, `introduction_group_members`, `introduction_deliveries`, `introduction_pair_scores`, `matching_profile_versions`) — unified AI-assisted introduction engine ledger.
- Airtable `MEMBERS` (read-only GET token) — membership, payment and service-access fields.
- Airtable `MATCH GROUPS` — legacy pre-AI introduction history (2025-05 → 2026-05).

## 2. Eligibility criteria

Included: member record appearing in at least one sent group of a production (delivery_mode=production, status=completed) AI-assisted run, with a valid delivery send date, matching an Airtable member record.

Excluded (in order): no recorded delivery send date; Airtable record id absent from MEMBERS; duplicate identity rows (same normalized email — one keeper per email); test/internal/placeholder emails (staff domain, placeholder domains, test/demo/fake local-parts).

Cancelled and paused members were retained deliberately.

## 3. Unit of analysis

One row per member. The index (reference) date is the member's first AI-assisted introduction email send date (introduction_deliveries.sent_at).

## 4. Anonymisation process

All joins use internal identifiers (Airtable record ids / emails) in memory. After all variables are computed, identifiers are discarded. Rows are shuffled with cryptographic randomness and assigned sequential research_ids (R000001...). No mapping between research_id and any identifier is written anywhere. City is reduced to a quartile density category; no free-text fields are exported.

## 5. Variable definitions

See data_dictionary.csv (derivation and source field documented per variable).

## 6. Retention calculations

Production V2 service-access rule: valid access at reference date D ⇔ stored `Service access until` (Stripe-derived, monotonic) >= D AND `Stripe subscription status` != 'paused'. retained_Nd is 1/0 by this rule at index + N days; NULL when index + N days is after the analysis date (insufficient observation time). days_from_index_to_service_end uses the stored access end date when it lies in the past; otherwise NULL (censored).

## 7. Duplicate handling

Ledger-level duplicates are prevented by unique indexes (verified: no duplicate group-member rows). Member-level identity duplicates (same normalized email across Airtable rows) are collapsed to one keeper (lowest record id); removed rows are counted in the quality report.

## 8. Missing-data handling

No imputation. Missing inputs produce NULL variables. Negative membership tenure (impossible dates) is set to NULL and counted in the quality report. Negative days_from_index_to_service_end (access ended before the index introduction) is set to NULL and counted in the quality report. Members with insufficient follow-up receive NULL retention outcomes.

## 9. Data-quality validation

All checks (missing values, duplicates, impossible dates, intro-after-service-end, distributions) are computed in the same read-only run and reported in research_data_quality_report.md. Anomalies are flagged, not silently corrected.
