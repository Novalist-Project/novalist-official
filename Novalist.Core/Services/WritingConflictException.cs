namespace Novalist.Core.Services;

public sealed class WritingConflictException(string message) : IOException(message);
