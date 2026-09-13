import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ApiError,
  BrowserEnvironmentError,
  ConfigurationError,
  Inklet,
  InvalidResponseError,
  InvalidSecretKeyError,
  NetworkError,
  PermissionDeniedError,
  RevokedSecretKeyError,
  SubscriptionRequiredError,
} from "../dist/esm/index.js";

const SECRET = "inklet_pat_test_123456789";
const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = originalWindow;
  }
});

describe("Inklet client initialization", () => {
  it("does not make a network request during construction", () => {
    let calls = 0;
    const client = new Inklet({
      secretKey: SECRET,
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    });

    assert.equal(client.baseUrl, "https://dev.iminklet.com");
    assert.equal(calls, 0);
  });

  it("accepts the pat compatibility alias", () => {
    assert.doesNotThrow(
      () => new Inklet({ pat: SECRET, fetch: async () => Response.json({}) }),
    );
  });

  for (const options of [
    {},
    { secretKey: "" },
    { secretKey: "   " },
    { secretKey: SECRET, pat: SECRET },
  ]) {
    it(`rejects invalid credentials: ${JSON.stringify(options)}`, () => {
      assert.throws(
        () =>
          new Inklet({
            ...options,
            fetch: async () => Response.json({}),
          }),
        ConfigurationError,
      );
    });
  }

  for (const baseUrl of [
    "not a url",
    "file:///tmp/inklet",
    "https://user:password@example.com",
    "https://example.com?token=unsafe",
    "https://example.com#unsafe",
  ]) {
    it(`rejects unsafe base URL: ${baseUrl}`, () => {
      assert.throws(
        () =>
          new Inklet({
            secretKey: SECRET,
            baseUrl,
            fetch: async () => Response.json({}),
          }),
        ConfigurationError,
      );
    });
  }

  it("blocks browser use before any request can be sent", () => {
    let calls = 0;
    globalThis.window = { document: {} };

    assert.throws(
      () =>
        new Inklet({
          secretKey: SECRET,
          fetch: async () => {
            calls += 1;
            return Response.json({});
          },
        }),
      BrowserEnvironmentError,
    );
    assert.equal(calls, 0);
  });
});

describe("Inklet authenticated requests", () => {
  it("adds bearer authentication and JSON headers", async () => {
    const calls = [];
    const client = new Inklet({
      secretKey: SECRET,
      baseUrl: "http://localhost:8787/v1/",
      fetch: async (...args) => {
        calls.push(args);
        return Response.json({ id: "display_123" });
      },
    });

    const result = await client.request("/displays", {
      method: "POST",
      headers: { authorization: "Bearer attacker-controlled" },
      json: { name: "Office" },
    });

    assert.deepEqual(result, { id: "display_123" });
    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    assert.equal(url.toString(), "http://localhost:8787/v1/displays");
    assert.equal(init.body, '{"name":"Office"}');
    assert.equal(init.redirect, "error");

    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${SECRET}`);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("content-type"), "application/json");
  });

  it("rejects cross-origin paths so credentials cannot be sent elsewhere", async () => {
    let calls = 0;
    const client = new Inklet({
      secretKey: SECRET,
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    });

    for (const path of [
      "https://attacker.example/resource",
      "//attacker.example/resource",
      "\\\\attacker.example\\resource",
    ]) {
      await assert.rejects(client.request(path), ConfigurationError);
    }
    assert.equal(calls, 0);
  });

  it("returns undefined for an empty successful response", async () => {
    const client = new Inklet({
      secretKey: SECRET,
      fetch: async () => new Response(null, { status: 204 }),
    });

    assert.equal(await client.request("/empty"), undefined);
  });

  it("reports invalid JSON responses with the request ID", async () => {
    const client = new Inklet({
      secretKey: SECRET,
      fetch: async () =>
        new Response("{not-json", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_invalid_json",
          },
        }),
    });

    await assert.rejects(client.request("/broken"), (error) => {
      assert.ok(error instanceof InvalidResponseError);
      assert.equal(error.requestId, "req_invalid_json");
      return true;
    });
  });
});

describe("Inklet error classification", () => {
  it("classifies an invalid credential separately", async () => {
    await assert.rejects(
      clientReturning(401, {
        error: { code: "invalid_secret_key" },
      }).request("/displays"),
      InvalidSecretKeyError,
    );
  });

  it("classifies a revoked credential separately", async () => {
    const client = clientReturning(
      401,
      { error: { code: "project_secret_revoked" } },
      { "x-request-id": "req_revoked" },
    );

    await assert.rejects(client.request("/displays"), (error) => {
      assert.ok(error instanceof RevokedSecretKeyError);
      assert.equal(error.requestId, "req_revoked");
      assert.equal(error.status, 401);
      return true;
    });
  });

  it("does not turn permission errors into not-found responses", async () => {
    const client = clientReturning(403, {
      error: { message: "Project cannot access this display" },
      requestId: "req_forbidden",
    });

    await assert.rejects(client.request("/displays/other"), (error) => {
      assert.ok(error instanceof PermissionDeniedError);
      assert.equal(error.requestId, "req_forbidden");
      assert.equal(error.status, 403);
      return true;
    });
  });

  it("classifies subscription-gated features separately", async () => {
    const client = clientReturning(
      403,
      {
        error: {
          code: "subscription_required",
          message: "Auto Push requires an active Pro subscription.",
          requestId: "req_subscription",
          details: {
            currentPlan: "free",
            requiredPlan: "pro",
            feature: "push.auto",
          },
        },
      },
      { "x-request-id": "req_subscription" },
    );

    await assert.rejects(client.request("/api/sdk/v1/contents"), (error) => {
      assert.ok(error instanceof SubscriptionRequiredError);
      assert.ok(error instanceof PermissionDeniedError);
      assert.equal(error.code, "subscription_required");
      assert.equal(error.status, 403);
      assert.equal(error.requestId, "req_subscription");
      assert.deepEqual(error.details, {
        currentPlan: "free",
        requiredPlan: "pro",
        feature: "push.auto",
      });
      return true;
    });
  });

  it("preserves request IDs for other server errors", async () => {
    const client = clientReturning(
      500,
      { message: "Rendering dependency failed" },
      { "x-correlation-id": "req_server" },
    );

    await assert.rejects(client.request("/status"), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.requestId, "req_server");
      assert.equal(error.status, 500);
      return true;
    });
  });

  it("redacts a credential echoed by an upstream response", async () => {
    const client = clientReturning(500, {
      message: `Unexpected credential ${SECRET}`,
    });

    await assert.rejects(client.request("/status"), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, "Unexpected credential [REDACTED]");
      assert.doesNotMatch(JSON.stringify(error), new RegExp(SECRET));
      return true;
    });
  });

  it("distinguishes network failures without retaining an unsafe cause", async () => {
    const client = new Inklet({
      secretKey: SECRET,
      fetch: async () => {
        throw new TypeError(`connect failed with ${SECRET}`);
      },
    });

    await assert.rejects(client.request("/displays"), (error) => {
      assert.ok(error instanceof NetworkError);
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      assert.doesNotMatch(JSON.stringify(error), new RegExp(SECRET));
      assert.equal(error.cause, undefined);
      return true;
    });
  });
});

function clientReturning(status, body, headers = {}) {
  return new Inklet({
    secretKey: SECRET,
    fetch: async () =>
      Response.json(body, {
        status,
        headers,
      }),
  });
}
