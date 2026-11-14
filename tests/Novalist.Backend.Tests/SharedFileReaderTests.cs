using Novalist.Backend.Tests.TestHelpers;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed class SharedFileReaderTests
{
    [Fact]
    public async Task AFileHeldOpenForWritingBreaksPlainReadsButNotTheSharedRead()
    {
        using var temp = new TempDir();
        var path = temp.Combine("scene.novalist");
        await using var writer = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read);
        await writer.WriteAsync("held text"u8.ToArray(), TestContext.Current.CancellationToken);
        await writer.FlushAsync(TestContext.Current.CancellationToken);

        await Assert.ThrowsAsync<IOException>(() => File.ReadAllTextAsync(path, TestContext.Current.CancellationToken));
        Assert.Equal("held text", SharedFileReader.TryReadText(path));
    }

    [Fact]
    public async Task AFileLockedExclusivelyOrMissingReadsAsNotThereYet()
    {
        using var temp = new TempDir();
        var path = temp.Combine("locked.txt");
        await File.WriteAllTextAsync(path, "x", TestContext.Current.CancellationToken);

        using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            Assert.Null(SharedFileReader.TryReadText(path));
        Assert.Null(SharedFileReader.TryReadText(temp.Combine("missing.txt")));
        Assert.False(SharedFileReader.Contains(path, "y"));
        Assert.True(SharedFileReader.Contains(path, "x"));
    }

    [Fact]
    public async Task ReadingSharedNeverStopsTheProductReplacingTheFile()
    {
        using var temp = new TempDir();
        var path = temp.Combine("scene.novalist");
        var replacement = temp.Combine("scene.tmp");
        await File.WriteAllTextAsync(path, "old", TestContext.Current.CancellationToken);
        await File.WriteAllTextAsync(replacement, "new", TestContext.Current.CancellationToken);

        using (new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            File.Replace(replacement, path, null);

        Assert.Equal("new", SharedFileReader.TryReadText(path));
    }

    [Fact]
    public async Task FilesContainingScansDirectoriesThatAreMissingOrPartlyLocked()
    {
        using var temp = new TempDir();
        Assert.Empty(SharedFileReader.FilesContaining(temp.Combine("none"), "a"));
        var found = temp.Combine("sub", "found.json");
        Directory.CreateDirectory(Path.GetDirectoryName(found)!);
        await File.WriteAllTextAsync(found, "needle", TestContext.Current.CancellationToken);
        var locked = temp.Combine("locked.json");
        await File.WriteAllTextAsync(locked, "needle", TestContext.Current.CancellationToken);

        using (new FileStream(locked, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            Assert.Equal([found], SharedFileReader.FilesContaining(temp.Path, "needle"));
    }

    [Fact]
    public async Task WaitingReturnsWhatWasLastReadWhenTheTextNeverArrives()
    {
        using var temp = new TempDir();
        var path = temp.Combine("scene.novalist");
        var ct = TestContext.Current.CancellationToken;

        Assert.Equal("<file missing or locked>", await SharedFileReader.WaitForTextAsync(path, "x", 2, TimeSpan.FromMilliseconds(1), ct));
        await File.WriteAllTextAsync(path, "other", ct);
        Assert.Equal("other", await SharedFileReader.WaitForTextAsync(path, "x", 2, TimeSpan.FromMilliseconds(1), ct));
        var arriving = SharedFileReader.WaitForTextAsync(path, "arrived", 100, TimeSpan.FromMilliseconds(5), ct);
        await File.WriteAllTextAsync(path, "arrived", ct);
        Assert.Equal("arrived", await arriving);
    }
}
