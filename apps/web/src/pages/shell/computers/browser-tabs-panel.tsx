import { Trans } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { Globe } from "lucide-react";

/** The shared browser's open tabs, each labelled with the bot that opened it. */
export function BrowserTabsPanel({ tabs }: { tabs: NonNullable<ComputerStatus["browserTabs"]> }) {
  return (
    <div
      data-testid="browser-tabs"
      className="overflow-hidden rounded-xl border border-border/60 bg-muted/30"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-caption font-medium text-muted-foreground">
        <Globe size={14} strokeWidth={1.9} aria-hidden />
        <Trans>Shared browser</Trans>
      </div>
      <ul className="divide-y divide-border/50">
        {tabs.map((tab) => {
          let host = tab.url;
          try {
            host = new URL(tab.url).host || tab.url;
          } catch {
            // A tab whose URL cannot be parsed still gets its title.
          }
          return (
            <li key={tab.id} className="flex items-center gap-2 px-3 py-2 text-body">
              <span className="max-w-[38%] shrink-0 truncate rounded-full bg-background px-2 py-0.5 text-caption text-muted-foreground">
                {tab.botName ?? <Trans>Unclaimed</Trans>}
              </span>
              <span className="min-w-0 flex-1 truncate">{tab.title || tab.url}</span>
              <span className="max-w-[38%] shrink-0 truncate text-caption text-muted-foreground">
                {host}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
