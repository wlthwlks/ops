/**
 * Read-only audit: load live development location catalogue and report
 * countries that cannot map to ISO2 + calling code.
 *
 *   npx tsx scripts/audit-phone-country-mapping.ts
 */
import "dotenv/config";
import {
  auditCountryPhoneMappings,
  loadLocationCatalog,
  REQUIRED_PHONE_COUNTRY_LABELS,
  resolveCountryDialCode,
} from "../src/lib/forms/reference-data";

async function main() {
  console.log("Loading location catalogue (read-only)…");
  const catalog = await loadLocationCatalog(undefined, { force: true });
  console.log(
    `Source: ${catalog.source} · countries: ${catalog.countries.length} · fetchedAt: ${catalog.fetchedAt}`
  );

  const { mapped, unmapped } = auditCountryPhoneMappings(catalog.countries);

  console.log("\n=== Mapped countries ===");
  for (const m of mapped) {
    console.log(`  ${m.label.padEnd(28)} ${m.iso2}  ${m.dialCode}`);
  }

  console.log("\n=== Unmapped countries (need deliberate resolver entry) ===");
  if (unmapped.length === 0) {
    console.log("  (none)");
  } else {
    for (const u of unmapped) {
      console.log(`  ${u.label} (${u.code})`);
    }
  }

  console.log("\n=== Required product labels ===");
  let requiredOk = true;
  for (const label of REQUIRED_PHONE_COUNTRY_LABELS) {
    const { iso2, dialCode } = resolveCountryDialCode(label);
    const ok = Boolean(iso2 && dialCode);
    if (!ok) requiredOk = false;
    console.log(`  ${ok ? "OK" : "FAIL"}  ${label} → ${iso2 || "?"} ${dialCode || "?"}`);
  }

  if (unmapped.length > 0 || !requiredOk) {
    console.error("\nAudit incomplete — resolve unmapped labels before relying on phone defaults.");
    process.exitCode = 1;
  } else {
    console.log("\nAudit passed.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
