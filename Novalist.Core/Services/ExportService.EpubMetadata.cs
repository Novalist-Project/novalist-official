using System.IO.Compression;
using System.Text;
using Novalist.Core.Models;
using static Novalist.Core.Services.ExportArchive;

namespace Novalist.Core.Services;

public partial class ExportService
{
    /// <summary>
    /// What a reading system and a retailer need to know about how accessible
    /// this book is. Declared from what the file actually contains rather than
    /// asserted, because claiming alt text that is not there is worse than
    /// claiming nothing.
    /// </summary>
    /// <remarks>
    /// Every picture placed in the file is counted - each prose image a
    /// chapter writes, and the cover - and one is described when its text is
    /// not blank. A book with any picture is visual; it claims alternative
    /// text only when every picture has a description, and its summary says
    /// whether all, some or none of the prose images are described.
    /// </remarks>
    private static string AccessibilityMetadataXml(
        List<ChapterExportContent> chapters, IReadOnlyDictionary<string, string>? images, ExportOptions options)
    {
        var (described, undescribed) = ProseImageDescriptions(chapters, images);
        var hasImages = described + undescribed > 0;
        var hasCover = CoverMediaType(options.CoverImagePath) != null;
        var coverDescribed = hasCover && !string.IsNullOrWhiteSpace(options.CoverAltText);
        var features = new List<string> { "structuralNavigation", "tableOfContents" };
        if ((hasImages || hasCover) && undescribed == 0 && (!hasCover || coverDescribed))
            features.Add("alternativeText");

        var lines = new List<string>
        {
            "    <meta property=\"schema:accessMode\">textual</meta>"
        };
        if (hasImages || hasCover) lines.Add("    <meta property=\"schema:accessMode\">visual</meta>");
        lines.Add("    <meta property=\"schema:accessModeSufficient\">textual</meta>");
        foreach (var feature in features)
            lines.Add($"    <meta property=\"schema:accessibilityFeature\">{feature}</meta>");
        lines.Add("    <meta property=\"schema:accessibilityHazard\">none</meta>");

        var language = EpubLanguage(options);
        var (summary, written) = EpubAccessibilitySummary.For(
            language, described, undescribed, hasCover, coverDescribed);
        // Marked only when it differs from the package's own language, which
        // is the English fallback for a book in a language without a translation.
        var lang = string.Equals(written, NormalizeLanguageTag(language), StringComparison.Ordinal)
            ? string.Empty
            : $" xml:lang=\"{written}\"";
        lines.Add($"    <meta property=\"schema:accessibilitySummary\"{lang}>{EscapeXml(summary)}</meta>");
        return string.Join("\n", lines);
    }

    /// <summary>
    /// The prose images the chapters will write, split by whether they carry a
    /// description. Counted per placement, and only for images whose file made
    /// it into the package - the chapter writer drops the rest.
    /// </summary>
    private static (int Described, int Undescribed) ProseImageDescriptions(
        List<ChapterExportContent> chapters, IReadOnlyDictionary<string, string>? images)
    {
        var placed = chapters
            .SelectMany(c => c.Scenes)
            .SelectMany(s => ParseHtmlToBlocks(s.HtmlContent))
            .Where(b => b.ImagePath != null && images != null && images.ContainsKey(b.ImagePath))
            .ToList();
        var described = placed.Count(b => !string.IsNullOrWhiteSpace(b.ImageAlt));
        return (described, placed.Count - described);
    }

    private static string GenerateContentOpf(
        List<ChapterExportContent> chapters,
        ExportOptions options,
        string bookId,
        string modifiedDate,
        IReadOnlyDictionary<string, string>? images = null)
    {
        var (manifestItems, spineItems) = ContentManifest(chapters, options, images);

        var authorXml = !string.IsNullOrWhiteSpace(options.Author)
            ? $"<dc:creator>{EscapeXml(options.Author)}</dc:creator>"
            : "";

        var coverMetaXml = "";
        if (CoverMediaType(options.CoverImagePath) is { } coverMedia)
        {
            var ext = Path.GetExtension(options.CoverImagePath);
            manifestItems.AppendLine(
                $"    <item id=\"cover-image\" href=\"cover{ext}\" media-type=\"{coverMedia}\" properties=\"cover-image\"/>");
            manifestItems.AppendLine(
                "    <item id=\"cover\" href=\"cover.xhtml\" media-type=\"application/xhtml+xml\"/>");
            // The cover page goes first in the spine, ahead of the title page.
            spineItems.Insert(0, "    <itemref idref=\"cover\" linear=\"no\"/>" + Environment.NewLine);
            // EPUB 2 style pointer: EPUB 3 uses properties="cover-image", but
            // Kindle and several retailers still key off this meta tag.
            coverMetaXml = "<meta name=\"cover\" content=\"cover-image\"/>";
        }

        var language = EpubLanguage(options);

        // An ISBN is the identifier a retailer keys on, so when there is one it
        // becomes the package's unique identifier rather than sitting beside a
        // generated UUID that means nothing outside this file.
        var publishing = options.Publishing;
        var isbn = publishing.NormalizedIsbn();
        var identifierXml = isbn.Length > 0
            ? $"<dc:identifier id=\"BookId\">urn:isbn:{EscapeXml(isbn)}</dc:identifier>"
            : $"<dc:identifier id=\"BookId\">{EscapeXml(bookId)}</dc:identifier>";

        return $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" xml:lang="{EscapeXml(language)}">
              <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:schema="http://schema.org/">
                {identifierXml}
                <dc:title>{EscapeXml(options.Title)}</dc:title>
                {authorXml}
                <dc:language>{EscapeXml(language)}</dc:language>
            {PublishingMetadataXml(publishing)}
                {coverMetaXml}
                <meta property="dcterms:modified">{modifiedDate}</meta>
            {AccessibilityMetadataXml(chapters, images, options)}
              </metadata>
              <manifest>
            {manifestItems}
              </manifest>
              <spine toc="ncx">
            {spineItems}
              </spine>
            </package>
            """;
    }

    /// <summary>
    /// The optional Dublin Core elements, plus the EPUB 3 collection markup that
    /// states a book's place in its series.
    ///
    /// Series is the one that is not a plain element: EPUB 3 expresses it as a
    /// <c>belongs-to-collection</c> meta refined by <c>collection-type</c> and
    /// <c>group-position</c>. Retailers that do not read it fall back to the
    /// title, which is why the book still reads correctly without it.
    /// </summary>
    private static string PublishingMetadataXml(Models.PublishingMetadata publishing)
    {
        if (!publishing.HasAny) return string.Empty;

        var sb = new StringBuilder();
        void Element(string name, string value)
        {
            if (!string.IsNullOrWhiteSpace(value))
                sb.AppendLine($"    <dc:{name}>{EscapeXml(value.Trim())}</dc:{name}>");
        }

        Element("publisher", publishing.Publisher);
        Element("description", publishing.Description);
        Element("rights", publishing.Rights);
        Element("date", publishing.PublicationDate);

        foreach (var subject in publishing.Subjects)
            Element("subject", subject);

        if (!string.IsNullOrWhiteSpace(publishing.SeriesName))
        {
            sb.AppendLine(
                $"    <meta property=\"belongs-to-collection\" id=\"series\">{EscapeXml(publishing.SeriesName.Trim())}</meta>");
            sb.AppendLine(
                "    <meta refines=\"#series\" property=\"collection-type\">series</meta>");
            if (!string.IsNullOrWhiteSpace(publishing.SeriesPosition))
                sb.AppendLine(
                    $"    <meta refines=\"#series\" property=\"group-position\">{EscapeXml(publishing.SeriesPosition.Trim())}</meta>");
        }

        // An ISBN promoted to the package identifier is still worth stating as
        // its own element: some ingestion pipelines look for the scheme-tagged
        // form rather than parsing the urn.
        var isbn = publishing.NormalizedIsbn();
        if (isbn.Length > 0)
            sb.AppendLine(
                $"    <dc:identifier opf:scheme=\"ISBN\" xmlns:opf=\"http://www.idpf.org/2007/opf\">{EscapeXml(isbn)}</dc:identifier>");

        return sb.ToString().TrimEnd();
    }

    private static (StringBuilder Manifest, StringBuilder Spine) ContentManifest(List<ChapterExportContent> chapters, ExportOptions options, IReadOnlyDictionary<string, string>? images)
    {
        var manifestItems = new StringBuilder();
        var spineItems = new StringBuilder();

        manifestItems.AppendLine("    <item id=\"css\" href=\"styles.css\" media-type=\"text/css\"/>");
        manifestItems.AppendLine("    <item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>");
        manifestItems.AppendLine("    <item id=\"ncx\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/>");

        // Prose images are manifested but never spined: they are shown inside a
        // chapter, not read as a document of their own.
        var imageIndex = 0;
        foreach (var href in images?.Values ?? [])
        {
            imageIndex++;
            var media = CoverMediaType(href) ?? "image/png";
            manifestItems.AppendLine(
                $"    <item id=\"prose-image-{imageIndex}\" href=\"{href}\" media-type=\"{media}\"/>");
        }

        if (options.IncludeTitlePage)
        {
            manifestItems.AppendLine("    <item id=\"title\" href=\"title.xhtml\" media-type=\"application/xhtml+xml\"/>");
            spineItems.AppendLine("    <itemref idref=\"title\"/>");
        }

        // Front matter precedes the story in the spine; back matter follows it.
        void AppendMatter(string placement)
        {
            for (var i = 0; i < options.Matter.Count; i++)
            {
                if (!string.Equals(options.Matter[i].Placement, placement, StringComparison.Ordinal))
                    continue;

                var matterId = $"matter-{i + 1}";
                manifestItems.AppendLine(
                    $"    <item id=\"{matterId}\" href=\"{matterId}.xhtml\" media-type=\"application/xhtml+xml\"/>");
                spineItems.AppendLine($"    <itemref idref=\"{matterId}\"/>");
            }
        }

        AppendMatter("Front");

        for (var i = 0; i < chapters.Count; i++)
        {
            var id = $"chapter-{i + 1}";
            manifestItems.AppendLine($"    <item id=\"{id}\" href=\"{id}.xhtml\" media-type=\"application/xhtml+xml\"/>");
            spineItems.AppendLine($"    <itemref idref=\"{id}\"/>");
        }

        AppendMatter("Back");

        return (manifestItems, spineItems);
    }
}
