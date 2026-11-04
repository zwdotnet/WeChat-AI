import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatCurrentTime,
  loadLlmConfigFromEnv,
  resolveSearchEndpoint,
  WebSearchClient,
} from "./client.js";

describe("formatCurrentTime", () => {
  it("returns JSON with iso and Asia/Shanghai fields", () => {
    const raw = formatCurrentTime("Asia/Shanghai");
    const obj = JSON.parse(raw) as {
      iso: string;
      timeZone: string;
      local: string;
      weekday: string;
    };
    assert.equal(obj.timeZone, "Asia/Shanghai");
    assert.ok(obj.iso.includes("T"));
    assert.ok(obj.local.length > 0);
  });
});

describe("loadLlmConfigFromEnv", () => {
  it("loads platform LLM and optional tools gateway", () => {
    const cfg = loadLlmConfigFromEnv({
      LLM_API_KEY: "sk-platform",
      LLM_BASE_URL: "https://api.openai.com/v1",
      LLM_MODEL: "gpt-4o-mini",
      TOOLS_BASE_URL: "http://127.0.0.1:7860",
      TOOLS_API_KEY: "tools-secret",
    });
    assert.equal(cfg.apiKey, "sk-platform");
    assert.equal(cfg.toolsBaseUrl, "http://127.0.0.1:7860");
    assert.equal(cfg.toolsApiKey, "tools-secret");
  });

  it("requires LLM_API_KEY for platform", () => {
    assert.throws(() => loadLlmConfigFromEnv({}), /LLM_API_KEY/);
  });
});

describe("resolveSearchEndpoint", () => {
  it("appends gateway path for bare origin", () => {
    assert.equal(
      resolveSearchEndpoint("http://127.0.0.1:7860"),
      "http://127.0.0.1:7860/v1/web-search",
    );
    assert.equal(
      resolveSearchEndpoint("https://api.tavily.com"),
      "https://api.tavily.com/v1/web-search",
    );
  });

  it("uses full link as-is when a path is present", () => {
    assert.equal(
      resolveSearchEndpoint("https://api.tavily.com/search"),
      "https://api.tavily.com/search",
    );
    assert.equal(
      resolveSearchEndpoint("https://gateway.example.com/v1/web-search"),
      "https://gateway.example.com/v1/web-search",
    );
  });
});

describe("WebSearchClient", () => {
  it("tavily provider posts to native /search with bearer key", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenBody = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      seenBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ results: [{ title: "T", url: "https://t", content: "c" }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const client = new WebSearchClient({
        toolsBaseUrl: "",
        toolsApiKey: "tvly-test",
        provider: "tavily",
      });
      const hits = await client.search("q", 3);
      assert.equal(seenUrl, "https://api.tavily.com/search");
      assert.equal(seenAuth, "Bearer tvly-test");
      assert.ok(seenBody.includes('"max_results":3'));
      assert.equal(hits[0]!.snippet, "c");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exa provider posts to native /search with x-api-key", async () => {
    let seenUrl = "";
    let seenKey = "";
    let seenBody = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenKey = (init?.headers as Record<string, string>)?.["x-api-key"] ?? "";
      seenBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          results: [{ title: "E", url: "https://e", text: "exa text" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const client = new WebSearchClient({
        toolsBaseUrl: "",
        toolsApiKey: "exa-test",
        provider: "exa",
      });
      const hits = await client.search("q", 2);
      assert.equal(seenUrl, "https://api.exa.ai/search");
      assert.equal(seenKey, "exa-test");
      assert.ok(seenBody.includes('"numResults":2'));
      assert.equal(hits[0]!.snippet, "exa text");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("firecrawl provider posts to native /v1/search and maps description", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      return new Response(
        JSON.stringify({
          success: true,
          data: [{ title: "F", url: "https://f", description: "fc desc" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const client = new WebSearchClient({
        toolsBaseUrl: "",
        toolsApiKey: "fc-test",
        provider: "firecrawl",
      });
      const hits = await client.search("q");
      assert.equal(seenUrl, "https://api.firecrawl.dev/v1/search");
      assert.equal(seenAuth, "Bearer fc-test");
      assert.equal(hits[0]!.snippet, "fc desc");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("hits the resolved endpoint with bearer auth", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const client = new WebSearchClient({
        toolsBaseUrl: "https://api.tavily.com/search",
        toolsApiKey: "test-key-123",
      });
      await client.search("test");
      assert.equal(seenUrl, "https://api.tavily.com/search");
      assert.equal(seenAuth, "Bearer test-key-123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps gateway snippet and Tavily content fields", async () => {
    const responses = [
      JSON.stringify({
        results: [{ title: "A", url: "https://a", snippet: "s" }],
      }),
      JSON.stringify({
        results: [{ title: "B", url: "https://b", content: "c" }],
      }),
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(responses.shift() ?? "{}", { status: 200 })) as typeof fetch;
    try {
      const client = new WebSearchClient({
        toolsBaseUrl: "http://127.0.0.1:7860",
        toolsApiKey: "",
      });
      const gatewayHit = (await client.search("q"))[0]!;
      assert.equal(gatewayHit.snippet, "s");
      const tavilyHit = (await client.search("q"))[0]!;
      assert.equal(tavilyHit.snippet, "c");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
