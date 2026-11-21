using System.IO.Compression;
using System.Text;
using System.Xml.Linq;

namespace Novalist.Core.Services;

/// <summary>One comment an editor left in a Word document.</summary>
public sealed class DocxComment
{
    public string Id { get; init; } = string.Empty;
    public string Author { get; init; } = string.Empty;
    public string Date { get; init; } = string.Empty;

    /// <summary>What the editor wrote.</summary>
    public string Text { get; init; } = string.Empty;

    /// <summary>
    /// The manuscript text the comment was anchored to, when the range markers
    /// let it be recovered. Empty for a comment anchored to nothing findable,
    /// which is how Word stores a comment on an empty selection.
    /// </summary>
    public string AnchorText { get; init; } = string.Empty;
}

/// <summary>One tracked insertion or deletion.</summary>
public sealed class DocxRevision
{
    /// <summary>"insert" or "delete".</summary>
    public string Kind { get; init; } = string.Empty;

    public string Author { get; init; } = string.Empty;
    public string Date { get; init; } = string.Empty;

    public string Text { get; init; } = string.Empty;
}

/// <summary>Everything reviewable found in one edited Word document.</summary>
public sealed class DocxReview
{
    public IReadOnlyList<DocxComment> Comments { get; init; } = [];
    public IReadOnlyList<DocxRevision> Revisions { get; init; } = [];

    /// <summary>True when the file parsed but carried no comments or revisions,
    /// which is a different outcome from a file that could not be read.</summary>
    public bool IsEmpty => Comments.Count == 0 && Revisions.Count == 0;
}

/// <summary>
/// Reads the review layer out of a .docx an editor sent back: Word comments and
/// tracked insertions and deletions.
///
/// This is deliberately read-only and tolerant. A file that is not a Word
/// document, or is missing the parts, yields an empty review rather than
/// throwing - the caller's job is to tell the writer "nothing to import", not to
/// surface a parser error about a file their editor produced.
/// </summary>
public static class DocxReviewReader
{
    private static readonly XNamespace W =
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

    /// <summary>Reads a .docx from disk. A missing or unreadable file yields an
    /// empty review.</summary>
    public static DocxReview Read(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            return new DocxReview();

        try
        {
            using var stream = File.OpenRead(path);
            return Read(stream);
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException)
        {
            return new DocxReview();
        }
    }

    /// <summary>Reads a .docx from a stream. Split out so tests can build a
    /// document in memory.</summary>
    public static DocxReview Read(Stream stream)
    {
        try
        {
            using var zip = new ZipArchive(stream, ZipArchiveMode.Read, leaveOpen: true);
            var document = LoadPart(zip, "word/document.xml");
            if (document == null)
                return new DocxReview();

            var comments = ReadComments(zip, document);
            var revisions = ReadRevisions(document);
            return new DocxReview { Comments = comments, Revisions = revisions };
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException)
        {
            return new DocxReview();
        }
    }

    private static XDocument? LoadPart(ZipArchive zip, string path)
    {
        var entry = zip.GetEntry(path);
        if (entry == null)
            return null;

        try
        {
            using var entryStream = entry.Open();
            return XDocument.Load(entryStream);
        }
        catch (System.Xml.XmlException)
        {
            return null;
        }
    }

    private static List<DocxComment> ReadComments(ZipArchive zip, XDocument document)
    {
        var result = new List<DocxComment>();
        var commentsPart = LoadPart(zip, "word/comments.xml");
        if (commentsPart?.Root == null)
            return result;

        var anchors = ReadCommentAnchors(document);

        foreach (var comment in commentsPart.Root.Elements(W + "comment"))
        {
            var id = (string?)comment.Attribute(W + "id") ?? string.Empty;
            result.Add(new DocxComment
            {
                Id = id,
                Author = (string?)comment.Attribute(W + "author") ?? string.Empty,
                Date = (string?)comment.Attribute(W + "date") ?? string.Empty,
                Text = GatherText(comment),
                AnchorText = anchors.TryGetValue(id, out var anchor) ? anchor : string.Empty
            });
        }

        return result;
    }

    /// <summary>
    /// Recovers the manuscript text each comment was attached to by walking the
    /// body between the range start and end markers. Word emits those as
    /// siblings rather than as a wrapping element, so this is a scan rather
    /// than a subtree read.
    /// </summary>
    private static Dictionary<string, string> ReadCommentAnchors(XDocument document)
    {
        var anchors = new Dictionary<string, string>(StringComparer.Ordinal);
        var open = new Dictionary<string, StringBuilder>(StringComparer.Ordinal);

        foreach (var node in document.Elements().SelectMany(root => root.Descendants()))
        {
            if (node.Name == W + "commentRangeStart")
            {
                var id = (string?)node.Attribute(W + "id");
                if (id != null)
                    open[id] = new StringBuilder();
            }
            else if (node.Name == W + "commentRangeEnd")
            {
                var id = (string?)node.Attribute(W + "id");
                if (id != null && open.Remove(id, out var text))
                    anchors[id] = text.ToString().Trim();
            }
            else if (open.Count > 0 && node.Name != W + "delText" && RunText(node) is { } text)
            {
                foreach (var buffer in open.Values)
                    buffer.Append(text);
            }
        }

        return anchors;
    }

    private static List<DocxRevision> ReadRevisions(XDocument document)
    {
        var result = new List<DocxRevision>();
        foreach (var element in document.Elements().SelectMany(root => root.Descendants()))
        {
            var kind =
                element.Name == W + "ins" ? "insert"
                : element.Name == W + "del" ? "delete"
                : null;
            if (kind == null)
                continue;

            // Deleted runs carry their text in w:delText, not w:t; a line
            // break inside either is a w:br or w:cr between them.
            var text = string.Concat(element.Descendants()
                .Where(d => kind == "delete" ? d.Name != W + "t" : d.Name != W + "delText")
                .Select(RunText));

            if (string.IsNullOrWhiteSpace(text))
                continue;

            result.Add(new DocxRevision
            {
                Kind = kind,
                Author = (string?)element.Attribute(W + "author") ?? string.Empty,
                Date = (string?)element.Attribute(W + "date") ?? string.Empty,
                Text = text
            });
        }

        return result;
    }

    /// <summary>
    /// What one element of a run contributes to the text: its characters for
    /// text, a newline for a line break (Shift+Enter in Word, and what
    /// Novalist writes for one), and nothing for anything else.
    /// </summary>
    private static string? RunText(XElement node) =>
        node.Name == W + "t" || node.Name == W + "delText" ? node.Value
        : node.Name == W + "br" || node.Name == W + "cr" ? "\n"
        : null;

    /// <summary>Flattens a comment body's runs into plain text, one line per
    /// paragraph.</summary>
    private static string GatherText(XElement comment)
    {
        var lines = comment
            .Elements(W + "p")
            .Select(p => string.Concat(p.Descendants(W + "t").Select(t => t.Value)))
            .Where(line => line.Length > 0);

        var joined = string.Join("\n", lines);
        return joined.Length > 0
            ? joined.Trim()
            : string.Concat(comment.Descendants(W + "t").Select(t => t.Value)).Trim();
    }
}
