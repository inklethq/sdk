# Changelog

## Unreleased

- Decouple upload from processing: `contents.upload()` stores Content without
  running AI; `inklet.analyze()` / `inklet.direct()` start an Analysis over
  `contentIds` and/or the user's history and produce Presentations.
- Add `context: "submitted" | "history"`, `scope.since`, and `target`
  (agent-selected, pinned Displays, or software-only `output`) to Analysis.
- Add `analyses.wait()`, `analyses.list()`, `no_change` outcomes,
  `AnalysisFailedError`, and `NoChangeError`.
- Remove `contents.confirm()`; Content state is now `pending | ready | failed`
  and only tracks Asset ingestion.
- `push.*` and `presentations.generate()` are now wrappers over upload plus
  Analysis and accept `context`.
- Document the wire contract in `ANALYSIS_CONTRACT.md`.
- Add `SubscriptionRequiredError` for plan-gated SDK operations.
- Document that Auto and Manual Push require Pro while Hardcode remains
  available on Free.
- Add targetless `presentations.generate()`, `waitUntilReady()`, list, and
  rendition rendering so Scene JSON and PNG output no longer require a
  registered Display.
- Add the typed, versioned `inklet Scene v1` contract and output profiles for
  software surfaces such as macOS Widgets.

## 0.1.0 — 2026-08-13

- Add typed Display, Content, Presentation, Asset, and Push resources.
- Add Auto, Manual, and Hardcode Push workflows.
- Add direct presigned uploads without forwarding the PAT to storage.
- Refresh failed upload tickets once and retry binary uploads.
- Preserve backend error codes, request IDs, and structured details.
- Add strict Asset, pagination, time-range, and Content request validation.
- Keep Hardcode image dimensions server-controlled: PNG/JPEG inputs are
  automatically scaled to the target Display output size.
- Document asynchronous Content and Presentation lifecycle behavior.
- Verify Auto, Manual, and Hardcode against the dev backend, including real
  PNG, RAW2, and RAW4 downloads.

## 0.1.0-alpha.1 — 2026-07-24

- Publish the server-only PAT-authenticated client foundation.
- Add ESM, CommonJS, and TypeScript declaration builds.
- Add browser-environment, credential-leak, URL, and redirect protections.
