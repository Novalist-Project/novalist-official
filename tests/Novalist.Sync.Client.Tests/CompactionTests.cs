using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.SignalR;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using NSec.Cryptography;
using Xunit;

namespace Novalist.Sync.Client.Tests;

public sealed class CompactionTests
{
    private static readonly CheckpointReference Manifest = new(Guid.NewGuid(), new string('a', 64));

    [Fact]
    public async Task ThePointerNamesTheNewestCheckpointOfTheHistory()
    {
        await using var fixture = await SessionFixture.CreateAsync();
        Assert.Null(CheckpointPointer.Read(fixture.Session));

        var newer = new CheckpointReference(Guid.NewGuid(), new string('b', 64));
        CheckpointPointer.Save(fixture.Session, new(newer, 9));
        CheckpointPointer.Save(fixture.Session, new(Manifest, 5));

        Assert.Equal(new LatestCheckpoint(newer, 9), CheckpointPointer.Read(fixture.Session));
        Assert.Equal(CheckpointPointer.ItemId(fixture.Project), CheckpointPointer.ItemId(fixture.Project));
        Assert.NotEqual(CheckpointPointer.ItemId(fixture.Project), CheckpointPointer.ItemId(Guid.NewGuid()));
    }

    [Theory]
    [InlineData("empty-manifest")]
    [InlineData("short-hash")]
    [InlineData("non-hex-hash")]
    [InlineData("start")]
    public async Task InvalidPointersAreNeverSaved(string fault)
    {
        await using var fixture = await SessionFixture.CreateAsync();
        var invalid = fault switch
        {
            "empty-manifest" => new LatestCheckpoint(Manifest with { ManifestId = Guid.Empty }, 2),
            "short-hash" => new LatestCheckpoint(Manifest with { Sha256 = "abc" }, 2),
            "non-hex-hash" => new LatestCheckpoint(Manifest with { Sha256 = new string('z', 64) }, 2),
            _ => new LatestCheckpoint(Manifest, 0)
        };

        Assert.Throws<InvalidDataException>(() => CheckpointPointer.Save(fixture.Session, invalid));
        Assert.Null(CheckpointPointer.Read(fixture.Session));
    }

    [Theory]
    [InlineData("""{"Version":2,"ManifestId":"6f1b4c2e-0000-4000-8000-000000000001","Sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","FirstServerSequence":3}""")]
    [InlineData("""{"Version":1,"ManifestId":"6f1b4c2e-0000-4000-8000-000000000001","Sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","FirstServerSequence":0}""")]
    [InlineData("null")]
    public async Task UnreadablePointersAreRejected(string json)
    {
        await using var fixture = await SessionFixture.CreateAsync();
        fixture.Session.Save(CheckpointPointer.ItemId(fixture.Project), Encoding.UTF8.GetBytes(json));

        Assert.Throws<InvalidDataException>(() => CheckpointPointer.Read(fixture.Session));
    }

    [Fact]
    public async Task OversizedPointersAreRejected()
    {
        await using var fixture = await SessionFixture.CreateAsync();
        fixture.Session.Save(CheckpointPointer.ItemId(fixture.Project), new byte[4097]);

        Assert.Throws<InvalidDataException>(() => CheckpointPointer.Read(fixture.Session));
    }

    [Theory]
    [InlineData(512 * 1024, null, null, false)]
    [InlineData(4 * 1024 * 1024, null, null, false)]
    [InlineData(8 * 1024 * 1024, null, null, true)]
    [InlineData(3 * 1024 * 1024, 512L * 1024, 30, true)]
    [InlineData(2 * 1024 * 1024, 512L * 1024, 30, false)]
    [InlineData(2 * 1024 * 1024, 512L * 1024, 2, false)]
    [InlineData(2 * 1024 * 1024, 600L * 1024, 30, false)]
    [InlineData(800 * 1024, 100L * 1024, 30, false)]
    public void CompactionIsDueWhenTheHistoryOutgrowsItsCheckpointAtMostDaily(long bytes, long? checkpoint, int? hoursAgo, bool due)
    {
        var now = DateTimeOffset.UtcNow;
        var history = new HostedProjectHistory(10, 100, bytes, checkpoint, hoursAgo is { } hours ? now.AddHours(-hours) : null);

        Assert.Equal(due, CompactionPolicy.IsDue(history, now));
    }

    [Fact]
    public void RefusalsAreRecognisedOnlyFromTheServer()
    {
        Assert.True(HostedProtocol.IsTransitionInProgress(new HubException("Failed to invoke 'Push'. HubException: " + HostedProtocol.TransitionInProgress)));
        Assert.True(HostedProtocol.IsHistoryReplaced(new HubException(HostedProtocol.HistoryReplaced + " It now starts at update 4.")));
        Assert.False(HostedProtocol.IsTransitionInProgress(new InvalidOperationException(HostedProtocol.TransitionInProgress)));
        Assert.False(HostedProtocol.IsHistoryReplaced(new HubException("Access ended.")));
        Assert.False(HostedProtocol.IsHistoryReplaced(null));
    }

    [Fact]
    public async Task PushesRefusedDuringACompactionAreRetriedRatherThanEndingTheSession()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var fixture = await SessionFixture.CreateAsync();
        var attempts = 0;
        var delivered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Wire.PushAsync(Arg.Any<UpdateEnvelope>(), Arg.Any<CancellationToken>()).Returns(_ =>
        {
            if (Interlocked.Increment(ref attempts) == 1) throw new HubException(HostedProtocol.TransitionInProgress);
            delivered.TrySetResult();
            return Task.FromResult(1L);
        });
        await using var live = new SessionSynchronizer(fixture.Session);
        await live.StartAsync(createProject: false, ct);

        fixture.Session.Save(Guid.NewGuid(), [1]);
        await delivered.Task.WaitAsync(TimeSpan.FromSeconds(10), ct);

        Assert.Equal(2, attempts);
        Assert.NotEqual(SessionConnectionState.Failed, live.Status.State);
        Assert.False(fixture.Session.HasPendingUpdates);
    }

    [Fact]
    public async Task CatchUpBeforeTheBoundaryAsksForTheNewestCheckpoint()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var fixture = await SessionFixture.CreateAsync();
        fixture.Wire.CatchUpAsync(Arg.Any<Guid>(), Arg.Any<long>(), Arg.Any<CancellationToken>())
            .Returns(_ => Refused(new HubException(HostedProtocol.HistoryReplaced)));
        await using var live = new SessionSynchronizer(fixture.Session);

        await Assert.ThrowsAsync<HubException>(() => live.StartAsync(createProject: false, ct));
        Assert.True(HostedProtocol.IsHistoryReplaced(live.Status.Error));
    }

    private static async IAsyncEnumerable<SequencedUpdate> Refused(Exception error)
    {
        await Task.Yield();
        throw error;
#pragma warning disable CS0162 // An iterator needs a yield to be one.
        yield break;
#pragma warning restore CS0162
    }

    private sealed class SessionFixture : IAsyncDisposable
    {
        private readonly string folder;
        private readonly Key signing;
        private readonly EnvelopeCipher cipher;
        private readonly DeviceSequence sequence;
        private readonly SessionJournal journal;
        internal Guid Project { get; }
        internal IUpdateTransport Wire { get; }
        internal CollaborationSession Session { get; }

        private SessionFixture(string folder)
        {
            this.folder = folder;
            Project = Guid.NewGuid();
            var device = Guid.NewGuid();
            signing = Key.Create(SignatureAlgorithm.Ed25519);
            cipher = new EnvelopeCipher(Project, 0, RandomNumberGenerator.GetBytes(32));
            sequence = new DeviceSequence(Path.Combine(folder, "sequence.sqlite"), device);
            journal = new SessionJournal(Path.Combine(folder, "journal.sqlite"), Guid.NewGuid(), Project, sequence);
            Wire = Substitute.For<IUpdateTransport>();
            Wire.ConnectionIdentity.Returns("test:compaction");
            Wire.IsConnected.Returns(true);
            Wire.CatchUpAsync(Arg.Any<Guid>(), Arg.Any<long>(), Arg.Any<CancellationToken>()).Returns(_ => AsyncEnumerable.Empty<SequencedUpdate>());
            Session = new CollaborationSession(new(Project, device, 0), journal, cipher, signing,
                new Dictionary<Guid, PublicKey> { [device] = signing.PublicKey }, Wire);
        }

        internal static Task<SessionFixture> CreateAsync() =>
            Task.FromResult(new SessionFixture(Path.Combine(Path.GetTempPath(), "novalist-compaction", Guid.NewGuid().ToString("N"))));

        public async ValueTask DisposeAsync()
        {
            await Session.DisposeAsync();
            journal.Dispose();
            sequence.Dispose();
            cipher.Dispose();
            signing.Dispose();
            if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true);
        }
    }
}
