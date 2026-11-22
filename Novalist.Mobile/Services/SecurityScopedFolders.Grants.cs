namespace Novalist.Mobile.Services;

public static partial class SecurityScopedFolders
{
    private static string? CoveringFolder(IEnumerable<string> folders, string path) =>
        folders.Where(folder => path == folder || path.StartsWith(folder.TrimEnd('/') + '/', StringComparison.Ordinal))
            .MaxBy(folder => folder.Length);

    internal static T[] DetachUnusedGrants<T>(Dictionary<string, T> active, string? projectPath) where T : class
    {
        T? retained = null;
        if (projectPath != null && CoveringFolder(active.Keys, projectPath) is { } folder)
            active.Remove(folder, out retained);
        var detached = active.Values.ToArray();
        active.Clear();
        // A joined project can be a new child of the folder chosen in Files.
        if (projectPath != null && retained != null) active.Add(projectPath, retained);
        return detached;
    }
}
