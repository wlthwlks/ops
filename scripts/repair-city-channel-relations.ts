/**
 * Repair Members → Cities → Slack channels relationships.
 *
 * Dry-run / audit by default. Writes require explicit apply flags + --confirm-apply.
 *
 *   npm run airtable:repair-city-relations -- --audit
 *   npm run airtable:repair-city-relations -- --dry-run
 *   npm run airtable:repair-city-relations -- --apply-city-records --confirm-apply
 *   npm run airtable:repair-city-relations -- --apply-channel-relations --confirm-apply
 *   npm run airtable:repair-city-relations -- --apply-member-links --confirm-apply
 *   npm run airtable:repair-city-relations -- --apply-all --confirm-apply
 */
import * as dotenv from "dotenv";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import {
  loadCityRelationConfig,
  validateCityRelationConfig,
  resolveFieldNames,
} from "../src/lib/ops/city-relation-config";
import {
  fieldStr,
  indexChannels,
  indexCities,
  linkedRecordIds,
  loadLiveSnapshots,
  mapPool,
  parseRepairArgs,
  pickCanonicalDuplicate,
  proposeChannelRelations,
  proposeCityRecords,
  proposeMemberLinks,
  sameIdSet,
  sleep,
  toCsv,
  toLinkedRecordWriteValue,
} from "../src/lib/ops/city-relation-repair";
import { normalizeCityKey } from "../src/lib/ops/city-normalize";

dotenv.config();

export { parseRepairArgs };

async function main() {
  const args = parseRepairArgs(process.argv.slice(2));
  const config = loadCityRelationConfig(args.configPath);
  const fields = resolveFieldNames(config);

  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    console.error("Missing AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID");
    process.exit(1);
  }

  console.log("=== City ↔ Channel relation repair ===");
  console.log(`Base: ${baseId}`);
  console.log(`Config: ${args.configPath}`);
  console.log(`Tables: ${fields.membersTable} | ${fields.citiesTable} | ${fields.channelsTable}`);
  console.log(
    `Member fields: legacy="${fields.memberCityLegacy}" link="${fields.memberCityLink}"`
  );
  console.log(
    `Flags: audit=${args.audit} dryRun=${args.dryRun} applyCities=${args.applyCityRecords} applyChannels=${args.applyChannelRelations} applyMembers=${args.applyMemberLinks} confirm=${args.confirmApply}`
  );
  console.log("");

  if (args.anyApply && !args.confirmApply) {
    console.error("Refusing to write: pass --confirm-apply together with an --apply-* flag.");
    process.exit(1);
  }

  const airtable = createAirtableClient({
    apiKey: token,
    baseId,
    rateLimitMinWaitMs: 1000,
    batchGapMs: 250,
  });

  console.log("Loading live Airtable snapshots...");
  const snap = await loadLiveSnapshots(airtable, fields);
  console.log(
    `Loaded members=${snap.members.length} cities=${snap.cities.length} channels=${snap.channels.length}`
  );

  const chIndex = indexChannels(snap.channels, fields);
  const validation = validateCityRelationConfig(config, {
    channelNames: chIndex.names,
    channelSlackIds: chIndex.slackIds,
    channelStatuses: chIndex.statuses,
  });

  if (!validation.ok) {
    console.error("Config validation failed:");
    for (const e of validation.errors) console.error(`  - ${e}`);
    // Audit/dry-run may continue with warnings so reports can still be produced.
    // Every apply mode must abort before any Airtable write.
    if (args.anyApply) {
      console.error(
        "\nAborting apply: fix configuration validation errors before writing to Airtable."
      );
      process.exit(1);
    }
    console.warn("Continuing audit/dry-run despite validation warnings (no writes)...");
  }

  // For audit reports after failed live validation, still build in-memory maps (no writes).
  const { buildCityToChannelMap } = await import("../src/lib/ops/city-normalize");
  const cityToChannel =
    validation.ok
      ? validation.validated.cityToChannel
      : buildCityToChannelMap(config.channelCityLinks);
  const knownCanonicals = new Set<string>();
  for (const cities of Object.values(config.channelCityLinks)) {
    for (const c of cities) knownCanonicals.add(c);
  }
  for (const c of config.citiesToCreate) knownCanonicals.add(c.city);
  const aliasKeys = new Map<string, string>(Object.entries(config.aliases || {}));
  const validated = validation.ok
    ? validation.validated
    : { ...config, cityToChannel, knownCanonicals, aliasKeys };

  const cityProposals = proposeCityRecords(snap.cities, validated as never, fields);
  const channelProposals = proposeChannelRelations(
    snap.cities,
    snap.channels,
    validated as never,
    fields
  );
  const { proposals: memberProposals, unresolved } = proposeMemberLinks(
    snap.members,
    snap.cities,
    validated as never,
    fields,
    { assignInvalidToVirtual: args.assignInvalidToVirtual }
  );

  const wouldCreateCities = cityProposals.filter((p) => p.action === "create").length;
  const wouldRenameCities = cityProposals.filter((p) => p.action === "rename").length;
  const wouldCountry = cityProposals.filter((p) => p.action === "country_override").length;
  const duplicates = cityProposals.filter((p) => p.action === "merge_duplicate").length;
  const channelUpdates = channelProposals.filter((p) => p.wouldUpdate).length;
  const memberUpdates = memberProposals.filter((p) => p.wouldUpdate).length;

  console.log("\n=== Proposed changes ===");
  console.log(`City creates: ${wouldCreateCities}`);
  console.log(`City renames: ${wouldRenameCities}`);
  console.log(`Country overrides: ${wouldCountry}`);
  console.log(`Duplicate city rows: ${duplicates}`);
  console.log(`Channel relation updates: ${channelUpdates}`);
  console.log(`Member link updates: ${memberUpdates}`);
  console.log(`Unresolved members: ${unresolved.length}`);
  console.log(
    `Active channels missing ID: ${[...chIndex.statuses.entries()].filter(([n, s]) => s.toLowerCase().includes("active") && !chIndex.slackIds.get(n)).length}`
  );
  console.log(
    `Paused/Closed without ID: ${[...chIndex.statuses.entries()].filter(([n, s]) => (s.toLowerCase().includes("paused") || s.toLowerCase().includes("closed")) && !chIndex.slackIds.get(n)).length}`
  );

  // Reports
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir =
    args.reportDir || join("reports", "city-relation-repair", stamp);
  mkdirSync(reportDir, { recursive: true });

  const summary = {
    baseId,
    configPath: args.configPath,
    generatedAt: new Date().toISOString(),
    counts: {
      members: snap.members.length,
      cities: snap.cities.length,
      channels: snap.channels.length,
      cityCreates: wouldCreateCities,
      cityRenames: wouldRenameCities,
      countryOverrides: wouldCountry,
      duplicates,
      channelUpdates,
      memberUpdates,
      unresolved: unresolved.length,
    },
    validationErrors: validation.ok ? [] : validation.errors,
  };
  writeFileSync(join(reportDir, "summary.json"), JSON.stringify(summary, null, 2));

  writeFileSync(
    join(reportDir, "cities-proposed.csv"),
    toCsv(
      ["action", "recordId", "beforeName", "afterName", "country", "reason", "safe"],
      cityProposals.map((p) => [
        p.action,
        p.recordId,
        p.beforeName,
        p.afterName,
        p.country,
        p.reason,
        String(p.safeToAutoApply),
      ])
    )
  );

  writeFileSync(
    join(reportDir, "channels-proposed.csv"),
    toCsv(
      [
        "channelRecordId",
        "channelName",
        "status",
        "slackChannelId",
        "beforeCount",
        "afterCount",
        "added",
        "wouldUpdate",
        "reason",
      ],
      channelProposals.map((p) => [
        p.channelRecordId,
        p.channelName,
        p.status,
        p.slackChannelId,
        String(p.beforeCityIds.length),
        String(p.afterCityIds.length),
        p.addedCityNames.join("|"),
        String(p.wouldUpdate),
        p.reason,
      ])
    )
  );

  writeFileSync(
    join(reportDir, "members-proposed.csv"),
    toCsv(
      [
        "airtableRecordId",
        "memberName",
        "email",
        "legacyCity",
        "proposedCanonical",
        "proposedCityRecordId",
        "proposedChannel",
        "via",
        "wouldUpdate",
        "reason",
      ],
      memberProposals.map((p) => [
        p.airtableRecordId,
        p.memberName,
        p.email,
        p.legacyCity,
        p.proposedCanonical,
        p.proposedCityRecordId,
        p.proposedChannelName,
        p.via,
        String(p.wouldUpdate),
        p.reason,
      ])
    )
  );

  writeFileSync(
    join(reportDir, "unresolved.csv"),
    toCsv(
      ["airtableRecordId", "memberName", "email", "legacyCity", "reason"],
      unresolved.map((p) => [
        p.airtableRecordId,
        p.memberName,
        p.email,
        p.legacyCity,
        p.manualReviewReason || p.reason,
      ])
    )
  );

  writeFileSync(
    join(reportDir, "channels-before.csv"),
    toCsv(
      ["id", "name", "status", "slackChannelId", "cityLinkCount"],
      snap.channels.map((c) => [
        c.id,
        fieldStr(c.fields, fields.channelName),
        fieldStr(c.fields, fields.channelStatus),
        fieldStr(c.fields, fields.channelSlackId),
        String(linkedRecordIds(c.fields, fields.channelCities).length),
      ])
    )
  );

  writeFileSync(
    join(reportDir, "cities-before.csv"),
    toCsv(
      ["id", "city", "country"],
      snap.cities.map((c) => [
        c.id,
        fieldStr(c.fields, fields.cityName),
        fieldStr(c.fields, fields.cityCountry),
      ])
    )
  );

  console.log(`\nReports written to ${reportDir}`);

  if (!args.anyApply) {
    console.log("\nNo writes performed (audit/dry-run).");
    return;
  }

  // ── APPLY ──
  const errors: string[] = [];
  let citiesCreated = 0;
  let citiesRenamed = 0;
  let countriesUpdated = 0;
  let channelsUpdated = 0;
  let membersUpdated = 0;
  let duplicatesMerged = 0;

  // 1) City records
  if (args.applyCityRecords) {
    console.log("\nApplying city record creates/renames/countries...");
    // Creates first
    for (const p of cityProposals.filter((x) => x.action === "create" && x.safeToAutoApply)) {
      try {
        // re-check existence
        const live = await airtable.listRecords(fields.citiesTable, {
          filterByFormula: `{${fields.cityName}} = "${p.afterName.replace(/"/g, '\\"')}"`,
          maxRecords: 1,
        });
        if (live.length > 0) {
          console.log(`  skip create (exists): ${p.afterName}`);
          continue;
        }
        await airtable.createRecords(fields.citiesTable, [
          {
            fields: {
              [fields.cityName]: p.afterName,
              ...(p.country ? { [fields.cityCountry]: p.country } : {}),
            },
          },
        ]);
        citiesCreated++;
        console.log(`  created city: ${p.afterName}`);
        await sleep(250);
      } catch (e) {
        errors.push(`create ${p.afterName}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Renames + country
    const updates = cityProposals.filter(
      (x) =>
        (x.action === "rename" || x.action === "country_override") &&
        x.safeToAutoApply &&
        x.recordId
    );
    const patch = updates.map((p) => {
      const f: Record<string, unknown> = {};
      if (p.action === "rename") f[fields.cityName] = p.afterName;
      if (p.action === "country_override" || p.country) f[fields.cityCountry] = p.country;
      return { id: p.recordId, fields: f };
    });
    if (patch.length) {
      try {
        await airtable.updateRecordsBatched(fields.citiesTable, patch, {
          batchSize: 10,
          gapMs: 250,
        });
        citiesRenamed += updates.filter((u) => u.action === "rename").length;
        countriesUpdated += updates.filter((u) => u.action === "country_override").length;
        console.log(`  updated ${patch.length} city record(s)`);
      } catch (e) {
        errors.push(`city updates: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Refresh cities after creates
    snap.cities = await airtable.listRecords(fields.citiesTable);
  }

  // 2) Merge duplicates (re-link members + channels to canonical)
  if (args.mergeDuplicates) {
    console.log("\nMerging duplicate city records...");
    const { byNormalizedName } = indexCities(snap.cities, fields.cityName);
    for (const dupName of config.duplicateCityNames) {
      const matches = byNormalizedName.get(normalizeCityKey(dupName)) || [];
      if (matches.length < 2) continue;
      const canonical = pickCanonicalDuplicate(matches, fields);
      const dupes = matches.filter((m) => m.id !== canonical.id);
      for (const d of dupes) {
        // Re-link members pointing at duplicate
        const membersToFix = snap.members.filter((m) =>
          linkedRecordIds(m.fields, fields.memberCityLink).includes(d.id)
        );
        const memberPatches = membersToFix.map((m) => {
          const ids = linkedRecordIds(m.fields, fields.memberCityLink).map((id) =>
            id === d.id ? canonical.id : id
          );
          return {
            id: m.id,
            fields: { [fields.memberCityLink]: toLinkedRecordWriteValue(ids) },
          };
        });
        if (memberPatches.length) {
          try {
            await airtable.updateRecordsBatched(fields.membersTable, memberPatches, {
              batchSize: 10,
              gapMs: 250,
            });
            duplicatesMerged += memberPatches.length;
          } catch (e) {
            errors.push(`dup member relink: ${e instanceof Error ? e.message : e}`);
          }
        }
        // Re-link channels
        for (const ch of snap.channels) {
          const ids = linkedRecordIds(ch.fields, fields.channelCities);
          if (!ids.includes(d.id)) continue;
          const next = ids.map((id) => (id === d.id ? canonical.id : id));
          const uniq = [...new Set(next)];
          try {
            await airtable.updateRecords(fields.channelsTable, [
              {
                id: ch.id,
                fields: { [fields.channelCities]: toLinkedRecordWriteValue(uniq) },
              },
            ]);
            await sleep(250);
          } catch (e) {
            errors.push(`dup channel relink: ${e instanceof Error ? e.message : e}`);
          }
        }

        if (args.deleteMergedDuplicates) {
          // Airtable REST has no bulk delete in our client — skip hard delete, report
          console.log(
            `  duplicate ${d.id} ready for manual delete (no destroy API in client)`
          );
        }
      }
    }
    snap.cities = await airtable.listRecords(fields.citiesTable);
    snap.members = await loadLiveSnapshots(airtable, fields).then((s) => s.members);
  }

  // 3) Channel relations (write Slack channels.Cities only)
  if (args.applyChannelRelations) {
    console.log("\nApplying channel ↔ city relations...");
    // refresh proposals with latest cities
    const freshChannelProposals = proposeChannelRelations(
      snap.cities,
      snap.channels,
      validated as never,
      fields
    );
    const toWrite = freshChannelProposals.filter((p) => p.wouldUpdate);
    let done = 0;
    for (const p of toWrite) {
      try {
        // re-fetch channel
        const fresh = await airtable.getRecord(fields.channelsTable, p.channelRecordId);
        const current = linkedRecordIds(fresh.fields, fields.channelCities);
        if (sameIdSet(current, p.afterCityIds)) {
          done++;
          continue;
        }
        await airtable.updateRecords(fields.channelsTable, [
          {
            id: p.channelRecordId,
            fields: {
              [fields.channelCities]: toLinkedRecordWriteValue(p.afterCityIds),
            },
          },
        ]);
        channelsUpdated++;
        done++;
        if (done % 5 === 0) console.log(`  channels ${done}/${toWrite.length}`);
        await sleep(250);
      } catch (e) {
        errors.push(
          `channel ${p.channelName}: ${e instanceof Error ? e.message : e}`
        );
      }
    }
    console.log(`  channel relations updated: ${channelsUpdated}`);
  }

  // 4) Member links
  if (args.applyMemberLinks) {
    console.log("\nApplying member City relation links...");
    console.log(
      `  Field: ${fields.membersTable}."${fields.memberCityLink}" → ${fields.citiesTable}`
    );

    // Prove the link field exists (recreated columns must match this exact name)
    try {
      await airtable.listRecords(fields.membersTable, {
        fields: [fields.memberCityLink],
        maxRecords: 1,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `\nMissing or inaccessible field "${fields.memberCityLink}" on ${fields.membersTable}.\n` +
          `Create it as: Link to another record → ${fields.citiesTable} (allow linking to only one record).\n` +
          `Exact name must be: ${fields.memberCityLink}\n` +
          `Or set AIRTABLE_MEMBER_CITY_LINK_FIELD to your field name.\n` +
          `Airtable error: ${msg}`
      );
      process.exit(1);
    }

    // Fresh load so current link values are accurate after column recreate
    snap.cities = await airtable.listRecords(fields.citiesTable);
    snap.members = await airtable.listRecords(fields.membersTable, {
      fields: [
        "Name",
        "email",
        fields.memberCityLegacy,
        fields.memberCityLink,
      ],
    });

    const { proposals: freshMembers, unresolved: freshUnresolved } = proposeMemberLinks(
      snap.members,
      snap.cities,
      validated as never,
      fields,
      { assignInvalidToVirtual: args.assignInvalidToVirtual }
    );

    writeFileSync(
      join(reportDir, "unresolved-after-cities.csv"),
      toCsv(
        ["airtableRecordId", "legacyCity", "reason"],
        freshUnresolved.map((u) => [u.airtableRecordId, u.legacyCity, u.reason])
      )
    );

    const alreadyOk = freshMembers.filter((p) => !p.wouldUpdate && p.safeToAutoApply).length;
    const toWrite = freshMembers.filter((p) => p.wouldUpdate && p.safeToAutoApply);
    console.log(
      `  proposals=${freshMembers.length} already_linked=${alreadyOk} to_write=${toWrite.length} unresolved=${freshUnresolved.length}`
    );

    if (toWrite.length === 0) {
      console.log("  No member City relation updates needed.");
    } else {
      // Validate first patch payload shape before bulk write
      const sample = toWrite[0];
      const samplePayload = toLinkedRecordWriteValue([sample.proposedCityRecordId]);
      if (samplePayload.length !== 1 || !samplePayload[0].startsWith("rec")) {
        console.error("Invalid linked-record payload — aborting member writes", samplePayload);
        process.exit(1);
      }
      console.log(
        `  sample: ${sample.airtableRecordId} "${sample.legacyCity}" → ${sample.proposedCanonical} (${samplePayload[0]})`
      );

      const patches = toWrite.map((p) => ({
        id: p.airtableRecordId,
        fields: {
          // Airtable REST: linked records = string IDs only
          [fields.memberCityLink]: toLinkedRecordWriteValue([p.proposedCityRecordId]),
        },
      }));

      try {
        const result = await airtable.updateRecordsBatchedDetailed(
          fields.membersTable,
          patches,
          {
            batchSize: 10,
            gapMs: 250,
            onBatch: (info) => {
              if (
                info.batchIndex === 1 ||
                info.batchIndex % 20 === 0 ||
                info.batchIndex === info.totalBatches ||
                info.status !== "ok"
              ) {
                console.log(
                  `  members batch ${info.batchIndex}/${info.totalBatches} ` +
                    `success=${info.successTotal}/${patches.length} ` +
                    `durationMs=${info.durationMs}` +
                    (info.error ? ` error=${info.error.slice(0, 120)}` : "")
                );
              }
            },
          }
        );
        membersUpdated = result.successIds.length;
        if (result.error) {
          errors.push(result.error.message);
          if (result.error.message.includes("Unknown field name")) {
            errors.push(
              `Create linked-record field "${fields.memberCityLink}" on ${fields.membersTable} (Link → ${fields.citiesTable}, allow one).`
            );
          }
          if (result.error.message.includes("[object Object]")) {
            errors.push(
              "Linked-record write used object shape; must be bare record ID strings."
            );
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(msg);
        console.error(`Member link apply failed: ${msg}`);
      }
    }
    console.log(`  members updated: ${membersUpdated}`);
  }

  writeFileSync(
    join(reportDir, "errors.json"),
    JSON.stringify({ errors, citiesCreated, citiesRenamed, countriesUpdated, channelsUpdated, membersUpdated, duplicatesMerged }, null, 2)
  );

  console.log("\n=== Apply complete ===");
  console.log(`Cities created: ${citiesCreated}`);
  console.log(`Cities renamed: ${citiesRenamed}`);
  console.log(`Countries updated: ${countriesUpdated}`);
  console.log(`Channels updated: ${channelsUpdated}`);
  console.log(`Members updated: ${membersUpdated}`);
  console.log(`Errors: ${errors.length}`);
  if (errors.length) {
    console.error(errors.slice(0, 20).join("\n"));
    process.exitCode = 1;
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("repair-city-channel-relations.ts") ||
    process.argv[1].includes("repair-city-channel-relations"));

if (isMain) {
  main().catch((e) => {
    console.error("Fatal:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
