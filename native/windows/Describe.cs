using Interop.UIAutomationClient;
using static Dtf.Native;

namespace Dtf;

/// <summary>
/// Full description of an interacted element: identity, ancestry, owning app,
/// and which OS surface it lives on — the ElementContext the recorder and
/// `element.atPoint` return. This is the platform-neutral contract with the
/// Node side; here it is decided from window classes, the taskbar's UIA tree
/// and the shell's notification host.
/// </summary>
static class Describe
{
    /// <summary>Ancestors, closest first, up to but excluding the desktop root.</summary>
    public static List<IUIAutomationElement> Ancestors(IUIAutomationElement e, int max = 40)
    {
        var out_ = new List<IUIAutomationElement>();
        var cur = Uia.Parent(e);
        while (cur != null && out_.Count < max)
        {
            // The desktop root (Pane "Desktop N", pid of explorer) plays the
            // part of the application element on macOS: dropped.
            if (Uia.Int(cur, P.NativeWindowHandle) is int h && h != 0 && GetAncestor(new IntPtr(h), GA_ROOT) == new IntPtr(h) && ClassName(new IntPtr(h)) == "#32769") break;
            if (Uia.Str(cur, P.ClassName) == "#32769") break;
            out_.Add(cur);
            cur = Uia.Parent(cur);
        }
        return out_;
    }

    static List<string> Texts(Node root, int maxDepth = 10, int limit = 8)
    {
        var texts = new List<string>();
        Walk.Run(root, maxDepth, 3000, (n, _) =>
        {
            if (n.Props.ControlType == CT.Text && n.Props.Title is string t && t.Length > 0) texts.Add(t);
            return texts.Count < limit;
        });
        return texts;
    }

    public static Dictionary<string, object?> Element(IUIAutomationElement e)
    {
        var props = Props.Read(e, null);
        var out_ = new Dictionary<string, object?> { ["element"] = props.Summary() };

        var ancestors = Ancestors(e);
        var ancProps = ancestors.Select(a => Props.Read(a, null)).ToList();
        out_["ancestors"] = ancProps.Select(a => a.Summary()).ToList();

        var pid = props.Pid != 0 ? props.Pid : ancProps.Select(a => a.Pid).FirstOrDefault(p => p != 0);
        out_["pid"] = (int)pid;
        out_["app"] = Apps.Name(pid);
        out_["bundleId"] = Apps.BundleId(pid);

        var hwnd = Apps.HwndOf(e);
        var top = hwnd == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hwnd, GA_ROOT);
        var topClass = top == IntPtr.Zero ? "" : ClassName(top);
        var chain = new List<Props> { props }; chain.AddRange(ancProps);

        // ── Notification toast ──────────────────────────────────────────
        if (Notifications.IsToastWindow(top) || chain.Any(c => Notifications.IsToastRoot(c)))
        {
            out_["surface"] = "notification";
            var toast = Notifications.ToastFor(e, chain);
            if (toast != null) out_["notification"] = new Dictionary<string, object?> { ["raw"] = toast.Raw, ["texts"] = toast.Texts };
            return out_;
        }

        // ── Tray icon ───────────────────────────────────────────────────
        var trayHit = chain.FirstOrDefault(Tray.IsIconProps);
        if (trayHit != null)
        {
            out_["surface"] = "tray";
            var item = Tray.Resolve(trayHit);
            if (item != null)
            {
                // The icon is drawn by Explorer, but the click belongs to the
                // app that owns it; the recorder scopes events by this pid.
                if (item.Pid != 0) { out_["pid"] = (int)item.Pid; out_["app"] = item.App; out_["bundleId"] = item.BundleId; }
                out_["trayItem"] = Tray.Summary(item);
            }
            else out_["trayItem"] = trayHit.Summary();
            return out_;
        }

        // ── Menus ───────────────────────────────────────────────────────
        // A popup menu is its own top-level window. Which surface it is
        // (tray menu, menu bar dropdown, context menu) depends on what opened
        // it, which only the recorder knows; it refines this afterwards.
        var inPopup = topClass == "#32768" || chain.Any(c => c.ControlType == CT.Menu && c.Hwnd == top && top != IntPtr.Zero)
            || (top != IntPtr.Zero && Popups.Windows(pid).Contains(top));
        var menuPath = chain.Where(c => c.ControlType == CT.MenuItem).Select(c => c.Label).Reverse().ToList();
        if (chain.Any(c => c.ControlType == CT.MenuBar))
        {
            out_["surface"] = "menuBar";
            out_["menuPath"] = menuPath;
            return out_;
        }
        if (inPopup)
        {
            out_["surface"] = "contextMenu";
            out_["menuPath"] = menuPath;
            return out_;
        }

        // ── Windows and dialogs ─────────────────────────────────────────
        var win = chain.FirstOrDefault(c => c.ControlType == CT.Window) ?? (top != IntPtr.Zero ? Props.Read(Uia.FromHandle(top)!, null) : null);
        if (win != null) out_["window"] = win.Summary();

        if (top != IntPtr.Zero && (Apps.IsDialogWindow(top) || (win != null && win.Subrole == "AXDialog")))
        {
            out_["surface"] = "dialog";
            var rootEl = Uia.FromHandle(top);
            var root = rootEl != null ? new ElementNode(rootEl) : null;
            var kind = root != null && IsFilePicker(root) ? "filePanel" : "dialog";
            out_["dialog"] = new Dictionary<string, object?>
            {
                ["kind"] = kind,
                ["title"] = WindowText(top),
                ["texts"] = root != null ? Texts(root) : new List<string>(),
            };
            return out_;
        }

        out_["surface"] = win != null ? "window" : "unknown";
        return out_;
    }

    /// <summary>IFileDialog leaves a stable fingerprint: the filename box host and the DirectUI view.</summary>
    public static bool IsFilePicker(Node dialogRoot)
    {
        bool hit = false;
        Walk.Run(dialogRoot, 6, 800, (n, _) =>
        {
            var p = n.Props;
            if (p.Identifier == "FileNameControlHost" || p.ClassName == "DUIViewWndClassName" || p.Identifier == "1001" && p.ControlType == CT.Edit)
            { hit = true; return false; }
            return true;
        });
        return hit;
    }

    /// <summary>A `Dialog` record for a dialog window, or null if the window is not one after all.</summary>
    public static Dictionary<string, object?>? DialogEntry(IUIAutomationElement el, IntPtr hwnd)
    {
        var root = new ElementNode(el);
        var pid = Pid(hwnd);
        var buttons = new List<object?>();
        var texts = new List<string>();
        Walk.Run(root, 10, 3000, (n, d) =>
        {
            var p = n.Props;
            // Title-bar buttons are chrome, not choices; skip that subtree.
            if (p.ControlType == CT.TitleBar) return Step.SkipChildren;
            if (p.ControlType == CT.Button && n.Element != null)
            {
                buttons.Add(new Dictionary<string, object?> { ["ref"] = Registry.Shared.Put(n.Element), ["title"] = p.Label, ["enabled"] = p.Enabled ?? true });
            }
            else if (p.ControlType == CT.Text && p.Title is string t && t.Length > 0) texts.Add(t);
            return Step.Continue;
        });
        var kind = IsFilePicker(root) ? "filePanel" : "dialog";
        return new()
        {
            ["kind"] = kind,
            ["ref"] = Registry.Shared.Put(el),
            ["pid"] = (int)pid,
            ["app"] = Apps.Name(pid),
            ["bundleId"] = Apps.BundleId(pid),
            ["title"] = WindowText(hwnd),
            ["subrole"] = "AXDialog",
            ["buttons"] = buttons,
            ["texts"] = texts,
            ["root"] = new Serializer(new SerializeOptions { MaxDepth = 8, MaxNodes = 1200 }).Node(root),
        };
    }
}
