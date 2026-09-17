# Research Dataset Summary (Plain English)

Generated 2026-09-17.

**A. Final cohort size:** 2291 members.
**B. Qualifying AI-generated introductions:** 766 introduction groups (2297 delivery emails, 1 monthly cycle — 88 city runs).
**C. Historical date range:** AI-assisted introductions 2026-09-01 to 2026-09-01. Legacy (pre-AI) introduction history used for controls: 2025-05 to 2026-05.
**D. Maximum follow-up available:** 16 days (as of 2026-09-17).
**E. Is genuine six-month retention measurable?** NO. The first AI-assisted cycle was sent on 2026-09-01, so not even 30-day retention is observable yet. All retained_30d..retained_180d values are NULL (not observable). A six-month variable was NOT fabricated. Interim outcomes are provided instead: valid_access_at_analysis_date and days_from_index_to_service_end.
**F. Most reliable engagement measures available:** introduction delivery (intro_delivered_count, successful_delivery_rate). Provider open/click events and reply data do not exist in the data. Future re-runs will add subsequent-cycle participation as it accumulates.
**G. Most reliable retention measure:** the production service-access rule (Service access until >= date; paused blocks) evaluated at the analysis date, plus days_from_index_to_service_end. Once follow-up matures, retained_30d..retained_180d will become observable.
**H. Major dataset limitations:** (1) only one AI-assisted matching cycle has occurred (~16 days of follow-up) so retention/engagement outcomes are essentially unobservable today; (2) engagement tracking beyond 'email sent' does not exist; (3) legacy onboarding match history is unavailable; (4) retention uses the current Airtable billing snapshot, which cannot reconstruct interim gaps.
**I. Recommended variables:**
- Independent (exposure): ai_intro_count_total, average_ai_correlation_score, average_pair_score, matching_algorithm_version, unique_members_introduced_count, average_group_size, first_vs_recurring_intro.
- Dependent (engagement): intro_delivered_count, successful_delivery_rate (later: subsequent cycle participation counts).
- Dependent (retention): retained_30d..retained_180d (once observable), days_from_index_to_service_end, valid_access_at_analysis_date.
- Controls: membership_tenure_days_at_index, matching_pool_size, network_density_category, number_of_previous_introductions, index_ai_intro_month, repeat_match_count.
