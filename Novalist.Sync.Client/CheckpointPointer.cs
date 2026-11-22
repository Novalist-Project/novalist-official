using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Novalist.Sync.Client;

public sealed record LatestCheckpoint(CheckpointReference Reference, long FirstServerSequence);

// Names the newest whole-project checkpoint inside the encrypted log. Rotations and compactions save it right
// after their checkpoint, so a device that catches up from a history boundary finds the checkpoint that starts it.
public static class CheckpointPointer
{
    private const int MaxLength = 4096;
    private sealed record Pointer(int Version, Guid ManifestId, string Sha256, long FirstServerSequence);

    public static Guid ItemId(Guid project)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes("novalist/checkpoint-pointer/v1/" + project.ToString("D")));
        return new Guid(hash.AsSpan(0, 16));
    }

    public static void Save(CollaborationSession session, LatestCheckpoint checkpoint)
    {
        Validate(checkpoint);
        session.Save(ItemId(session.Context.ProjectId), JsonSerializer.SerializeToUtf8Bytes(
            new Pointer(1, checkpoint.Reference.ManifestId, checkpoint.Reference.Sha256, checkpoint.FirstServerSequence)));
    }

    // The newest valid pointer the session holds, or null when this history has none yet.
    public static LatestCheckpoint? Read(CollaborationSession session)
    {
        LatestCheckpoint? newest = null;
        foreach (var value in session.ReadItem(ItemId(session.Context.ProjectId)))
        {
            if (value.Length > MaxLength) throw new InvalidDataException("The checkpoint pointer is too large.");
            var pointer = JsonSerializer.Deserialize<Pointer>(value) ?? throw new InvalidDataException("Invalid checkpoint pointer.");
            if (pointer.Version != 1) throw new InvalidDataException("Unsupported checkpoint pointer.");
            var candidate = new LatestCheckpoint(new(pointer.ManifestId, pointer.Sha256), pointer.FirstServerSequence);
            Validate(candidate);
            if (newest is null || candidate.FirstServerSequence > newest.FirstServerSequence) newest = candidate;
        }
        return newest;
    }

    private static void Validate(LatestCheckpoint checkpoint)
    {
        var sha = checkpoint.Reference.Sha256;
        if (checkpoint.Reference.ManifestId == Guid.Empty || checkpoint.FirstServerSequence < 1 ||
            sha is not { Length: 64 } || !sha.All(Uri.IsHexDigit))
            throw new InvalidDataException("Invalid checkpoint pointer.");
    }
}
