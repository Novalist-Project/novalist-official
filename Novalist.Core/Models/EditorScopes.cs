namespace Novalist.Core.Models;

/// <summary>
/// The values <see cref="AppSettings.EditorScope"/> can take.
/// </summary>
/// <remarks>
/// A settings file is a text file a writer or a sync tool can edit, so a value
/// the renderer does not know is read as the single-scene editor rather than
/// handed on as a mode nothing can draw.
/// </remarks>
public static class EditorScopes
{
    /// <summary>One scene at a time; the editor Novalist has always had.</summary>
    public const string Scene = "scene";

    /// <summary>Every scene of the open scene's chapter, one below the other.</summary>
    public const string Chapter = "chapter";

    /// <summary>Every scene of the book, one below the other.</summary>
    public const string Manuscript = "manuscript";

    /// <summary>Returns a known scope, falling back to <see cref="Scene"/>.</summary>
    public static string Normalize(string? value) => value switch
    {
        Chapter => Chapter,
        Manuscript => Manuscript,
        _ => Scene
    };
}
