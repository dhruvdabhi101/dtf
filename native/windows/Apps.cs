using System.Diagnostics;
using Interop.UIAutomationClient;
using static Dtf.Native;

namespace Dtf;

/// <summary>
/// Processes as applications, and their top-level windows.
///
/// Windows has no NSRunningApplication. An "app" here is a process that owns a
/// top-level window (or a tray icon), named from its executable's version
/// resource, and identified by its AppUserModelID when it set one and by its
/// executable path otherwise — the closest thing to a bundle id that exists.
/// </summary>
static class Apps
{
    static readonly Dictionary<string, (string name, string company)> VersionCache = new(StringComparer.OrdinalIgnoreCase);

    public static string? Path(uint pid) => ProcessPath(pid);

    /// <summary>Display name: the exe's FileDescription (what the Task Manager shows), else ProductName, else the file name.</summary>
    public static string Name(uint pid)
    {
        var path = Path(pid);
        if (path == null)
        {
            try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
        }
        lock (VersionCache)
        {
            if (!VersionCache.TryGetValue(path, out var v))
            {
                string name = System.IO.Path.GetFileNameWithoutExtension(path), company = "";
                try
                {
                    var info = FileVersionInfo.GetVersionInfo(path);
                    var desc = info.FileDescription?.Trim();
                    var prod = info.ProductName?.Trim();
                    if (!string.IsNullOrEmpty(desc)) name = desc;
                    else if (!string.IsNullOrEmpty(prod)) name = prod;
                    company = info.CompanyName ?? "";
                }
                catch { }
                v = (name, company);
                VersionCache[path] = v;
            }
            return v.name;
        }
    }

    /// <summary>AUMID if any window of the process carries one, else the executable path.</summary>
    public static string BundleId(uint pid, IEnumerable<IntPtr>? windows = null)
    {
        foreach (var h in windows ?? Windows(pid, includeHidden: true))
        {
            var aumid = WindowAumid(h);
            if (!string.IsNullOrEmpty(aumid)) return aumid;
        }
        return Path(pid) ?? "";
    }

    public static bool IsRunning(uint pid)
    {
        try { return !Process.GetProcessById((int)pid).HasExited; } catch { return false; }
    }

    // ── Windows ─────────────────────────────────────────────────────────────

    static readonly HashSet<string> NeverAWindow = new(StringComparer.Ordinal)
    {
        "#32768", "tooltips_class32", "IME", "MSCTFIME UI", "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
        "Windows.UI.Core.CoreWindow", "ForegroundStaging", "MultitaskingViewFrame", "XamlExplorerHostIslandWindow",
    };

    /// <summary>
    /// The windows a user would call windows: visible, not cloaked, not a tool
    /// window, not a menu or tooltip. `includeHidden` widens to everything the
    /// process owns, for identity lookups.
    /// </summary>
    public static List<IntPtr> Windows(uint pid, bool includeHidden = false, bool includeTools = false)
    {
        var out_ = new List<IntPtr>();
        foreach (var h in TopLevelWindows())
        {
            if (Pid(h) != pid) continue;
            if (includeHidden) { out_.Add(h); continue; }
            if (!IsWindowVisible(h) || IsCloaked(h)) continue;
            var cls = ClassName(h);
            if (NeverAWindow.Contains(cls)) continue;
            if (!includeTools && (ExStyle(h) & WS_EX_TOOLWINDOW) != 0) continue;
            GetWindowRect(h, out var r);
            if (!includeTools && r.Width <= 0 && r.Height <= 0) continue;
            out_.Add(h);
        }
        return out_;
    }

    /// <summary>Every top-level window, visible or not, across processes (z-order, topmost first).</summary>
    public static List<IntPtr> AllVisibleWindows(bool includeTools = true)
    {
        var out_ = new List<IntPtr>();
        foreach (var h in TopLevelWindows())
        {
            if (!IsWindowVisible(h) || IsCloaked(h)) continue;
            if (!includeTools && (ExStyle(h) & WS_EX_TOOLWINDOW) != 0) continue;
            out_.Add(h);
        }
        return out_;
    }

    public static bool IsDialogWindow(IntPtr h)
    {
        var cls = ClassName(h);
        if (cls == "#32770") return true;
        // A modal dialog disables its owner while it is up; that is the one
        // reliable signal for WinForms/WPF dialogs, which use ordinary classes.
        var owner = GetWindow(h, GW_OWNER);
        if (owner != IntPtr.Zero && IsWindowVisible(owner) && !IsWindowEnabled(owner)) return true;
        return false;
    }

    // ── Processes with UI ───────────────────────────────────────────────────

    public static List<Dictionary<string, object?>> List()
    {
        var byPid = new Dictionary<uint, List<IntPtr>>();
        foreach (var h in TopLevelWindows())
        {
            if (!IsWindowVisible(h) || IsCloaked(h)) continue;
            var pid = Pid(h);
            if (!byPid.TryGetValue(pid, out var l)) byPid[pid] = l = new List<IntPtr>();
            l.Add(h);
        }
        foreach (var t in Tray.Items(null)) if (t.Pid != 0 && !byPid.ContainsKey(t.Pid)) byPid[t.Pid] = new List<IntPtr>();

        var fg = Pid(GetForegroundWindow());
        var out_ = new List<Dictionary<string, object?>>();
        foreach (var (pid, wins) in byPid)
        {
            if (pid == 0) continue;
            var regular = wins.Any(h => (ExStyle(h) & WS_EX_TOOLWINDOW) == 0 && !NeverAWindow.Contains(ClassName(h)) && (Style(h) & WS_CAPTION) == WS_CAPTION);
            out_.Add(new()
            {
                ["pid"] = (int)pid,
                ["name"] = Name(pid),
                ["bundleId"] = BundleId(pid, wins),
                ["active"] = pid == fg,
                ["hidden"] = false,
                ["policy"] = regular ? "regular" : "accessory",
            });
        }
        return out_;
    }

    public static Dictionary<string, object?> Info(uint pid)
    {
        if (!IsRunning(pid)) throw new OpError("noApp", $"no running app with pid {pid}");
        var wins = Windows(pid);
        return new()
        {
            ["pid"] = (int)pid,
            ["name"] = Name(pid),
            ["bundleId"] = BundleId(pid),
            ["active"] = Pid(GetForegroundWindow()) == pid,
            ["hidden"] = false,
            ["terminated"] = false,
            ["windowCount"] = wins.Count,
            ["hasMenuBarExtra"] = Tray.Items(pid).Count > 0,
        };
    }

    public static List<Dictionary<string, object?>> Find(string? bundleId, string? name)
    {
        return List().Where(a =>
        {
            if (bundleId != null && !string.Equals((string?)a["bundleId"], bundleId, StringComparison.OrdinalIgnoreCase)) return false;
            if (name != null && !string.Equals((string?)a["name"], name, StringComparison.OrdinalIgnoreCase)) return false;
            return true;
        }).ToList();
    }

    /// <summary>
    /// Brings a process's main window to the front.
    ///
    /// SetForegroundWindow is refused unless the caller owns the foreground or
    /// recently received input. The reliable sequence is: restore if minimised,
    /// tap Alt so this process counts as "last input", then attach to the
    /// foreground thread's input queue and switch.
    /// </summary>
    public static bool Activate(uint pid)
    {
        var wins = Windows(pid);
        if (wins.Count == 0) return false;
        return ActivateWindow(wins.FirstOrDefault(h => GetWindow(h, GW_OWNER) == IntPtr.Zero, wins[0]));
    }

    /// <summary>Brings one window to the foreground, past the foreground lock if need be. True if it got there.</summary>
    public static bool ActivateWindow(IntPtr target)
    {
        if (IsIconic(target)) ShowWindow(target, SW_RESTORE);
        if (GetForegroundWindow() == target) return true;

        SetForegroundWindow(target);
        if (GetForegroundWindow() == target) return true;

        Input.Key("alt");
        SetForegroundWindow(target);
        if (GetForegroundWindow() == target) return true;

        var fg = GetForegroundWindow();
        var fgTid = fg == IntPtr.Zero ? 0 : Tid(fg);
        var me = GetCurrentThreadId();
        if (fgTid != 0 && fgTid != me) AttachThreadInput(me, fgTid, true);
        try
        {
            BringWindowToTop(target);
            SetForegroundWindow(target);
        }
        finally { if (fgTid != 0 && fgTid != me) AttachThreadInput(me, fgTid, false); }
        return GetForegroundWindow() == target;
    }

    public static bool Hide(uint pid)
    {
        var any = false;
        foreach (var h in Windows(pid)) { ShowWindow(h, SW_MINIMIZE); any = true; }
        return any;
    }

    /// <summary>
    /// Asks a process to quit. There is no Quit message on Windows; WM_CLOSE on
    /// each window plus WM_QUIT to each UI thread is what a user's "close"
    /// and Task Manager's "end task" add up to. A tray app that hides on close
    /// survives this, exactly as on macOS, and the caller escalates to kill.
    /// </summary>
    public static bool Terminate(uint pid, bool force)
    {
        if (!IsRunning(pid)) return true;
        if (force)
        {
            try { Process.GetProcessById((int)pid).Kill(true); return true; } catch { return false; }
        }
        var threads = new HashSet<uint>();
        foreach (var h in Windows(pid, includeHidden: true))
        {
            if (IsWindowVisible(h)) PostMessageW(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            threads.Add(Tid(h));
        }
        foreach (var t in threads) PostThreadMessageW(t, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        return true;
    }

    // ── Window records ──────────────────────────────────────────────────────

    public static List<Dictionary<string, object?>> WindowList(uint pid)
    {
        var out_ = new List<Dictionary<string, object?>>();
        var fg = GetForegroundWindow();
        var wins = Windows(pid);
        // The "main" window: the foreground one if it belongs to the app, else
        // the topmost un-owned window in z-order.
        var main = wins.Contains(fg) ? fg : wins.FirstOrDefault(h => GetWindow(h, GW_OWNER) == IntPtr.Zero, wins.Count > 0 ? wins[0] : IntPtr.Zero);
        int i = 0;
        foreach (var h in wins)
        {
            var el = Uia.FromHandle(h);
            if (el == null) continue;
            GetWindowRect(h, out var r);
            var isDialog = IsDialogWindow(h) || Uia.Bool(el, P.IsDialog) == true;
            out_.Add(new()
            {
                ["index"] = i++,
                ["ref"] = Registry.Shared.Put(el),
                ["title"] = WindowText(h),
                ["subrole"] = isDialog ? "AXDialog" : "AXStandardWindow",
                ["minimized"] = IsIconic(h),
                ["main"] = h == main,
                ["focused"] = h == fg,
                ["rect"] = new Rect(r.left, r.top, r.Width, r.Height).ToJson(),
                ["windowId"] = h.ToInt64(),
            });
        }
        return out_;
    }

    /// <summary>The HWND behind an element: its own, else the nearest ancestor's.</summary>
    public static IntPtr HwndOf(IUIAutomationElement e)
    {
        var cur = e;
        for (int i = 0; i < 40 && cur != null; i++)
        {
            var h = new IntPtr(Uia.Int(cur, P.NativeWindowHandle) ?? 0);
            if (h != IntPtr.Zero) return h;
            cur = Uia.Parent(cur);
        }
        return IntPtr.Zero;
    }

    /// <summary>The top-level HWND that contains an element.</summary>
    public static IntPtr TopLevelHwndOf(IUIAutomationElement e)
    {
        var h = HwndOf(e);
        return h == IntPtr.Zero ? IntPtr.Zero : GetAncestor(h, GA_ROOT);
    }
}
