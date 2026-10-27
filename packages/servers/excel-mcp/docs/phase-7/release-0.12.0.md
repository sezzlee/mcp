# Excel MCP 0.12.0 release

Published on 2026-10-27 from release commit `0eb935362f46ff10fd946a0a5fb5b3b562fa003e`.

| Package                     | Published version | Reason                                                                |
| --------------------------- | ----------------- | --------------------------------------------------------------------- |
| `@sezzlee/excel-mcp`        | `0.12.0`          | Bulk preparation, report authoring, calculation and expert workflows. |
| `@sezzlee/file-core`        | `0.3.5`           | Published native dependency floor moves to `^0.3.1`.                  |
| `@sezzlee/file-core-native` | `0.3.1`           | Atomic directory publication and the Windows publication handle fix.  |

Excel's published ranges require `file-core ^0.3.5` and `file-core-native ^0.3.1`. The server descriptor and generated references identify 0.12.0. No runtime implementation was changed in this release commit.

## Tested artifact publication

The required [Publish dry run](https://github.com/sezzlee/mcp/actions/runs/40507086621) passed all 17 jobs, including the native Node 22/24 matrix and clean packed installation. The [actual Publish run](https://github.com/sezzlee/mcp/actions/runs/40508233700) used `from_run=40507086621` on the same main commit; CI was reused.

All three npm versions are tagged `latest`, carry provenance and match the SHA-512 identities of dry-run artifact `12736510061`:

- `@sezzlee/excel-mcp@0.12.0`: `sha512-YfOli4L0QL0+mVfj4PSgY7paNQBDxebhgt8R7TCsVt35niCDcsLbLN25xSLh0aURBNi/knq0v3YHIXUHEZMQwg==`
- `@sezzlee/file-core@0.3.5`: `sha512-1HDOwhQpBGSItzqOnIcP9gfIJIIEIR6pqJgqMCWUbmlxYIbA3j2RgDu/p+GOBaIAhNcGtNTss9lQoLr1Wc9HRw==`
- `@sezzlee/file-core-native@0.3.1`: `sha512-wgMc3dlx7ZS85RAY4NCkXBm45dMFnDGUfwZt4stgyRWa87iSBxs9W99uscH4uZalNUoV3Bmx0Oepn2w21u8zMw==`

Registry metadata and the native download briefly lagged successful publication. Initial clean installation attempts returned ETARGET/E404; no version was republished. The final ordinary npm installation succeeded.

## Actual registry consumer

A fresh directory installed `@sezzlee/excel-mcp@0.12.0` from npm without workspace links or dependency overrides. The installed Excel 0.12.0, file-core 0.3.5 and native 0.3.1 resolved one physical native module.

Real MCP stdio calls passed creation, atomic bulk publication, durable replay, typed template fill, validation/conditional formatting, notes/links, chart/pivot authoring, formula calculation and protection. Independent saved values were checked: pivot grand total 35; horizontal INDEX 10; fractional VLOOKUP 10; unsupported-array cache absent. Source bytes remained unchanged.

## Registry and live docs

The [MCP Registry run](https://github.com/sezzlee/mcp/actions/runs/40508544669) succeeded on attempt 2. Its first attempt failed because npm had not yet exposed Excel 0.12.0; only the failed job was retried. The public Registry API now lists `io.github.sezzlee/excel@0.12.0` with npm package 0.12.0.

The release docs were deployed as Worker version `3981b106-0206-4d80-a197-464ea4896e9e`. Both authoring recipes and all three reference pages returned HTTPS 200 and contain 0.12.0:

- [Chart and pivot report](https://docs.sezzlee.app/docs/excel-mcp/build-a-chart-and-pivot-report)
- [Formatted report](https://docs.sezzlee.app/docs/excel-mcp/build-a-formatted-report)
- [Tools](https://docs.sezzlee.app/docs/excel-mcp/tools)
- [Error codes](https://docs.sezzlee.app/docs/excel-mcp/error-codes)
- [Limits](https://docs.sezzlee.app/docs/excel-mcp/limits)

The release examples passed through the workspace MCP build before deployment. Publication does not update any private product runtime pin automatically. The earlier phase acceptance remains historical evidence for its recorded source; this release note records the later package publication.
