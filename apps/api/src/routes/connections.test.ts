import { ORPCError } from "@orpc/server";
import type { ConnectorCatalogItem, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { connectionsRoutes } from "./connections.js";
import type { RouterContext } from "./context.js";

const actor = { spaceId: "space-1", userId: "user-1" } as Actor;

type CatalogHandler = (args: {
  context: { actor: Actor; signal?: AbortSignal };
  input: { query?: string; connectorId?: string };
}) => Promise<ConnectorCatalogItem[]>;

/** Every `authed.*.handler(...)` in the route file returns its handler unchanged. */
function fakeAuthed(): unknown {
  const node = new Proxy(
    {},
    {
      get: (_target, key) => (key === "handler" ? (handler: unknown) => handler : node),
    },
  );
  return node;
}

/** Runs the catalog handler itself; the route file only wraps it for auth and side effects. */
function catalogHandler(providers: ManagedConnectorProvider[]): CatalogHandler {
  const ctx = {
    deps: { connectors: { managedProviders: () => providers } } as unknown as RouterDeps,
    authed: fakeAuthed(),
  } as unknown as RouterContext;
  return connectionsRoutes(ctx).connections.catalog as unknown as CatalogHandler;
}

function provider(id: string, catalog: ManagedConnectorProvider["catalog"]) {
  return {
    describe: () => ({ id }),
    catalog,
    begin: vi.fn(),
    complete: vi.fn(),
    connectionReady: vi.fn(),
    listConnectedExternalIds: vi.fn(async () => []),
    revoke: vi.fn(),
  } as unknown as ManagedConnectorProvider;
}

const item: ConnectorCatalogItem = {
  connectorId: "composio",
  slug: "gmail",
  name: "Gmail",
  logo: null,
  connected: false,
  noAuth: false,
};

describe("connections.catalog", () => {
  it("surfaces a provider failure instead of answering with an empty catalog", async () => {
    const error = vi.spyOn(getLogger(), "error");
    const composio = provider("composio", async () => {
      throw new Error("Composio rejected the request: 401 Unauthorized");
    });

    await expect(
      catalogHandler([composio])({ context: { actor }, input: {} }),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: expect.stringContaining("composio"),
    });
    expect(error).toHaveBeenCalledWith(
      "integration.catalog_failed",
      expect.stringContaining("401"),
      { provider: "composio" },
    );
  });

  it("still answers with the catalog when every provider reads", async () => {
    const composio = provider("composio", async () => [item]);

    await expect(catalogHandler([composio])({ context: { actor }, input: {} })).resolves.toEqual([
      item,
    ]);
  });

  it("fails the whole list when one of several providers is down", async () => {
    const composio = provider("composio", async () => {
      throw new Error("401 Unauthorized");
    });
    const other = provider("other", async () => [item]);

    await expect(
      catalogHandler([composio, other])({ context: { actor }, input: {} }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});
