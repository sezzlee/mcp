using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using ModelContextProtocol.Server;
using Sezzlee.AspNetCore.Caching;
using Sezzlee.AspNetCore.Errors;
using Sezzlee.AspNetCore.Tools;
using Sezzlee.AspNetCore.Transport;
using Sezzlee.AspNetCore.Visibility;
using Sezzlee.AspNetCore.Visibility.Probe;

namespace Sezzlee.AspNetCore;

public static class SezzleeServiceCollectionExtensions
{
    public static IServiceCollection AddSezzlee(
        this IServiceCollection services, Action<SezzleeOptions>? configure = null)
    {
        services.AddOptions<SezzleeOptions>();
        if (configure is not null)
        {
            services.Configure(configure);
        }

        if (services.Any(d => d.ServiceType == typeof(SezzleeRegistrationMarker)))
        {
            return services;
        }
        services.AddSingleton<SezzleeRegistrationMarker>();

        services.TryAddSingleton(TimeProvider.System);
        services.AddHttpContextAccessor();
        services.AddEndpointsApiExplorer();
        services.TryAddSingleton<PipelineHolder>();
        services.TryAddSingleton<SyntheticRequestFactory>();
        services.TryAddSingleton<SezzleeDispatcher>();
        services.TryAddSingleton<SezzleeCatalogProvider>();
        services.TryAddSingleton<ISezzleeCatalogChangeSource>(p => p.GetRequiredService<SezzleeCatalogProvider>());
        services.TryAddSingleton(p => new SezzleeOpenApiExtensions(p.GetRequiredService<SezzleeCatalogProvider>()));
        services.TryAddSingleton<IVisibilityEvaluator, DeclarativeVisibilityEvaluator>();
        services.TryAddSingleton<IProbeEvaluator, ProbeEvaluator>();
        services.TryAddSingleton<ICallerScopeResolver, CarrierHashCallerScopeResolver>();
        services.TryAddSingleton<ToolAccessResolver>();
        services.TryAddSingleton<ISezzleeCache, MemorySezzleeCache>();
        services.TryAddSingleton<CallerVisibilityProvider>();
        services.TryAddSingleton<ISezzleeCacheInvalidator, SezzleeCacheInvalidator>();
        services.TryAddSingleton<IInvokeResultMapper, InvokeResultMapper>();
        services.TryAddSingleton<IProtectedResourceMetadataProvider, OptionsProtectedResourceMetadataProvider>();
        services.TryAddSingleton<SezzleeEndpointRegistration>();
        services.TryAddSingleton<ToolListChangePublisher>();
        services.AddHostedService<Discovery.SezzleeFamilyLoader>();
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IValidateOptions<SezzleeOptions>, SezzleeOptionsValidator>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IPostConfigureOptions<McpServerOptions>, ToolCollectionSetup>());
        services.AddOptions<SezzleeOptions>().ValidateOnStart();

        DecorateAuthorizationResultHandler(services);
        services.Configure<MvcOptions>(mvc => mvc.Filters.Add<ProbeResourceFilter>(int.MinValue));
        services.AddMcpServer().WithHttpTransport().WithTools<SezzleeMetaTools>();
        return services;
    }

    /// <summary>
    /// Binds <see cref="SezzleeOptions"/> from <paramref name="configuration"/>, then applies
    /// <paramref name="configure"/>, so code wins over configuration. A key that names no option
    /// fails startup instead of being ignored. Delegates and family sources are set in code.
    /// </summary>
    public static IServiceCollection AddSezzlee(
        this IServiceCollection services, IConfiguration configuration, Action<SezzleeOptions>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        services.AddOptions<SezzleeOptions>()
            .Bind(configuration, binder => binder.ErrorOnUnknownConfiguration = true);
        return services.AddSezzlee(configure);
    }

    private static void DecorateAuthorizationResultHandler(IServiceCollection services)
    {
        ServiceDescriptor? existing = services.LastOrDefault(d =>
            !d.IsKeyedService && d.ServiceType == typeof(IAuthorizationMiddlewareResultHandler));
        if (existing is not null)
        {
            services.Remove(existing);
        }
        services.AddSingleton<IAuthorizationMiddlewareResultHandler>(provider =>
        {
            IAuthorizationMiddlewareResultHandler inner = existing switch
            {
                { ImplementationInstance: IAuthorizationMiddlewareResultHandler instance } => instance,
                { ImplementationFactory: { } factory } => (IAuthorizationMiddlewareResultHandler)factory(provider),
                { ImplementationType: { } type } =>
                    (IAuthorizationMiddlewareResultHandler)ActivatorUtilities.CreateInstance(provider, type),
                _ => new AuthorizationMiddlewareResultHandler(),
            };
            return new ProbeAuthorizationResultHandler(inner);
        });
    }
}

internal sealed class SezzleeRegistrationMarker;

public static class SezzleeApplicationBuilderExtensions
{
    public static IApplicationBuilder UseSezzleeCapture(this IApplicationBuilder app)
    {
        PipelineHolder holder = app.ApplicationServices.GetRequiredService<PipelineHolder>();
        holder.Registered = true;
        app.UseMiddleware<ResourceServerMiddleware>();
        return app.Use(next =>
        {
            holder.Pipeline = next;
            return next;
        });
    }

    public static IEndpointConventionBuilder MapSezzlee(
        this IEndpointRouteBuilder endpoints, string pattern = "/mcp")
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pattern);

        PipelineHolder holder = endpoints.ServiceProvider.GetRequiredService<PipelineHolder>();
        if (!holder.Registered)
        {
            throw new InvalidOperationException(
                "MapSezzlee() requires app.UseSezzleeCapture() earlier in the pipeline, before UseRouting(), "
                + "UseAuthentication() and UseAuthorization(). Add app.UseSezzleeCapture() near the top of the pipeline.");
        }

        SezzleeCatalogProvider catalog = endpoints.ServiceProvider.GetRequiredService<SezzleeCatalogProvider>();
        catalog.Attach(endpoints.DataSources, pattern);

        SezzleeEndpointRegistration registration = endpoints.ServiceProvider.GetRequiredService<SezzleeEndpointRegistration>();
        registration.Pattern = new PathString(pattern);
        endpoints.ServiceProvider.GetRequiredService<ToolListChangePublisher>();

        endpoints.ServiceProvider.GetService<IHostApplicationLifetime>()
            ?.ApplicationStarted.Register(catalog.WarmUp);

        return endpoints.MapMcp(pattern);
    }
}
