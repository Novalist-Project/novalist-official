using System.IO.Compression;
using System.Text;
using System.Xml.Linq;
using Markdig;
using NSubstitute;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Novalist.Core.Tests.TestHelpers;
using Novalist.Core.Utilities;
using Xunit;

namespace Novalist.Core.Tests.Services;

/// <summary>
/// Enter starts a new paragraph; Shift+Enter starts a new line inside the same
/// paragraph. The editor sets prose with <c>white-space: pre-wrap</c>, so the
/// browser stores that line break as a newline in the paragraph's text, while
/// pasted and imported text carries a <c>&lt;br&gt;</c>. Every export keeps
/// either one as a line break in its own form rather than flattening the line
/// into a space. One case per format, so a writer added later either keeps the
/// break or visibly does not.
/// </summary>
public class ExportLineBreakTests : IDisposable
{
    /// <summary>
    /// What the editor saves for "Erste Zeile", Shift+Enter, "zweite Zeile",
    /// Shift+Enter, Enter, "Neuer Absatz". The break left at the end of the
    /// first paragraph has no line after it, so it is not a line of the book.
    /// </summary>
    private const string Scene = "<p>Erste Zeile\nzweite Zeile\n</p><p>Neuer Absatz</p>";

    private static readonly XNamespace Xhtml = "http://www.w3.org/1999/xhtml";
    private static readonly XNamespace W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

    private readonly TempDir _dir = new();
    private readonly IProjectService _project = Substitute.For<IProjectService>();

    public void Dispose() => _dir.Dispose();

    private async Task<string> ExportAsync(
        ExportFormat format, string extension, string html = Scene, ExportPreset? preset = null)
    {
        var chapter = new ChapterData { Title = "Eins", Order = 1 };
        var scene = new SceneData { Id = "s1", Title = "S", Order = 1, ChapterGuid = chapter.Guid };
        _project.ReadSceneContentAsync(chapter, scene).Returns(html);
        _project.GetChaptersOrdered().Returns([chapter]);
        _project.GetScenesForChapter(chapter.Guid).Returns([scene]);

        var outPath = _dir.Combine(Guid.NewGuid().ToString("N") + extension);
        var options = new ExportOptions
        {
            Format = format,
            Title = "Roman",
            IncludeTitlePage = false,
            SelectedChapterGuids = [chapter.Guid]
        };
        if (preset != null)
        {
            // Layouts the writer made live with the book, which is where the
            // export resolves them from.
            _project.ActiveBook.Returns(new BookData { ExportPresets = [preset] });
            options.PresetId = preset.Id;
        }
        await new ExportService(_project).ExportAsync(options, outPath);
        return outPath;
    }

    private static string ReadEntry(string archive, string entry)
    {
        using var zip = ZipFile.OpenRead(archive);
        using var reader = new StreamReader(zip.GetEntry(entry)!.Open(), Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static readonly ExportPreset DropCapLayout = new()
    {
        Id = "custom-dropcap", DisplayName = "Drop cap", IsCustom = true, DropCap = true, LeadInSmallCapsWords = 1
    };

    // ── What counts as a line break ──

    [Theory]
    [InlineData("<p>a\nb</p>")]
    [InlineData("<p>a\r\nb</p>")]
    [InlineData("<p>a\rb</p>")]
    [InlineData("<p>a&#10;b</p>")]
    [InlineData("<p>a<br>b</p>")]
    [InlineData("<p>a<br/>b</p>")]
    [InlineData("<p>a<BR />b</p>")]
    [InlineData("<p>a\nb\n</p>")]
    [InlineData("<p>\na<br>b<br><br></p>")]
    [InlineData("a\nb")]
    [InlineData("a<br>b")]
    public void EveryStoredFormOfALineBreakIsOneBreakBetweenTwoLines(string html)
    {
        var block = Assert.Single(ExportService.ParseHtmlToBlocks(html));

        Assert.Equal(["a", "\n", "b"], block.Segments.Select(s => s.Text));
        Assert.Equal([false, true, false], block.Segments.Select(s => s.LineBreak));
    }

    [Fact]
    public void AnEmptyLineBetweenTwoBreaksIsKeptAndTheLinesKeepTheirFormatting()
    {
        var block = Assert.Single(ExportService.ParseHtmlToBlocks("<p><em>a\n\nb</em></p>"));

        Assert.Equal(["a", "\n", "\n", "b"], block.Segments.Select(s => s.Text));
        Assert.All(block.Segments, s => Assert.True(s.Italic));
    }

    // ── EPUB ──

    [Fact]
    public async Task Epub_LineBreakIsABrInsideTheParagraph()
    {
        var page = XDocument.Parse(ReadEntry(await ExportAsync(ExportFormat.Epub, ".epub"), "OEBPS/chapter-1.xhtml"));

        var paragraphs = page.Descendants(Xhtml + "p").ToList();
        Assert.Equal(2, paragraphs.Count);
        var first = paragraphs[0];
        // One break between the two lines; the trailing placeholder is not a line.
        Assert.Single(first.Descendants(Xhtml + "br"));
        Assert.Equal("Erste Zeile", ((XText)first.Descendants(Xhtml + "br").Single().PreviousNode!).Value);
        Assert.Equal("zweite Zeile", ((XText)first.Descendants(Xhtml + "br").Single().NextNode!).Value);
        Assert.Equal("Neuer Absatz", paragraphs[1].Value);
    }

    [Theory]
    [InlineData("<p class=\"nv-style-poetry\">Rosen<br>Veilchen<br>Tulpen</p>")]
    [InlineData("<p class=\"nv-style-poetry\">Rosen\nVeilchen\nTulpen</p>")]
    public async Task Epub_VerseKeepsEveryLineAsABreak(string scene)
    {
        var page = XDocument.Parse(ReadEntry(await ExportAsync(ExportFormat.Epub, ".epub", scene), "OEBPS/chapter-1.xhtml"));

        var verse = page.Descendants(Xhtml + "p").Single(p => (string?)p.Attribute("class") == "poetry");
        Assert.Equal(2, verse.Descendants(Xhtml + "br").Count());
        // The verse style keeps newlines, so one left in the text beside its
        // break would open an empty line between every two lines of the poem.
        Assert.DoesNotContain('\n', verse.Value);
    }

    // ── Word ──

    [Fact]
    public async Task Docx_LineBreakIsAWordLineBreakInsideTheParagraph()
    {
        var document = XDocument.Parse(ReadEntry(await ExportAsync(ExportFormat.Docx, ".docx"), "word/document.xml"));

        var paragraph = document.Descendants(W + "p")
            .Single(p => p.Descendants(W + "t").Any(t => t.Value == "Erste Zeile"));
        Assert.Single(paragraph.Descendants(W + "br"));
        Assert.Equal(["Erste Zeile", "zweite Zeile"], paragraph.Descendants(W + "t").Select(t => t.Value));
        Assert.DoesNotContain(document.Descendants(W + "t"), t => t.Value.Contains('\n'));
    }

    [Fact]
    public async Task Docx_DropCapOpenerKeepsItsLineBreak()
    {
        var document = XDocument.Parse(ReadEntry(
            await ExportAsync(ExportFormat.Docx, ".docx", preset: DropCapLayout), "word/document.xml"));

        Assert.Contains(document.Descendants(W + "framePr"), f => (string?)f.Attribute(W + "dropCap") == "drop");
        var tail = document.Descendants(W + "p")
            .Single(p => p.Descendants(W + "t").Any(t => t.Value.Contains("Zeile", StringComparison.Ordinal)));
        Assert.Contains(tail.Descendants(W + "t"), t => t.Value == "rste");
        Assert.Single(tail.Descendants(W + "br"));
        Assert.DoesNotContain(tail.Descendants(W + "t"), t => t.Value.Contains('\n'));
    }

    [Fact]
    public async Task Docx_ReviewReaderReadsTheBreakBackInACommentAnchor()
    {
        // The anchor of a comment on a paragraph with a break comes back with
        // its lines apart, not glued into "Erste Zeilezweite Zeile".
        var chapter = new ChapterData { Title = "Eins", Order = 1 };
        var scene = new SceneData
        {
            Id = "s1", Title = "S", Order = 1, ChapterGuid = chapter.Guid,
            Comments = [new SceneComment { Id = "c1", AnchorText = "Erste", Text = "Kürzen." }]
        };
        _project.ReadSceneContentAsync(chapter, scene).Returns(Scene);
        _project.GetChaptersOrdered().Returns([chapter]);
        _project.GetScenesForChapter(chapter.Guid).Returns([scene]);
        var outPath = _dir.Combine("review.docx");
        await new ExportService(_project).ExportAsync(
            new ExportOptions { Format = ExportFormat.Docx, Title = "Roman", SelectedChapterGuids = [chapter.Guid] },
            outPath);

        var comment = Assert.Single(DocxReviewReader.Read(outPath).Comments);
        Assert.Equal("Erste Zeile\nzweite Zeile", comment.AnchorText);
    }

    [Fact]
    public void Docx_ReviewReaderReadsWordsOwnBreaksInTrackedChanges()
    {
        // What Word writes when an editor types Shift+Enter inside an insertion,
        // or deletes across one.
        var document =
            "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p>"
            + "<w:ins w:id=\"1\" w:author=\"Ed\"><w:r><w:t>neu</w:t><w:br/><w:t>Zeile</w:t></w:r></w:ins>"
            + "<w:del w:id=\"2\" w:author=\"Ed\"><w:r><w:delText>alt</w:delText><w:cr/><w:delText>weg</w:delText></w:r></w:del>"
            + "</w:p></w:body></w:document>";
        using var stream = new MemoryStream();
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        using (var writer = new StreamWriter(zip.CreateEntry("word/document.xml").Open()))
            writer.Write(document);
        stream.Position = 0;

        var revisions = DocxReviewReader.Read(stream).Revisions;

        Assert.Equal(["neu\nZeile", "alt\nweg"], revisions.Select(r => r.Text));
    }

    // ── Markdown ──

    /// <summary>The pipeline the app's own Markdown import uses, so what the
    /// export writes is checked against what the import reads back.</summary>
    private static readonly MarkdownPipeline ImportPipeline =
        new MarkdownPipelineBuilder().DisableHtml().UseEmphasisExtras().Build();

    [Fact]
    public async Task Markdown_LineBreakIsAHardBreakTheImportReadsBack()
    {
        var markdown = await File.ReadAllTextAsync(await ExportAsync(ExportFormat.Markdown, ".md"));

        Assert.Contains("Erste Zeile\\\nzweite Zeile\n", markdown.ReplaceLineEndings("\n"));
        var html = Markdown.ToHtml(markdown, ImportPipeline);
        Assert.Contains("<p>Erste Zeile<br />\nzweite Zeile</p>", html);
        Assert.Contains("<p>Neuer Absatz</p>", html);
    }

    [Theory]
    [InlineData("<p class=\"nv-style-blockquote\">a<br>b</p>", "<blockquote>\n<p>a<br />\nb</p>\n</blockquote>")]
    [InlineData("<ul><li>a<br>b</li></ul>", "<li>a<br />\nb</li>")]
    [InlineData("<ol><li>a<br>b</li></ol>", "<li>a<br />\nb</li>")]
    [InlineData("<p class=\"nv-style-poetry\">a<br>b</p>", "<pre><code>a\nb\n</code></pre>")]
    public async Task Markdown_LineBreakStaysInsideItsBlock(string scene, string expected)
    {
        var markdown = await File.ReadAllTextAsync(await ExportAsync(ExportFormat.Markdown, ".md", scene));

        Assert.Contains(expected, Markdown.ToHtml(markdown, ImportPipeline));
    }

    [Fact]
    public async Task Markdown_HeadingCannotHoldABreakAndJoinsWithASpace()
    {
        var markdown = await File.ReadAllTextAsync(
            await ExportAsync(ExportFormat.Markdown, ".md", "<p class=\"nv-style-heading\">Teil<br>Eins</p>"));

        Assert.Contains("# Teil Eins", markdown);
    }

    // ── LaTeX ──

    [Fact]
    public async Task Latex_LineBreakIsALatexLineBreak()
    {
        var latex = (await File.ReadAllTextAsync(await ExportAsync(ExportFormat.LaTeX, ".tex"))).ReplaceLineEndings("\n");

        Assert.Contains("Erste Zeile\\\\\nzweite Zeile\n", latex);
        Assert.DoesNotContain("zweite Zeile\\\\", latex);
    }

    [Fact]
    public async Task Latex_ConsecutiveBreaksKeepTheEmptyLineWithoutALatexError()
    {
        var latex = (await File.ReadAllTextAsync(
            await ExportAsync(ExportFormat.LaTeX, ".tex", "<p>a<br><br>b</p>"))).ReplaceLineEndings("\n");

        Assert.Contains("a\\\\\n\\mbox{}\\\\\nb", latex);
    }

    [Fact]
    public async Task Latex_DropCapOpenerKeepsItsLineBreak()
    {
        var latex = (await File.ReadAllTextAsync(
            await ExportAsync(ExportFormat.LaTeX, ".tex", preset: DropCapLayout))).ReplaceLineEndings("\n");

        Assert.Contains("\\lettrine{E}{rste}", latex);
        Assert.Contains("Zeile\\\\\nzweite Zeile", latex);
    }

    // ── PDF ──

    private static int PdfPages(string path)
    {
        using var doc = PdfSharp.Pdf.IO.PdfReader.Open(path, PdfSharp.Pdf.IO.PdfDocumentOpenMode.Import);
        return doc.PageCount;
    }

    [Fact]
    public async Task Pdf_EachLineBreakStartsANewLine()
    {
        // The same 120 words, once on one line each and once as running text.
        // Kept apart, they need several pages; run together, one.
        var words = Enumerable.Range(1, 120).Select(i => $"Wort{i}").ToList();
        var lines = await ExportAsync(ExportFormat.Pdf, ".pdf", $"<p>{string.Join("<br>", words)}</p>");
        var prose = await ExportAsync(ExportFormat.Pdf, ".pdf", $"<p>{string.Join(" ", words)}</p>");

        Assert.True(PdfPages(lines) > PdfPages(prose), $"{PdfPages(lines)} vs {PdfPages(prose)}");
    }

    // ── Normseiten ──

    [Fact]
    public void Normseiten_LineBreakStartsANewGridLineWithoutABlankLine()
    {
        var lines = NormseitenRenderer.RenderLines(ExportService.HtmlToNormseitenBlocks(Scene));

        Assert.Equal(["Erste Zeile", "zweite Zeile", "", "Neuer Absatz"], lines);
    }

    [Fact]
    public void Normseiten_HeadingWithABreakStaysOneHeading()
    {
        var lines = NormseitenRenderer.RenderLines(
            ExportService.HtmlToNormseitenBlocks("<p class=\"nv-style-heading\">Teil<br>Eins</p>"));

        Assert.Equal(["TEIL EINS"], lines);
    }

    // ── Preview ──

    [Fact]
    public async Task Preview_CountsTheWordsOnBothSidesOfABreakAndAParagraph()
    {
        var chapter = new ChapterData { Title = "Eins", Order = 1 };
        var scene = new SceneData { Id = "s1", Title = "S", Order = 1, ChapterGuid = chapter.Guid };
        _project.ReadSceneContentAsync(chapter, scene).Returns("<p>eins<br>zwei</p><p>drei</p>");
        _project.GetChaptersOrdered().Returns([chapter]);
        _project.GetScenesForChapter(chapter.Guid).Returns([scene]);

        var preview = await new ExportService(_project).PreviewAsync(
            new ExportOptions { Format = ExportFormat.Epub, SelectedChapterGuids = [chapter.Guid] });

        Assert.Equal(3, preview.Words);
    }
}
