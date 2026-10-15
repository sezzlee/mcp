using Microsoft.Extensions.Primitives;

namespace Sezzlee.AspNetCore;

public interface ISezzleeCatalogChangeSource
{
    long Generation { get; }

    IChangeToken GetChangeToken();

    /// <summary>
    /// Loads family members again and rebuilds the catalog, then signals the change to connected clients.
    /// </summary>
    /// <exception cref="SezzleeCatalogException">
    /// A family source is registered and the rebuild would turn a valid catalog fatal; the current catalog is kept.
    /// </exception>
    ValueTask ReloadAsync(CancellationToken cancellationToken = default);
}
