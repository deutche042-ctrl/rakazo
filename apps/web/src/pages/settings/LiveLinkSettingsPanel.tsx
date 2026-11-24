import { useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import { Button } from "@rakazo/ui-web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { SettingsGroup, SettingsRow } from "../../components/settings/SettingsRows";

/**
 * The native live link (scripts/native/tunnel.sh) as Settings shows it: a lamp for the tunnel's
 * state, the link to copy, one Stop and the tail of its log. The API owns both reads and the stop,
 * so the page never touches the tunnel itself, and a 401 is its own case: the session is gone, so
 * the panel asks the person to sign in instead of reporting a failure nobody can act on.
 */

export const LIVE_LINK_RUNTIME_PATH = "/api/native/runtime";
export const LIVE_LINK_STOP_PATH = "/api/native/runtime/stop";
/** The lamp, the uptime and the log follow the tunnel this often. */
export const LIVE_LINK_REFRESH_MS = 3000;
/** The API sends the last 100 lines; a reply with more keeps the newest. */
const LOG_LINES = 100;
const COPY_FEEDBACK_MS = 2000;

export type LiveLinkState = "running" | "stopped" | "error" | "off";

export interface LiveLinkView {
  state: LiveLinkState;
  /** The public https link, while the tunnel runs. */
  url: string | null;
  /** When the tunnel started, as an ISO timestamp. */
  since: string | null;
  pid: number | null;
  lastError: string | null;
  /** Whole seconds since `since`; null unless the tunnel is running. */
  uptimeSeconds: number | null;
  /** The last lines of tunnel.log, newest last. */
  logs: string[];
}

/** One read of the runtime route; `signed-out` is separate so the panel can say sign in. */
export type LiveLinkRead =
  | { kind: "ready"; view: LiveLinkView }
  | { kind: "signed-out" }
  | { kind: "failed"; detail: string };

const STATES: ReadonlySet<string> = new Set(["running", "stopped", "error", "off"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Anything the script could not have written is refused, never shown as a running tunnel. */
function parseView(raw: unknown): LiveLinkView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.state !== "string" || !STATES.has(record.state)) return null;
  const uptime = record.uptimeSeconds;
  return {
    state: record.state as LiveLinkState,
    url: text(record.url),
    since: text(record.since),
    pid: typeof record.pid === "number" && Number.isInteger(record.pid) ? record.pid : null,
    lastError: text(record.lastError),
    uptimeSeconds:
      typeof uptime === "number" && Number.isFinite(uptime) && uptime >= 0
        ? Math.round(uptime)
        : null,
    logs: Array.isArray(record.logs)
      ? record.logs.filter((line): line is string => typeof line === "string").slice(-LOG_LINES)
      : [],
  };
}

async function requestView(path: string, init: RequestInit): Promise<LiveLinkRead> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "include", cache: "no-store", ...init });
  } catch {
    return { kind: "failed", detail: "network" };
  }
  if (response.status === 401) return { kind: "signed-out" };
  if (!response.ok) return { kind: "failed", detail: `HTTP ${response.status}` };
  try {
    const view = parseView(await response.json());
    return view ? { kind: "ready", view } : { kind: "failed", detail: "unexpected reply" };
  } catch {
    return { kind: "failed", detail: "unreadable reply" };
  }
}

export function readLiveLink(): Promise<LiveLinkRead> {
  return requestView(LIVE_LINK_RUNTIME_PATH, {
    headers: { accept: "application/json" },
  });
}

/** The API stops the tunnel its script started and answers with the state it reads next. */
export function stopLiveLink(): Promise<LiveLinkRead> {
  return requestView(LIVE_LINK_STOP_PATH, {
    method: "POST",
    // A JSON body forces a CORS preflight, the same guard the API applies to this route.
    headers: { accept: "application/json", "content-type": "application/json" },
    body: "{}",
  });
}

/** Copies by selecting the text, which works where the Clipboard API does not: plain http, say. */
function copyBySelection(value: string): boolean {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = value;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
  // Next to the focused control, so a dialog's focus trap lets the selection happen.
  (active?.parentElement ?? document.body).append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  active?.focus({ preventScroll: true });
  return copied;
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // A document that lost focus cannot copy through the Clipboard API; select the text instead.
  }
  return copyBySelection(value);
}

/** `1d 2h`, `3h 4m`, `5m 6s`, `7s`: whole units, two at most. */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

const LAMP: Record<"success" | "warning" | "destructive", string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

export function LiveLinkSettingsPanel() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  useTimeout(() => setCopied(false), copied ? COPY_FEEDBACK_MS : null, copied);

  const query = useQuery<LiveLinkRead>({
    queryKey: ["live-link"],
    queryFn: readLiveLink,
    refetchInterval: LIVE_LINK_REFRESH_MS,
    retry: false,
  });
  const stop = useMutation({
    mutationFn: stopLiveLink,
    onSuccess: (result) => {
      // A failed stop says so beside the Stop button; the lamp keeps showing what the tunnel does.
      if (result.kind !== "failed") queryClient.setQueryData(["live-link"], result);
      void queryClient.invalidateQueries({ queryKey: ["live-link"] });
    },
  });

  const read = query.data;

  if (!read) {
    return (
      <SettingsGroup data-testid="settings-live-link">
        <SettingsRow label={t`Live link`}>
          <p className="text-body-sm text-muted-foreground">{t`Checking the live link…`}</p>
        </SettingsRow>
      </SettingsGroup>
    );
  }

  if (read.kind === "signed-out") {
    return (
      <SettingsGroup data-testid="settings-live-link">
        <SettingsRow label={t`Sign in again to manage the live link`}>
          <p className="mt-1 text-body-sm text-muted-foreground">
            {t`Your session ended. Sign in again to see the link and stop the tunnel.`}
          </p>
          <a
            href="/sign-in"
            className="mt-2 inline-flex text-body-sm text-primary underline-offset-4 hover:underline"
          >
            {t`Sign in`}
          </a>
        </SettingsRow>
      </SettingsGroup>
    );
  }

  if (read.kind === "failed") {
    return (
      <SettingsGroup data-testid="settings-live-link">
        <SettingsRow label={t`Live link`}>
          <p role="alert" className="mt-1 text-body-sm text-destructive">
            {t`Could not read the live link status.`}{" "}
            <span className="text-muted-foreground">({read.detail})</span>
          </p>
        </SettingsRow>
      </SettingsGroup>
    );
  }

  const view = read.view;
  const running = view.state === "running";
  const tone = running ? "success" : view.state === "error" ? "warning" : "destructive";
  const label = running
    ? t`Running`
    : view.state === "error"
      ? t`Problem`
      : view.state === "stopped"
        ? t`Stopped`
        : t`Off`;
  const description = running
    ? t`Anyone who has the link can open this server.`
    : view.state === "error"
      ? t`The tunnel is not running. Check the log below.`
      : t`Start it with bash scripts/native/tunnel.sh.`;

  return (
    <div className="space-y-8" data-testid="settings-live-link">
      <SettingsGroup>
        <SettingsRow
          label={
            <>
              <span className="flex items-center gap-2">
                <span
                  data-testid="live-link-lamp"
                  data-state={view.state}
                  aria-hidden="true"
                  className={`size-2.5 shrink-0 rounded-full ${LAMP[tone]}`}
                />
                <span>{label}</span>
                {running && view.uptimeSeconds !== null ? (
                  <span className="text-body-sm text-muted-foreground">
                    {t`Up ${formatUptime(view.uptimeSeconds)}`}
                  </span>
                ) : null}
              </span>
              <p className="mt-0.5 text-body-sm text-muted-foreground">{description}</p>
            </>
          }
          control={
            running ? (
              <Button
                variant="destructive"
                size="sm"
                data-testid="live-link-stop"
                disabled={stop.isPending}
                onClick={() => stop.mutate()}
              >
                {stop.isPending ? t`Stopping…` : t`Stop`}
              </Button>
            ) : undefined
          }
        >
          {view.state === "error" && view.lastError ? (
            <p role="alert" className="mt-2 text-body-sm text-destructive">
              {view.lastError}
            </p>
          ) : null}
          {stop.data?.kind === "failed" ? (
            <p role="alert" className="mt-2 text-body-sm text-destructive">
              {t`Could not stop the tunnel.`}{" "}
              <span className="text-muted-foreground">({stop.data.detail})</span>
            </p>
          ) : null}
        </SettingsRow>
        {view.url ? (
          <SettingsRow
            label={t`Link`}
            control={
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid="live-link-copy"
                aria-label={copied ? t`Copied` : t`Copy link`}
                onClick={() => {
                  const link = view.url;
                  if (!link) return;
                  void copyText(link).then((ok) => {
                    if (ok) setCopied(true);
                  });
                }}
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            }
          >
            <p className="mt-1 break-all font-mono text-label text-foreground/75">{view.url}</p>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={t`Logs`}>
        <details data-testid="live-link-logs" className="px-4 py-3">
          <summary className="cursor-pointer text-body text-foreground">
            {t`Show the last 100 lines`}
          </summary>
          {view.logs.length > 0 ? (
            <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-label whitespace-pre-wrap break-all text-foreground/75">
              {view.logs.join("\n")}
            </pre>
          ) : (
            <p className="mt-2 text-body-sm text-muted-foreground">{t`No log lines yet.`}</p>
          )}
        </details>
      </SettingsGroup>
    </div>
  );
}
