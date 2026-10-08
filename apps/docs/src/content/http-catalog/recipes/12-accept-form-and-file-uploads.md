# Accept form bodies and file uploads

Expose form bodies, `multipart/form-data` uploads, `+json` variants and raw `text/plain` endpoints as tools, and let a file reach your endpoint without the agent writing it into its own context. Where this page and the [request-bodies spec](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/request-bodies.md) differ, the spec wins.

## What you get for free

The agent always sends a JSON object of arguments. The SDK decides how those go on the wire, from what your framework already says about the endpoint.

- **`[Consumes]` and JSON variants.** On ASP.NET Core the media type comes from the endpoint's accepts metadata, so `[Consumes("application/merge-patch+json")]` is sent as exactly that.
- **Forms.** A `[FromForm]` DTO, a minimal-API `[FromForm]` parameter, or a Nest `@Body()` with `consumes` set to urlencoded becomes a tool whose arguments are the form's fields. A nested object is one level deep, written `address.city` on ASP.NET Core and `address[city]` on Nest.
- **Files.** `IFormFile`, `IFormFileCollection`, and a Nest `FileInterceptor` with its field declared become multipart file fields.
- **JSON Patch.** A `JsonPatchDocument<T>` body is published as the RFC 6902 operation array the agent sends as `body`.

## Declare what cannot be read

Nest keeps a file interceptor's field name in a closure, so you declare it:

```ts
@Post("upload")
@McpTool({ files: { attachment: { mediaType: "text/csv" } } })
@UseInterceptors(FileInterceptor("attachment"))
upload(@UploadedFile() file: UploadedPart | undefined, @Body() body: TitleForm) {
  return { title: body.title, file: describePart(file) };
}
```

`multiple: true` covers a `FilesInterceptor`. An `@ApiBody` schema that marks the field `format: "binary"` is read too. Without either, the endpoint is dropped with `unresolved_file_field`. When discovery cannot see the media type, name it with `@McpTool({ consumes: "…" })` on NestJS or `[McpTool(Consumes = "...")]` on ASP.NET Core. The declaration has to be one the endpoint accepts, or it is `content_type_not_accepted`.

## What the agent sends for a file

A file argument carries exactly one source:

```json
{ "attachment": { "text": "a,b\n1,2", "name": "report.csv" } }
{ "avatar": { "base64": "iVBORw==", "name": "me.png" } }
{ "attachment": { "ref": "att-1" } }
```

- `text` is for content the agent produced itself. It costs nothing extra.
- `base64` is for small binary files. Every byte is model output, so it is capped by `invoke.maxInlineFileBytes` (1 MiB by default, summed over the call) and refused above that.
- `ref` is a handle your own storage resolves. It is offered only when you bind a resolver.

## Bind a resolver for large files

A `ref` is how a file the user attached, or one another tool stored, reaches your endpoint without passing through the agent. You implement one method. These resolvers are the in-memory ones the SDKs' own tests use. Yours looks the ref up in your store.

:::tabs

```csharp title="ASP.NET Core"
private sealed class MemoryResolver : ISezzleeFileResolver
{
    public string RefDescription => "An attachment id returned by upload_attachment.";

    public async ValueTask<FileResolution> ResolveAsync(
        FileResolveRequest request, CancellationToken cancellationToken)
    {
        return request.Ref switch
        {
            "att-1" => new FileResolution.Resolved("id,total\n1,10\n"u8.ToArray(), "rapor.csv", "text/csv"),
            "att-denied" => new FileResolution.Refused(FileRefusal.Forbidden),
            _ => new FileResolution.Refused(FileRefusal.NotFound),
        };
    }
}

builder.Services.AddSingleton<ISezzleeFileResolver>(_resolver);
```

```ts title="NestJS"
class MemoryResolver implements FileResolver {
  readonly refDescription = "An attachment id returned by upload_attachment.";

  resolve(request: FileResolveRequest) {
    if (request.ref === "att-denied") {
      return Promise.resolve({
        ok: false as const,
        reason: "forbidden" as const,
      });
    }
    const bytes = stored[request.ref];
    return Promise.resolve(
      bytes === undefined
        ? { ok: false as const, reason: "not_found" as const }
        : {
            ok: true as const,
            bytes,
            filename: "rapor.csv",
            mediaType: "text/csv",
          },
    );
  }
}

SezzleeModule.forRoot((options) => {
  options.files.resolver = resolver;
});
```

:::

Authorize the ref against the caller. A ref is a string the agent wrote, and the SDK checks nothing about it. `not_found` and `forbidden` produce the same message on purpose, so an agent cannot use the error to find out which refs exist.

The resolver runs inside the invoke deadline and receives the cancellation signal. A resolved file over `invoke.maxFileBytes` (16 MiB by default) is refused with `file_too_large`. The limit is passed to the resolver so it can refuse before loading.

:::details[When an endpoint still does not appear]

Four codes are specific to bodies, and each drops only the endpoint it names:

- `unsupported_binding`: a media type with no writer, such as `application/xml`, or a raw-body binding.
- `unsupported_body_shape`: a free-form form body, a second level of nesting, an array of objects, or a file in a urlencoded body.
- `form_antiforgery_required`: an ASP.NET Core form endpoint requires antiforgery. Opt it out with `.DisableAntiforgery()` if browsers do not reach it. sezzlee never bypasses antiforgery for you, because a synthetic request carries no token and turning off a security control is your decision.
- `body_parser_missing`: Nest has no parser for the media type. `app.useBodyParser("text")` adds one for `text/plain`.

:::

:::details[Known gaps]

On Nest, a `+json` endpoint is sent as `application/json`, because Express's default JSON parser reads nothing else. Declare `consumes` if you registered a parser for the variant. Bodies are held in memory, so the peak is `invoke.maxFileBytes` times the number of concurrent calls.

:::
