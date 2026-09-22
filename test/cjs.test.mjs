// The behaviour suites again, against the CommonJS build.
//
// dist/cjs is compiled separately from dist/esm and is what every `require`
// caller gets, so it earns more than the smoke test in
// package-exports.test.mjs. Each import below carries `?build=cjs`, which
// gives the suite a module instance of its own that loads dist/cjs (see
// sdk.mjs); the suites themselves are unchanged.
await import("./client.test.mjs?build=cjs");
await import("./resources.test.mjs?build=cjs");
await import("./events.test.mjs?build=cjs");
await import("./reliability.test.mjs?build=cjs");
