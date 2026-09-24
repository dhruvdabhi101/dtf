using System.Diagnostics;
using Interop.UIAutomationClient;
using static Dtf.Native;

namespace Dtf;

sealed class Toast
{
    public IUIAutomationElement Root = null!;
    public IntPtr Hwnd;
    public string App = "", Title = "", Subtitle = "", Body = "", Raw = "";
    public List<string> Texts = new();
    public List<(IUIAutomationElement el, string title, string id)> Buttons = new();
    public Rect? Rect;
}

/// <summary>
/// Toast notifications, read live from the shell's notification host through
/// UIA — the same approach as macOS, for the same reason: it reflects what the
/// user actually saw, and Focus Assist suppression is visible rather than
/// silent. (wpndatabase.db has richer history but is locked while the
/// notification service runs, and holds XML payloads, not rendered text.)
///
/// The host window is a `Windows.UI.Core.CoreWindow` titled "New notification"
/// owned by ShellExperienceHost. It sits in the immersive-notification z-band,
/// which EnumWindows does not enumerate (it only walks the desktop band) and
/// UIA does not list under the desktop root. FindWindow does see it, so that
/// is how it is located. Inside, each toast is a Window element whose
/// AutomationId ends in "ToastView", with SenderName / Title / MessageText
/// texts and Settings / Dismiss buttons.
/// </summary>
static class Notifications
{
    static readonly HashSet<string> HostProcesses = new(StringComparer.OrdinalIgnoreCase) { "ShellExperienceHost", "ShellHost", "explorer" };

    static bool IsHostPid(uint pid)
    {
        try { using var p = Process.GetProcessById((int)pid); return HostProcesses.Contains(p.ProcessName); }
        catch { return false; }
    }

    public static bool IsToastWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd)) return false;
        if (ClassName(hwnd) != "Windows.UI.Core.CoreWindow") return false;
        // "New notification" in English; fall back to the owning process for other locales.
        return WindowText(hwnd).Contains("notification", StringComparison.OrdinalIgnoreCase) || IsHostPid(Pid(hwnd));
    }

    public static bool IsToastRoot(Props p) => p.Identifier != null && p.Identifier.EndsWith("ToastView", StringComparison.Ordinal);

    /// <summary>Every visible toast host window, found through FindWindow because EnumWindows cannot see its z-band.</summary>
    static List<IntPtr> HostWindows()
    {
        var out_ = new List<IntPtr>();
        var h = IntPtr.Zero;
        for (int i = 0; i < 64; i++)
        {
            h = FindWindowExW(IntPtr.Zero, h, "Windows.UI.Core.CoreWindow", null);
            if (h == IntPtr.Zero) break;
            if (IsToastWindow(h) && !IsCloaked(h)) out_.Add(h);
        }
        return out_;
    }

    static List<Toast> Read()
    {
        var out_ = new List<Toast>();
        foreach (var h in HostWindows())
        {
            var el = Uia.FromHandle(h);
            if (el == null) continue;
            var roots = new List<Node>();
            Walk.Run(new ElementNode(el), 8, 2000, (n, d) =>
            {
                if (d > 0 && IsToastRoot(n.Props) && n.Element != null) { roots.Add(n); return Step.SkipChildren; }
                return Step.Continue;
            });
            foreach (var r in roots)
            {
                var t = Parse(r, h);
                if (t != null) out_.Add(t);
            }
        }
        return out_;
    }

    static Toast? Parse(Node root, IntPtr hwnd)
    {
        string? sender = null, title = null, message = null;
        var others = new List<string>();
        var buttons = new List<(IUIAutomationElement, string, string)>();
        Walk.Run(root, 8, 1500, (n, d) =>
        {
            if (d == 0) return true;
            var p = n.Props;
            if (p.ControlType == CT.Text && !string.IsNullOrEmpty(p.Title))
            {
                switch (p.Identifier)
                {
                    case "SenderName": sender = p.Title; break;
                    case "Title": title = p.Title; break;
                    case "MessageText": message = p.Title; break;
                    default: others.Add(p.Title!); break;
                }
            }
            else if (p.ControlType == CT.Button && n.Element != null) buttons.Add((n.Element, p.Label, p.Identifier ?? ""));
            return true;
        });
        if (sender == null && title == null && message == null && others.Count == 0) return null;

        // MessageText carries subtitle and body as separate lines.
        var lines = (message ?? "").Split('\n').Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
        var texts = new List<string>();
        if (title != null) texts.Add(title);
        texts.AddRange(lines);
        texts.AddRange(others.Where(o => !IsTimestamp(o)));
        return new Toast
        {
            Root = root.Element!, Hwnd = hwnd, Rect = root.Props.Rect,
            App = sender ?? "",
            Title = title ?? (texts.Count > 0 ? texts[0] : ""),
            Subtitle = lines.Count > 1 ? lines[0] : "",
            Body = lines.Count > 1 ? lines[^1] : (lines.Count == 1 ? lines[0] : ""),
            Texts = texts,
            Raw = root.Props.Title ?? string.Join(", ", texts),
            Buttons = buttons,
        };
    }

    static bool IsTimestamp(string s) => s.Length <= 12 && (s.Equals("now", StringComparison.OrdinalIgnoreCase) || s.Equals("Just now", StringComparison.OrdinalIgnoreCase)
        || System.Text.RegularExpressions.Regex.IsMatch(s, @"^\d+\s*(m|h|d|min|hr|sec|s)\b|^\d{1,2}:\d{2}"));

    /// <summary>The toast a recorded click landed in, matched by geometry.</summary>
    public static Toast? ToastFor(IUIAutomationElement e, List<Props> chain)
    {
        var all = Read();
        var rootProps = chain.FirstOrDefault(IsToastRoot);
        if (rootProps?.Rect is Rect r)
        {
            var hit = all.FirstOrDefault(t => t.Rect is Rect tr && Math.Abs(tr.X - r.X) < 3 && Math.Abs(tr.Y - r.Y) < 3);
            if (hit != null) return hit;
        }
        var top = Apps.TopLevelHwndOf(e);
        return all.FirstOrDefault(t => t.Hwnd == top) ?? all.FirstOrDefault();
    }

    public static List<Dictionary<string, object?>> List()
    {
        var out_ = new List<Dictionary<string, object?>>();
        foreach (var t in Read())
        {
            out_.Add(new()
            {
                ["ref"] = Registry.Shared.Put(t.Root),
                ["index"] = out_.Count,
                ["app"] = t.App,
                ["title"] = t.Title,
                ["subtitle"] = t.Subtitle,
                ["body"] = t.Body,
                ["texts"] = t.Texts,
                ["raw"] = t.Raw,
                ["buttons"] = t.Buttons.Select(b => (object?)new Dictionary<string, object?> { ["ref"] = Registry.Shared.Put(b.el), ["title"] = b.title }).ToList(),
                ["actions"] = new List<string> { "AXPress" },
            });
        }
        return out_;
    }

    static bool IsClose((IUIAutomationElement el, string title, string id) b) =>
        b.id == "DismissButton" || b.title.Contains("Dismiss", StringComparison.OrdinalIgnoreCase)
        || b.title.Contains("Close", StringComparison.OrdinalIgnoreCase) || b.title.Contains("Notification Center", StringComparison.OrdinalIgnoreCase);

    public static Dictionary<string, object?> Act(Args a)
    {
        var list = Read();
        var idx = a.Int("index") ?? 0;
        if (idx >= list.Count) throw new OpError("noNotification", $"no notification at index {idx} ({list.Count} visible)");
        var t = list[idx];
        var action = a.Str("action") ?? "press";

        switch (action)
        {
            case "press":
            case "click":
            {
                // Toasts respond to a real click; Invoke on the container does nothing.
                if (t.Rect is not Rect r) throw new OpError("noGeometry", "notification is not on screen");
                // Aim at the text, not the centre, which can land on a button.
                Input.Click(r.X + Math.Min(r.Width * 0.35, 120), r.Y + r.Height * 0.6);
                return new() { ["ok"] = true };
            }
            case "close":
            case "dismiss":
            {
                var btn = t.Buttons.FirstOrDefault(IsClose);
                if (btn.el == null)
                {
                    // Some toast layouts only render the controls on hover.
                    if (t.Rect is Rect r) { Input.Move(r.Center.x, r.Center.y); Thread.Sleep(350); }
                    var refreshed = Read();
                    if (idx >= refreshed.Count) return new() { ["ok"] = true, ["alreadyGone"] = true };
                    btn = refreshed[idx].Buttons.FirstOrDefault(IsClose);
                }
                if (btn.el != null) { Elements.Perform(btn.el, "AXPress"); return new() { ["ok"] = true }; }
                throw new OpError("noCloseButton", $"no close button on notification {idx}; buttons: [{string.Join(", ", t.Buttons.Select(b => b.title))}]");
            }
            default:
            {
                var btn = t.Buttons.FirstOrDefault(b => b.title.Equals(action, StringComparison.OrdinalIgnoreCase));
                if (btn.el == null)
                {
                    if (t.Rect is Rect r) { Input.Move(r.Center.x, r.Center.y); Thread.Sleep(350); }
                    var refreshed = Read();
                    if (idx >= refreshed.Count) throw new OpError("noNotification", "notification disappeared");
                    btn = refreshed[idx].Buttons.FirstOrDefault(b => b.title.Equals(action, StringComparison.OrdinalIgnoreCase));
                    if (btn.el == null) throw new OpError("noButton", $"no notification button '{action}'; available: [{string.Join(", ", refreshed[idx].Buttons.Select(b => b.title))}]");
                }
                Elements.Perform(btn.el, "AXPress");
                return new() { ["ok"] = true };
            }
        }
    }
}
