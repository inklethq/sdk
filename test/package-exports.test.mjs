import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

describe("published package exports", () => {
  it("loads through the ESM import condition", async () => {
    const sdk = await import("@inklethq/sdk");

    assert.equal(typeof sdk.Inklet, "function");
    assert.equal(sdk.Inklet, sdk.InkletClient);
    assert.equal(typeof sdk.AssetsResource, "function");
    assert.equal(typeof sdk.ContentsResource, "function");
    assert.equal(typeof sdk.AnalysesResource, "function");
    assert.equal(typeof sdk.DisplaysResource, "function");
    assert.equal(typeof sdk.PresentationsResource, "function");
    assert.equal(typeof sdk.PushResource, "function");
  });

  it("loads through the CommonJS require condition", () => {
    const require = createRequire(import.meta.url);
    const sdk = require("@inklethq/sdk");

    assert.equal(typeof sdk.Inklet, "function");
    assert.equal(sdk.Inklet, sdk.InkletClient);
    assert.equal(typeof sdk.PushResource, "function");
  });
});
