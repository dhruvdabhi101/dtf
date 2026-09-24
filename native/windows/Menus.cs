using Interop.UIAutomationClient;

namespace Dtf;

/// <summary>
/// The application menu bar via UIA MenuBar/MenuItem.
///
/// Unlike AppKit, Windows does not publish a menu's items until the menu is
/// open: a collapsed MenuItem has no children. So reading the tree below the
/// top level means expanding each menu in turn and collapsing it again — it
/// flickers, briefly, and that is the price of a structural read. Clicking
/// walks the same way: expand, find, expand, ..., invoke the leaf.
/// </summary>
static class Menus
{
    /// <summary>The MenuBar element of the app's main window (first window that has one).</summary>
    static (IUIAutomationElement bar, IUIAutomationElement window)? FindBar(uint pid)
    {
        foreach (var h in Apps.Windows(pid))
        {
            var w = Uia.FromHandle(h);
            if (w == null) continue;
            // The menu bar is a direct child of the window (Win32, WinForms
            // MenuStrip docked at the top, WPF Menu) or one level down.
            var wn = new ElementNode(w);
            IUIAutomationElement? bar = null;
            Walk.Run(wn, 3, 400, (n, d) =>
            {
                if (n.Props.ControlType == CT.MenuBar && n.Element != null) { bar = n.Element; return Step.Stop; }
                // Do not descend into documents or lists looking for a menu bar.
                return d == 0 || n.Props.ControlType is CT.Pane or CT.Group or CT.Custom or CT.ToolBar ? Step.Continue : Step.SkipChildren;
            });
            if (bar != null) return (bar, w);
        }
        return null;
    }

    static bool Expand(IUIAutomationElement item)
    {
        var ec = Uia.Pattern<IUIAutomationExpandCollapsePattern>(item, Uia.ExpandCollapsePattern);
        if (ec != null)
        {
            try { ec.Expand(); return true; } catch { }
        }
        var inv = Uia.Pattern<IUIAutomationInvokePattern>(item, Uia.InvokePattern);
        if (inv != null)
        {
            try { inv.Invoke(); return true; } catch { }
        }
        return false;
    }

    static void Collapse(IUIAutomationElement item)
    {
        var ec = Uia.Pattern<IUIAutomationExpandCollapsePattern>(item, Uia.ExpandCollapsePattern);
        try { ec?.Collapse(); } catch { }
    }

    /// <summary>Waits for the menu an expanded item opened: its AXMenu child (UIA children or the grafted popup window).</summary>
    static Node? WaitForSubmenu(Node item, int timeoutMs = 2500)
    {
        return Ops.WaitFor(timeoutMs, () =>
        {
            var kids = item.Children();
            var menu = kids.FirstOrDefault(k => k.Props.Role == "AXMenu");
            if (menu != null && menu.Children().Count > 0) return menu;
            return null;
        }, 60);
    }

    public static Dictionary<string, object?> Tree(uint pid, int maxDepth)
    {
        var found = FindBar(pid) ?? throw new OpError("noMenuBar", $"app {pid} exposes no menu bar");
        var bar = new ElementNode(found.bar);
        var o = bar.Props.Summary();
        o["ref"] = bar.Ref();
        var tops = bar.Children();
        o["childCount"] = tops.Count;
        var kids = new List<object?>();
        foreach (var top in tops)
        {
            var t = top.Props.Summary();
            t["ref"] = top.Ref();
            if (top.Props.Actions.Count > 0) t["actions"] = top.Props.Actions;
            if (maxDepth >= 2 && top.Element != null && top.Props.Role == "AXMenuBarItem")
            {
                var ser = new Serializer(new SerializeOptions { MaxDepth = maxDepth - 2 });
                if (Expand(top.Element))
                {
                    var menu = WaitForSubmenu(top);
                    if (menu != null) t["children"] = new List<object?> { ser.Node(menu, 0) };
                    Collapse(top.Element);
                    // Belt and braces: a menu that stays open steals the next click.
                    if (Uia.Refresh(top.Element) is IUIAutomationElement re && Props.Read(re, null).ExpandState == 1) Input.Key("escape");
                }
            }
            else if (maxDepth >= 2) t["truncated"] = true;
            kids.Add(t);
        }
        if (kids.Count > 0) o["children"] = kids;
        return o;
    }

    public static Dictionary<string, object?> Click(uint pid, List<string> path)
    {
        if (path.Count == 0) throw new OpError("badArgs", "menu.click needs a non-empty 'path'");
        var found = FindBar(pid) ?? throw new OpError("noMenuBar", $"app {pid} exposes no menu bar");
        Apps.Activate(pid);
        Node container = new ElementNode(found.bar);
        var opened = new List<IUIAutomationElement>();
        try
        {
            for (int i = 0; i < path.Count; i++)
            {
                var title = path[i];
                var isLeaf = i == path.Count - 1;
                var kids = container.Children();
                var match = kids.FirstOrDefault(k => k.Props.Title == title)
                    ?? kids.FirstOrDefault(k => k.Props.Title != null && k.Props.Title.Replace("&", "") == title);
                if (match == null)
                {
                    var available = kids.Select(k => k.Props.Title).Where(t => !string.IsNullOrEmpty(t)).ToList();
                    throw new OpError("menuItemNotFound",
                        $"no menu item titled '{title}' at path {string.Join(" > ", path.Take(i + 1))}; available: [{string.Join(", ", available)}]");
                }
                if (match.Element == null) throw new OpError("menuItemNotFound", $"'{title}' is not a real menu item");
                if (isLeaf)
                {
                    if (match.Props.Enabled == false) throw new OpError("menuItemDisabled", $"menu item '{title}' is disabled");
                    Elements.Perform(match.Element, "AXPress");
                    opened.Clear();
                    return new() { ["ok"] = true, ["clicked"] = string.Join(" > ", path) };
                }
                if (!Expand(match.Element)) throw new OpError("actionFailed", $"could not open menu '{title}'");
                opened.Add(match.Element);
                container = WaitForSubmenu(match) ?? throw new OpError("menuItemNotFound", $"menu '{title}' opened but exposed no items");
            }
        }
        catch
        {
            // Leave nothing open: a stuck menu would swallow the next test's first click.
            for (int i = opened.Count - 1; i >= 0; i--) Collapse(opened[i]);
            if (opened.Count > 0) Input.Key("escape");
            throw;
        }
        throw new OpError("menuItemNotFound", "unreachable");
    }
}
