using Interop.UIAutomationClient;
using static Dtf.Native;

namespace Dtf;

/// <summary>
/// Popup menus as Windows actually implements them.
///
/// AppKit parents an open menu under the item that opened it, and the
/// framework's TrayPopup and menu code rely on that shape. Windows does not: a
/// Win32 menu opens a separate top-level `#32768` window, and a WinForms
/// ToolStripDropDown opens a top-level tool window of its own. UIA neither
/// lists those under the item nor, for `#32768`, under the desktop root — the
/// one reliable way to find them is Win32 enumeration by owner process. This
/// class finds them and matches each to the item that opened it by geometry,
/// so the rest of the helper can present the AppKit shape.
/// </summary>
static class Popups
{
    static bool IsMenuClass(string cls) => cls == "#32768" || cls.StartsWith("WindowsForms10.Window", StringComparison.Ordinal) || cls.Contains("Popup", StringComparison.OrdinalIgnoreCase);

    /// <summary>Visible popup-menu windows of a process, topmost first.</summary>
    public static List<IntPtr> Windows(uint pid)
    {
        var out_ = new List<IntPtr>();
        foreach (var h in TopLevelWindows())
        {
            if (Pid(h) != pid || !IsWindowVisible(h)) continue;
            var cls = ClassName(h);
            if (cls == "#32768") { out_.Add(h); continue; }
            // Non-Win32 menus: a visible tool window without a caption whose
            // UIA control type is Menu (ToolStripDropDown, WPF Popup, Chromium).
            if ((ExStyle(h) & WS_EX_TOOLWINDOW) != 0 && (Style(h) & WS_CAPTION) != WS_CAPTION)
            {
                var el = Uia.FromHandle(h);
                if (el != null && Uia.Int(el, P.ControlType) == CT.Menu) out_.Add(h);
            }
        }
        return out_;
    }

    public static IUIAutomationElement? Element(IntPtr hwnd) => Uia.FromHandle(hwnd);

    /// <summary>
    /// The open popup that belongs to `item`: the one whose top-left sits just
    /// below (menu bar) or just right of (submenu) the item, and which does not
    /// itself contain the item.
    /// </summary>
    public static IntPtr ForItem(Props item)
    {
        if (item.Rect is not Rect r || item.Pid == 0) return IntPtr.Zero;
        var own = item.Hwnd != IntPtr.Zero ? GetAncestor(item.Hwnd, GA_ROOT) : IntPtr.Zero;
        IntPtr best = IntPtr.Zero; double bestScore = double.MaxValue;
        foreach (var h in Windows(item.Pid))
        {
            if (h == own) continue;
            GetWindowRect(h, out var w);
            // Distance from the item's bottom-left (menu bar case) or top-right
            // (submenu case) corner to the popup's top-left corner.
            var below = Math.Abs(w.left - r.X) + Math.Abs(w.top - (r.Y + r.Height));
            var right = Math.Abs(w.left - (r.X + r.Width)) + Math.Abs(w.top - r.Y);
            var score = Math.Min(below, right);
            // Submenus can overlap their parent slightly; keep it generous.
            if (score < bestScore && score < 80) { bestScore = score; best = h; }
        }
        return best;
    }

    /// <summary>All open popups as nodes, for the application root.</summary>
    public static List<Node> Nodes(uint pid)
    {
        var out_ = new List<Node>();
        foreach (var h in Windows(pid))
        {
            var el = Element(h);
            if (el != null) out_.Add(new ElementNode(el));
        }
        return out_;
    }
}
