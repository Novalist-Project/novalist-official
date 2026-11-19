namespace Novalist.Core.Services;

/// <summary>
/// The plain-language accessibility summary an EPUB carries, built from what
/// the book actually contains and written in the book's own language. A reader
/// who relies on it is reading a German book; an English sentence claiming
/// there is nothing to describe, on a book with an undescribed cover, helps
/// nobody.
///
/// Covers the languages the app itself ships. Any other book language gets the
/// English text, marked as English so a reading system does not read it with
/// the book's voice.
/// </summary>
internal static class EpubAccessibilitySummary
{
    /// <summary>The sentences one language needs, in the order they are used.</summary>
    private sealed record Phrases(
        string Text,
        string NoImages,
        string ImagesDescribed,
        string SomeImagesUndescribed,
        string NoImagesDescribed,
        string CoverDescribed,
        string CoverUndescribed,
        string Cover,
        string Separator = " ");

    private static readonly Dictionary<string, Phrases> ByLanguage = new(StringComparer.Ordinal)
    {
        ["en"] = new(
            "Reflowable text with a table of contents.",
            "There are no images to describe.",
            "Images carry the descriptions the author wrote.",
            "Some images have no text description.",
            "The images have no text descriptions.",
            "The cover image has a text description.",
            "The cover image has no text description.",
            "Cover"),
        ["de"] = new(
            "Umbrechbarer Text mit Inhaltsverzeichnis.",
            "Das Buch enthält keine Bilder, die beschrieben werden müssten.",
            "Bilder tragen die Beschreibungen, die beim Schreiben hinterlegt wurden.",
            "Einige Bilder haben keine Textbeschreibung.",
            "Die Bilder haben keine Textbeschreibungen.",
            "Das Coverbild hat eine Textbeschreibung.",
            "Das Coverbild hat keine Textbeschreibung.",
            "Coverbild"),
        ["zh"] = new(
            "可重排文本，附有目录。",
            "书中没有需要描述的图片。",
            "图片附有作者撰写的描述。",
            "部分图片没有文字描述。",
            "图片均没有文字描述。",
            "封面图片附有文字描述。",
            "封面图片没有文字描述。",
            "封面",
            Separator: ""),
        ["ar"] = new(
            "نص قابل لإعادة التدفق مع جدول محتويات.",
            "لا توجد صور تحتاج إلى وصف.",
            "تحمل الصور الأوصاف التي كتبها المؤلف.",
            "بعض الصور بلا وصف نصي.",
            "الصور بلا أوصاف نصية.",
            "لصورة الغلاف وصف نصي.",
            "صورة الغلاف بلا وصف نصي.",
            "الغلاف")
    };

    private static (Phrases Phrases, string Language) Resolve(string language)
    {
        var primary = ExportService.NormalizeLanguageTag(language);
        return ByLanguage.TryGetValue(primary, out var phrases)
            ? (phrases, primary)
            : (ByLanguage["en"], "en");
    }

    /// <summary>
    /// The summary for a book, and the language it is actually written in -
    /// the book's own, or "en" when the book's language has no translation.
    /// The counts are of the prose images the file actually carries, so the
    /// sentence about them is one of: all described, some not, none.
    /// </summary>
    public static (string Text, string Language) For(
        string language, int describedImages, int undescribedImages, bool cover, bool coverDescribed)
    {
        var (phrases, written) = Resolve(language);
        var sentences = new List<string> { phrases.Text };
        if (describedImages + undescribedImages == 0)
        {
            if (!cover) sentences.Add(phrases.NoImages);
        }
        else if (undescribedImages == 0) sentences.Add(phrases.ImagesDescribed);
        else if (describedImages > 0) sentences.Add(phrases.SomeImagesUndescribed);
        else sentences.Add(phrases.NoImagesDescribed);
        if (cover) sentences.Add(coverDescribed ? phrases.CoverDescribed : phrases.CoverUndescribed);
        return (string.Join(phrases.Separator, sentences), written);
    }

    /// <summary>The word for a book cover, used to name a cover that has
    /// neither a description nor a book title to be named by.</summary>
    public static string CoverWord(string language) => Resolve(language).Phrases.Cover;
}
