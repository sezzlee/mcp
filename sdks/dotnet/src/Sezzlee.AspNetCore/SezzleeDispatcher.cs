using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Primitives;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Errors;
using Sezzlee.AspNetCore.Requests;
using Sezzlee.AspNetCore.Visibility.Probe;

namespace Sezzlee.AspNetCore;

internal sealed record DispatchResult(int Status, string Body, string? ContentType, IReadOnlyDictionary<string, string> Headers)
{
    public BackendResponse ToBackendResponse() => new(Status, ContentType, Headers, Body);
}

internal sealed record ProbeOutcome(int Status, bool ShortCircuited);

/// <summary>Raised when an invocation outlived its deadline and was abandoned.</summary>
internal sealed class SezzleeDispatchTimeout()
    : Exception("sezzlee: the backend did not answer within the invoke deadline.");

/// <summary>Raised when a <c>ref</c> was not delivered; the meta-tool layer turns it into an envelope.</summary>
internal sealed class SezzleeFileRefused(string field, string reason, int limit)
    : Exception($"sezzlee: file argument '{field}' was refused ({reason}).")
{
    public string Field { get; } = field;
    public string Reason { get; } = reason;
    public int Limit { get; } = limit;
}

/// <summary>What an invocation's body needs beyond its arguments: the budgets and whom a <c>ref</c> is resolved for.</summary>
internal sealed record DispatchFiles(InvokeTarget Target, int MaxInlineFileBytes, int MaxFileBytes);

/// <remarks>
/// Guard: minimal APIs read a JSON body only when this feature says <c>CanHaveBody</c>, and a
/// <see cref="DefaultHttpContext"/> carries none, so without it every minimal-API JSON body binds
/// as absent (a 400, or a silent <c>null</c> for an optional one). Kestrel sets it per request;
/// this mirrors it. Pinned by JsonPatchHostTests.JH4 and MinimalJsonBodyHostTests.
/// </remarks>
internal sealed class SyntheticBodyDetection(bool canHaveBody) : IHttpRequestBodyDetectionFeature
{
    public bool CanHaveBody { get; } = canHaveBody;
}

internal sealed class SezzleeDispatcher(
    PipelineHolder holder, SyntheticRequestFactory requests, IServiceProvider services,
    ILogger<SezzleeDispatcher> logger)
{
    private static readonly IReadOnlyDictionary<string, string> NoHeaders =
        new Dictionary<string, string>();

    public Task<DispatchResult> DispatchAsync(
        HttpMethod method, string path, HttpRequest? outerRequest, CancellationToken cancellationToken)
    {
        return DispatchAsync(method, new ComposedRequest(path, NoHeaders, null), outerRequest, cancellationToken, default, null);
    }

    public Task<DispatchResult> DispatchAsync(
        RequestTemplate template, JsonElement arguments, HttpRequest? outerRequest,
        CancellationToken cancellationToken,
        IReadOnlyDictionary<string, JsonElement>? deferred = null,
        TimeSpan deadline = default,
        DispatchFiles? files = null)
    {
        ComposedRequest composed = RequestComposer.Compose(
            template, arguments, deferred,
            files is null ? null : new ComposeLimits(files.MaxInlineFileBytes));
        return DispatchAsync(template.Method, composed, outerRequest, cancellationToken, deadline, files);
    }

    public async Task<ProbeOutcome> ProbeAsync(
        HttpMethod method, string path, HttpRequest? outerRequest, CancellationToken cancellationToken)
    {
        RequestDelegate pipeline = Pipeline();
        await using SyntheticRequest synthetic = requests.Create(outerRequest, cancellationToken);
        DefaultHttpContext context = synthetic.Context;
        context.Request.Method = method.Method;
        context.Request.Path = path;
        context.Response.Body = Stream.Null;
        SezzleeProbe.MarkProbe(context);

        await RunAsync(pipeline, context);

        return new ProbeOutcome(context.Response.StatusCode, SezzleeProbe.WasShortCircuited(context));
    }

    /// <remarks>
    /// Guard: Kestrel answers an exception that escapes the pipeline with a bare 500 and logs it;
    /// the dispatcher does the same. Letting it propagate made a handler's exception an
    /// <c>internal_error</c> blamed on sezzlee and carrying the exception message to the agent,
    /// where every other 5xx body is withheld. A cancellation of the synthetic request itself still
    /// propagates, because that is the deadline or the caller, not the handler. Pinned by
    /// UnhandledExceptionHostTests.
    /// </remarks>
    private async Task RunAsync(RequestDelegate pipeline, HttpContext context)
    {
        try
        {
            await pipeline(context).ConfigureAwait(false);
        }
        catch (Exception ex) when (!(ex is OperationCanceledException && context.RequestAborted.IsCancellationRequested))
        {
            logger.LogError(
                ex, "sezzlee: an unhandled exception escaped {Method} {Path}; answered 500.",
                context.Request.Method, context.Request.Path);
            context.Response.Clear();
            context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        }
    }

    private RequestDelegate Pipeline() => holder.Pipeline
        ?? throw new InvalidOperationException(
            "sezzlee pipeline is not captured. Call app.UseSezzleeCapture() before routing and start the host first.");

    private Func<RefFile, string, ValueTask<ResolvedFile>> RefResolver(
        HttpRequest? outerRequest, DispatchFiles? files, CancellationToken cancellationToken)
    {
        return async (file, field) =>
        {
            Files.ISezzleeFileResolver resolver = services.GetService(typeof(Files.ISezzleeFileResolver))
                as Files.ISezzleeFileResolver
                ?? throw new InvalidOperationException(
                    $"sezzlee: file argument '{field}' is a ref but no file resolver is registered.");
            if (files is null)
            {
                throw new InvalidOperationException(
                    $"sezzlee: file argument '{field}' is a ref but the call carries no file budget.");
            }
            int limit = files.MaxFileBytes;
            Files.FileResolution outcome = await resolver.ResolveAsync(
                new Files.FileResolveRequest(
                    file.Ref, field, files.Target, CallerFactory.From(outerRequest?.HttpContext), limit),
                cancellationToken).ConfigureAwait(false);
            switch (outcome)
            {
                case Files.FileResolution.Refused refused:
                    throw new SezzleeFileRefused(field, refused.Reason switch
                    {
                        Files.FileRefusal.NotFound => "not_found",
                        Files.FileRefusal.Forbidden => "forbidden",
                        Files.FileRefusal.TooLarge => "too_large",
                        _ => "unavailable",
                    }, limit);
                case Files.FileResolution.Resolved resolved:
                    if (resolved.Bytes.Length > limit)
                    {
                        throw new SezzleeFileRefused(field, "too_large", limit);
                    }
                    return new ResolvedFile(
                        resolved.Bytes,
                        file.FileName ?? (RequestBodyEncoder.IsUsableFileName(resolved.FileName) ? resolved.FileName! : file.FallbackFileName),
                        file.MediaType ?? (resolved.MediaType is { } type && RequestBodyEncoder.MediaTypeGrammar().IsMatch(type) ? type : file.FallbackMediaType));
                default:
                    throw new InvalidOperationException("sezzlee: the file resolver returned an unknown resolution.");
            }
        };
    }

    /// <remarks>
    /// Guard: the deadline is armed before any <c>ref</c> is resolved, so a resolver that hangs is
    /// bounded exactly like a backend that hangs. Resolving during the validating composition would
    /// let it outlive the call it serves.
    /// Guard: the deadline cancels the handler's <c>RequestAborted</c> and the abandon signal from one
    /// token, so a handler that honours cancellation can win <c>WhenAny</c>; its cancellation is still
    /// the deadline and must answer <c>invoke_timeout</c>. Pinned by ResponseBudgetTests.R4, which
    /// failed on net10.0 in CI before <c>await run</c> mapped it.
    /// </remarks>
    private async Task<DispatchResult> DispatchAsync(
        HttpMethod method, ComposedRequest composed, HttpRequest? outerRequest,
        CancellationToken cancellationToken, TimeSpan deadline, DispatchFiles? files)
    {
        RequestDelegate pipeline = Pipeline();

        using CancellationTokenSource linked =
            CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (deadline > TimeSpan.Zero)
        {
            linked.CancelAfter(deadline);
        }

        WrittenBody? written = null;
        if (composed.Content is { } content)
        {
            try
            {
                written = await BodyWriter.WriteAsync(content, RefResolver(outerRequest, files, linked.Token))
                    .AsTask().WaitAsync(linked.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (linked.IsCancellationRequested)
            {
                cancellationToken.ThrowIfCancellationRequested();
                throw new SezzleeDispatchTimeout();
            }
        }

        SyntheticRequest synthetic = requests.Create(outerRequest, linked.Token);
        bool owned = true;
        try
        {
            DefaultHttpContext context = synthetic.Context;

            context.Request.Method = method.Method;
            int queryIndex = composed.PathAndQuery.IndexOf('?');
            if (queryIndex < 0)
            {
                context.Request.Path = composed.PathAndQuery;
            }
            else
            {
                context.Request.Path = composed.PathAndQuery[..queryIndex];
                context.Request.QueryString = new QueryString(composed.PathAndQuery[queryIndex..]);
            }

            foreach ((string name, string value) in composed.Headers)
            {
                if (string.Equals(name, "cookie", StringComparison.OrdinalIgnoreCase))
                {
                    string? carried = context.Request.Headers.TryGetValue("Cookie", out StringValues existing)
                        ? existing.ToString()
                        : null;
                    string? merged = RequestComposer.MergeCookieHeader(carried, value);
                    if (merged is not null)
                    {
                        context.Request.Headers["Cookie"] = merged;
                    }
                    continue;
                }
                context.Request.Headers[name] = value;
            }
            context.Features.Set<IHttpRequestBodyDetectionFeature>(new SyntheticBodyDetection(written is not null));
            if (written is not null)
            {
                context.Request.Body = new MemoryStream(written.Bytes);
                context.Request.ContentLength = written.Bytes.Length;
                context.Request.ContentType = written.ContentType;
            }

            MemoryStream responseBody = new();
            context.Response.Body = responseBody;

            Task run = RunAsync(pipeline, context);
            TaskCompletionSource abandoned = new(TaskCreationOptions.RunContinuationsAsynchronously);
            using (linked.Token.Register(() => abandoned.TrySetResult()))
            {
                if (await Task.WhenAny(run, abandoned.Task).ConfigureAwait(false) != run)
                {
                    owned = false;
                    Abandon(synthetic, responseBody, run);
                    cancellationToken.ThrowIfCancellationRequested();
                    throw new SezzleeDispatchTimeout();
                }
            }
            try
            {
                await run.ConfigureAwait(false);
                // Guard: ASP.NET's JSON writer swallows a cancelled RequestAborted, so a handler cut
                // off mid-response returns normally with a partial body, and it can win the race
                // against the abandon signal above. A pipeline that finished after the deadline is a
                // timeout, never a truncated success. Pinned by ResponseBudgetTests.R6.
                linked.Token.ThrowIfCancellationRequested();
            }
            catch (OperationCanceledException) when (linked.IsCancellationRequested)
            {
                cancellationToken.ThrowIfCancellationRequested();
                throw new SezzleeDispatchTimeout();
            }

            responseBody.Position = 0;
            using StreamReader reader = new(responseBody);
            string body = await reader.ReadToEndAsync(cancellationToken);

            Dictionary<string, string> headers = new(StringComparer.OrdinalIgnoreCase);
            foreach ((string name, StringValues values) in context.Response.Headers)
            {
                headers[name] = string.Join(", ", values.ToArray());
            }

            return new DispatchResult(context.Response.StatusCode, body, context.Response.ContentType, headers);
        }
        finally
        {
            if (owned)
            {
                await synthetic.DisposeAsync().ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Hands the request scope and the response buffer to the handler that is still running, so an
    /// abandoned handler writing after the deadline cannot hit a disposed stream or a disposed DI
    /// scope. Observing <c>task.Exception</c> is what keeps that throw off the finalizer thread as
    /// an unobserved task exception. Pinned by ResponseBudgetTests.
    /// </summary>
    private static void Abandon(SyntheticRequest synthetic, MemoryStream responseBody, Task run)
    {
        _ = run.ContinueWith(
            async completed =>
            {
                _ = completed.Exception;
                await responseBody.DisposeAsync().ConfigureAwait(false);
                await synthetic.DisposeAsync().ConfigureAwait(false);
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }
}
