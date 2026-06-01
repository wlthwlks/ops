/**
 * Traction → businessStage mapping.
 * Keys use regular hyphens to match Airtable's actual values (e.g., "$50k-$100k").
 */
export const TRACTION_TO_STAGE: ReadonlyMap<string, string> = new Map([
  ["$0", "Pre-Revenue"],
  ["$0-$10k", "Idea Validation"],
  ["$10k-$50k", "Early Traction"],
  ["$50k-$100k", "Initial Product-Market Fit"],
  ["$100k-$500k", "Growing Traction"],
  ["$500k-$1M", "Strong Traction"],
  ["$1M-$2M", "Early Scale"],
  ["$2M-$5M", "Scaling"],
  ["$5M-$10M", "Rapid Growth"],
  ["$10M-$20M", "Expansion Stage"],
  ["$20M+", "Established Scale"],
]);

export const PERSONAL_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  "gmail.com", "googlemail.com",
  // Microsoft
  "hotmail.com", "outlook.com", "live.com", "msn.com", "hotmail.co.uk",
  // Yahoo
  "yahoo.com", "yahoo.co.uk", "yahoo.co.in", "ymail.com", "rocketmail.com",
  // Apple
  "icloud.com", "me.com", "mac.com",
  // AOL / legacy
  "aol.com", "aim.com",
  // Privacy-focused
  "protonmail.com", "proton.me", "tutanota.com", "tutamail.com",
  // Other common
  "zoho.com", "mail.com", "gmx.com", "gmx.net",
  "inbox.com", "fastmail.com", "hushmail.com",
  // Regional
  "qq.com", "163.com", "126.com",
  "yandex.com", "yandex.ru",
  "web.de", "t-online.de",
  "libero.it", "virgilio.it",
  "laposte.net", "orange.fr", "free.fr",
  "btinternet.com", "sky.com", "virginmedia.com",
]);

