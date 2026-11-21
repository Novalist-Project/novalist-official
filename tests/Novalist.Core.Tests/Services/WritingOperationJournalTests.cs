using Novalist.Core.Services;
using Novalist.Core.Tests.TestHelpers;
using Xunit;
using System.Text.Json;

namespace Novalist.Core.Tests.Services;

public sealed class WritingOperationJournalTests
{
    [Fact]
    public async Task ExternalChangeDuringCommitPreservesNewerFileAndRestoresOtherAffectedFiles()
    {
        using var directory = new TempDir();
        var files = new ConcurrentWriteFiles();
        var one = Path.Combine(directory.Path, "one.html");
        var two = Path.Combine(directory.Path, "two.html");
        await files.WriteTextAsync(one, "before");
        await files.WriteTextAsync(two, "before");
        var journal = new WritingOperationJournal(directory.Path, files);
        var operation = await journal.PrepareAsync("transaction", "hash", [new(one, "before", "after"), new(two, "before", "after")]);
        files.Trigger = one;
        files.Other = two;
        await Assert.ThrowsAsync<IOException>(() => journal.CommitAsync(operation));
        Assert.Equal("external", await files.ReadTextAsync(two));
        Assert.Equal("before", await files.ReadTextAsync(one));
    }

    [Fact]
    public async Task EmptyDuplicateSelfAndMalformedRecoveryManifestsAreRejected()
    {
        using var directory = new TempDir();
        var files = new FileService();
        var journal = new WritingOperationJournal(directory.Path, files);
        var path = Path.Combine(directory.Path, "scene.html");
        await Assert.ThrowsAsync<InvalidDataException>(() => journal.PrepareAsync("empty", "hash", []));
        await Assert.ThrowsAsync<InvalidDataException>(() => journal.PrepareAsync("duplicate", "hash", [new(path, null, "a"), new(path, null, "b")]));
        var id = WritingOperationJournal.OperationId("self");
        var recordPath = Path.Combine(directory.Path, ".novalist", "writing-operations", id + ".json");
        await Assert.ThrowsAsync<InvalidDataException>(() => journal.PrepareAsync("self", "hash", [new(recordPath, null, "a")]));
        await files.WriteTextAsync(recordPath, JsonSerializer.Serialize(new WritingOperation(id, "self", "hash", "invalid", [new("scene.html", null, "a")])));
        await Assert.ThrowsAsync<InvalidDataException>(() => journal.RecoverAsync());
        await files.WriteTextAsync(recordPath, JsonSerializer.Serialize(new WritingOperation(id, "self", "hash", "prepared", [new(path, null, "a")])));
        await Assert.ThrowsAsync<InvalidDataException>(() => journal.RecoverAsync());
        await Assert.ThrowsAsync<InvalidDataException>(() => journal.CommitAsync(new("invalid", "self", "hash", "prepared", [])));
    }

    [Fact]
    public async Task CreatedFilesRollbackAndReprepareButStaleBeforeImagesAreRefused()
    {
        using var directory = new TempDir();
        var files = new FileService();
        var journal = new WritingOperationJournal(directory.Path, files);
        var path = Path.Combine(directory.Path, "scene.html");
        var prepared = await journal.PrepareAsync("transaction", "hash", [new(path, null, "after")]);
        await files.WriteTextAsync(path, "after");
        var retry = await journal.PrepareAsync("transaction", "hash", [new(path, null, "after")]);
        Assert.False(await files.ExistsAsync(path));
        await journal.RollbackAsync(retry);
        await Assert.ThrowsAsync<InvalidOperationException>(() => journal.CommitAsync(prepared));
        await files.WriteTextAsync(path, "external");
        await Assert.ThrowsAsync<WritingConflictException>(() => journal.PrepareAsync("transaction", "hash", [new(path, null, "after")]));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => journal.RecoverAsync(new CancellationToken(true)));
    }

    [Fact]
    public async Task PrepareCommitAndReplayAreDurableAndIdempotent()
    {
        using var directory = new TempDir();
        var files = new FileService();
        var path = Path.Combine(directory.Path, "scene.html");
        await files.WriteTextAsync(path, "before");
        var journal = new WritingOperationJournal(directory.Path, files);
        var operation = await journal.PrepareAsync("transaction", "fingerprint", [new(path, "before", "after")]);
        Assert.Equal("before", await files.ReadTextAsync(path));
        await journal.CommitAsync(operation);
        await new WritingOperationJournal(directory.Path, files).RecoverAsync();
        var found = await journal.FindAsync("transaction", "fingerprint");
        Assert.NotNull(found);
        Assert.Equal("committed", found.State);
        await journal.CommitAsync(found);
        await journal.RollbackAsync(operation);
        Assert.Equal("after", await files.ReadTextAsync(path));
        await Assert.ThrowsAsync<InvalidOperationException>(() => journal.FindAsync("transaction", "different"));
    }

    [Fact]
    public async Task RestartRollsBackOnlyTransactionWritesAndRetainsRetry()
    {
        using var directory = new TempDir();
        var files = new FileService();
        var one = Path.Combine(directory.Path, "one.html");
        var two = Path.Combine(directory.Path, "two.html");
        await files.WriteTextAsync(one, "one-before");
        await files.WriteTextAsync(two, "two-before");
        var journal = new WritingOperationJournal(directory.Path, files);
        var prepared = await journal.PrepareAsync("transaction", "fingerprint",
            [new(one, "one-before", "one-after"), new(two, "two-before", "two-after")]);
        await files.WriteTextAsync(one, "one-after");
        await new WritingOperationJournal(directory.Path, files).RecoverAsync();
        Assert.Equal("one-before", await files.ReadTextAsync(one));
        Assert.Equal("two-before", await files.ReadTextAsync(two));
        var retry = await journal.PrepareAsync("transaction", "fingerprint",
            [new(one, "one-before", "one-after"), new(two, "two-before", "two-after")]);
        Assert.Equal(prepared.OperationId, retry.OperationId);
        await journal.CommitAsync(retry);
        Assert.Equal("two-after", await files.ReadTextAsync(two));
    }

    [Fact]
    public async Task RollbackNeverOverwritesUnrelatedExternalChanges()
    {
        using var directory = new TempDir();
        var files = new FileService();
        var path = Path.Combine(directory.Path, "scene.html");
        await files.WriteTextAsync(path, "before");
        var journal = new WritingOperationJournal(directory.Path, files);
        var operation = await journal.PrepareAsync("transaction", "fingerprint", [new(path, "before", "after")]);
        await files.WriteTextAsync(path, "external");
        await Assert.ThrowsAsync<IOException>(() => journal.RollbackAsync(operation));
        Assert.Equal("external", await files.ReadTextAsync(path));
    }

    [Fact]
    public async Task PrepareRejectsPathsOutsideProjectBeforeWritingJournal()
    {
        using var directory = new TempDir();
        var journal = new WritingOperationJournal(directory.Path, new FileService());
        await Assert.ThrowsAsync<InvalidDataException>(() => journal.PrepareAsync("transaction", "fingerprint",
            [new(Path.Combine(directory.Path, "..", "outside"), null, "after")]));
    }

    private sealed class ConcurrentWriteFiles : FileService, IFileService
    {
        internal string? Trigger { get; set; }
        internal string Other { get; set; } = string.Empty;
        async Task IFileService.WriteTextAsync(string path, string content)
        {
            await WriteTextAsync(path, content);
            if (path != Trigger) return;
            Trigger = null;
            await WriteTextAsync(Other, "external");
        }
    }
}
