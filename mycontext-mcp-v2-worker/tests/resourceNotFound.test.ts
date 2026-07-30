import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  McpServer,
  ProtocolErrorCode
} from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { registerAuthorStyleResources } from "../src/resources/authorStyle.js";
import { registerMetaskillResources } from "../src/resources/metaskill.js";
import type { TidbClient } from "../src/tidb.js";

type ResourceRegistrar = (server: McpServer, client: TidbClient) => void;

interface ResourceCase {
  label: string;
  register: ResourceRegistrar;
  unknownDocumentUri: string;
  missingSectionUri: string;
}

const RESOURCE_CASES: ResourceCase[] = [
  {
    label: "author style",
    register: registerAuthorStyleResources,
    unknownDocumentUri: "mycontext://author-style/unsupported/sections/missing",
    missingSectionUri: "mycontext://author-style/ore-title-style/sections/missing"
  },
  {
    label: "metaskill",
    register: registerMetaskillResources,
    unknownDocumentUri: "mycontext://metaskill/unsupported/sections/missing",
    missingSectionUri: "mycontext://metaskill/ai-self-strategy/sections/missing"
  }
];

describe.each(RESOURCE_CASES)("$label resource not-found contract", ({
  label,
  register,
  unknownDocumentUri,
  missingSectionUri
}) => {
  it("maps an unsupported document ID to the modern resource-not-found shape", async () => {
    const execute = vi.fn(async (_sql: string, _params?: readonly unknown[]) => []);
    await withResourceClient(label, register, { execute }, async (client) => {
      await expect(client.readResource({ uri: unknownDocumentUri })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        data: { uri: unknownDocumentUri }
      });
      expect(execute).not.toHaveBeenCalled();
    });
  });

  it("preserves resource-not-found for a missing section in a valid document", async () => {
    const execute = vi.fn(async (_sql: string, _params?: readonly unknown[]) => []);
    await withResourceClient(label, register, { execute }, async (client) => {
      await expect(client.readResource({ uri: missingSectionUri })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        data: { uri: missingSectionUri }
      });
      expect(execute).toHaveBeenCalled();
    });
  });
});

async function withResourceClient(
  label: string,
  register: ResourceRegistrar,
  tidb: TidbClient,
  run: (client: Client) => Promise<void>
): Promise<void> {
  const server = new McpServer({ name: `${label}-server`, version: "1.0.0" });
  register(server, tidb);
  const client = new Client({ name: `${label}-client`, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}
