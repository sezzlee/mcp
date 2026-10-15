using Sezzlee.AspNetCore.Visibility;

namespace Sezzlee.AspNetCore.Caching;

public interface ISezzleeCacheInvalidator
{
    ValueTask InvalidateCallerAsync(CallerScope scope, CancellationToken cancellationToken = default);

    ValueTask InvalidateTagAsync(string tag, CancellationToken cancellationToken = default);

    ValueTask InvalidateAllAsync(CancellationToken cancellationToken = default);
}

internal sealed class SezzleeCacheInvalidator(ISezzleeCache cache, CallerVisibilityProvider visibility) : ISezzleeCacheInvalidator
{
    public ValueTask InvalidateCallerAsync(CallerScope scope, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(scope);
        visibility.Bump();
        visibility.ForgetCaller(scope);
        return cache.RemoveScopeAsync(scope.Key, cancellationToken);
    }

    public ValueTask InvalidateTagAsync(string tag, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(tag);
        visibility.Bump();
        visibility.ForgetAllCallers();
        return cache.RemoveTagAsync(tag, cancellationToken);
    }

    public ValueTask InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        visibility.Bump();
        visibility.ForgetAllCallers();
        return cache.ClearAsync(cancellationToken);
    }
}
