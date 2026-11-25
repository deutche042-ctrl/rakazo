import { describe, expect, it } from "vitest";
import { userTurnInstructions } from "../runs/assembly/run-instructions.prompt.js";
import {
  BROWSE_PAGE_ACTIONS,
  browseMcpOffered,
  browsePageWorkClause,
  browseToolName,
} from "./browse-instructions.js";
import {
  BROWSE_MCP_ALLOWED_TOOLS,
  browseMcpCommand,
  browseMcpServerDefinition,
  browseMcpToolAllowed,
  browseToolsForAction,
  isBrowseMcpServer,
} from "./browse-mcp.js";
import {
  externallyAttachedTabIds,
  mirrorablePageUrl,
  parseCdpTargets,
} from "./browse-tab-conflict.js";

const policy = { stdioEnabled: true, allowedCommands: ["/opt/rakazo/bin/browse"] };

describe("browseMcpServerDefinition", () => {
  it("defines the server only when stdio is on and the command is allowlisted", () => {
    expect(browseMcpServerDefinition(policy, { BROWSE_BIN: "/opt/rakazo/bin/browse" })).toEqual({
      slug: "browse",
      name: "browse",
      transport: "stdio",
      command: "/opt/rakazo/bin/browse",
      args: ["mcp"],
      allowedTools: BROWSE_MCP_ALLOWED_TOOLS,
      pageActions: BROWSE_PAGE_ACTIONS,
    });
  });

  it("stays undefined when the deployment does not run stdio servers", () => {
    expect(
      browseMcpServerDefinition(
        { stdioEnabled: false, allowedCommands: ["/opt/rakazo/bin/browse"] },
        { BROWSE_BIN: "/opt/rakazo/bin/browse" },
      ),
    ).toBeUndefined();
  });

  it("stays undefined when the command is not on the allowlist", () => {
    expect(
      browseMcpServerDefinition(policy, { BROWSE_BIN: "/usr/local/bin/other" }),
    ).toBeUndefined();
  });

  it("defaults to the install location under the home directory", () => {
    expect(browseMcpCommand({ HOME: "/home/person" })).toBe("/home/person/.local/bin/browse");
  });
});

describe("browse Mcp tool allowlist", () => {
  it("keeps page and tab tools", () => {
    for (const tool of ["execute", "status", "session_list", "tabs_cleanup"]) {
      expect(browseMcpToolAllowed(tool)).toBe(true);
    }
  });

  it("never allows the tools that would share a tab or read the person's secrets", () => {
    for (const tool of [
      "session_adopt",
      "network",
      "recording",
      "flight_recorder",
      "settings",
      "secrets_list",
      "secrets_run",
    ]) {
      expect(browseMcpToolAllowed(tool)).toBe(false);
    }
  });

  it("maps every allowed page action to tools inside the allowlist", () => {
    for (const action of BROWSE_PAGE_ACTIONS) {
      const tools = browseToolsForAction(action);
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) expect(browseMcpToolAllowed(tool)).toBe(true);
      if (action === "tabs") expect(tools).toContain("tabs_cleanup");
      else expect(tools).toEqual(["execute"]);
    }
  });
});

describe("isBrowseMcpServer", () => {
  it("recognizes the server by slug or by its command", () => {
    expect(isBrowseMcpServer({ transport: "stdio", slug: "browse" })).toBe(true);
    expect(
      isBrowseMcpServer({
        transport: "stdio",
        slug: "browser",
        command: "/home/me/.local/bin/browse",
      }),
    ).toBe(true);
  });

  it("leaves other servers and remote transports alone", () => {
    expect(isBrowseMcpServer({ transport: "stdio", slug: "other", command: "/bin/other" })).toBe(
      false,
    );
    expect(isBrowseMcpServer({ transport: "streamable_http", slug: "browse" })).toBe(false);
  });
});

describe("browseMcpOffered", () => {
  it("finds the execute tool under the browse slug", () => {
    expect(browseMcpOffered([browseToolName("execute"), "shell"])).toBe(true);
    expect(browseMcpOffered([browseToolName("status"), "shell"])).toBe(false);
  });
});

describe("browsePageWorkClause", () => {
  const clause = browsePageWorkClause();

  it("names the allowed page actions and the tools that carry them", () => {
    for (const action of BROWSE_PAGE_ACTIONS) expect(clause).toContain(action);
    expect(clause).toContain("mcp__browse__execute");
    expect(clause).toContain("mcp__browse__session_list");
    expect(clause).toContain("mcp__browse__tabs_cleanup");
  });

  it("keeps the tab split, the handoff and the purchase approval", () => {
    expect(clause).toContain("never the panel's tab");
    expect(clause).toContain("session_adopt");
    expect(clause).toContain("browser_navigate");
    expect(clause).toContain("request_takeover");
    expect(clause).toContain("browser_act");
  });
});

describe("userTurnInstructions with browse", () => {
  const parts = {
    botInstructions: "",
    groupContext: undefined,
    messagingContext: undefined,
    redactedMemoryContext: undefined,
    redactedScratchpadContext: undefined,
    hasHistoricalContext: false,
    computerInstruction: "",
    pageBrowserAllowed: true,
    browseMcp: true,
    workspaceInstruction: "",
    agentEnvironmentInstruction: undefined,
    botDirectory: undefined,
    pluginLine: undefined,
    agentSkillsLine: undefined,
    taughtSkillsLine: undefined,
    replyGuidance: "",
  };

  it("uses browse for page work instead of the page-tool clause", () => {
    const instructions = userTurnInstructions(parts).filter(Boolean).join("\n\n");
    expect(instructions).toContain("mcp__browse__execute");
    expect(instructions).not.toContain(
      "Use browser_navigate, browser_snapshot, and browser_act for page work",
    );
  });

  it("keeps the page-tool clause when browse is not assigned", () => {
    const instructions = userTurnInstructions({ ...parts, browseMcp: false })
      .filter(Boolean)
      .join("\n\n");
    expect(instructions).toContain(
      "Use browser_navigate, browser_snapshot, and browser_act for page work",
    );
  });
});

describe("CDP tab conflict helpers", () => {
  const targets = parseCdpTargets([
    { targetId: "browse", type: "page", url: "https://example.test/a", title: "A", attached: true },
    { targetId: "free", type: "page", url: "https://example.test/b", title: "B", attached: false },
    {
      targetId: "extension",
      type: "page",
      url: "chrome-extension://abc/onboarding.html",
      title: "Onboarding",
      attached: true,
    },
    {
      targetId: "worker",
      type: "service_worker",
      url: "chrome-extension://abc/bg.js",
      attached: true,
    },
  ]);

  it("lists pages another debugger already holds, and only pages", () => {
    expect([...externallyAttachedTabIds(targets)]).toEqual(["browse", "extension"]);
  });

  it("mirrors an http(s) page without credentials, never a privileged or credentialed one", () => {
    expect(mirrorablePageUrl("https://example.test/a?x=1")).toBe("https://example.test/a?x=1");
    expect(mirrorablePageUrl("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/");
    expect(mirrorablePageUrl("file:///etc/passwd")).toBeUndefined();
    expect(mirrorablePageUrl("chrome://settings")).toBeUndefined();
    expect(mirrorablePageUrl("https://user:pass@example.test/")).toBeUndefined();
    expect(mirrorablePageUrl("javascript:alert(1)")).toBeUndefined();
  });
});
