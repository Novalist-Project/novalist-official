using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Xunit;

namespace Novalist.Backend.Tests;

/// <summary>
/// Attaching a <c>BackendHost</c> replaces process-wide callbacks (the narration
/// "making" and audio-chunk hooks, webview posting, host notifications). A test
/// class that does so outside the <c>BackendStatics</c> collection runs in
/// parallel with the classes that assert on those callbacks and silently
/// unplugs them, which surfaced as a one-in-a-few-hundred CI failure. This makes
/// the omission a deterministic failure instead.
/// </summary>
public sealed partial class BackendStaticsGuardTests
{
    [GeneratedRegex(@"\b(BackendHost|HostedDesktop)\b")]
    private static partial Regex AttachesAHost();

    [GeneratedRegex(@"\[Collection\(\s*(""BackendStatics""|BackendStaticsCollection\.Name)\s*\)\]")]
    private static partial Regex InTheStaticsCollection();

    [Fact]
    public void EveryClassThatAttachesABackendHostIsSerializedWithTheOthers()
    {
        var directory = Path.GetDirectoryName(ThisFile())!;
        var offenders = Directory.EnumerateFiles(directory, "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            .Where(file => !file.Contains(Path.DirectorySeparatorChar + "TestHelpers" + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            .Where(file => Path.GetFileName(file) != nameof(BackendStaticsGuardTests) + ".cs")
            .Select(file => (file, text: File.ReadAllText(file)))
            .Where(entry => AttachesAHost().IsMatch(entry.text) && !InTheStaticsCollection().IsMatch(entry.text))
            .Select(entry => Path.GetFileName(entry.file))
            .ToArray();

        Assert.True(offenders.Length == 0,
            "Add [Collection(\"BackendStatics\")] to: " + string.Join(", ", offenders));
    }

    private static string ThisFile([CallerFilePath] string path = "") => path;
}
