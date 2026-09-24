using System.Text.Json;
using System.Text.RegularExpressions;

namespace Dtf;

/// <summary>
/// A single predicate over one element — a straight port of Selector.swift.
///
/// Everything is optional and ANDed together. `text` is the loose escape hatch:
/// it matches if any of title/value/description/help/placeholder contains the
/// substring, which is what you want for the many controls that put their label
/// in a different attribute than you'd guess.
/// </summary>
sealed class Selector
{
    public string? Role, Subrole, Title, TitleContains, TitleMatch, Description, DescriptionContains, Value, ValueContains,
        Identifier, Help, HelpContains, Text;
    public bool? Enabled, Focused;
    public int? Nth;
    public int MaxDepth = 20;

    public Selector(JsonElement d)
    {
        string? S(string k) => d.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        bool? B(string k) => d.TryGetProperty(k, out var v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False) ? v.GetBoolean() : null;
        int? I(string k) => d.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : null;
        Role = S("role"); Subrole = S("subrole"); Title = S("title"); TitleContains = S("titleContains"); TitleMatch = S("titleMatch");
        Description = S("description"); DescriptionContains = S("descriptionContains"); Value = S("value"); ValueContains = S("valueContains");
        Identifier = S("identifier"); Help = S("help"); HelpContains = S("helpContains"); Text = S("text");
        Enabled = B("enabled"); Focused = B("focused"); Nth = I("nth");
        if (I("maxDepth") is int md) MaxDepth = md;
    }

    static string? ValueString(Props p) => p.Value switch { null => null, string s => s, var o => Convert.ToString(o, System.Globalization.CultureInfo.InvariantCulture) };

    public bool Matches(Props p)
    {
        if (Role != null && p.Role != Role) return false;
        if (Subrole != null && p.Subrole != Subrole) return false;
        if (Title != null && p.Title != Title) return false;
        if (TitleContains != null && !Uia.Ci(p.Title, TitleContains)) return false;
        if (TitleMatch != null)
        {
            try { if (!Regex.IsMatch(p.Title ?? "", TitleMatch)) return false; }
            catch { return false; }
        }
        if (Description != null && p.Description != Description) return false;
        if (DescriptionContains != null && !Uia.Ci(p.Description, DescriptionContains)) return false;
        var val = ValueString(p);
        if (Value != null && val != Value) return false;
        if (ValueContains != null && !Uia.Ci(val, ValueContains)) return false;
        if (Identifier != null && p.Identifier != Identifier) return false;
        if (Help != null && p.Help != Help) return false;
        if (HelpContains != null && !Uia.Ci(p.Help, HelpContains)) return false;
        if (Enabled is bool en && (p.Enabled ?? true) != en) return false;
        if (Focused is bool f && (p.Focused ?? false) != f) return false;
        if (Text != null)
        {
            var hit = Uia.Ci(p.Title, Text) || Uia.Ci(val, Text) || Uia.Ci(p.Description, Text)
                || Uia.Ci(p.Help, Text) || Uia.Ci(p.Placeholder, Text);
            if (!hit) return false;
        }
        return true;
    }

    public static List<Selector> ParsePath(JsonElement arg)
    {
        var out_ = new List<Selector>();
        if (arg.ValueKind == JsonValueKind.Array)
        {
            foreach (var x in arg.EnumerateArray()) if (x.ValueKind == JsonValueKind.Object) out_.Add(new Selector(x));
        }
        else if (arg.ValueKind == JsonValueKind.Object) out_.Add(new Selector(arg));
        return out_;
    }
}

static class Find
{
    /// <summary>Every descendant of `root` matching `sel` (root itself included).</summary>
    public static List<Node> All(Node root, Selector sel, int limit = 200)
    {
        var found = new List<Node>();
        Walk.Run(root, sel.MaxDepth, (n, _) =>
        {
            if (sel.Matches(n.Props))
            {
                found.Add(n);
                if (found.Count >= limit) return false;
            }
            return true;
        });
        return found;
    }

    /// <summary>
    /// Resolves a chained selector path. Each step searches within the previous
    /// match, so `[{role: AXWindow}, {role: AXButton, title: OK}]` scopes the
    /// button to the window.
    /// </summary>
    public static Node? Path(Node root, List<Selector> path)
    {
        var current = root;
        for (int i = 0; i < path.Count; i++)
        {
            var sel = path[i];
            var candidates = All(current, sel);
            // The first step may match the root itself; later steps must descend.
            var pool = i == 0 ? candidates : candidates.Where(c => !c.SameAs(current)).ToList();
            if (pool.Count == 0) return null;
            var idx = sel.Nth ?? 0;
            if (idx < 0 || idx >= pool.Count) return null;
            current = pool[idx];
        }
        return current;
    }
}
