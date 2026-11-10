using System.Text.Json;
using Nerdbank.Streams;
using Novalist.Backend.Extensions;
using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Core.Models;
using Novalist.Core.Services;
using StreamJsonRpc;
using StreamJsonRpc.Protocol;
using Xunit;

namespace Novalist.Backend.Tests;

[Collection("BackendStatics")]
public sealed class ExternalAnnotationCoordinationTests
{
    [Theory]
    [InlineData("import", true)]
    [InlineData("add", true)]
    [InlineData("resolve", true)]
    [InlineData("delete", true)]
    [InlineData("import", false)]
    [InlineData("add", false)]
    [InlineData("resolve", false)]
    [InlineData("delete", false)]
    public async Task ExternalCommentWritesWaitForLocalFlushAndRespectItsVeto(string operation, bool saved)
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        await workspace.Projects.CreateProjectAsync(directory.Path, "Novel", "Book");
        var chapter = await workspace.Projects.CreateChapterAsync("Chapter");
        var scene = await workspace.Projects.CreateSceneAsync(chapter.Guid, "Scene");
        scene.Comments = [new() { Id = "original", Text = "Original" }];
        await workspace.Projects.SaveScenesAsync();
        using var gate = new SemaphoreSlim(1, 1);
        var coordinator = new WorkspaceCoordinator(workspace, gate);
        using var host = new HostServices(workspace.FileService, workspace.Projects,
            new EntityService(workspace.Projects), workspace.Settings);
        host.CoordinateWorkspace = coordinator.RunAsync;
        coordinator.Validate(new("1", 0, null), "project/getState");
        var phases = new List<string>();
        coordinator.Notify = async (method, payload) =>
        {
            phases.Add(method);
            var token = JsonSerializer.SerializeToElement(payload).GetProperty("token").GetString()
                ?? throw new InvalidOperationException("Missing transition token.");
            if (method == "workspace/prepare")
            {
                Assert.Single(scene.Comments);
                if (saved)
                {
                    scene.Comments = [.. scene.Comments, new() { Id = "pending", Text = "Pending local comment" }];
                    await workspace.Projects.WriteSceneContentAsync(chapter, scene, "<p>Pending local prose</p>");
                    await workspace.Projects.SaveScenesAsync();
                }
                coordinator.Prepared(token, saved, saved ? null : "Local save failed");
            }
            else if (method == "workspace/changed") coordinator.Applied(token);
        };
        var streams = FullDuplexStream.CreatePair();
        using var server = new SerialDispatchJsonRpc(Handler(streams.Item1), gate, coordinator: coordinator);
        using var client = new OwnedClient(Handler(streams.Item2));
        server.AddLocalRpcTarget(new ReviewRpc(workspace));
        server.StartListening();
        client.StartListening();
        async Task MutateAsync()
        {
            var review = host.ReviewService;
            switch (operation)
            {
                case "import":
                    Assert.Equal(1, await client.InvokeAsync<int>("review/applyComments", chapter.Guid, scene.Id,
                        new[] { new ReviewCommentDto("import", "", "", "External", "") }));
                    break;
                case "add":
                    Assert.NotEmpty(await review.AddCommentAsync(chapter.Guid, scene.Id, "", "External", ""));
                    break;
                case "resolve":
                    Assert.True(await review.SetCommentResolvedAsync(chapter.Guid, scene.Id, "pending", true));
                    break;
                case "delete":
                    Assert.True(await review.DeleteCommentAsync(chapter.Guid, scene.Id, "pending"));
                    break;
            }
        }
        if (!saved)
        {
            var error = await Assert.ThrowsAnyAsync<Exception>(MutateAsync);
            Assert.Contains("Local save failed", error.Message);
            Assert.Equal(["workspace/prepare", "workspace/aborted"], phases);
            Assert.Equal("Original", Assert.Single(scene.Comments).Text);
            Assert.Equal(0, coordinator.Epoch);
            return;
        }
        await MutateAsync();
        Assert.Equal(["workspace/prepare", "workspace/changed"], phases);
        Assert.Equal(1, coordinator.Epoch);
        Assert.Contains("Pending local prose", await workspace.Projects.ReadSceneContentAsync(chapter, scene));
        Assert.Contains(scene.Comments, comment => comment.Id == "original");
        if (operation is "import" or "add")
        {
            Assert.Contains(scene.Comments, comment => comment.Id == "pending");
            Assert.Contains(scene.Comments, comment => comment.Text == "External");
        }
        else if (operation == "resolve") Assert.True(scene.Comments.Single(comment => comment.Id == "pending").Resolved);
        else Assert.DoesNotContain(scene.Comments, comment => comment.Id == "pending");
    }

    private static HeaderDelimitedMessageHandler Handler(Stream stream)
    {
        var formatter = new SystemTextJsonFormatter();
        formatter.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        return new(stream, stream, formatter);
    }

    private sealed class OwnedClient(IJsonRpcMessageHandler handler) : JsonRpc(handler)
    {
        private long _sequence;
        protected override RequestId CreateNewRequestId() => new($"nl/1/0/{Interlocked.Increment(ref _sequence)}/-");
    }
}
