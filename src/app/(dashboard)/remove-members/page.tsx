"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Spin } from "antd";

/**
 * Compatibility redirect — legacy /remove-members bookmarks.
 * Cancellations/removal queue lives under Slack Community.
 */
export default function RemoveMembersRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/members/slack-access?tab=remove");
  }, [router]);

  return (
    <div style={{ padding: 48, textAlign: "center" }}>
      <Spin size="large" />
      <div style={{ marginTop: 16 }}>Redirecting to Slack Community removal queue…</div>
    </div>
  );
}
