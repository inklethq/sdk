import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { describeFor, loadSdk } from "./sdk.mjs";

const describe = describeFor(import.meta.url);
const {
  ApiError,
  BrowserEnvironmentError,
  ConfigurationError,
  ConflictError,
  Inklet,
  InvalidResponseError,
  InvalidSecretKeyError,
  NetworkError,
  NotFoundError,
  OperationAbortedError,
  PayloadTooLargeError,
  PermissionDeniedError,
  RateLimitError,
  RequestTimeoutError,
  RevokedSecretKeyError,
  SubscriptionRequiredError,
} = await loadSdk(import.meta.url);

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

  it("keeps the backend code on a 409 so conflicts can be told apart", async () => {
    const cases = [
      {
        code: "presentation_not_deliverable",
        message: "That Presentation cannot be shown on this Display.",
        details: {
          presentationId: "presentation_123",
          displayId: "display_123",
          reason: "not_rendered",
        },
      },
      {
        code: "analysis_in_progress",
        message: "Too many Analyses are already queued.",
        details: { queued: 5 },
      },
      {
        code: "asset_not_uploaded",
        message: "An Asset has not finished uploading.",
        details: { assetIndex: 0 },
      },
    ];

    for (const error of cases) {
      const client = clientReturning(409, { error }, { "x-request-id": "req_conflict" });
      await assert.rejects(client.request("/api/sdk/v1/probe"), (thrown) => {
        assert.ok(thrown instanceof ConflictError);
        assert.equal(thrown.code, error.code);
        assert.equal(thrown.status, 409);
        assert.equal(thrown.message, error.message);
        assert.equal(thrown.requestId, "req_conflict");
        assert.deepEqual(thrown.details, error.details);
        return true;
      });
    }
  });

  it("falls back to the generic conflict code when the backend sends none", async () => {
    await assert.rejects(
      clientReturning(409, { error: { message: "Conflict" } }).request("/probe"),
      (thrown) => {
        assert.ok(thrown instanceof ConflictError);
        assert.equal(thrown.code, "conflict");
        return true;
      },
    );
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

describe("Inklet raw requests", () => {
  it("returns the unread Response, authenticated, and still throws typed errors", async () => {
    const calls = [];
    const client = new Inklet({
      secretKey: SECRET,
      baseUrl: "http://localhost:8787/v1",
      fetch: async (input, init = {}) => {
        calls.push({ url: new URL(input), init });
        if (calls.length === 1) {
          return new Response("data: 1\n\n", {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json(
          { error: { code: "analysis_not_found", message: "No such Analysis." } },
          { status: 404, headers: { "x-request-id": "req_raw" } },
        );
      },
    });

    const response = await client.requestRaw("/stream", {
      headers: { accept: "text/event-stream" },
    });
    // The body is the caller's to read, and has not been touched.
    assert.equal(response.bodyUsed, false);
    assert.equal(await response.text(), "data: 1\n\n");
    assert.equal(calls[0].url.toString(), "http://localhost:8787/v1/stream");
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${SECRET}`);
    assert.equal(headers.get("accept"), "text/event-stream");
    assert.equal(calls[0].init.redirect, "error");

    await assert.rejects(client.requestRaw("/missing"), (error) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.code, "analysis_not_found");
      assert.equal(error.requestId, "req_raw");
      return true;
    });
  });

  it("refuses the same unsafe paths as request()", async () => {
    let calls = 0;
    const client = new Inklet({
      secretKey: SECRET,
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    });
    await assert.rejects(
      client.requestRaw("https://attacker.example/stream"),
      ConfigurationError,
    );
    assert.equal(calls, 0);
  });
});

describe("Inklet error mapping for 413, 429, and bodies that are not JSON", () => {
  it("maps 413 to PayloadTooLargeError with the backend code and details", async () => {
    const client = clientReturning(
      413,
      {
        error: {
          code: "asset_too_large",
          message: "Asset 0 is larger than 10 MiB.",
          details: { assetIndex: 0, maxBytes: 10_485_760 },
        },
      },
      { "x-request-id": "req_large" },
    );
    await assert.rejects(client.request("/api/sdk/v1/contents"), (error) => {
      assert.ok(error instanceof PayloadTooLargeError);
      assert.equal(error.status, 413);
      assert.equal(error.code, "asset_too_large");
      assert.equal(error.message, "Asset 0 is larger than 10 MiB.");
      assert.deepEqual(error.details, { assetIndex: 0, maxBytes: 10_485_760 });
      assert.equal(error.requestId, "req_large");
      return true;
    });
  });

  it("maps 429 to RateLimitError and reads Retry-After in either form", async () => {
    const now = Date.now();
    const cases = [
      [{ "retry-after": "7" }, (ms) => ms === 7_000],
      [{ "retry-after": " 0 " }, (ms) => ms === 0],
      // An HTTP-date is measured from now; one in the past means now.
      [
        { "retry-after": new Date(now + 30_000).toUTCString() },
        (ms) => ms > 25_000 && ms <= 30_000,
      ],
      [{ "retry-after": new Date(now - 60_000).toUTCString() }, (ms) => ms === 0],
      [{ "retry-after": "soon" }, (ms) => ms === null],
      [{ "retry-after": "-5" }, (ms) => ms === null],
      [{}, (ms) => ms === null],
    ];

    for (const [headers, expected] of cases) {
      const client = clientReturning(
        429,
        { error: { code: "rate_limited", message: "Slow down." } },
        headers,
      );
      await assert.rejects(client.request("/probe"), (error) => {
        assert.ok(error instanceof RateLimitError);
        assert.equal(error.status, 429);
        assert.equal(error.code, "rate_limited");
        assert.ok(expected(error.retryAfterMs), `${JSON.stringify(headers)} -> ${error.retryAfterMs}`);
        assert.equal(error.toJSON().retryAfterMs, error.retryAfterMs);
        return true;
      });
    }
  });

  it("keeps quota_exceeded apart from rate limiting on the same class", async () => {
    const client = clientReturning(429, {
      error: {
        code: "quota_exceeded",
        message: "The monthly AI allowance is spent.",
        details: { quota: "ai", limit: 100, used: 100, resetAt: "2026-10-01T00:00:00Z" },
      },
    });
    await assert.rejects(client.request("/probe"), (error) => {
      assert.ok(error instanceof RateLimitError);
      assert.equal(error.code, "quota_exceeded");
      assert.equal(error.retryAfterMs, null);
      assert.equal(error.details.resetAt, "2026-10-01T00:00:00Z");
      return true;
    });
  });

  it("puts Retry-After on an ApiError too, which is where a 503 lands", async () => {
    const client = clientReturning(
      503,
      { error: { code: "processing_unavailable", message: "Try again shortly." } },
      { "retry-after": "3" },
    );
    await assert.rejects(client.request("/probe"), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "processing_unavailable");
      assert.equal(error.retryAfterMs, 3_000);
      return true;
    });
  });

  it("summarizes a gateway's HTML page instead of using it as the message", async () => {
    const page = `<!DOCTYPE html>
<html><head><title>502 Bad Gateway</title>
<style>body { font-family: sans-serif; }</style></head>
<body><h1>Bad Gateway</h1><p>The upstream server returned an invalid response.</p>
<script>window.__trace = "abc";</script></body></html>`;
    const client = new Inklet({
      secretKey: SECRET,
      fetch: async () =>
        new Response(page, {
          status: 502,
          headers: { "content-type": "text/html; charset=utf-8", "x-request-id": "req_gw" },
        }),
    });

    await assert.rejects(client.request("/status"), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "api_error");
      assert.equal(error.requestId, "req_gw");
      assert.equal(error.message, "The Inklet API returned HTTP 502: 502 Bad Gateway");
      return true;
    });
  });

  it("cuts a long plain-text body to one short line, with credentials redacted first", async () => {
    // The PAT straddles the cut: redacting after cutting would leave half of it.
    const body = `upstream\r\n\tfailure ${"x".repeat(180)} ${SECRET} ${"y".repeat(400)}`;
    const client = new Inklet({
      secretKey: SECRET,
      fetch: async () =>
        new Response(body, { status: 500, headers: { "content-type": "text/plain" } }),
    });

    await assert.rejects(client.request("/status"), (error) => {
      assert.ok(error instanceof ApiError);
      assert.match(error.message, /^The Inklet API returned HTTP 500: upstream failure x+/);
      assert.ok(error.message.endsWith("…"));
      assert.ok(error.message.length < 260, `${error.message.length} characters`);
      assert.doesNotMatch(error.message, /[\r\n\t]/);
      assert.doesNotMatch(error.message, /inklet_pat/);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(SECRET.slice(0, 12)));
      return true;
    });
  });

  it("falls back to the status alone when a non-JSON body says nothing", async () => {
    const client = new Inklet({
      secretKey: SECRET,
      fetch: async () =>
        new Response("<html><body>   </body></html>", {
          status: 504,
          headers: { "content-type": "text/html" },
        }),
    });
    await assert.rejects(client.request("/status"), (error) => {
      assert.equal(error.message, "The Inklet API returned HTTP 504.");
      return true;
    });
  });
});

describe("Inklet request timeouts and cancellation", () => {
  it("times a request out with RequestTimeoutError, a kind of NetworkError", async () => {
    const seen = [];
    const client = new Inklet({
      secretKey: SECRET,
      timeoutMs: 30,
      fetch: hangingFetch(seen),
    });

    const startedAt = Date.now();
    await assert.rejects(client.request("/slow"), (error) => {
      assert.ok(error instanceof RequestTimeoutError);
      assert.ok(error instanceof NetworkError);
      assert.equal(error.code, "request_timed_out");
      assert.equal(error.timeoutMs, 30);
      assert.equal(error.details.timeoutMs, 30);
      assert.match(error.message, /did not complete within 30 ms/);
      return true;
    });
    assert.ok(Date.now() - startedAt < 1_000);
    // The request itself was cancelled, not merely abandoned.
    assert.equal(seen[0].signal.aborted, true);
  });

  it("lets one call override the client timeout", async () => {
    const client = new Inklet({
      secretKey: SECRET,
      timeoutMs: 60_000,
      fetch: hangingFetch(),
    });
    await assert.rejects(
      client.request("/slow", { timeoutMs: 20 }),
      (error) => error instanceof RequestTimeoutError && error.timeoutMs === 20,
    );
    await assert.rejects(
      client.displays.retrieve("display_123", { timeoutMs: 20 }),
      (error) => error instanceof RequestTimeoutError && error.timeoutMs === 20,
    );
  });

  it("keeps timing request() while the body is read", async () => {
    const client = new Inklet({
      secretKey: SECRET,
      timeoutMs: 40,
      fetch: async (_input, init = {}) => stalledBody(init.signal, '{"id": "display_'),
    });
    await assert.rejects(client.request("/partial"), (error) => {
      assert.ok(error instanceof RequestTimeoutError);
      assert.equal(error.status, 200);
      return true;
    });
  });

  it("stops timing requestRaw() once the headers arrive", async () => {
    const client = new Inklet({
      secretKey: SECRET,
      timeoutMs: 20,
      fetch: async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
              // Well past the timeout: a stream is not cut off for being slow.
              await new Promise((resolve) => setTimeout(resolve, 80));
              controller.enqueue(new TextEncoder().encode("data: 2\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const response = await client.requestRaw("/stream");
    assert.equal(await response.text(), "data: 1\n\ndata: 2\n\n");
  });

  it("reports a caller's abort as OperationAbortedError, never as a network failure", async () => {
    const seen = [];
    const client = new Inklet({ secretKey: SECRET, fetch: hangingFetch(seen) });
    const controller = new AbortController();
    const pending = client.request("/slow", { signal: controller.signal });
    controller.abort(new Error("user navigated away"));

    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof OperationAbortedError);
      assert.ok(!(error instanceof NetworkError));
      assert.equal(error.cause.message, "user navigated away");
      return true;
    });
    assert.equal(seen[0].signal.aborted, true);

    // A signal that is already aborted sends nothing at all.
    const before = seen.length;
    await assert.rejects(
      client.contents.retrieve("content_123", { signal: controller.signal }),
      OperationAbortedError,
    );
    assert.equal(seen.length, before);
  });

  it("aborts a raw body mid-read", async () => {
    const controller = new AbortController();
    const client = new Inklet({
      secretKey: SECRET,
      fetch: async (_input, init = {}) => stalledBody(init.signal, "data: 1\n\n", "text/event-stream"),
    });
    const response = await client.requestRaw("/stream", { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    const next = reader.read();
    controller.abort();
    await assert.rejects(next);
  });

  it("validates timeouts before anything is sent", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return Response.json({});
    };
    for (const timeoutMs of [0, -1, 1.5, "1000", 2 ** 31, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new Inklet({ secretKey: SECRET, fetch, timeoutMs }),
        ConfigurationError,
        String(timeoutMs),
      );
      assert.throws(
        () => new Inklet({ secretKey: SECRET, fetch, uploadTimeoutMs: timeoutMs }),
        ConfigurationError,
      );
    }
    const client = new Inklet({ secretKey: SECRET, fetch });
    await assert.rejects(client.request("/x", { timeoutMs: 0 }), ConfigurationError);
    await assert.rejects(
      client.presentations.retrieve("presentation_123", { timeoutMs: -5 }),
      ConfigurationError,
    );
    assert.equal(calls, 0);
  });

  it("combines signals by hand where AbortSignal.any is missing", async () => {
    const original = AbortSignal.any;
    AbortSignal.any = undefined;
    try {
      const client = new Inklet({ secretKey: SECRET, timeoutMs: 25, fetch: hangingFetch() });
      await assert.rejects(client.request("/slow"), RequestTimeoutError);

      const controller = new AbortController();
      const pending = client.request("/slow", {
        signal: controller.signal,
        timeoutMs: 60_000,
      });
      controller.abort();
      await assert.rejects(pending, OperationAbortedError);

      // A request that finishes lets go of the caller's signal.
      const quick = new Inklet({
        secretKey: SECRET,
        fetch: async () => Response.json({ ok: true }),
      });
      const shared = new AbortController();
      assert.deepEqual(await quick.request("/ok", { signal: shared.signal }), { ok: true });
      shared.abort();
    } finally {
      AbortSignal.any = original;
    }
  });
});

/**
 * A fetch that never answers on its own, and rejects the way `fetch` does
 * once its signal aborts. Each call's init is pushed onto `seen`.
 */
function hangingFetch(seen = []) {
  return (_input, init = {}) =>
    new Promise((_resolve, reject) => {
      seen.push(init);
      init.signal?.addEventListener(
        "abort",
        () => reject(init.signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
}

/** A 200 whose body sends `first` and then stalls until the request is aborted. */
function stalledBody(signal, first, contentType = "application/json") {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(first));
        signal?.addEventListener(
          "abort",
          () => controller.error(signal.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      },
    }),
    { headers: { "content-type": contentType } },
  );
}

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
