import { Trans } from "@lingui/react/macro";

export function DesktopKindEmptyState({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Trans>
        This bot runs on your computer rather than a sandbox. Shell and files use your home folder.
      </Trans>
    </div>
  );
}
