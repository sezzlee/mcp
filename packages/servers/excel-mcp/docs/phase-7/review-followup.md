# PR 73 review follow-up

Status, 2026-10-27: two confirmed runtime defects have been fixed on the existing branch. Acceptance is reopened for the changed runtime; this is not a merge-readiness sign-off. No merge, publication, deployment or private-consumer rollout was performed.

## Revisions and evidence boundaries

The review started at `87cbca8706b2f53ba03fc7be18bc2763cc585dbc`. PR metadata reported base `8fdb09f102d9e56f8d9dd0ca6d8d793ec1359649`. The fixes are `0e20250b22207b7708e20fdc84a981a1f20cdc26` and `87c0707b6243b6b495f3d2ab91ad1795f81d717d`.

The ordinary PR CI run [40492867042](https://github.com/sezzlee/mcp/actions/runs/40492867042) checked out synthetic merge `51aa21f8779092363e5fe5135691f8d4c6c8a8d3`, whose other parent is newer main `a2323e47eb13d2348c22c9e13953e4f48e66c5b4`. Do not confuse the PR metadata base with this actual tested integration. Excel build, type checking and lint passed; the combined job failed at generated-reference validation. Formatting and Vitest did not run after that failure. The new owner tests have not yet been executed.

The previous 6,520/136 test results, Qwen/application/SDK/scale evidence and full 15-job CI remain historical evidence for the runtime identified in the acceptance record. They are not acceptance of these fixes. No historical test count was incremented to imply a rerun.

## Confirmed findings

### P1: replacing a pivot could erase its new source

At `src/format/pivot-authoring.ts:255-262` in the starting revision, replacement read the new source before unconditionally clearing the previous pivot output. The existing overlap guard only considered the new output range.

Reproducer: create a pivot at `Data!E1:F4`, then replace that named pivot at `Data!H1`, selecting `Data!E1:F4` as its new source. The old output is now the requested source. The original implementation read it, erased it and produced a cache still pointing to those now-empty cells with `refreshOnLoad="0"`. The retained input version stayed unchanged, but the newly published workbook lost its source and advertised a current cache.

Commit `87c0707` rejects both full and partial old-output/new-source overlap before clearing any cells. Distinct-sheet sources and nonoverlapping shorter sources remain supported. The guard does not silently narrow supported safe refreshes.

`test/pivot-refresh.spec.ts` adds four MCP regressions: full and partial overlap after an earlier transaction write, plus same-sheet and different-sheet shorter-source success cases. Failure asserts unchanged source bytes and no new publication; success checks output values, the complete old tail and real cache metadata.

The isolated format harness reproduced the original corruption and the corrected refusal. Four controls passed; both refusal cases left every package part unchanged. An independent Python ZIP/XML check passed for both successful output artifacts. These checks used an explicitly limited ZIP adapter, not the production MCP/schema/fflate boundary.

### P2: scalar INDEX confused a blank cell with an invalid reference

At `src/calculation/evaluate.ts:440-446` in the starting revision, nullish coalescing converted a legitimate blank (`null`) to `#REF!`, just like an absent array element. The error propagated into saved XLSX caches while calculation reported `complete/current`.

Commit `0e20250` distinguishes `undefined` from `null`. Blank references retain blank semantics and become numeric zero where required; invalid addresses and real typed errors are retained.

`test/calculation-lookup.spec.ts` adds an MCP saved-cache regression with twelve fixed typed answers, and an opt-in uncached LibreOffice comparison. It covers stored and absent blanks, arithmetic, SUM, IFERROR, an omitted column argument, number/text/boolean values, invalid indices and a source error. Expected results are constants, not production-calculator outputs.

The isolated original-format reproduction had four wrong results out of eight. The patched output passed all eight independent XML value/type checks. Actual LibreOffice independently recalculated the uncached eight-formula fixture and agreed with the fixed answers. An initial attempt using stale input caches merely retained them and was rejected as calculation evidence rather than counted as success.

### Open integration gate: generated tool reference

CI reports `apps/docs/src/content/excel-mcp/reference/01-tools.md` out of date. Newer main changes the `find_in_sheet.sheetName` description, while the reviewed branch retains its earlier definition. Regenerate from the intended integrated source and inspect the generator's diff. No generated file was edited manually, and no gate was weakened. The full generated diff was not available in this sandbox, so the main change is a verified integration difference, not a claim that every generated difference has been isolated.

## Additional executed checks

Eight direct Linux x64 / Node 22.16.0 checks against the real historical CI native tarball passed: complete publication and source preservation; existing destination refusal with staging cleanup; asynchronous buffer copying; one complete unmixed concurrent winner; duplicate entry names; aggregate byte limits; entry traversal; and a symlink destination. This is not a clean npm installation, restart/power-loss proof or a rerun of the cross-platform matrix.

The two exact source changes and two new test files also passed `git apply --check` in a minimal temporary worktree, and applying the patch reproduced all four pushed blobs. That check is not compilation or Vitest execution.

## Runtime identity

The downloaded historical package has 129 JavaScript modules with sorted-path/NUL/bytes/NUL SHA-256 `9abd27742e21704b6da3500bc6d239e4f8f9430391f455525aad300b19da5b52`. The isolated harness substituted two modules transpiled with TypeScript 5.8.3; the resulting module-payload fingerprint is `9926b083d49202d5d7a2cf5509e524db63cbff1e35d40b53d5b8a974d74df30c`. Its loader adapters are additional explicit test infrastructure. Neither fingerprint identifies a fresh official build of the new head.

The actual fixed source identity is the full commit SHA above. Fresh CI used Node 24.21.0, pnpm 12.6.0 and TypeScript 7.0.2. Capture the final official dist fingerprint again before corpus, model, application and installed-package acceptance.

## Remaining acceptance work

The sandbox could read/write through the GitHub connector, but direct GitHub/npm DNS access and workspace dependency installation were unavailable. It had Node 22 and LibreOffice, not a complete Node 24/pnpm workspace, the external corpus, the configured model endpoint or .NET SDK. These limits do not turn unexecuted checks into passes.

Run commands from a clean repository checkout of the intended integrated source, with output directories outside the repository. The commands below are pending instructions, not executed evidence.

1. Regenerate the reference after building its actual dependencies, then run the normal reference/format gates. Use `pnpm turbo run build --filter='@sezzlee/docs^...' --concurrency=1 --ui=stream`, `node apps/docs/scripts/gen-reference.mjs`, `pnpm turbo run validate --filter=@sezzlee/docs --concurrency=1 --ui=stream` and `pnpm turbo run format:check`. Inspect and retain the generated diff; do not hand-edit it.
2. Execute the narrow owner tests first: `SEZZLEE_CALCULATION_ORACLE=1 pnpm turbo run test --filter=@sezzlee/excel-mcp --concurrency=1 --ui=stream -- test/calculation-lookup.spec.ts test/pivot-refresh.spec.ts --maxWorkers=1`. All six test cases, including the real LibreOffice case, must pass with no skips.
3. Run the full Excel suite with the authorized external `SEZZLEE_CORPUS` and `SEZZLEE_CALCULATION_ORACLE=1`, the lab suite, and build/type/lint checks through the documented Turbo commands. Record actual counts, skips and final dist identity; do not reuse historical counts.
4. Run the existing independent oracle self-tests and the expert scripted application/visual scenario. Validate the selected generated files with the existing Open XML SDK validator. Check actual values, relationships and chart series, not only successful opening. Keep LibreOffice's recorded `stopIfTrue` export limitation distinct from incorrect original OOXML.
5. Repeat the TR/EN expert model scenarios using the user's existing `SEZZLEE_AGENT_LAB_OLLAMA_URL` and selected model. Do not guess or commit an endpoint. Record model/settings, source/runtime identity, failed trials and full artifact/application/visual verdicts.
6. Repeat the expert scale scenario and required native/installed-tarball gates on the final source. Direct extraction and the eight native probes above do not replace a clean npm installation. No full matrix was manually restarted during this review.
7. Complete the remaining broad review coverage before sign-off. The review inspected the whole changed-file inventory and selected runtime/test paths, but did not finish a line-by-line review of all changed files or all phase-plan/status/acceptance documents. Phase 4 plan remainder, Phase 5 detailed records, Phase 6 plan/record, all native implementation changes, complete lab oracle changes and full cross-feature composition remain explicit coverage gaps. This is a review-completeness gap as well as an execution gap, not a claim that those files could not be read.

The most important unclosed interactions remain scoped names and structural edits; chart/image/note shared dependencies; protected-template unprotect/edit/reprotect; two-period/retry/retained-version workflows; and separate formula/chart/pivot freshness after editing. Unsupported interactions must fail atomically, not silently degrade. There is no new claim of encryption, macro editing/execution, threaded comments, shared-pivot-cache refresh or general Excel formula support.
