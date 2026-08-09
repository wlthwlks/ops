import { describe, it, expect } from "vitest";
import {
  normalizeHttpUrl,
  normalizeBusinessWebsite,
  normalizeSocialUrl,
  normalizeBusinessName,
  normalizeProfessionalHeadline,
  normalizeProfileBio,
  serializeSocialMediaField,
  parseSocialMediaField,
  findDuplicateSocialPlatforms,
  isSocialPlatform,
} from "@/lib/forms/validation/profile-urls";

describe("normalizeHttpUrl", () => {
  it("accepts bare domains and prepends https://", () => {
    const r = normalizeHttpUrl("example.com");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://example.com");
  });

  it("accepts www prefixed domains", () => {
    const r = normalizeHttpUrl("www.example.com");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://www.example.com");
  });

  it("preserves https:// protocol", () => {
    const r = normalizeHttpUrl("https://example.com/about");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://example.com/about");
  });

  it("upgrades http:// to https://", () => {
    const r = normalizeHttpUrl("http://example.com/path?q=1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://example.com/path?q=1");
  });

  it("rejects javascript: protocol", () => {
    const r = normalizeHttpUrl("javascript:alert(1)");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("valid");
  });

  it("rejects data: protocol", () => {
    const r = normalizeHttpUrl("data:text/html,<script>alert(1)</script>");
    expect(r.ok).toBe(false);
  });

  it("rejects file: protocol", () => {
    const r = normalizeHttpUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
  });

  it("returns empty for blank input", () => {
    const r = normalizeHttpUrl("");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("");
  });

  it("returns empty for whitespace-only", () => {
    const r = normalizeHttpUrl("   ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("");
  });

  it("rejects whitespace-only as non-valid url", () => {
    const r = normalizeHttpUrl("   ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("");
  });

  it("accepts subdomains", () => {
    const r = normalizeHttpUrl("blog.example.co.nz");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://blog.example.co.nz");
  });

  it("preserves paths and query strings", () => {
    const r = normalizeHttpUrl("https://example.com/about?ref=home#section");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://example.com/about?ref=home#section");
  });

  it("rejects malformed url", () => {
    const r = normalizeHttpUrl("not a valid url at all !");
    expect(r.ok).toBe(false);
  });

  it("normalizes hostname case", () => {
    const r = normalizeHttpUrl("HTTPS://EXAMPLE.COM/Path");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://example.com/Path");
  });
});

describe("normalizeBusinessWebsite", () => {
  it("prepends https:// to bare domains", () => {
    const r = normalizeBusinessWebsite("mybusiness.com");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://mybusiness.com");
  });

  it("accepts valid https url", () => {
    const r = normalizeBusinessWebsite("https://www.mybusiness.com");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://www.mybusiness.com");
  });
});

describe("normalizeSocialUrl", () => {
  describe("linkedin", () => {
    it("accepts linkedin.com/in/username", () => {
      const r = normalizeSocialUrl("linkedin", "https://linkedin.com/in/jane-smith");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toContain("linkedin.com/in/jane-smith");
    });

    it("normalizes hostname and prepends https", () => {
      const r = normalizeSocialUrl("linkedin", "linkedin.com/in/person");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toBe("https://www.linkedin.com/in/person");
    });

    it("rejects non-linkedin domain", () => {
      const r = normalizeSocialUrl("linkedin", "https://instagram.com/in/person");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("LinkedIn");
    });

    it("accepts company path", () => {
      const r = normalizeSocialUrl("linkedin", "linkedin.com/company/acme-corp");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toBe("https://www.linkedin.com/company/acme-corp");
    });
  });

  describe("instagram", () => {
    it("accepts instagram.com/username", () => {
      const r = normalizeSocialUrl("instagram", "instagram.com/wlthwlks");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toBe("https://www.instagram.com/wlthwlks");
    });

    it("rejects linkedin URL on instagram platform", () => {
      const r = normalizeSocialUrl("instagram", "https://linkedin.com/in/person");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("Instagram");
    });

    it("strips tracking query params", () => {
      const r = normalizeSocialUrl("instagram", "https://instagram.com/user?igsh=abc123");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).not.toContain("igsh");
    });

    it("accepts www variant", () => {
      const r = normalizeSocialUrl("instagram", "www.instagram.com/person");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toBe("https://www.instagram.com/person");
    });
  });

  describe("x / twitter", () => {
    it("accepts x.com/username", () => {
      const r = normalizeSocialUrl("x", "x.com/user123");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toBe("https://x.com/user123");
    });

    it("accepts twitter.com/username", () => {
      const r = normalizeSocialUrl("x", "twitter.com/user123");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toBe("https://x.com/user123");
    });
  });

  describe("threads", () => {
    it("accepts threads.net/@username", () => {
      const r = normalizeSocialUrl("threads", "threads.net/@username");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toBe("https://www.threads.net/@username");
    });

    it("adds @ prefix when missing", () => {
      const r = normalizeSocialUrl("threads", "https://threads.net/username");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toContain("/@username");
    });
  });

  describe("facebook", () => {
    it("accepts facebook.com/username", () => {
      const r = normalizeSocialUrl("facebook", "facebook.com/profile.name");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toBe("https://www.facebook.com/profile.name");
    });
  });

  describe("youtube", () => {
    it("accepts @channel", () => {
      const r = normalizeSocialUrl("youtube", "youtube.com/@mychannel");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toContain("@mychannel");
    });

    it("accepts channel/ID form", () => {
      const r = normalizeSocialUrl("youtube", "youtube.com/channel/UC123");
      expect(r.ok).toBe(true);
    });

    it("accepts c/ form", () => {
      const r = normalizeSocialUrl("youtube", "youtube.com/c/mycompany");
      expect(r.ok).toBe(true);
    });

    it("accepts user/ form", () => {
      const r = normalizeSocialUrl("youtube", "youtube.com/user/myuser");
      expect(r.ok).toBe(true);
    });

    it("accepts youtu.be short URL", () => {
      const r = normalizeSocialUrl("youtube", "https://youtu.be/mychannel");
      expect(r.ok).toBe(true);
    });
  });

  describe("tiktok", () => {
    it("accepts tiktok.com/@username", () => {
      const r = normalizeSocialUrl("tiktok", "tiktok.com/@username");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toBe("https://www.tiktok.com/@username");
    });

    it("adds @ when missing", () => {
      const r = normalizeSocialUrl("tiktok", "https://tiktok.com/username");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toContain("/@username");
    });
  });

  describe("other", () => {
    it("accepts any valid URL", () => {
      const r = normalizeSocialUrl("other", "https://myblog.com/about");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toBe("https://myblog.com/about");
    });

    it("rejects unsafe protocols", () => {
      const r = normalizeSocialUrl("other", "javascript:void(0)");
      expect(r.ok).toBe(false);
    });
  });
});

describe("serializeSocialMediaField / parseSocialMediaField", () => {
  it("roundtrips social links", () => {
    const links = [
      { platform: "linkedin" as const, url: "https://www.linkedin.com/in/jane" },
      { platform: "instagram" as const, url: "https://www.instagram.com/janesmith" },
    ];
    const serialized = serializeSocialMediaField(links);
    expect(serialized).toContain("linkedin|https://");
    expect(serialized).toContain("instagram|https://");

    const parsed = parseSocialMediaField(serialized);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].platform).toBe("linkedin");
    expect(parsed[1].platform).toBe("instagram");
  });

  it("returns empty array for empty input", () => {
    expect(parseSocialMediaField("")).toEqual([]);
    expect(parseSocialMediaField(null)).toEqual([]);
  });

  it("no-duplicate platforms when parsing", () => {
    const parsed = parseSocialMediaField(
      "linkedin|https://www.linkedin.com/in/a\nlinkedin|https://www.linkedin.com/in/b"
    );
    const platforms = parsed.map((p) => p.platform);
    expect(new Set(platforms).size).toBe(platforms.length);
  });
});

describe("findDuplicateSocialPlatforms", () => {
  it("returns null when no duplicates", () => {
    const r = findDuplicateSocialPlatforms([
      { platform: "linkedin" },
      { platform: "instagram" },
    ]);
    expect(r).toBeNull();
  });

  it("detects duplicate platform", () => {
    const r = findDuplicateSocialPlatforms([
      { platform: "linkedin" },
      { platform: "linkedin" },
    ]);
    expect(r).toBe("linkedin");
  });

  it("is case-insensitive", () => {
    const r = findDuplicateSocialPlatforms([
      { platform: "LinkedIn" },
      { platform: "linkedin" },
    ]);
    expect(r).toBe("linkedin");
  });
});

describe("normalizeBusinessName", () => {
  it("trims and caps at 120 chars", () => {
    expect(normalizeBusinessName("  Acme Corp  ")).toBe("Acme Corp");
    const long = "a".repeat(200);
    expect(normalizeBusinessName(long).length).toBe(120);
  });
});

describe("normalizeProfessionalHeadline", () => {
  it("trims and caps at 80 chars", () => {
    expect(normalizeProfessionalHeadline("  Founder & CEO  ")).toBe("Founder & CEO");
    expect(normalizeProfessionalHeadline("a".repeat(100)).length).toBe(80);
  });
});

describe("normalizeProfileBio", () => {
  it("caps at 500 chars", () => {
    expect(normalizeProfileBio("a".repeat(1000)).length).toBe(500);
  });
});

describe("isSocialPlatform", () => {
  it("returns true for valid platforms", () => {
    expect(isSocialPlatform("linkedin")).toBe(true);
    expect(isSocialPlatform("instagram")).toBe(true);
    expect(isSocialPlatform("other")).toBe(true);
  });

  it("returns false for invalid platforms", () => {
    expect(isSocialPlatform("myspace")).toBe(false);
    expect(isSocialPlatform("")).toBe(false);
  });
});
