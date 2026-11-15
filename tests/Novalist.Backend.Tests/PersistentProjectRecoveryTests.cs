using System.Text.Json.Nodes;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Core.Services;
using Novalist.Sync.Client;
using Novalist.Sync.Client.Tests;
using StreamJsonRpc;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed class PersistentProjectRecoveryTests
{
    [Fact]
    public async Task RestoringACheckpointPreservesPersonalSettingsAndRollsBackLocalFiles()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        var files = new FileService();
        var project = new ProjectService(files);
        await project.CreateProjectAsync(temp.Path, "Novel", "Book");
        var root = project.ProjectRoot!;
        Directory.CreateDirectory(Path.Combine(root, "Research"));
        var lower = Path.Combine(root, "Research", "note.txt");
        var upper = Path.Combine(root, "Research", "Note.txt");
        await File.WriteAllTextAsync(lower, "Checkpoint note.", ct);
        await using var archive = new MemoryStream();
        await ProjectCheckpoint.CreateAsync(root, archive, () => ProjectContentSelection.Read(root), ct);
        File.Move(lower, upper);
        var extraDirectory = Path.Combine(root, "Research", "Retained", "Drafts");
        Directory.CreateDirectory(extraDirectory);
        var extra = Path.Combine(extraDirectory, "extra.txt");
        await File.WriteAllTextAsync(extra, "Retained local file.", ct);
        var settingsPath = SharedProjectPath.Resolve(root, ".novalist/settings.json");
        var settings = await File.ReadAllBytesAsync(settingsPath, ct);
        archive.Position = 0;
        using var restore = await RetainedProjectRestore.PrepareAsync(root, archive, temp.Path, ct);
        await restore.ApplyAsync(files, ct);
        Assert.False(File.Exists(extra));
        Assert.False(Directory.Exists(Path.Combine(root, "Research", "Retained")));
        Assert.Single(Directory.GetFiles(Path.Combine(root, "Research")));
        Assert.Equal("Checkpoint note.", await File.ReadAllTextAsync(lower, ct));
        Assert.True(File.Exists(restore.RecoveryPath));
        await restore.RollbackAsync(files);
        Assert.Equal("Retained local file.", await File.ReadAllTextAsync(extra, ct));
        Assert.Equal(settings, await File.ReadAllBytesAsync(settingsPath, ct));
        await File.WriteAllTextAsync(SharedProjectPath.Resolve(root, ".novalist/project.json"), "invalid", ct);
        archive.Position = 0;
        await Assert.ThrowsAnyAsync<System.Text.Json.JsonException>(() => RetainedProjectRestore.PrepareAsync(root, archive, temp.Path, ct));
    }

    [Fact]
    public async Task ReconnectRejectsCopiedIdentityAndKeepsThePreviousConnectionRecord()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        var settings = Path.Combine(temp.Path, "settings");
        var files = new RegistryFiles();
        await using var desktop = new HostedDesktop(settings, identity, fileService: files);
        var project = new ProjectService(new FileService());
        await project.CreateProjectAsync(temp.Path, "Novel", "Book");
        var chapter = await project.CreateChapterAsync("Opening");
        var scene = await project.CreateSceneAsync(chapter.Guid, "Arrival");
        await desktop.Rpc.InvokeAsync("project/open", project.ProjectRoot);
        await desktop.SignInAsync(server.Address);
        await desktop.Rpc.InvokeAsync("collaboration/persistent/create", server.Address);
        await desktop.Rpc.InvokeAsync("collaboration/end");
        var path = Directory.GetFiles(Path.Combine(settings, "Collaboration", "persistent", "projects"), "*.json").Single();
        var saved = await File.ReadAllTextAsync(path, ct);
        var record = JsonNode.Parse(saved)!;
        record["LocalProjectId"] = "another-project";
        await File.WriteAllTextAsync(path, record.ToJsonString(), ct);
        await Assert.ThrowsAsync<RemoteInvocationException>(() => desktop.Rpc.InvokeAsync("collaboration/persistent/resume"));
        await File.WriteAllTextAsync(path, saved, ct);
        record = JsonNode.Parse(saved)!;
        record["DeviceId"] = Guid.NewGuid();
        await File.WriteAllTextAsync(path, record.ToJsonString(), ct);
        await Assert.ThrowsAsync<RemoteInvocationException>(() => desktop.Rpc.InvokeAsync("collaboration/persistent/resume"));
        await File.WriteAllTextAsync(path, saved, ct);
        var scenePath = project.GetSceneFilePath(chapter, scene);
        var local = Novalist.Core.Models.FileFrontMatter.Stamp("<p>Unsynced local writing.</p>", scene.Id);
        await File.WriteAllTextAsync(scenePath, local, ct);
        desktop.Documents.RejectNextLoad = true;
        await Assert.ThrowsAsync<RemoteInvocationException>(() => desktop.Rpc.InvokeAsync("collaboration/persistent/resume"));
        Assert.Equal(local, await File.ReadAllTextAsync(scenePath, ct));
        files.RejectRegistry = true;
        await Assert.ThrowsAsync<RemoteInvocationException>(() => desktop.Rpc.InvokeAsync("collaboration/persistent/resume"));
        Assert.Equal(local, await File.ReadAllTextAsync(scenePath, ct));
        await desktop.Rpc.InvokeAsync("collaboration/persistent/resume");
        await desktop.Rpc.InvokeAsync("collaboration/end");
        await desktop.Rpc.InvokeAsync("collaboration/account/signOut", server.Address);
        await Assert.ThrowsAsync<RemoteInvocationException>(() => desktop.Rpc.InvokeAsync("collaboration/persistent/resume"));
    }

    [Theory]
    [InlineData("activate")]
    [InlineData("join")]
    [InlineData("attach")]
    public async Task FailedJoiningDoesNotCreateADestinationOrPublishAnActiveSession(string failure)
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var owner = new HostedDesktop(Path.Combine(temp.Path, "owner"), identity);
        var project = new ProjectService(new FileService());
        await project.CreateProjectAsync(temp.Path, "Novel", "Book");
        var chapter = await project.CreateChapterAsync("Opening");
        await project.CreateSceneAsync(chapter.Guid, "Arrival");
        await owner.Rpc.InvokeAsync("project/open", project.ProjectRoot);
        await owner.SignInAsync(server.Address);
        await owner.Rpc.InvokeAsync("collaboration/persistent/create", server.Address);
        var link = await owner.Rpc.InvokeAsync<string>("collaboration/invite", DateTimeOffset.UtcNow.AddHours(1));
        await owner.Rpc.InvokeAsync("collaboration/end");
        identity.Subject = "guest";
        identity.IssueAccessToken = () => "guest-token";
        await using var guest = new HostedDesktop(Path.Combine(temp.Path, "guest"), identity);
        await guest.SignInAsync(server.Address);
        var destination = Path.Combine(temp.Path, "Joined");
        await using (var other = await PersistentSessionServer.StartAsync(identity.Authority, ct))
        {
            await guest.SignInAsync(other.Address);
            await Assert.ThrowsAsync<RemoteInvocationException>(() => guest.Rpc.InvokeAsync("collaboration/persistent/join", other.Address, link, destination));
        }
        if (failure == "attach") guest.Documents.RejectNextLoad = true;
        else server.Reject = failure;
        await Assert.ThrowsAsync<RemoteInvocationException>(() => guest.Rpc.InvokeAsync("collaboration/persistent/join", server.Address, link, destination));
        Assert.False(Directory.Exists(destination));
        Assert.Null(await guest.Rpc.InvokeAsync<object?>("collaboration/status"));
        server.Reject = null;
        await guest.Rpc.InvokeAsync("collaboration/persistent/join", server.Address, link, destination);
        await guest.Rpc.InvokeAsync("collaboration/end");
    }

    private sealed class RegistryFiles : FileService, IFileService
    {
        internal bool RejectRegistry { get; set; }
        public new Task WriteTextAsync(string path, string content)
        {
            if (RejectRegistry && path.Contains(Path.Combine("persistent", "projects"), StringComparison.Ordinal))
            {
                RejectRegistry = false;
                throw new IOException("Connection record write failed.");
            }
            return base.WriteTextAsync(path, content);
        }
    }
}
