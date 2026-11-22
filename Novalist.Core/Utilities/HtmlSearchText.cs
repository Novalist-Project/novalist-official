using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace Novalist.Core.Utilities;

internal sealed class HtmlSearchText
{
    private sealed record Part(string Raw, string Text, int Start, bool Markup);
    private readonly List<Part> _parts = [];
    public string Text { get; }

    public HtmlSearchText(string html)
    {
        var visible = new StringBuilder();
        var ignoredDepth = 0;
        foreach (Match token in Regex.Matches(html, """<(?:"[^"]*"|'[^']*'|[^'">])*>|[^<]+|<""",
            RegexOptions.NonBacktracking, TimeSpan.FromSeconds(2)))
        {
            var raw = token.Value;
            var markup = raw.StartsWith('<') && raw.Length > 1;
            var hidden = IsHidden(raw, markup, ref ignoredDepth);
            var text = hidden ? string.Empty : markup
                ? Regex.IsMatch(raw, @"^</p\s*>$|^<br(?:\s|/?>)",
                    RegexOptions.IgnoreCase | RegexOptions.NonBacktracking, TimeSpan.FromSeconds(2)) ? "\n" : string.Empty
                : WebUtility.HtmlDecode(raw);
            _parts.Add(new Part(raw, text, visible.Length, markup));
            visible.Append(text);
        }
        Text = visible.ToString();
    }

    private static bool IsHidden(string raw, bool markup, ref int depth)
    {
        var hidden = depth > 0;
        if (!markup) return hidden;
        var tag = Regex.Match(raw, @"^<(?<close>/)?(?<name>[a-z][a-z0-9:-]*)", RegexOptions.IgnoreCase | RegexOptions.NonBacktracking,
            TimeSpan.FromSeconds(2));
        if (!tag.Success) return hidden;
        if (tag.Groups["close"].Success)
        {
            if (depth > 0) depth--;
            return hidden;
        }
        var attributes = Regex.Matches(raw[tag.Length..], """(?<name>[\w:-]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?""",
            RegexOptions.NonBacktracking, TimeSpan.FromSeconds(2));
        hidden |= attributes.Cast<Match>().Any(attribute => attribute.Groups["name"].Value.Equals("data-editor-chrome", StringComparison.OrdinalIgnoreCase));
        var name = tag.Groups["name"].Value.ToLowerInvariant();
        if (hidden && name is not ("area" or "base" or "br" or "col" or "embed" or "hr" or "img" or "input" or "link" or "meta" or "param" or "source" or "track" or "wbr")) depth++;
        return hidden;
    }

    public (string Html, int Count) Replace(Regex regex, string replacement)
        => Replace(regex.Matches(Text).Cast<Match>().ToArray(), replacement);

    public (string Html, int Count) Replace(IReadOnlyList<Match> matches, string replacement)
    {
        if (matches.Count == 0) return (string.Concat(_parts.Select(part => part.Raw)), 0);
        var output = new StringBuilder();
        var matchIndex = 0;
        var lastInserted = -1;
        foreach (var part in _parts)
        {
            if (part.Text.Length == 0)
            {
                output.Append(part.Raw);
                continue;
            }
            while (matchIndex < matches.Count &&
                matches[matchIndex].Index + matches[matchIndex].Length < part.Start)
                matchIndex++;
            var changed = ReplacePart(part, matches, matchIndex, replacement, ref lastInserted);
            output.Append(changed);
        }
        if (lastInserted < matches.Count - 1)
            output.Append(WebUtility.HtmlEncode(replacement));
        return (output.ToString(), matches.Count);
    }

    private static string ReplacePart(Part part, IReadOnlyList<Match> matches, int firstMatch,
        string replacement, ref int lastInserted)
    {
        var text = new StringBuilder();
        var cursor = 0;
        var changed = false;
        var end = part.Start + part.Text.Length;
        for (var i = firstMatch; i < matches.Count && matches[i].Index <= end; i++)
        {
            var match = matches[i];
            if (match.Index == end && match.Length > 0) break;
            var matchEnd = match.Index + match.Length;
            if (matchEnd <= part.Start && match.Length > 0) continue;
            var start = Math.Clamp(match.Index - part.Start, 0, part.Text.Length);
            var stop = Math.Clamp(matchEnd - part.Start, start, part.Text.Length);
            text.Append(part.Text, cursor, start - cursor);
            if (i > lastInserted)
            {
                text.Append(replacement);
                lastInserted = i;
            }
            cursor = stop;
            changed = true;
        }
        if (!changed) return part.Raw;
        text.Append(part.Text, cursor, part.Text.Length - cursor);
        return part.Markup
            ? WebUtility.HtmlEncode(text.ToString().Replace("\n", string.Empty)) + part.Raw
            : WebUtility.HtmlEncode(text.ToString());
    }
}
