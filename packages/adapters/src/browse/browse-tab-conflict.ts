/**
 * chrome.debugger (the browse extension) and the panel's page browser both attach a debugger to
 * one Chromium tab. One tab must have one driver: when browse holds a tab, the page browser does
 * not attach to it. It opens the panel's own tab on the same page instead, so a person keeps a tab
 * to watch and operate while the bot keeps its browse tab.
 *
 * `Target.getTargets` reports `attached` for any tab that already has a client, which is how the
 * page browser tells browse's tab apart before it connects.
 */

export type LiveBrowserTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
};

/** Normalizes the `Target.getTargets` answer without trusting its shape. */
export function parseCdpTargets(value: unknown): LiveBrowserTarget[] {
  if (!Array.isArray(value)) return [];
  const targets: LiveBrowserTarget[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const target = entry as Record<string, unknown>;
    if (typeof target.targetId !== "string" || !target.targetId) continue;
    targets.push({
      id: target.targetId,
      type: typeof target.type === "string" ? target.type : "",
      title: typeof target.title === "string" ? target.title : "",
      url: typeof target.url === "string" ? target.url : "",
      attached: target.attached === true,
    });
  }
  return targets;
}

/** Page targets another client already holds; those are not safe for the page browser to drive. */
export function externallyAttachedTabIds(targets: readonly LiveBrowserTarget[]): Set<string> {
  return new Set(
    targets
      .filter((target) => target.type === "page" && target.attached)
      .map((target) => target.id),
  );
}

/**
 * A URL the panel may open in its own tab: HTTP(S) without embedded credentials, the same rule
 * browser navigation already enforces. Anything else opens as a blank tab instead of reproducing
 * a privileged (`chrome://`, `file://`) or credential-bearing page.
 */
export function mirrorablePageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Chromium's own pages (settings, extension UI, DevTools) are never a bot's page. */
export function isPrivilegedPageUrl(value: string): boolean {
  return /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|about|view-source):/i.test(
    value,
  );
}
