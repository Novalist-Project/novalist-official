using System.Text;
using Novalist.Core.Services;
using Novalist.Core.Tests.TestHelpers;
using Xunit;

namespace Novalist.Core.Tests.Services;

public sealed class StagedFileServiceTests
{
    [Fact]
    public async Task OverlayReadsMovesAndDeletesWithoutChangingSourceAndRetainsReadBaseline()
    {
        using var dir = new TempDir();
        var disk = new FileService();
        var original = Path.Combine(dir.Path, "source", "file.txt");
        await disk.WriteTextAsync(original, "Before");
        var staged = new StagedFileService(disk);
        Assert.Equal("Before", await staged.ReadTextAsync(original));
        await disk.WriteTextAsync(original, "Remote");
        Assert.Equal("Before", await staged.ReadTextAsync(original));
        await staged.WriteBytesAsync(original, Encoding.UTF8.GetBytes("After"));
        Assert.Equal("After", await staged.ReadTextAsync(original));
        Assert.Equal(5, await staged.GetFileSizeAsync(original));
        Assert.Equal(DateTime.UnixEpoch, await staged.GetLastWriteTimeUtcAsync(original));
        Assert.Equal("Before", Assert.Single(staged.Changes).Before);
        var target = staged.CombinePath(dir.Path, "target");
        await staged.MoveDirectoryAsync(Path.GetDirectoryName(original)!, target);
        var moved = Assert.Single(await staged.GetFilesAsync(target, "*.txt", true));
        Assert.Equal("file.txt", staged.GetFileName(moved));
        Assert.Equal("file", staged.GetFileNameWithoutExtension(moved));
        Assert.Equal(target, staged.GetDirectoryName(moved));
        Assert.Contains(target, await staged.GetDirectoriesAsync(dir.Path));
        Assert.True(await staged.DirectoryExistsAsync(target));
        Assert.False(await staged.ExistsAsync(original));
        await Assert.ThrowsAsync<FileNotFoundException>(() => staged.ReadTextAsync(original));
        Assert.Empty(await staged.GetFilesAsync(Path.Combine(dir.Path, "absent")));
        await Assert.ThrowsAsync<IOException>(() => staged.MoveFileAsync(moved, moved));
        await staged.DeleteDirectoryAsync(target);
        Assert.Empty(await staged.GetFilesAsync(target));
        Assert.Equal("Remote", await disk.ReadTextAsync(original));
        Assert.False(await disk.DirectoryExistsAsync(target));
    }
}
