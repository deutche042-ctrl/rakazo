import { describe, expect, it } from "vitest";
import {
  connectedPluginsInstruction,
  hostComputerInstruction,
  taughtSkillsInstruction,
} from "./run-instructions.prompt.js";

describe("connectedPluginsInstruction", () => {
  it("names each connected plugin and prefers its tools to browsing", () => {
    expect(
      connectedPluginsInstruction([
        { displayName: "Mail", connectorId: "apps", provider: "mail" },
        { displayName: "Code", connectorId: "apps", provider: "code" },
      ]),
    ).toBe(
      "Connected plugins: Mail (apps:mail), Code (apps:code). Prefer those plugin tools over the computer browser or web search when reading app data (repos, releases, mail, calendar, and similar).",
    );
  });

  it("says so when nothing is connected", () => {
    expect(connectedPluginsInstruction([])).toBe("No plugins are connected yet.");
  });
});

describe("taughtSkillsInstruction", () => {
  it("lists each taught skill with when to use it", () => {
    expect(
      taughtSkillsInstruction([
        { name: "File expenses", whenToUse: "When a receipt arrives" },
        { name: "Book travel", whenToUse: "Book a trip" },
      ]),
    ).toBe(
      "Saved taught skills:\n- File expenses: When a receipt arrives\n- Book travel: Book a trip\nWhen the user asks to run a taught skill by name, follow that skill's playbook exactly. The full playbook is included in the user task when they invoke it.",
    );
  });

  it("adds nothing when no skill was taught", () => {
    expect(taughtSkillsInstruction([])).toBeUndefined();
  });
});

describe("hostComputerInstruction", () => {
  const host = { home: "/home/me", shell: "bash", platform: "linux" };

  it("points a self-hosted Linux host at browser-login.sh and forbids retrying", () => {
    const instruction = hostComputerInstruction("local", host, { sharedNativeBrowser: true });
    expect(instruction).toContain("bash scripts/native/browser-login.sh");
    expect(instruction).toContain("never retry");
    // A blocked page is a human handoff, not a page to work around or retry.
    expect(instruction).toContain("stop immediately");
    expect(instruction).toContain("hand the step to the user");
  });

  it("points a cloud or non-Linux computer at OAuth and never at a local script", () => {
    for (const [kind, platform] of [
      ["wuying", "win32"],
      ["local", "darwin"],
    ] as const) {
      const instruction = hostComputerInstruction(kind, { ...host, platform });
      expect(instruction).toContain("OAuth");
      expect(instruction).toContain("stop immediately");
      expect(instruction).not.toContain("browser-login.sh");
    }
  });

  it("does not name a local script on a Linux host not marked as the native stack", () => {
    // A Linux desktop app host has no scripts/native, so platform alone is not enough.
    const instruction = hostComputerInstruction("local", host);
    expect(instruction).toContain("OAuth");
    expect(instruction).not.toContain("browser-login.sh");
  });
});
