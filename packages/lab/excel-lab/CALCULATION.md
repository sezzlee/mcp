# Calculation acceptance

Build through Turbo before invoking the CLI. Run from the repository root:

```sh
pnpm turbo run build --filter=@sezzlee/excel-mcp
node packages/lab/excel-lab/src/lab/run-cli.ts --out /tmp/calculation-scripted --suite calc
SEZZLEE_AGENT_LAB_OLLAMA_URL=http://MODEL_HOST:11434 node packages/lab/excel-lab/src/lab/run-cli.ts --out /tmp/calculation-model --suite calc --model MODEL
```

Each run creates synthetic public fixtures and tests calculation, edit → calculate and explicit unsupported/circular reporting in Turkish and English. The scripted baseline always runs both languages; `--languages tr` or `--languages en` selects the model-trial languages. Output directories are fresh evidence roots, not existing source or corpus directories.

The live run uses the existing Ollama wire adapter, `think: false`, a 65,536-token context, temperature zero, a 4,096-token response limit and a budget of ten requests and ten calls. It records host/model identity, controls, complete traces, selected output paths, source hashes and final claim checks. An unfinished model turn is a failure even when a correct workbook was produced.

`calculation-oracle.ts` independently reads saved ZIP/XML with Saxes and checks fixed expected scalar results, cache types, exact formula text and absent caches for unavailable cells. Its corruption controls reject wrong values/types, changed/missing formulas, duplicate/missing cells and stale caches. Model output never supplies the expected numeric answer.

Run the calculation owners and independent spreadsheet comparison:

```sh
SEZZLEE_CALCULATION_ORACLE=1 pnpm turbo run test --filter=@sezzlee/excel-mcp -- test/calculation.spec.ts
pnpm turbo run test --filter=@sezzlee/excel-lab -- test/calculation-oracle.spec.ts
```

The first command requires `soffice` on PATH and recomputes uncached synthetic fixtures in a separate LibreOffice profile. The [implementation status](../../servers/excel-mcp/docs/phase-6/implementation-status.md) identifies Excel-specific cases where LibreOffice is deliberately not treated as the reference engine. Full reader regression additionally sets `SEZZLEE_CORPUS` to the existing licensed corpus; do not copy that corpus into the repository.

Validate selected output files with the existing Open XML SDK project. Keep live endpoint addresses, traces, licensed workbooks and generated evidence outside the public repository. A local model run does not replace native/packed-package CI acceptance.
