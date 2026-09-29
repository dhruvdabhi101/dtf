using System.Runtime.InteropServices;
using Interop.UIAutomationClient;

using static Dtf.Native;

namespace Dtf;

/// <summary>One notification-area icon, with whatever ownership information could be recovered.</summary>
sealed class TrayItem
{
    public IUIAutomationElement? Element;
    public Props? Props;
    public uint Pid;
    public string App = "", BundleId = "", Label = "";
    public string? Title, Help, Identifier, ExePath;
    public Rect? Rect;
    /// <summary>True for an icon that lives in the hidden overflow area and is not currently on screen.</summary>
    public bool Hidden;
}

/// <summary>Registry key for an icon that is known to exist but is not on screen (Windows 11 overflow, flyout closed).</summary>
sealed record HiddenTrayIcon(string Tooltip, string? ExePath);

/// <summary>
/// The notification area ("tray").
///
/// Structurally unlike macOS: icons are drawn by Explorer, not by the owning
/// app, so nothing in the app's own UIA tree knows about them. Two layouts:
///
///  * Windows 10 — `Shell_TrayWnd › TrayNotifyWnd › SysPager › ToolbarWindow32`
///    holds the visible icons and `NotifyIconOverflowWindow › ToolbarWindow32`
///    the hidden ones. The toolbar's TBBUTTON data (read out of Explorer's
///    memory) names the owning window and therefore the owning process.
///  * Windows 11 — a XAML taskbar. Icons are `Button` elements with
///    AutomationId `NotifyItemIcon`; hidden ones live in a flyout window
///    ("System tray overflow window.") that only exists while open. Ownership
///    comes from `HKCU\Control Panel\NotifyIconSettings`, which records each
///    icon's executable and its initial tooltip.
///
/// New apps land in the overflow by default on Windows 11. That is fatal for a
/// tray test (the icon has no on-screen rect and cannot be clicked), so when a
/// listing is scoped to a pid whose icon is hidden, the icon is *promoted* by
/// setting `IsPromoted` on its registry entry — the same bit the Settings app
/// flips — and Explorer moves it onto the taskbar within a second or so.
/// </summary>
static class Tray
{
    const string SettingsKey = @"Control Panel\NotifyIconSettings";

    // ── Enumeration ─────────────────────────────────────────────────────────

    public static List<TrayItem> Items(uint? pid)
    {
        var items = Enumerate();
        if (pid is uint p)
        {
            var mine = items.Where(i => i.Pid == p).ToList();
            if (mine.Any(i => i.Hidden) && Promote(p))
            {
                // Give Explorer a moment to re-lay out the taskbar, then re-read.
                var deadline = DateTime.UtcNow.AddMilliseconds(2500);
                while (DateTime.UtcNow < deadline)
                {
                    Thread.Sleep(200);
                    mine = Enumerate().Where(i => i.Pid == p).ToList();
                    if (mine.Count > 0 && mine.All(i => !i.Hidden)) break;
                }
            }
            return mine;
        }
        return items;
    }

    static List<TrayItem> Enumerate()
    {
        var items = new List<TrayItem>();
        var seen = new HashSet<string>();
        var taskbar = FindWindowW("Shell_TrayWnd", null);

        // Windows 11 XAML taskbar (and its overflow flyout, if open) — also any
        // secondary taskbars on other monitors.
        var roots = new List<IntPtr>();
        if (taskbar != IntPtr.Zero) roots.Add(taskbar);
        foreach (var h in TopLevelWindows())
        {
            var cls = ClassName(h);
            if (cls == "Shell_SecondaryTrayWnd" || (cls == "TopLevelWindowForOverflowXamlIsland" && IsWindowVisible(h))) roots.Add(h);
        }
        foreach (var root in roots)
        {
            var el = Uia.FromHandle(root);
            if (el == null) continue;
            Walk.Run(new ElementNode(el), 10, 2000, (n, _) =>
            {
                var p = n.Props;
                if (IsIconProps(p) && n.Element != null)
                {
                    var item = FromElement(n.Element, p);
                    if (seen.Add(Key(item))) items.Add(item);
                    return Step.SkipChildren;
                }
                // Do not wade through the running-apps list or the widgets button.
                if (p.ControlType == CT.Button && p.Identifier != "NotifyItemIcon") return Step.SkipChildren;
                return Step.Continue;
            });
        }

        // Windows 10 toolbars (also present on Windows 11 as an invisible
        // compatibility shell, hence the visibility check).
        foreach (var (toolbar, hidden) in Win10Toolbars())
        {
            var el = Uia.FromHandle(toolbar);
            if (el == null) continue;
            var owners = Win10Owners(toolbar);
            int index = 0;
            foreach (var b in Uia.Children(el))
            {
                var p = Props.Read(b, null);
                if (p.ControlType != CT.Button) continue;
                var item = FromElement(b, p);
                item.Hidden = hidden || p.Rect == null;
                if (index < owners.Count && owners[index] != IntPtr.Zero) SetOwner(item, Pid(owners[index]));
                index++;
                if (seen.Add(Key(item))) items.Add(item);
            }
        }

        // Resolve ownership for anything on screen that is still anonymous.
        foreach (var item in items.Where(i => i.Pid == 0)) ResolveOwner(item);

        // Icons the registry knows but nothing on screen shows: hidden in the
        // Windows 11 overflow while the flyout is closed. Many apps (Electron
        // among them) create the icon first and set its tooltip afterwards, so
        // InitialTooltip is often empty; such entries are keyed on the exe alone.
        foreach (var (tooltip, exe, _) in RegistrySettings())
        {
            if (exe == null) continue;
            if (!string.IsNullOrEmpty(tooltip) && items.Any(i => Norm(i.Label) == Norm(tooltip))) continue;
            var pids = PidsForExe(exe);
            if (pids.Count == 0) continue; // not running: no icon to show
            if (items.Any(i => i.Pid == pids[0] || (i.ExePath != null && string.Equals(i.ExePath, exe, StringComparison.OrdinalIgnoreCase)))) continue;
            var label = string.IsNullOrEmpty(tooltip) ? Apps.Name(pids[0]) : tooltip;
            var item = new TrayItem { Label = label, Title = string.IsNullOrEmpty(tooltip) ? null : tooltip, Hidden = true, ExePath = exe };
            SetOwner(item, pids[0]);
            if (seen.Add(Key(item))) items.Add(item);
        }
        return items;
    }

    static string Key(TrayItem i) => i.Element != null && i.Rect is Rect r ? $"{r.X},{r.Y}|{Norm(i.Label)}" : $"hidden|{Norm(i.Label)}";
    static string Norm(string s) => s.Trim().ToLowerInvariant();

    public static bool IsIconProps(Props p) =>
        p.ControlType == CT.Button && (p.Identifier == "NotifyItemIcon" || p.ClassName.Contains("SystemTray.NormalButton", StringComparison.Ordinal));

    static TrayItem FromElement(IUIAutomationElement e, Props p)
    {
        var label = (p.Title ?? p.Help ?? "").Trim();
        return new TrayItem
        {
            Element = e, Props = p, Label = label, Title = p.Title?.Trim(), Help = p.Help, Identifier = p.Identifier, Rect = p.Rect,
            Hidden = p.Rect == null,
        };
    }

    static void SetOwner(TrayItem item, uint pid)
    {
        if (pid == 0) return;
        item.Pid = pid;
        item.App = Apps.Name(pid);
        item.BundleId = Apps.BundleId(pid);
        item.ExePath ??= Apps.Path(pid);
    }

    /// <summary>
    /// Who owns an icon, when the OS did not say. The registry maps initial
    /// tooltips to executables; failing that, an icon whose name is the
    /// display name of a running process with a registered icon is theirs.
    /// </summary>
    static void ResolveOwner(TrayItem item)
    {
        var settings = RegistrySettings();
        var label = Norm(item.Label);
        var byTip = settings.FirstOrDefault(s => !string.IsNullOrEmpty(s.tooltip) && Norm(s.tooltip) == label && s.exe != null);
        if (byTip.exe != null)
        {
            var pids = PidsForExe(byTip.exe);
            if (pids.Count > 0) { SetOwner(item, pids[0]); item.ExePath = byTip.exe; return; }
        }
        foreach (var (_, exe, _) in settings)
        {
            if (exe == null) continue;
            var pids = PidsForExe(exe);
            if (pids.Count == 0) continue;
            // Only the main process registers the icon: match on it, not on a helper.
            var name = Norm(Apps.Name(pids[0]));
            var stem = Norm(Path.GetFileNameWithoutExtension(exe));
            if (NamedAfter(label, name) || NamedAfter(label, stem)) { SetOwner(item, pids[0]); item.ExePath = exe; return; }
        }
    }

    /// <summary>"Worktrace", "Worktrace - Not signed in", "Worktrace: 3 new" are all named after "worktrace".</summary>
    static bool NamedAfter(string label, string name) =>
        name.Length > 0 && label.StartsWith(name, StringComparison.Ordinal) && (label.Length == name.Length || !char.IsLetterOrDigit(label[name.Length]));

    /// <summary>Re-resolves a tray hit from a recorder click to a full item (ownership included).</summary>
    public static TrayItem? Resolve(Props hit)
    {
        var items = Enumerate();
        return items.FirstOrDefault(i => i.Rect is Rect r && hit.Rect is Rect h && Math.Abs(r.X - h.X) < 3 && Math.Abs(r.Y - h.Y) < 3)
            ?? items.FirstOrDefault(i => Norm(i.Label) == Norm(hit.Title ?? ""));
    }

    // ── Registry (Windows 11) ───────────────────────────────────────────────

    static readonly Dictionary<string, string> KnownFolders = new(StringComparer.OrdinalIgnoreCase)
    {
        ["{6D809377-6AF0-444B-8957-A3773F02200E}"] = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
        ["{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}"] = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
        ["{F38BF404-1D43-42F2-9305-67DE0B28FC23}"] = Environment.GetFolderPath(Environment.SpecialFolder.Windows),
        ["{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}"] = Environment.GetFolderPath(Environment.SpecialFolder.System),
        ["{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}"] = Environment.GetFolderPath(Environment.SpecialFolder.SystemX86),
        ["{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}"] = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        ["{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}"] = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        ["{5E6C858F-0E22-4760-9AFE-EA3317B67173}"] = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ["{62AB5D82-FDC1-4DC3-A9DD-070D1D495D97}"] = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
    };

    /// <summary>Explorer stores executable paths with the known folder as a GUID; expand it back to a path.</summary>
    static string? ExpandExe(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        if (raw.StartsWith('{'))
        {
            var end = raw.IndexOf('}');
            if (end > 0 && KnownFolders.TryGetValue(raw[..(end + 1)], out var folder)) return folder + raw[(end + 1)..];
        }
        return raw;
    }

    static (List<(string tooltip, string? exe, string key)> items, DateTime at) _settingsCache;

    static List<(string tooltip, string? exe, string key)> RegistrySettings()
    {
        if ((DateTime.UtcNow - _settingsCache.at).TotalMilliseconds < 500 && _settingsCache.items != null) return _settingsCache.items;
        var out_ = new List<(string, string?, string)>();
        try
        {
            using var root = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(SettingsKey);
            if (root != null)
            {
                foreach (var name in root.GetSubKeyNames())
                {
                    using var k = root.OpenSubKey(name);
                    if (k == null) continue;
                    out_.Add((k.GetValue("InitialTooltip") as string ?? "", ExpandExe(k.GetValue("ExecutablePath") as string), name));
                }
            }
        }
        catch { }
        _settingsCache = (out_, DateTime.UtcNow);
        return out_;
    }

    static readonly Dictionary<string, (List<uint> pids, DateTime at)> _pidCache = new(StringComparer.OrdinalIgnoreCase);

    static List<uint> PidsForExe(string exe)
    {
        if (_pidCache.TryGetValue(exe, out var c) && (DateTime.UtcNow - c.at).TotalMilliseconds < 1000) return c.pids;
        var pids = new List<uint>();
        try
        {
            var stem = Path.GetFileNameWithoutExtension(exe);
            foreach (var proc in System.Diagnostics.Process.GetProcessesByName(stem))
            {
                using (proc)
                {
                    var path = Apps.Path((uint)proc.Id);
                    if (path != null && string.Equals(path, exe, StringComparison.OrdinalIgnoreCase)) pids.Add((uint)proc.Id);
                }
            }
            // Multi-process apps (Electron, Chromium, WebView2 hosts) run the same
            // exe as renderer, GPU and utility children. The icon belongs to the
            // root: the one whose parent is not itself this exe. Put roots first.
            if (pids.Count > 1)
            {
                var parents = ParentPids();
                var set = new HashSet<uint>(pids);
                pids = pids.OrderBy(p => parents.TryGetValue(p, out var pp) && set.Contains(pp) ? 1 : 0).ThenBy(p => p).ToList();
            }
        }
        catch { }
        _pidCache[exe] = (pids, DateTime.UtcNow);
        return pids;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);

    /// <summary>pid → parent pid for every running process.</summary>
    static Dictionary<uint, uint> ParentPids()
    {
        var map = new Dictionary<uint, uint>();
        var snap = CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return map;
        try
        {
            var e = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>() };
            for (var ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e)) map[e.th32ProcessID] = e.th32ParentProcessID;
        }
        finally { CloseHandle(snap); }
        return map;
    }

    /// <summary>Flips IsPromoted for every icon entry of the process's executable. Returns true if anything changed.</summary>
    static bool Promote(uint pid)
    {
        var exe = Apps.Path(pid);
        if (exe == null) return false;
        var changed = false;
        try
        {
            using var root = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(SettingsKey, writable: true);
            if (root == null) return false;
            foreach (var name in root.GetSubKeyNames())
            {
                using var k = root.OpenSubKey(name, writable: true);
                if (k == null) continue;
                var path = ExpandExe(k.GetValue("ExecutablePath") as string);
                if (path == null || !string.Equals(path, exe, StringComparison.OrdinalIgnoreCase)) continue;
                if ((k.GetValue("IsPromoted") as int?) == 1) continue;
                k.SetValue("IsPromoted", 1, Microsoft.Win32.RegistryValueKind.DWord);
                changed = true;
            }
        }
        catch (Exception e) { Program.Warn($"tray: could not promote icon: {e.Message}"); }
        if (changed) Program.Warn($"tray: promoted the tray icon of pid {pid} out of the overflow area (HKCU\\{SettingsKey}\\*\\IsPromoted)");
        return changed;
    }

    // ── Windows 10 toolbars ─────────────────────────────────────────────────

    static List<(IntPtr toolbar, bool hidden)> Win10Toolbars()
    {
        var out_ = new List<(IntPtr, bool)>();
        var tray = FindWindowW("Shell_TrayWnd", null);
        if (tray != IntPtr.Zero)
        {
            var notify = FindWindowExW(tray, IntPtr.Zero, "TrayNotifyWnd", null);
            var pager = notify == IntPtr.Zero ? IntPtr.Zero : FindWindowExW(notify, IntPtr.Zero, "SysPager", null);
            var tb = pager == IntPtr.Zero ? IntPtr.Zero : FindWindowExW(pager, IntPtr.Zero, "ToolbarWindow32", null);
            if (tb != IntPtr.Zero && IsWindowVisible(tb)) out_.Add((tb, false));
        }
        var overflow = FindWindowW("NotifyIconOverflowWindow", null);
        if (overflow != IntPtr.Zero)
        {
            var tb = FindWindowExW(overflow, IntPtr.Zero, "ToolbarWindow32", null);
            if (tb != IntPtr.Zero && SendMessageW(tb, TB_BUTTONCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt32() > 0) out_.Add((tb, !IsWindowVisible(overflow)));
        }
        return out_;
    }

    const uint TB_BUTTONCOUNT = 0x0418, TB_GETBUTTON = 0x0417;
    const uint PROCESS_VM_OPERATION = 0x8, PROCESS_VM_WRITE = 0x20, MEM_COMMIT = 0x1000, MEM_RELEASE = 0x8000, PAGE_READWRITE = 0x4;

    [DllImport("kernel32.dll")] static extern IntPtr VirtualAllocEx(IntPtr proc, IntPtr addr, IntPtr size, uint type, uint protect);
    [DllImport("kernel32.dll")] static extern bool VirtualFreeEx(IntPtr proc, IntPtr addr, IntPtr size, uint type);

    /// <summary>
    /// The owning window of each toolbar button, via TB_GETBUTTON. The TBBUTTON
    /// lives in Explorer's address space, so the struct is fetched with
    /// ReadProcessMemory, and its dwData points at Explorer's private
    /// TRAYDATA whose first field is the owner HWND.
    /// </summary>
    static List<IntPtr> Win10Owners(IntPtr toolbar)
    {
        var owners = new List<IntPtr>();
        var count = SendMessageW(toolbar, TB_BUTTONCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt32();
        if (count <= 0) return owners;
        var proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ | PROCESS_VM_OPERATION | PROCESS_VM_WRITE, false, Pid(toolbar));
        if (proc == IntPtr.Zero) return owners;
        try
        {
            IsWow64Process(proc, out var wow64);
            int tbSize = wow64 ? 20 : 32; // sizeof(TBBUTTON) for 32/64-bit Explorer
            var remote = VirtualAllocEx(proc, IntPtr.Zero, new IntPtr(tbSize), MEM_COMMIT, PAGE_READWRITE);
            if (remote == IntPtr.Zero) return owners;
            try
            {
                var buf = new byte[tbSize];
                var tray = new byte[16];
                for (int i = 0; i < count; i++)
                {
                    if (SendMessageW(toolbar, TB_GETBUTTON, new IntPtr(i), remote) == IntPtr.Zero
                        || !ReadProcessMemory(proc, remote, buf, new IntPtr(tbSize), out _)) { owners.Add(IntPtr.Zero); continue; }
                    // TBBUTTON: iBitmap(4) idCommand(4) fsState(1) fsStyle(1) pad(2|6) dwData(4|8) iString
                    var dwData = wow64 ? new IntPtr(BitConverter.ToInt32(buf, 12)) : new IntPtr(BitConverter.ToInt64(buf, 16));
                    if (dwData == IntPtr.Zero || !ReadProcessMemory(proc, dwData, tray, new IntPtr(tray.Length), out _)) { owners.Add(IntPtr.Zero); continue; }
                    var hwnd = wow64 ? new IntPtr(BitConverter.ToInt32(tray, 0)) : new IntPtr(BitConverter.ToInt64(tray, 0));
                    owners.Add(IsWindow(hwnd) ? hwnd : IntPtr.Zero);
                }
            }
            finally { VirtualFreeEx(proc, remote, IntPtr.Zero, MEM_RELEASE); }
        }
        finally { CloseHandle(proc); }
        return owners;
    }

    // ── Serialisation ───────────────────────────────────────────────────────

    public static List<Dictionary<string, object?>> List(uint? pid)
    {
        var out_ = new List<Dictionary<string, object?>>();
        int i = 0;
        foreach (var item in Items(pid))
        {
            var o = Summary(item);
            o["ref"] = item.Element != null ? Registry.Shared.Put(item.Element) : Registry.Shared.Put(new HiddenTrayIcon(item.Label, item.ExePath));
            o["index"] = i++;
            o["pid"] = (int)item.Pid;
            o["app"] = item.App;
            o["bundleId"] = item.BundleId;
            o["actions"] = new List<string> { "AXPress", "AXShowMenu" };
            out_.Add(o);
        }
        return out_;
    }

    /// <summary>The ElementSummary-shaped part of an item (also used as `trayItem` in recorder events).</summary>
    public static Dictionary<string, object?> Summary(TrayItem item)
    {
        var o = new Dictionary<string, object?> { ["role"] = "AXButton", ["label"] = item.Label };
        if (!string.IsNullOrEmpty(item.Title)) o["title"] = item.Title;
        if (!string.IsNullOrEmpty(item.Help)) o["help"] = item.Help;
        if (!string.IsNullOrEmpty(item.Identifier)) o["identifier"] = item.Identifier;
        if (item.Rect is Rect r) o["rect"] = r.ToJson();
        if (item.Hidden) o["hidden"] = true;
        return o;
    }

    // ── Opening ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Clicks a tray icon and returns whatever it produced: a popup menu
    /// (`#32768` or a WinForms/WPF dropdown) or a new window of the owning app.
    /// Clicks are real mouse clicks: NotifyIcon handlers key off WM_xBUTTONUP
    /// messages that a UIA Invoke does not reproduce.
    /// </summary>
    public static Dictionary<string, object?> Open(Args a)
    {
        var r = a.RequireStr("ref");
        var entry = Registry.Shared.Get(r) ?? throw new OpError("staleRef", $"stale tray ref '{r}'");
        TrayItem? item = null;
        if (entry is IUIAutomationElement el)
        {
            var p = Props.Read(Uia.Refresh(el) ?? el, null);
            item = Resolve(p) ?? FromElement(el, p);
        }
        else if (entry is HiddenTrayIcon hidden)
        {
            var all = Enumerate();
            // Prefer the on-screen copy (promoted since listing), then any match.
            item = all.FirstOrDefault(i => !i.Hidden && SameIcon(i, hidden.Tooltip, hidden.ExePath))
                ?? all.FirstOrDefault(i => SameIcon(i, hidden.Tooltip, hidden.ExePath));
        }
        if (item == null) throw new OpError("staleRef", "tray item is gone; re-list the tray");

        if (item.Element == null || item.Rect == null)
        {
            // Hidden in the Windows 11 overflow: open the flyout and find it there.
            item = RevealHidden(item) ?? throw new OpError("noGeometry", "tray item is in the hidden overflow and could not be revealed");
        }

        var pid = item.Pid;
        var maxDepth = a.Int("maxDepth");

        // The previous popup may still be on screen: fading out after a close
        // (Chromium menus animate), or never closed because Escape went to a
        // window that did not own it. Wait it out; if it really is still open,
        // it is the answer, since clicking the icon again would toggle it shut.
        if (_lastContent != IntPtr.Zero && !AwaitClosed(700) && Uia.FromHandle(_lastContent) is { } still)
        {
            var isMenu = ClassName(_lastContent) == "#32768" || Uia.Int(still, P.ControlType) == CT.Menu;
            return Content(isMenu ? "menu" : "window", still, maxDepth ?? (isMenu ? 6 : 8));
        }

        // A click on the icon just after its menu closed is swallowed (Electron
        // treats it as the tail of the dismissal), so leave a gap.
        var sinceClose = DateTime.UtcNow - _closedAt;
        if (sinceClose < ReopenGap) Thread.Sleep(ReopenGap - sinceClose);

        var before = pid == 0 ? new HashSet<long>() : new HashSet<long>(Apps.Windows(pid, includeTools: true).Concat(Popups.Windows(pid)).Select(h => h.ToInt64()));
        var beforeMenus = new HashSet<long>(TopLevelWindows().Where(h => IsWindowVisible(h) && ClassName(h) == "#32768").Select(h => h.ToInt64()));

        // Where the icon is now, not where it was when listed: the taskbar
        // reflows whenever another icon comes or goes (a location or mic
        // indicator appears the moment a browser uses it), and a stale rect
        // clicks the neighbour.
        var clickedAt = CurrentRect(item) ?? item.Rect!.Value;
        Input.Click(clickedAt.Center.Item1, clickedAt.Center.Item2, a.Str("button") ?? "left");

        var timeout = a.Int("timeoutMs") ?? 3000;
        var deadline = DateTime.UtcNow.AddMilliseconds(timeout);
        var recheckAt = DateTime.UtcNow.AddMilliseconds(timeout / 2);
        while (DateTime.UtcNow < deadline)
        {
            // Nothing yet and the icon has moved since the click: it landed on
            // whatever slid into that spot. Click where the icon is now.
            if (recheckAt != DateTime.MaxValue && DateTime.UtcNow >= recheckAt)
            {
                recheckAt = DateTime.MaxValue;
                if (CurrentRect(item) is Rect now && (Math.Abs(now.X - clickedAt.X) > 2 || Math.Abs(now.Y - clickedAt.Y) > 2))
                {
                    Program.Warn($"tray: icon moved from {clickedAt.X},{clickedAt.Y} to {now.X},{now.Y} during the click; clicking again");
                    clickedAt = now;
                    Input.Click(now.Center.Item1, now.Center.Item2, a.Str("button") ?? "left");
                    deadline = DateTime.UtcNow.AddMilliseconds(timeout);
                }
            }
            // 1. A Win32 context menu, from any process if ownership is unknown.
            foreach (var h in TopLevelWindows())
            {
                if (!IsWindowVisible(h) || ClassName(h) != "#32768" || beforeMenus.Contains(h.ToInt64())) continue;
                if (pid != 0 && Pid(h) != pid) continue;
                var el2 = Uia.FromHandle(h);
                if (el2 != null) { _lastContent = h; return Content("menu", el2, maxDepth ?? 6); }
            }
            if (pid != 0)
            {
                // 2. A new window of the app — a dropdown menu or a popover panel.
                foreach (var h in Apps.Windows(pid, includeTools: true).Concat(Popups.Windows(pid)))
                {
                    if (before.Contains(h.ToInt64())) continue;
                    var el2 = Uia.FromHandle(h);
                    if (el2 == null) continue;
                    var isMenu = Uia.Int(el2, P.ControlType) == CT.Menu;
                    if (IsTransient(h)) _lastContent = h;
                    return Content(isMenu ? "menu" : "window", el2, maxDepth ?? (isMenu ? 6 : 8));
                }
            }
            Thread.Sleep(100);
        }
        throw new OpError("trayNoContent", $"tray item was clicked but produced no menu or window within {timeout}ms");
    }

    /// <summary>
    /// The icon's on-screen rect right now. Explorer can rebuild the taskbar's
    /// buttons on reflow, so a dead element falls back to a fresh listing.
    /// </summary>
    static Rect? CurrentRect(TrayItem item)
    {
        if (item.Element != null && Uia.Refresh(item.Element) is { } el && Props.Read(el, null).Rect is Rect r) return r;
        var again = Enumerate().FirstOrDefault(i => !i.Hidden && i.Rect != null && ((item.Pid != 0 && i.Pid == item.Pid) || SameIcon(i, item.Label, item.ExePath)));
        return again?.Rect;
    }

    /// <summary>The window the last successful Open returned, when it is a transient popup.</summary>
    static IntPtr _lastContent;

    /// <summary>
    /// A popup that goes away on its own (a menu, a Chromium menu window), as
    /// opposed to an ordinary app window a tray click happened to open.
    /// </summary>
    static bool IsTransient(IntPtr h) =>
        ClassName(h) == "#32768" || ((ExStyle(h) & WS_EX_TOOLWINDOW) != 0 && (Style(h) & WS_CAPTION) != WS_CAPTION);

    /// <summary>
    /// Waits up to `ms` for the last opened popup to leave the screen. True
    /// when it is gone (or there was none).
    /// </summary>
    public static bool AwaitClosed(int ms)
    {
        var h = _lastContent;
        if (h == IntPtr.Zero) return true;
        var deadline = DateTime.UtcNow.AddMilliseconds(ms);
        while (IsWindow(h) && IsWindowVisible(h))
        {
            if (DateTime.UtcNow >= deadline) return false;
            Thread.Sleep(50);
        }
        _lastContent = IntPtr.Zero;
        _closedAt = DateTime.UtcNow;
        return true;
    }

    static DateTime _closedAt = DateTime.MinValue;
    static readonly TimeSpan ReopenGap = TimeSpan.FromMilliseconds(700);

    /// <summary>
    /// Dismisses the open popup. Escape goes to the focused window, which is
    /// not always the popup (a popover can open without taking focus), so a
    /// popup that outlives it gets focus and a second Escape.
    /// </summary>
    public static void Close()
    {
        Input.Key("escape");
        if (AwaitClosed(600)) return;
        SetForegroundWindow(_lastContent);
        Input.Key("escape");
        AwaitClosed(600);
    }

    static Dictionary<string, object?> Content(string kind, IUIAutomationElement root, int depth)
        => new() { ["kind"] = kind, ["root"] = new Serializer(new SerializeOptions { MaxDepth = depth }).Node(new ElementNode(root)) };

    /// <summary>Opens the Windows 11 overflow flyout and returns the item as it appears there.</summary>
    static TrayItem? RevealHidden(TrayItem item)
    {
        var taskbar = FindWindowW("Shell_TrayWnd", null);
        var el = Uia.FromHandle(taskbar);
        if (el == null) return null;
        Node? chevron = null;
        Walk.Run(new ElementNode(el), 6, 500, (n, _) =>
        {
            if (n.Props.ControlType == CT.Button && n.Props.Identifier == "SystemTrayIcon" && Uia.Ci(n.Props.Title, "hidden icons")) { chevron = n; return Step.Stop; }
            return Step.Continue;
        });
        if (chevron?.Element == null) return null;
        Elements.Perform(chevron.Element, "AXPress");
        var found = Ops.WaitFor(2500, () => Enumerate().FirstOrDefault(i => !i.Hidden && i.Rect != null && SameIcon(i, item.Label, item.ExePath)), 150);
        if (found != null && found.Pid == 0) { found.Pid = item.Pid; found.App = item.App; found.BundleId = item.BundleId; }
        return found;
    }

    /// <summary>Whether `i` is the icon known by `label` / `exe`: same label, same exe, or a label named after it.</summary>
    static bool SameIcon(TrayItem i, string label, string? exe) =>
        Norm(i.Label) == Norm(label)
        || (exe != null && i.ExePath != null && string.Equals(i.ExePath, exe, StringComparison.OrdinalIgnoreCase))
        || NamedAfter(Norm(i.Label), Norm(label));
}
