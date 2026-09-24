using System.Text.Json;
using Interop.UIAutomationClient;
using static Dtf.Native;

namespace Dtf;

/// <summary>The op table. Same names, argument names, result shapes and error codes as Ops.swift.</summary>
static class Ops
{
    // ── Roots ───────────────────────────────────────────────────────────────

    /// <summary>Most ops accept either an app pid or an existing element ref as their root.</summary>
    public static Node ResolveRoot(Args a)
    {
        if (a.Str("ref") is string r)
        {
            var v = Registry.Shared.Get(r) ?? throw new OpError("staleRef", $"element ref '{r}' is stale; re-query the tree");
            return NodeFor(v);
        }
        if (a.Int("pid") is int pid) return AppNode((uint)pid);
        throw new OpError("badArgs", "expected either 'pid' or 'ref'");
    }

    public static Node NodeFor(object registryValue) => registryValue switch
    {
        IUIAutomationElement e => new ElementNode(Uia.Refresh(e) ?? e),
        AppRoot app => AppNode(app.Pid),
        Grafted g => new SyntheticNode("AXMenu", null, () => Uia.Children(g.Owner).Select(k => (Node)new ElementNode(k)).ToList(), g),
        _ => throw new OpError("staleRef", "unknown registry entry"),
    };

    /// <summary>
    /// A process has no root element in UIA. The framework expects one, so it
    /// is synthesised: an AXApplication whose children are the process's
    /// top-level windows (including popup menus, which are top-level too).
    /// </summary>
    public static Node AppNode(uint pid)
    {
        var key = new AppRoot(pid);
        return new SyntheticNode("AXApplication", Apps.Name(pid), () =>
        {
            var kids = Uia.TopLevel(pid).Select(w => (Node)new ElementNode(w)).ToList();
            // Open popup menus are top-level windows UIA does not list under
            // the desktop; add them so `find` from the app root can reach them.
            var seen = new HashSet<long>(kids.Select(k => k.Props.Hwnd.ToInt64()));
            foreach (var n in Popups.Nodes(pid)) if (seen.Add(n.Props.Hwnd.ToInt64())) kids.Add(n);
            return kids;
        }, key);
    }

    public static IUIAutomationElement RequireElement(Args a)
    {
        var r = a.RequireStr("ref");
        var e = Registry.Shared.Element(r);
        return e;
    }

    static Props Live(IUIAutomationElement e) => Props.Read(Uia.Refresh(e) ?? e, null);

    public static (double x, double y) Center(IUIAutomationElement e)
    {
        var p = Live(e);
        if (p.Rect is not Rect r) throw new OpError("noGeometry", "element has no on-screen position; it may be offscreen or not yet drawn");
        return r.Center;
    }

    static Dictionary<string, object?> Serialize(Node n, Args a, int defaultDepth = 12)
    {
        var o = new SerializeOptions { MaxDepth = a.Int("maxDepth") ?? defaultDepth };
        if (a.Int("maxNodes") is int mn) o.MaxNodes = mn;
        return new Serializer(o).Node(n);
    }

    /// <summary>Poll until `check` returns non-null or the deadline passes.</summary>
    public static T? WaitFor<T>(int timeoutMs, Func<T?> check, int intervalMs = 100) where T : class
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (true)
        {
            var v = check();
            if (v != null) return v;
            if (DateTime.UtcNow >= deadline) return null;
            Thread.Sleep(intervalMs);
        }
    }

    static readonly Dictionary<string, object?> Ok = new() { ["ok"] = true };

    // ── Dispatch ────────────────────────────────────────────────────────────

    public static object? Dispatch(string op, Args args)
    {
        switch (op)
        {
            case "ping":
                return new Dictionary<string, object?> { ["ok"] = true, ["pid"] = Environment.ProcessId };

            // No Accessibility permission exists on Windows. What can go wrong
            // is integrity: input from this process never reaches an elevated
            // window, which `preflight` reports separately.
            case "perm.accessibility":
                return new Dictionary<string, object?> { ["trusted"] = true };
            case "perm.screenRecording":
                return new Dictionary<string, object?> { ["granted"] = true };
            case "perm.requestScreenRecording":
                return new Dictionary<string, object?> { ["requested"] = true };

            case "perm.focusAssist":
                return Environ.FocusAssist();
            case "session.info":
                return Environ.SessionInfo();
            case "perm.consent.read":
                return Permissions.Read(args.RequireStr("capability"), args.RequireStr("app"));
            case "perm.consent.write":
                return Permissions.Write(args.RequireStr("capability"), args.RequireStr("app"), args.Str("value"));

            // ── Applications ───────────────────────────────────────────────
            case "app.list":
                return Apps.List();
            case "app.find":
                return Apps.Find(args.Str("bundleId"), args.Str("name"));
            case "app.info":
                return Apps.Info((uint)args.RequireInt("pid"));
            case "app.enableElectronAccessibility":
                // Chromium turns its accessibility tree on by itself when a UIA
                // client connects (it watches WM_GETOBJECT), so there is nothing
                // to set here; the macOS attribute has no Windows counterpart.
                return new Dictionary<string, object?> { ["manualAccessibility"] = false, ["enhancedUserInterface"] = false };
            case "app.activate":
            {
                var pid = (uint)args.RequireInt("pid");
                if (!Apps.IsRunning(pid)) throw new OpError("noApp", $"no running app with pid {pid}");
                return new Dictionary<string, object?> { ["ok"] = Apps.Activate(pid) };
            }
            case "app.hide":
                return new Dictionary<string, object?> { ["ok"] = Apps.Hide((uint)args.RequireInt("pid")) };
            case "app.terminate":
            {
                var pid = (uint)args.RequireInt("pid");
                if (!Apps.IsRunning(pid)) return new Dictionary<string, object?> { ["ok"] = true, ["alreadyGone"] = true };
                return new Dictionary<string, object?> { ["ok"] = Apps.Terminate(pid, args.Bool("force") ?? false) };
            }

            // ── Tree / query ───────────────────────────────────────────────
            case "tree":
                return Serialize(ResolveRoot(args), args);

            case "find":
            {
                var root = ResolveRoot(args);
                var path = Selector.ParsePath(args.Raw("selector"));
                if (path.Count == 0) throw new OpError("badArgs", "missing 'selector'");
                var timeout = args.Int("timeoutMs") ?? 0;

                if (args.Bool("all") == true)
                {
                    // `all` only ever applies to the final step of the path.
                    var scope = path.Count > 1 ? Find.Path(root, path.Take(path.Count - 1).ToList()) : root;
                    if (scope == null) return new List<object?>();
                    return Find.All(scope, path[^1]).Select(m => (object?)Serialize(m, args)).ToList();
                }

                var found = WaitFor(timeout, () => Find.Path(root, path));
                if (found == null)
                {
                    throw new OpError("notFound", timeout > 0 ? $"no element matched selector within {timeout}ms" : "no element matched selector");
                }
                return Serialize(found, args);
            }

            case "exists":
            {
                var root = ResolveRoot(args);
                var path = Selector.ParsePath(args.Raw("selector"));
                return new Dictionary<string, object?> { ["exists"] = Find.Path(root, path) != null };
            }

            // ── Element interaction ────────────────────────────────────────
            case "element.get":
                return Serialize(new ElementNode(Uia.Refresh(RequireElement(args)) ?? RequireElement(args)), args);

            case "element.attributes":
                return Elements.Attributes(RequireElement(args));

            case "element.action":
            {
                var e = RequireElement(args);
                var action = args.Str("action") ?? "AXPress";
                if (args.Bool("nonBlocking") == true)
                {
                    // Anything that opens a menu may not return until the menu
                    // closes (Win32 menu proxies run the tracking loop inside the
                    // action). Callers that intend to inspect the opened menu ask
                    // for a fire-and-forget press and poll for the result.
                    ThreadPool.QueueUserWorkItem(_ => { try { Elements.Perform(e, action); } catch (Exception ex) { Program.Warn($"nonBlocking {action}: {ex.Message}"); } });
                    return new Dictionary<string, object?> { ["ok"] = true, ["dispatched"] = true };
                }
                Elements.Perform(e, action);
                return Ok;
            }

            case "element.setValue":
            {
                var e = RequireElement(args);
                var raw = args.Raw("value");
                if (raw.ValueKind == JsonValueKind.Undefined) throw new OpError("badArgs", "missing 'value'");
                Elements.SetValue(e, raw);
                return Ok;
            }

            case "element.click":
            {
                var e = RequireElement(args);
                var (x, y) = Center(e);
                Input.Click(x, y, args.Str("button") ?? "left", args.Int("count") ?? 1, args.StrList("modifiers"));
                return Ok;
            }

            case "element.hover":
            {
                var (x, y) = Center(RequireElement(args));
                Input.Move(x, y);
                return Ok;
            }

            case "element.focus":
                Elements.Focus(RequireElement(args));
                return Ok;

            case "element.rect":
            {
                var p = Live(RequireElement(args));
                if (p.Rect is not Rect r) throw new OpError("noGeometry", "element has no position/size");
                return r.ToJson();
            }

            // ── Tray ───────────────────────────────────────────────────────
            case "tray.list":
                return Tray.List(args.Int("pid") is int tp ? (uint)tp : null);
            case "tray.open":
                return Tray.Open(args);
            case "tray.close":
                // Escape reliably dismisses a tracking menu and the overflow flyout.
                Input.Key("escape");
                return Ok;

            // ── Application menu bar ───────────────────────────────────────
            case "menu.tree":
                return Menus.Tree((uint)args.RequireInt("pid"), args.Int("maxDepth") ?? 4);
            case "menu.click":
                return Menus.Click((uint)(args.Int("pid") ?? 0), args.StrList("path"));

            // ── Windows ────────────────────────────────────────────────────
            case "window.list":
                return Apps.WindowList((uint)args.RequireInt("pid"));

            case "window.setBounds":
            {
                var e = RequireElement(args);
                var h = Apps.HwndOf(e);
                if (h == IntPtr.Zero) throw new OpError("noGeometry", "window has no native handle");
                GetWindowRect(h, out var r);
                var x = args.Dbl("x") ?? r.left; var y = args.Dbl("y") ?? r.top;
                var w = args.Dbl("width") ?? r.Width; var hgt = args.Dbl("height") ?? r.Height;
                if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
                SetWindowPos(h, IntPtr.Zero, (int)x, (int)y, (int)w, (int)hgt, SWP_NOZORDER | SWP_NOACTIVATE);
                return Ok;
            }

            case "window.setMinimized":
            {
                var h = Apps.HwndOf(RequireElement(args));
                if (h == IntPtr.Zero) throw new OpError("noGeometry", "window has no native handle");
                ShowWindow(h, (args.Bool("minimized") ?? true) ? SW_MINIMIZE : SW_RESTORE);
                return Ok;
            }

            // ── Notifications ──────────────────────────────────────────────
            case "notification.list":
                return Notifications.List();
            case "notification.act":
                return Notifications.Act(args);

            // ── Dialogs ────────────────────────────────────────────────────
            case "dialog.list":
                return Dialogs.List(args.Int("pid") is int dp ? (uint)dp : null);
            case "dialog.setFilePath":
                return Dialogs.SetFilePath(RequireElement(args), args.RequireStr("path"));

            // ── Raw input ──────────────────────────────────────────────────
            case "key":
            {
                var combo = args.RequireStr("combo");
                if (!Input.Key(combo)) throw new OpError("badKey", $"could not parse key combo '{combo}'");
                return Ok;
            }
            case "type":
                Input.Type(args.RequireStr("text"), args.Int("delayMs") ?? 8);
                return Ok;
            case "click":
                Input.Click(args.Dbl("x") ?? 0, args.Dbl("y") ?? 0, args.Str("button") ?? "left", args.Int("count") ?? 1, args.StrList("modifiers"));
                return Ok;
            case "move":
                Input.Move(args.Dbl("x") ?? 0, args.Dbl("y") ?? 0);
                return Ok;
            case "drag":
                Input.Drag(args.Dbl("fromX") ?? 0, args.Dbl("fromY") ?? 0, args.Dbl("toX") ?? 0, args.Dbl("toY") ?? 0);
                return Ok;
            case "scroll":
                Input.Scroll(args.Dbl("x") ?? 0, args.Dbl("y") ?? 0, args.Int("dx") ?? 0, args.Int("dy") ?? 0);
                return Ok;
            case "mouse.location":
            {
                var (x, y) = Input.MouseLocation();
                return new Dictionary<string, object?> { ["x"] = x, ["y"] = y };
            }

            case "screen.info":
                return Screen.Info();
            case "screenshot":
                return Screen.Shot(args);

            // ── Recording ──────────────────────────────────────────────────
            case "record.start":
                Recorder.Shared.Start();
                return Ok;
            case "record.stop":
                Recorder.Shared.Stop();
                return Ok;
            case "record.pick":
            {
                // The next left click is swallowed and reported as a `pick`
                // event instead of reaching the app — how the recorder selects
                // an element to assert on without also clicking it.
                if (!Recorder.Shared.Running) throw new OpError("notRecording", "record.start first");
                Recorder.Shared.PickArmed = args.Bool("armed") ?? true;
                return new Dictionary<string, object?> { ["ok"] = true, ["armed"] = Recorder.Shared.PickArmed };
            }
            case "element.atPoint":
            {
                var x = args.Dbl("x") ?? 0; var y = args.Dbl("y") ?? 0;
                var e = Uia.FromPoint(x, y) ?? throw new OpError("notFound", $"no accessible element at ({x}, {y})");
                var d = Describe.Element(e);
                d["ref"] = Registry.Shared.Put(e);
                return d;
            }

            default:
                throw new OpError("unknownOp", $"unknown op '{op}'");
        }
    }
}

/// <summary>Acting on one element through its UIA patterns.</summary>
static class Elements
{
    /// <summary>
    /// Performs a macOS-named action via whichever UIA pattern the element has.
    /// AXPress is deliberately generous: Invoke, Toggle, ExpandCollapse,
    /// SelectionItem and the MSAA default action all count, and a real click
    /// at the element's centre is the last resort — the same fallback
    /// Locator.click already makes on the Node side.
    /// </summary>
    public static void Perform(IUIAutomationElement e, string action)
    {
        var p = Props.Read(Uia.Refresh(e) ?? e, null);
        switch (action)
        {
            case "AXPress":
            case "press":
                if (p.ControlType == CT.CheckBox && p.HasToggle) { Uia.Pattern<IUIAutomationTogglePattern>(e, Uia.TogglePattern)!.Toggle(); return; }
                if (Press(e, p)) return;
                if (p.HasInvoke) { Invoke(e); return; }
                if (p.HasToggle) { Uia.Pattern<IUIAutomationTogglePattern>(e, Uia.TogglePattern)!.Toggle(); return; }
                if (p.HasExpand)
                {
                    var ec = Uia.Pattern<IUIAutomationExpandCollapsePattern>(e, Uia.ExpandCollapsePattern)!;
                    if (ec.CurrentExpandCollapseState == ExpandCollapseState.ExpandCollapseState_Expanded) ec.Collapse(); else ec.Expand();
                    return;
                }
                if (p.HasSelect) { Uia.Pattern<IUIAutomationSelectionItemPattern>(e, Uia.SelectionItemPattern)!.Select(); return; }
                if (p.LegacyDefaultAction != null)
                {
                    var la = Uia.Pattern<IUIAutomationLegacyIAccessiblePattern>(e, Uia.LegacyIAccessiblePattern);
                    if (la != null) { try { la.DoDefaultAction(); return; } catch { } }
                }
                if (p.Rect is Rect r) { Input.Click(r.Center.x, r.Center.y); return; }
                throw new OpError("noAction", $"element does not support 'AXPress'; it supports {string.Join(",", p.Actions)}");

            case "AXShowMenu":
                if (p.HasExpand) { Uia.Pattern<IUIAutomationExpandCollapsePattern>(e, Uia.ExpandCollapsePattern)!.Expand(); return; }
                if (p.Rect is Rect rr) { Input.Click(rr.Center.x, rr.Center.y, "right"); return; }
                throw new OpError("noAction", "element has no menu to show");

            case "AXRaise":
            {
                var h = Apps.HwndOf(e);
                if (h == IntPtr.Zero) throw new OpError("noAction", "element is not a window");
                Apps.Activate(Pid(h));
                return;
            }

            case "AXIncrement":
            case "AXDecrement":
            {
                var rv = Uia.Pattern<IUIAutomationRangeValuePattern>(e, Uia.RangeValuePattern) ?? throw new OpError("noAction", "element has no range value");
                var step = rv.CurrentSmallChange > 0 ? rv.CurrentSmallChange : 1;
                rv.SetValue(rv.CurrentValue + (action == "AXIncrement" ? step : -step));
                return;
            }

            case "AXScrollToVisible":
            {
                var si = Uia.Pattern<IUIAutomationScrollItemPattern>(e, Uia.ScrollItemPattern) ?? throw new OpError("noAction", "element is not scrollable into view");
                si.ScrollIntoView();
                return;
            }

            default:
                throw new OpError("noAction", $"element does not support '{action}'; it supports {string.Join(",", p.Actions)}");
        }
    }

    /// <summary>
    /// Presses a control without holding a UIA call open on it.
    ///
    /// WinForms and WPF run the click handler *inside* the provider's Invoke
    /// call. A handler that opens a modal dialog therefore never returns
    /// until the dialog closes, and while that call is outstanding the
    /// process answers no other UIA request at all — the dialog cannot even
    /// be listed, let alone dismissed, and every query times out. So for
    /// those frameworks the press is delivered the way the OS would: a
    /// BM_CLICK posted to a button's own window, or a real click on anything
    /// that has no window of its own (ToolStrip items, WPF controls). Both are
    /// asynchronous, so the helper stays free and the dialog is readable.
    /// </summary>
    static bool Press(IUIAutomationElement e, Props p)
    {
        var framework = Uia.Str(Uia.Refresh(e) ?? e, P.FrameworkId) ?? "";
        var managed = framework is "WinForm" or "WPF";
        if (!managed) return false;
        if (p.Hwnd != IntPtr.Zero && p.ClassName.Contains("BUTTON", StringComparison.OrdinalIgnoreCase))
        {
            const uint BM_CLICK = 0x00F5;
            PostMessageW(p.Hwnd, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
            return true;
        }
        if (p.Rect is Rect r && Uia.Bool(e, P.IsOffscreen) != true)
        {
            var top = Apps.TopLevelHwndOf(e);
            if (top != IntPtr.Zero && GetForegroundWindow() != top && ClassName(top) != "#32768") Apps.Activate(Pid(top));
            Input.Click(r.Center.x, r.Center.y);
            return true;
        }
        return false;
    }

    /// <summary>
    /// Invoke with a bounded wait. Frameworks that run handlers synchronously
    /// inside the call are handled by `Press` above; this covers the rest, and
    /// still refuses to hang the helper if a provider misbehaves.
    /// </summary>
    static void Invoke(IUIAutomationElement e)
    {
        var pattern = Uia.Pattern<IUIAutomationInvokePattern>(e, Uia.InvokePattern) ?? throw new OpError("noAction", "element lost its Invoke pattern");
        Exception? failure = null;
        var done = new ManualResetEventSlim();
        ThreadPool.QueueUserWorkItem(_ =>
        {
            try { pattern.Invoke(); }
            catch (Exception ex) { failure = ex; }
            finally { done.Set(); }
        });
        if (done.Wait(1500) && failure != null && !IsTimeout(failure))
            throw new OpError("actionFailed", $"Invoke failed: {failure.Message}");
    }

    static bool IsTimeout(Exception ex) => (uint)ex.HResult == 0x80131505;

    public static void SetValue(IUIAutomationElement e, JsonElement raw)
    {
        var vp = Uia.Pattern<IUIAutomationValuePattern>(e, Uia.ValuePattern);
        if (vp != null && raw.ValueKind == JsonValueKind.String) { vp.SetValue(raw.GetString()); return; }
        if (vp != null && raw.ValueKind == JsonValueKind.Number) { vp.SetValue(raw.GetDouble().ToString(System.Globalization.CultureInfo.InvariantCulture)); return; }
        var rv = Uia.Pattern<IUIAutomationRangeValuePattern>(e, Uia.RangeValuePattern);
        if (rv != null && raw.ValueKind == JsonValueKind.Number) { rv.SetValue(raw.GetDouble()); return; }
        var tg = Uia.Pattern<IUIAutomationTogglePattern>(e, Uia.TogglePattern);
        if (tg != null && (raw.ValueKind == JsonValueKind.True || raw.ValueKind == JsonValueKind.False || raw.ValueKind == JsonValueKind.Number))
        {
            var want = raw.ValueKind == JsonValueKind.Number ? raw.GetDouble() != 0 : raw.GetBoolean();
            var on = tg.CurrentToggleState == ToggleState.ToggleState_On;
            if (want != on) tg.Toggle();
            return;
        }
        throw new OpError("setValueFailed", "element has no Value, RangeValue or Toggle pattern");
    }

    public static void Focus(IUIAutomationElement e)
    {
        // SetFocus needs the window to be foreground for keyboard input to
        // follow; the framework types right after focusing.
        var h = Apps.TopLevelHwndOf(e);
        if (h != IntPtr.Zero && GetForegroundWindow() != h) Apps.Activate(Pid(h));
        try { e.SetFocus(); } catch (Exception ex) { throw new OpError("actionFailed", $"SetFocus failed: {ex.Message}"); }
    }

    /// <summary>Every property the element reports, by name, plus its action list. For writing new tests.</summary>
    public static Dictionary<string, object?> Attributes(IUIAutomationElement e)
    {
        var live = Uia.Refresh(e) ?? e;
        var p = Props.Read(live, null);
        var attrs = new Dictionary<string, object?>();
        var names = new Dictionary<string, int>
        {
            ["Name"] = P.Name, ["AutomationId"] = P.AutomationId, ["ClassName"] = P.ClassName, ["ControlType"] = P.ControlType,
            ["LocalizedControlType"] = P.LocalizedControlType, ["HelpText"] = P.HelpText, ["FullDescription"] = P.FullDescription,
            ["FrameworkId"] = P.FrameworkId, ["IsEnabled"] = P.IsEnabled, ["HasKeyboardFocus"] = P.HasKeyboardFocus,
            ["IsOffscreen"] = P.IsOffscreen, ["ProcessId"] = P.ProcessId, ["NativeWindowHandle"] = P.NativeWindowHandle,
            ["AcceleratorKey"] = P.AcceleratorKey, ["IsDialog"] = P.IsDialog, ["ExpandCollapseState"] = P.ExpandCollapseState,
            ["ToggleState"] = P.ToggleState, ["IsPassword"] = P.IsPassword,
        };
        foreach (var (k, id) in names) attrs[k] = Uia.Prop(live, id);
        attrs["AXRole"] = p.Role;
        if (p.Subrole != null) attrs["AXSubrole"] = p.Subrole;
        if (p.Value != null) attrs["AXValue"] = p.Value;
        if (p.Rect is Rect r) attrs["AXFrame"] = r.ToJson();
        // Chromium exposes the document URL as the page root's value; the
        // browser surface reads it under the macOS name.
        if (p.Role == "AXWebArea" && p.Value is string url) attrs["AXURL"] = url;
        return new Dictionary<string, object?> { ["attributes"] = attrs, ["actions"] = p.Actions };
    }
}
