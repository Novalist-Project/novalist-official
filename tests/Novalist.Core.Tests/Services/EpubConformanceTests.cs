using System.IO.Compression;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using NSubstitute;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Novalist.Core.Tests.TestHelpers;
using Xunit;

namespace Novalist.Core.Tests.Services;

/// <summary>
/// A whole book with front and back matter, opened the way a validator or a
/// reading system opens it: every document parsed as strict XML, the two
/// contents files compared entry by entry, and the language and ARIA roles
/// that accessibility checkers look for read off the parsed markup.
/// </summary>
public class EpubConformanceTests : IDisposable
{
    private static readonly XNamespace Xhtml = "http://www.w3.org/1999/xhtml";
    private static readonly XNamespace Ops = "http://www.idpf.org/2007/ops";
    private static readonly XNamespace Opf = "http://www.idpf.org/2007/opf";
    private static readonly XNamespace Ncx = "http://www.daisy.org/z3986/2005/ncx/";

    /// <summary>The structural-semantics terms Ace by DAISY expects a matching
    /// ARIA role for, limited to the ones a Novalist book can carry.</summary>
    private static readonly Dictionary<string, string> RoleFor = new()
    {
        ["acknowledgments"] = "doc-acknowledgments",
        ["afterword"] = "doc-afterword",
        ["chapter"] = "doc-chapter",
        ["dedication"] = "doc-dedication",
        ["epigraph"] = "doc-epigraph",
        ["epilogue"] = "doc-epilogue",
        ["footnote"] = "doc-footnote",
        ["foreword"] = "doc-foreword",
        ["noteref"] = "doc-noteref",
        ["preface"] = "doc-preface",
        ["prologue"] = "doc-prologue",
        ["toc"] = "doc-toc"
    };

    /// <summary>Every character XML cares about, a paragraph break and a line
    /// break, the way a writer types them into the matter page's text box.</summary>
    private const string CopyrightText =
        "Bildnachweise & Grafiken: <Atelier> \"Nord\" & 'Süd'\n"
        + "Satz: Muster > Vorlage\n"
        + "\n"
        + "\n"
        + "Alle Rechte vorbehalten.\r\n"
        + "\r\n"
        + "Gedruckt in Deutschland.";

    private readonly TempDir _dir = new();
    private readonly IProjectService _project = Substitute.For<IProjectService>();

    public void Dispose() => _dir.Dispose();

    private static BookMatterElement Page(
        BookMatterKind kind, string content, bool inToc, string title = "") => new()
    {
        Kind = kind,
        Title = title,
        Content = content,
        Placement = BookMatterElement.DefaultPlacement(kind),
        InTableOfContents = inToc
    };

    private static List<BookMatterElement> ReportersBook(bool inToc) =>
    [
        Page(BookMatterKind.Copyright, CopyrightText, inToc, "Impressum"),
        Page(BookMatterKind.Custom, "Diese Geschichte enthält Gewalt.", inToc, "Content Note"),
        Page(BookMatterKind.Prologue, "Es war Nacht.\n\nDer Wind & das Meer.", inToc, "Prolog"),
        Page(BookMatterKind.Afterword, "Danke fürs Lesen.", inToc, "Nachwort"),
        Page(BookMatterKind.AboutTheAuthor, "Ich schreibe.", inToc, "Über mich")
    ];

    private async Task<string> ExportAsync(
        List<BookMatterElement> matter, string language = "de", string coverAltText = "", string title = "Roman")
    {
        var chapter = new ChapterData { Title = "Eins", Order = 1 };
        var scene = new SceneData
        {
            Id = "s1",
            Title = "Ankunft",
            Order = 1,
            ChapterGuid = chapter.Guid,
            Footnotes = [new SceneFootnote { Id = "n1", Number = 1, Text = "Eine Anmerkung." }]
        };
        _project.ReadSceneContentAsync(chapter, scene).Returns(
            "<p>Sie kam an.<sup class=\"nv-fn\" data-fn-id=\"n1\">1</sup></p>");
        _project.GetChaptersOrdered().Returns(new List<ChapterData> { chapter });
        _project.GetScenesForChapter(chapter.Guid).Returns(new List<SceneData> { scene });
        _project.ActiveBook.Returns(new BookData { Matter = matter });

        var cover = _dir.Combine("cover.png");
        await File.WriteAllBytesAsync(cover, Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="));

        var outPath = _dir.Combine("book.epub");
        await new ExportService(_project).ExportAsync(
            new ExportOptions
            {
                Format = ExportFormat.Epub,
                Title = title,
                Author = "A. Autor",
                Language = language,
                IncludeTitlePage = true,
                CoverImagePath = cover,
                CoverAltText = coverAltText,
                SelectedChapterGuids = [chapter.Guid]
            },
            outPath);
        return outPath;
    }

    /// <summary>
    /// Parses with the settings a validator uses: well-formedness is enforced,
    /// and the DOCTYPE is skipped rather than fetched, so an undeclared entity
    /// such as <c>&amp;nbsp;</c> or a bare ampersand fails the parse.
    /// </summary>
    private static XDocument Parse(ZipArchive zip, string entry)
    {
        using var stream = zip.GetEntry(entry)!.Open();
        using var reader = XmlReader.Create(stream, new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Ignore,
            XmlResolver = null
        });
        return XDocument.Load(reader);
    }

    private static Dictionary<string, XDocument> ParseAll(string epub)
    {
        using var zip = ZipFile.OpenRead(epub);
        return zip.Entries
            .Where(e => e.FullName.EndsWith(".xhtml", StringComparison.Ordinal)
                || e.FullName.EndsWith(".opf", StringComparison.Ordinal)
                || e.FullName.EndsWith(".ncx", StringComparison.Ordinal)
                || e.FullName.EndsWith(".xml", StringComparison.Ordinal))
            .ToDictionary(e => e.FullName, e => Parse(zip, e.FullName));
    }

    /// <summary>The matter page whose heading is <paramref name="title"/>.</summary>
    private static XDocument MatterPage(Dictionary<string, XDocument> docs, string title) =>
        docs.Where(d => d.Key.StartsWith("OEBPS/matter-", StringComparison.Ordinal))
            .Select(d => d.Value)
            .Single(d => d.Descendants(Xhtml + "h1").Any(h => h.Value == title));

    [Fact]
    public async Task Epub_EveryDocumentIsWellFormedXml()
    {
        var epub = await ExportAsync(ReportersBook(inToc: true));

        using var zip = ZipFile.OpenRead(epub);
        var documents = zip.Entries
            .Where(e => e.FullName.EndsWith(".xhtml", StringComparison.Ordinal)
                || e.FullName.EndsWith(".opf", StringComparison.Ordinal)
                || e.FullName.EndsWith(".ncx", StringComparison.Ordinal))
            .Select(e => e.FullName)
            .ToList();

        Assert.Contains("OEBPS/matter-1.xhtml", documents);
        Assert.Contains("OEBPS/cover.xhtml", documents);
        foreach (var entry in documents)
        {
            var failure = Record.Exception(() => Parse(zip, entry));
            Assert.True(failure == null, $"{entry}: {failure?.Message}");
        }
    }

    [Fact]
    public async Task Epub_MatterTextKeepsEveryCharacterTheWriterTyped()
    {
        var docs = ParseAll(await ExportAsync(ReportersBook(inToc: true)));

        var text = MatterPage(docs, "Impressum").Descendants(Xhtml + "p").First().Value;
        Assert.Contains("Bildnachweise & Grafiken: <Atelier> \"Nord\" & 'Süd'", text);
        Assert.Contains("Satz: Muster > Vorlage", text);
    }

    [Fact]
    public async Task Epub_BlankLinesSeparateParagraphsAndSingleBreaksStayLineBreaks()
    {
        var docs = ParseAll(await ExportAsync(ReportersBook(inToc: true)));

        var page = MatterPage(docs, "Impressum");
        var paragraphs = page.Descendants(Xhtml + "p").ToList();
        Assert.Equal(3, paragraphs.Count);
        Assert.Equal("Alle Rechte vorbehalten.", paragraphs[1].Value);
        Assert.Equal("Gedruckt in Deutschland.", paragraphs[2].Value);

        // The single line break inside the first paragraph is a real break,
        // and the text on either side of it is not left loose in the body.
        var first = paragraphs[0];
        Assert.Single(first.Elements(Xhtml + "br"));
        Assert.Equal(
            "Bildnachweise & Grafiken: <Atelier> \"Nord\" & 'Süd'",
            ((XText)first.Elements(Xhtml + "br").Single().PreviousNode!).Value);
        var body = page.Descendants(Xhtml + "body").Single();
        Assert.DoesNotContain(body.DescendantNodes().OfType<XText>(),
            t => t.Parent!.Name.LocalName is "body" or "section" && t.Value.Trim().Length > 0);
    }

    [Fact]
    public async Task Epub_PrologueParagraphsBecomeParagraphElements()
    {
        var docs = ParseAll(await ExportAsync(ReportersBook(inToc: true)));

        var paragraphs = MatterPage(docs, "Prolog").Descendants(Xhtml + "p").Select(p => p.Value);
        Assert.Equal(["Es war Nacht.", "Der Wind & das Meer."], paragraphs);
    }

    /// <summary>Every link target in the EPUB 3 contents, in reading order.</summary>
    private static List<string> NavTargets(Dictionary<string, XDocument> docs) =>
        docs["OEBPS/nav.xhtml"]
            .Descendants(Xhtml + "nav")
            .Single(n => (string?)n.Attribute(Ops + "type") == "toc")
            .Descendants(Xhtml + "a")
            .Select(a => (string)a.Attribute("href")!)
            .ToList();

    /// <summary>Every target in the EPUB 2 contents, in play order.</summary>
    private static List<string> NcxTargets(Dictionary<string, XDocument> docs) =>
        docs["OEBPS/toc.ncx"]
            .Descendants(Ncx + "navPoint")
            .OrderBy(p => int.Parse((string)p.Attribute("playOrder")!))
            .Select(p => (string)p.Element(Ncx + "content")!.Attribute("src")!)
            .ToList();

    [Fact]
    public async Task Epub_NavAndNcxListTheSameEntriesInTheSameOrder()
    {
        var docs = ParseAll(await ExportAsync(ReportersBook(inToc: true)));

        var nav = NavTargets(docs);
        Assert.Equal(
            ["title.xhtml", "matter-1.xhtml", "matter-2.xhtml", "matter-3.xhtml",
             "chapter-1.xhtml", "matter-4.xhtml", "matter-5.xhtml"],
            nav);
        Assert.Equal(nav, NcxTargets(docs));

        // The labels match too, and the play order has no gaps or repeats.
        var ncx = docs["OEBPS/toc.ncx"];
        Assert.Contains(ncx.Descendants(Ncx + "text"), t => t.Value == "Über mich");
        Assert.Equal(
            Enumerable.Range(1, nav.Count),
            ncx.Descendants(Ncx + "navPoint").Select(p => int.Parse((string)p.Attribute("playOrder")!)).Order());
    }

    [Fact]
    public async Task Epub_MatterNotMarkedForTheContentsIsInNeitherContentsFile()
    {
        var docs = ParseAll(await ExportAsync(ReportersBook(inToc: false)));

        Assert.Equal(["title.xhtml", "chapter-1.xhtml"], NavTargets(docs));
        Assert.Equal(NavTargets(docs), NcxTargets(docs));
    }

    [Fact]
    public async Task Epub_PackageAndEveryDocumentDeclareTheBookLanguage()
    {
        var docs = ParseAll(await ExportAsync(ReportersBook(inToc: true)));

        var package = docs["OEBPS/content.opf"].Root!;
        Assert.Equal(Opf + "package", package.Name);
        Assert.Equal("de", (string?)package.Attribute(XNamespace.Xml + "lang"));

        var pages = docs.Where(d => d.Key.EndsWith(".xhtml", StringComparison.Ordinal)).ToList();
        // Cover, title page, five matter pages, the chapter and the contents.
        Assert.Equal(9, pages.Count);
        foreach (var (name, doc) in pages)
        {
            Assert.True("de" == (string?)doc.Root!.Attribute("lang"), $"{name} lacks lang");
            Assert.True("de" == (string?)doc.Root!.Attribute(XNamespace.Xml + "lang"), $"{name} lacks xml:lang");
        }
    }

    [Fact]
    public async Task Epub_BlankLanguageDeclaresEnglishEverywhere()
    {
        var docs = ParseAll(await ExportAsync(ReportersBook(inToc: true), language: "  "));

        Assert.Equal("en", (string?)docs["OEBPS/content.opf"].Root!.Attribute(XNamespace.Xml + "lang"));
        Assert.All(
            docs.Where(d => d.Key.EndsWith(".xhtml", StringComparison.Ordinal)),
            d => Assert.Equal("en", (string?)d.Value.Root!.Attribute("lang")));
    }

    [Fact]
    public async Task Epub_StructuralSemanticsCarryTheMatchingAriaRole()
    {
        var docs = ParseAll(await ExportAsync(ReportersBook(inToc: true)));

        var checkedTypes = new HashSet<string>();
        foreach (var (name, doc) in docs.Where(d => d.Key.EndsWith(".xhtml", StringComparison.Ordinal)))
        {
            foreach (var element in doc.Descendants().Where(e => e.Attribute(Ops + "type") != null))
            {
                // Ace keys on the first term it has a mapping for.
                var mapped = ((string)element.Attribute(Ops + "type")!)
                    .Split(' ', StringSplitOptions.RemoveEmptyEntries)
                    .FirstOrDefault(RoleFor.ContainsKey);
                if (mapped == null) continue;

                checkedTypes.Add(mapped);
                Assert.True(
                    RoleFor[mapped] == (string?)element.Attribute("role"),
                    $"{name}: <{element.Name.LocalName} epub:type=\"{mapped}\"> has role \"{element.Attribute("role")?.Value}\"");
                // DPUB-ARIA roles are not allowed on body, which is why the
                // term has to sit on an element that can take the role.
                Assert.NotEqual("body", element.Name.LocalName);
            }
        }

        Assert.Superset(
            new HashSet<string> { "chapter", "toc", "prologue", "afterword", "footnote", "noteref" },
            checkedTypes);
    }

    // ── The cover's description, and a summary that tells the truth about it ──

    private static readonly XNamespace Svg = "http://www.w3.org/2000/svg";

    private static XElement CoverSvg(Dictionary<string, XDocument> docs) =>
        docs["OEBPS/cover.xhtml"].Descendants(Svg + "svg").Single();

    /// <summary>The accessible name of the cover svg, resolved the way
    /// assistive technology resolves <c>aria-labelledby</c>.</summary>
    private static string CoverName(XElement svg)
    {
        Assert.Equal("img", (string?)svg.Attribute("role"));
        var id = (string)svg.Attribute("aria-labelledby")!;
        return svg.Descendants().Single(e => (string?)e.Attribute("id") == id).Value;
    }

    private static List<string> Meta(Dictionary<string, XDocument> docs, string property) =>
        docs["OEBPS/content.opf"].Descendants(Opf + "meta")
            .Where(m => (string?)m.Attribute("property") == property)
            .Select(m => m.Value)
            .ToList();

    [Fact]
    public async Task Epub_DescribedCoverIsNamedByItsDescription()
    {
        var docs = ParseAll(await ExportAsync([], coverAltText: "  Ein Leuchtturm im Sturm & Regen  "));

        Assert.Equal("Ein Leuchtturm im Sturm & Regen", CoverName(CoverSvg(docs)));
        Assert.Contains("visual", Meta(docs, "schema:accessMode"));
        Assert.Contains("alternativeText", Meta(docs, "schema:accessibilityFeature"));
        Assert.Equal(
            ["Umbrechbarer Text mit Inhaltsverzeichnis. Das Coverbild hat eine Textbeschreibung."],
            Meta(docs, "schema:accessibilitySummary"));
    }

    [Fact]
    public async Task Epub_UndescribedCoverIsNamedByTheTitleAndClaimsNoAlternativeText()
    {
        var docs = ParseAll(await ExportAsync([]));

        Assert.Equal("Roman", CoverName(CoverSvg(docs)));
        Assert.Contains("visual", Meta(docs, "schema:accessMode"));
        Assert.DoesNotContain("alternativeText", Meta(docs, "schema:accessibilityFeature"));
        Assert.Equal(
            ["Umbrechbarer Text mit Inhaltsverzeichnis. Das Coverbild hat keine Textbeschreibung."],
            Meta(docs, "schema:accessibilitySummary"));
    }

    [Fact]
    public async Task Epub_CoverWithNeitherDescriptionNorTitleIsStillNamed()
    {
        var docs = ParseAll(await ExportAsync([], title: " "));

        Assert.Equal("Coverbild", CoverName(CoverSvg(docs)));
    }

    [Fact]
    public async Task Epub_SummaryInAnUntranslatedLanguageFallsBackToMarkedEnglish()
    {
        var docs = ParseAll(await ExportAsync([], language: "fr"));

        var summary = docs["OEBPS/content.opf"].Descendants(Opf + "meta")
            .Single(m => (string?)m.Attribute("property") == "schema:accessibilitySummary");
        Assert.Equal("en", (string?)summary.Attribute(XNamespace.Xml + "lang"));
        Assert.Equal(
            "Reflowable text with a table of contents. The cover image has no text description.",
            summary.Value);
        Assert.Equal("Cover", EpubAccessibilitySummary.CoverWord("fr"));
    }

    [Theory]
    [InlineData("en", 0, 0, false, false, "Reflowable text with a table of contents. There are no images to describe.")]
    [InlineData("en", 2, 0, true, true, "Reflowable text with a table of contents. Images carry the descriptions the author wrote. The cover image has a text description.")]
    [InlineData("en", 1, 1, false, false, "Reflowable text with a table of contents. Some images have no text description.")]
    [InlineData("en", 0, 3, false, false, "Reflowable text with a table of contents. The images have no text descriptions.")]
    [InlineData("de", 0, 0, false, false, "Umbrechbarer Text mit Inhaltsverzeichnis. Das Buch enthält keine Bilder, die beschrieben werden müssten.")]
    [InlineData("de", 1, 0, false, false, "Umbrechbarer Text mit Inhaltsverzeichnis. Bilder tragen die Beschreibungen, die beim Schreiben hinterlegt wurden.")]
    [InlineData("de", 2, 1, false, false, "Umbrechbarer Text mit Inhaltsverzeichnis. Einige Bilder haben keine Textbeschreibung.")]
    [InlineData("de", 0, 1, true, false, "Umbrechbarer Text mit Inhaltsverzeichnis. Die Bilder haben keine Textbeschreibungen. Das Coverbild hat keine Textbeschreibung.")]
    [InlineData("zh-CN", 0, 0, true, false, "可重排文本，附有目录。封面图片没有文字描述。")]
    [InlineData("zh", 0, 0, true, true, "可重排文本，附有目录。封面图片附有文字描述。")]
    [InlineData("zh", 1, 1, false, false, "可重排文本，附有目录。部分图片没有文字描述。")]
    [InlineData("zh", 0, 2, false, false, "可重排文本，附有目录。图片均没有文字描述。")]
    [InlineData("ar", 0, 0, true, true, "نص قابل لإعادة التدفق مع جدول محتويات. لصورة الغلاف وصف نصي.")]
    [InlineData("ar", 1, 0, true, false, "نص قابل لإعادة التدفق مع جدول محتويات. تحمل الصور الأوصاف التي كتبها المؤلف. صورة الغلاف بلا وصف نصي.")]
    [InlineData("ar", 1, 2, false, false, "نص قابل لإعادة التدفق مع جدول محتويات. بعض الصور بلا وصف نصي.")]
    [InlineData("ar", 0, 1, false, false, "نص قابل لإعادة التدفق مع جدول محتويات. الصور بلا أوصاف نصية.")]
    public void Summary_DescribesWhatTheBookContainsInItsLanguage(
        string language, int described, int undescribed, bool cover, bool coverDescribed, string expected)
    {
        var (text, written) = EpubAccessibilitySummary.For(language, described, undescribed, cover, coverDescribed);

        Assert.Equal(expected, text);
        Assert.Equal(ExportService.NormalizeLanguageTag(language), written);
    }

    [Fact]
    public async Task Epub_MatterPagesKeepTheirStylesheetHooks()
    {
        var docs = ParseAll(await ExportAsync(ReportersBook(inToc: true)));

        var body = MatterPage(docs, "Impressum").Descendants(Xhtml + "body").Single();
        Assert.Equal("matter matter-copyright", (string?)body.Attribute("class"));
        Assert.Contains(body.Descendants(), e => (string?)e.Attribute(Ops + "type") == "copyright-page");
        Assert.Equal("matter-title", (string?)body.Descendants(Xhtml + "h1").Single().Attribute("class"));
    }
}
