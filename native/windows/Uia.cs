using System.Globalization;
using System.Runtime.InteropServices;
using Interop.UIAutomationClient;

namespace Dtf;

/// <summary>UIA property identifiers (UIAutomationClient.h). Named here so the code reads.</summary>
static class P
{
    public const int BoundingRectangle = 30001, ProcessId = 30002, ControlType = 30003, LocalizedControlType = 30004, Name = 30005,
        AcceleratorKey = 30006, AccessKey = 30007, HasKeyboardFocus = 30008, IsKeyboardFocusable = 30009, IsEnabled = 30010,
        AutomationId = 30011, ClassName = 30012, HelpText = 30013, IsControlElement = 30016, IsContentElement = 30017,
        NativeWindowHandle = 30020, IsOffscreen = 30022, FrameworkId = 30024, IsPassword = 30019,
        IsExpandCollapsePatternAvailable = 30028, IsInvokePatternAvailable = 30031, IsRangeValuePatternAvailable = 30033,
        IsScrollItemPatternAvailable = 30035, IsSelectionItemPatternAvailable = 30036, IsSelectionPatternAvailable = 30037,
        IsTextPatternAvailable = 30040, IsTogglePatternAvailable = 30041, IsValuePatternAvailable = 30043, IsWindowPatternAvailable = 30044,
        ValueValue = 30045, ValueIsReadOnly = 30046, RangeValueValue = 30047, ExpandCollapseState = 30070,
        SelectionItemIsSelected = 30079, ToggleState = 30086, IsLegacyIAccessiblePatternAvailable = 30090,
        LegacyIAccessibleDefaultAction = 30093, LegacyIAccessibleDescription = 30094, LegacyIAccessibleRole = 30095,
        FullDescription = 30159, IsDialog = 30174;
}

/// <summary>UIA control type identifiers.</summary>
static class CT
{
    public const int Button = 50000, Calendar = 50001, CheckBox = 50002, ComboBox = 50003, Edit = 50004, Hyperlink = 50005, Image = 50006,
        ListItem = 50007, List = 50008, Menu = 50009, MenuBar = 50010, MenuItem = 50011, ProgressBar = 50012, RadioButton = 50013,
        ScrollBar = 50014, Slider = 50015, Spinner = 50016, StatusBar = 50017, Tab = 50018, TabItem = 50019, Text = 50020, ToolBar = 50021,
        ToolTip = 50022, Tree = 50023, TreeItem = 50024, Custom = 50025, Group = 50026, Thumb = 50027, DataGrid = 50028, DataItem = 50029,
        Document = 50030, SplitButton = 50031, Window = 50032, Pane = 50033, Header = 50034, HeaderItem = 50035, Table = 50036,
        TitleBar = 50037, Separator = 50038, SemanticZoom = 50039, AppBar = 50040;
}

/// <summary>
/// The UI Automation client, configured once.
///
/// Everything reads through cache requests: one cross-process round trip per
/// node fetches every property the framework exposes, instead of one round trip
/// per property. The cache is a per-call snapshot, never reused across calls,
/// which is exactly the discipline the managed UIA wrapper lacks.
/// </summary>
static class Uia
{
    public static readonly IUIAutomation Auto;
    public static readonly IUIAutomationCondition ControlView;
    public static readonly IUIAutomationCondition TrueCond;
    public static readonly IUIAutomationTreeWalker Walker;
    /// <summary>Properties of the element itself.</summary>
    public static readonly IUIAutomationCacheRequest ElementCache;
    /// <summary>The element plus its control-view children, each with properties.</summary>
    public static readonly IUIAutomationCacheRequest ChildrenCache;

    static readonly int[] CachedProps =
    {
        P.BoundingRectangle, P.ProcessId, P.ControlType, P.LocalizedControlType, P.Name, P.HasKeyboardFocus, P.IsEnabled, P.AutomationId,
        P.ClassName, P.HelpText, P.IsControlElement, P.NativeWindowHandle, P.IsOffscreen, P.FrameworkId, P.IsPassword,
        P.IsExpandCollapsePatternAvailable, P.IsInvokePatternAvailable, P.IsRangeValuePatternAvailable, P.IsScrollItemPatternAvailable,
        P.IsSelectionItemPatternAvailable, P.IsTextPatternAvailable, P.IsTogglePatternAvailable, P.IsValuePatternAvailable,
        P.IsWindowPatternAvailable, P.ValueValue, P.ValueIsReadOnly, P.RangeValueValue, P.ExpandCollapseState, P.SelectionItemIsSelected,
        P.ToggleState, P.IsLegacyIAccessiblePatternAvailable, P.LegacyIAccessibleDefaultAction, P.LegacyIAccessibleDescription,
        P.FullDescription, P.IsDialog, P.AcceleratorKey,
    };

    static Uia()
    {
        Auto = new CUIAutomation8();
        // A hung app must not wedge the helper: the defaults are 20s connection
        // and 2s per transaction. Short timeouts make a stuck window a fast,
        // legible error instead of a stalled suite.
        if (Auto is IUIAutomation2 a2)
        {
            a2.ConnectionTimeout = 1500;
            a2.TransactionTimeout = 2000;
        }
        ControlView = Auto.ControlViewCondition;
        TrueCond = Auto.CreateTrueCondition();
        Walker = Auto.ControlViewWalker;

        ElementCache = Auto.CreateCacheRequest();
        ChildrenCache = Auto.CreateCacheRequest();
        foreach (var req in new[] { ElementCache, ChildrenCache })
        {
            foreach (var p in CachedProps)
            {
                // Newer property ids (FullDescription, IsDialog) do not exist on
                // old Windows 10 builds; caching is best-effort per property.
                try { req.AddProperty(p); } catch { }
            }
            req.TreeFilter = ControlView;
            req.AutomationElementMode = AutomationElementMode.AutomationElementMode_Full;
        }
        ElementCache.TreeScope = TreeScope.TreeScope_Element;
        ChildrenCache.TreeScope = TreeScope.TreeScope_Element | TreeScope.TreeScope_Children;
    }

    public static IUIAutomationElement Desktop => Auto.GetRootElementBuildCache(ElementCache);

    public static IUIAutomationElement? Refresh(IUIAutomationElement e)
    {
        try { return e.BuildUpdatedCache(ElementCache); } catch { return null; }
    }

    public static IUIAutomationElement? FromHandle(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return null;
        try { return Auto.ElementFromHandleBuildCache(hwnd, ElementCache); } catch { return null; }
    }

    public static IUIAutomationElement? FromPoint(double x, double y)
    {
        try { return Auto.ElementFromPointBuildCache(new tagPOINT { x = (int)Math.Round(x), y = (int)Math.Round(y) }, ElementCache); }
        catch { return null; }
    }

    public static IUIAutomationElement? Focused()
    {
        try { return Auto.GetFocusedElementBuildCache(ElementCache); } catch { return null; }
    }

    /// <summary>
    /// Control-view children, each with its properties cached.
    ///
    /// Not `BuildUpdatedCache(TreeScope_Children)`: for Win32 windows that
    /// returns only the client-area controls and silently drops the non-client
    /// proxies (TitleBar, MenuBar), so an app "had no menu bar". FindAll over
    /// the raw children sees everything; the odd non-control wrapper is then
    /// replaced by its own control descendants, which is what the control view
    /// walker would have produced, at one extra round trip per wrapper.
    /// </summary>
    public static List<IUIAutomationElement> Children(IUIAutomationElement e, int depth = 0)
    {
        var list = new List<IUIAutomationElement>();
        try
        {
            var arr = e.FindAllBuildCache(TreeScope.TreeScope_Children, TrueCond, ElementCache);
            if (arr == null) return list;
            for (int i = 0; i < arr.Length; i++)
            {
                var k = arr.GetElement(i);
                if (Bool(k, P.IsControlElement) == false && depth < 3) list.AddRange(Children(k, depth + 1));
                else list.Add(k);
            }
        }
        catch { }
        return list;
    }

    public static IUIAutomationElement? Parent(IUIAutomationElement e)
    {
        try { return Walker.GetParentElementBuildCache(e, ElementCache); } catch { return null; }
    }

    /// <summary>Top-level windows in the control view, optionally scoped to one process.</summary>
    public static List<IUIAutomationElement> TopLevel(uint? pid)
    {
        var list = new List<IUIAutomationElement>();
        try
        {
            var cond = pid is uint p
                ? Auto.CreateAndCondition(ControlView, Auto.CreatePropertyCondition(P.ProcessId, (int)p))
                : ControlView;
            var arr = Auto.GetRootElement().FindAllBuildCache(TreeScope.TreeScope_Children, cond, ElementCache);
            for (int i = 0; i < arr.Length; i++) list.Add(arr.GetElement(i));
        }
        catch { }
        return list;
    }

    public static bool Same(IUIAutomationElement? a, IUIAutomationElement? b)
    {
        if (a == null || b == null) return false;
        try { return Auto.CompareElements(a, b) != 0; } catch { return false; }
    }

    // ── Cached property access ──────────────────────────────────────────────

    public static object? Prop(IUIAutomationElement e, int id)
    {
        try
        {
            var v = e.GetCachedPropertyValue(id);
            if (v == null || v is DBNull) return null;
            // Unsupported properties come back as a sentinel IUnknown.
            if (Marshal.IsComObject(v)) return null;
            return v;
        }
        catch { return null; }
    }

    public static string? Str(IUIAutomationElement e, int id)
    {
        var v = Prop(e, id);
        var s = v as string;
        return string.IsNullOrEmpty(s) ? null : s;
    }

    public static bool? Bool(IUIAutomationElement e, int id) => Prop(e, id) is bool b ? b : null;
    public static int? Int(IUIAutomationElement e, int id) => Prop(e, id) switch { int i => i, long l => (int)l, double d => (int)d, _ => null };

    public static Rect? Rect(IUIAutomationElement e)
    {
        try
        {
            var r = e.CachedBoundingRectangle;
            if (r.right - r.left <= 0 && r.bottom - r.top <= 0) return null;
            return new Rect(r.left, r.top, r.right - r.left, r.bottom - r.top);
        }
        catch { return null; }
    }

    // ── Patterns (live) ─────────────────────────────────────────────────────

    public static T? Pattern<T>(IUIAutomationElement e, int patternId) where T : class
    {
        try { return e.GetCurrentPattern(patternId) as T; } catch { return null; }
    }

    public const int InvokePattern = 10000, SelectionPattern = 10001, ValuePattern = 10002, RangeValuePattern = 10003, ScrollPattern = 10004,
        ExpandCollapsePattern = 10005, GridPattern = 10006, GridItemPattern = 10007, WindowPattern = 10009, SelectionItemPattern = 10010,
        TogglePattern = 10015, TextPattern = 10014, ScrollItemPattern = 10017, LegacyIAccessiblePattern = 10018;

    public static bool Ci(string? haystack, string needle)
    {
        if (haystack == null) return false;
        return CultureInfo.InvariantCulture.CompareInfo.IndexOf(haystack, needle, CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace) >= 0;
    }
}

record struct Rect(double X, double Y, double Width, double Height)
{
    public Dictionary<string, object?> ToJson() => new() { ["x"] = X, ["y"] = Y, ["width"] = Width, ["height"] = Height };
    public (double x, double y) Center => (X + Width / 2, Y + Height / 2);
}

/// <summary>
/// Maps UIA control types to the AX* role names the selector DSL already uses,
/// so tests and generated selectors stay portable across platforms.
/// </summary>
static class Roles
{
    public static string Of(int controlType, IUIAutomationElement e, Props? parent) => controlType switch
    {
        CT.Button => "AXButton",
        CT.Calendar => "AXGroup",
        CT.CheckBox => "AXCheckBox",
        CT.ComboBox => "AXComboBox",
        CT.Edit => "AXTextField",
        CT.Hyperlink => "AXLink",
        CT.Image => "AXImage",
        CT.ListItem => "AXRow",
        CT.List => "AXList",
        CT.Menu => "AXMenu",
        CT.MenuBar => "AXMenuBar",
        // Top-level entries of a menu bar are AXMenuBarItem on macOS; UIA calls
        // both levels MenuItem, so the distinction comes from the parent.
        CT.MenuItem => parent?.ControlType == CT.MenuBar ? "AXMenuBarItem" : "AXMenuItem",
        CT.ProgressBar => "AXProgressIndicator",
        CT.RadioButton => "AXRadioButton",
        CT.ScrollBar => "AXScrollBar",
        CT.Slider => "AXSlider",
        CT.Spinner => "AXIncrementor",
        CT.StatusBar => "AXGroup",
        CT.Tab => "AXTabGroup",
        // AppKit exposes tabs as radio buttons inside a tab group; the DSL's
        // `tab` alias already resolves to AXRadioButton.
        CT.TabItem => "AXRadioButton",
        CT.Text => "AXStaticText",
        CT.ToolBar => "AXToolbar",
        CT.ToolTip => "AXHelpTag",
        CT.Tree => "AXOutline",
        CT.TreeItem => "AXRow",
        CT.Custom => "AXGroup",
        CT.Group => "AXGroup",
        CT.Thumb => "AXValueIndicator",
        CT.DataGrid => "AXTable",
        CT.DataItem => "AXRow",
        // Chromium's page root is a Document; so is a RichEdit control.
        CT.Document => Uia.Str(e, P.FrameworkId) == "Chrome" ? "AXWebArea" : "AXTextArea",
        CT.SplitButton => "AXMenuButton",
        CT.Window => "AXWindow",
        CT.Pane => "AXGroup",
        CT.Header => "AXGroup",
        CT.HeaderItem => "AXButton",
        CT.Table => "AXTable",
        CT.TitleBar => "AXGroup",
        CT.Separator => "AXSplitter",
        CT.SemanticZoom => "AXGroup",
        CT.AppBar => "AXToolbar",
        _ => "AXUnknown",
    };
}

/// <summary>
/// A snapshot of one element's identifying fields — everything the framework's
/// AXNode / ElementSummary carry — read from a cached element in one go.
/// </summary>
sealed class Props
{
    public string Role = "AXUnknown";
    public string? Subrole, Title, Description, Help, Identifier, Placeholder;
    public object? Value;
    public bool? Enabled, Focused, Selected;
    public Rect? Rect;
    public List<string> Actions = new();
    public int ControlType;
    public string ClassName = "";
    public IntPtr Hwnd;
    public uint Pid;
    public bool HasInvoke, HasToggle, HasExpand, HasSelect, HasValue, HasWindow, HasLegacy, HasRange, HasText;
    public string? LegacyDefaultAction;
    public int ExpandState = -1;

    public static Props Read(IUIAutomationElement e, Props? parent)
    {
        var p = new Props();
        p.ControlType = Uia.Int(e, P.ControlType) ?? 0;
        p.ClassName = Uia.Str(e, P.ClassName) ?? "";
        p.Hwnd = new IntPtr(Uia.Int(e, P.NativeWindowHandle) ?? 0);
        p.Pid = (uint)(Uia.Int(e, P.ProcessId) ?? 0);
        p.Role = Roles.Of(p.ControlType, e, parent);

        p.HasInvoke = Uia.Bool(e, P.IsInvokePatternAvailable) == true;
        p.HasToggle = Uia.Bool(e, P.IsTogglePatternAvailable) == true;
        p.HasExpand = Uia.Bool(e, P.IsExpandCollapsePatternAvailable) == true;
        p.HasSelect = Uia.Bool(e, P.IsSelectionItemPatternAvailable) == true;
        p.HasValue = Uia.Bool(e, P.IsValuePatternAvailable) == true;
        p.HasWindow = Uia.Bool(e, P.IsWindowPatternAvailable) == true;
        p.HasLegacy = Uia.Bool(e, P.IsLegacyIAccessiblePatternAvailable) == true;
        p.HasRange = Uia.Bool(e, P.IsRangeValuePatternAvailable) == true;
        p.HasText = Uia.Bool(e, P.IsTextPatternAvailable) == true;
        if (p.HasExpand) p.ExpandState = Uia.Int(e, P.ExpandCollapseState) ?? -1;
        if (p.HasLegacy) p.LegacyDefaultAction = Uia.Str(e, P.LegacyIAccessibleDefaultAction);

        p.Title = Uia.Str(e, P.Name);
        p.Identifier = Uia.Str(e, P.AutomationId);
        p.Help = Uia.Str(e, P.HelpText);
        // WinForms publishes a TextBox's PlaceholderText as its HelpText; that
        // is the closest UIA gets to a placeholder, and it is what `text=`
        // selectors and the recorder expect to find there.
        if (p.ControlType == CT.Edit && p.Help != null) p.Placeholder = p.Help;
        p.Description = Uia.Str(e, P.FullDescription) ?? Uia.Str(e, P.LegacyIAccessibleDescription);
        p.Enabled = Uia.Bool(e, P.IsEnabled);
        p.Focused = Uia.Bool(e, P.HasKeyboardFocus);
        if (p.HasSelect) p.Selected = Uia.Bool(e, P.SelectionItemIsSelected);
        p.Rect = Uia.Rect(e);

        if (p.HasValue) p.Value = Uia.Str(e, P.ValueValue) ?? "";
        else if (p.HasRange) p.Value = Uia.Prop(e, P.RangeValueValue);
        else if (p.HasToggle) p.Value = Uia.Int(e, P.ToggleState) is int t ? (t == 1 ? 1 : 0) : null;
        // A static text's value *is* its label on macOS; mirror that so
        // `text[value="..."]` and shouldHaveText behave the same here.
        else if (p.ControlType == CT.Text) p.Value = p.Title;
        else if (p.HasSelect && p.Selected is bool sel) p.Value = sel ? 1 : 0;

        // Subroles the framework relies on: window kinds, password fields (the
        // macOS name, so `{ subrole: 'AXSecureTextField' }` finds a login
        // form's password box on both platforms), and the title bar buttons
        // `WindowHandle.close()` looks for.
        if (p.ControlType == CT.Edit && Uia.Bool(e, P.IsPassword) == true)
        {
            p.Subrole = "AXSecureTextField";
        }
        else if (p.ControlType == CT.Window)
        {
            var isDialog = Uia.Bool(e, P.IsDialog) == true || p.ClassName == "#32770";
            p.Subrole = isDialog ? "AXDialog" : "AXStandardWindow";
        }
        else if (p.ControlType == CT.Button && parent?.ControlType == CT.TitleBar)
        {
            p.Subrole = p.Identifier switch
            {
                "Close" => "AXCloseButton",
                "Minimize" => "AXMinimizeButton",
                "Maximize" => "AXZoomButton",
                _ => null,
            };
        }
        p.Actions = DeriveActions(p);
        return p;
    }

    /// <summary>
    /// Actions, expressed in macOS vocabulary so `Locator.click()` can keep
    /// asking for AXPress. Invoke, Toggle, ExpandCollapse and SelectionItem all
    /// count as "pressable"; so does anything with an MSAA default action.
    /// </summary>
    static List<string> DeriveActions(Props p)
    {
        var a = new List<string>();
        // Every XAML element reports LegacyIAccessible, so that alone does not
        // make something pressable; a non-empty default action does.
        bool pressable = p.HasInvoke || p.HasToggle || p.HasExpand || p.HasSelect || p.LegacyDefaultAction != null
            || p.ControlType is CT.MenuItem or CT.Button or CT.CheckBox or CT.RadioButton or CT.Hyperlink or CT.TabItem or CT.SplitButton;
        if (pressable) a.Add("AXPress");
        if (p.HasExpand || p.ControlType is CT.MenuItem or CT.ComboBox or CT.SplitButton) a.Add("AXShowMenu");
        if (p.HasWindow) a.Add("AXRaise");
        if (p.HasRange) { a.Add("AXIncrement"); a.Add("AXDecrement"); }
        return a;
    }

    public string Label => Title ?? Description ?? Help ?? "";

    /// <summary>The ElementSummary shape (no children, no ref).</summary>
    public Dictionary<string, object?> Summary()
    {
        var o = new Dictionary<string, object?> { ["role"] = Role };
        if (Subrole != null) o["subrole"] = Subrole;
        if (Title != null) o["title"] = Title;
        if (Description != null) o["description"] = Description;
        if (Help != null) o["help"] = Help;
        if (Identifier != null) o["identifier"] = Identifier;
        if (Placeholder != null) o["placeholder"] = Placeholder;
        if (Value is string sv && sv.Length > 0) o["value"] = sv.Length > 200 ? sv[..200] : sv;
        else if (Value != null && Value is not string) o["value"] = Value.ToString();
        if (Enabled is bool en) o["enabled"] = en;
        if (Rect is Rect r) o["rect"] = r.ToJson();
        return o;
    }
}

/// <summary>
/// Hands the Node side short string refs and keeps the live COM handles here
/// for the helper's lifetime. Entries are either an IUIAutomationElement or a
/// synthetic root (an application, a grafted menu) that has no UIA identity.
/// </summary>
sealed class Registry
{
    public static readonly Registry Shared = new();
    readonly Dictionary<string, object> _store = new();
    int _counter;
    readonly object _lock = new();

    public string Put(object e)
    {
        lock (_lock)
        {
            _counter++;
            var r = $"e{_counter}";
            _store[r] = e;
            return r;
        }
    }

    public object? Get(string r) { lock (_lock) return _store.TryGetValue(r, out var v) ? v : null; }

    public IUIAutomationElement Element(string r)
    {
        var v = Get(r);
        if (v is IUIAutomationElement e) return e;
        if (v == null) throw new OpError("staleRef", $"element ref '{r}' is not known to this helper; re-query the tree");
        throw new OpError("noGeometry", $"ref '{r}' is a synthetic node with no on-screen element");
    }

    /// <summary>Refs are only valid while the UI they point at is alive. Callers re-query after any action that can rebuild the tree.</summary>
    public void Clear() { lock (_lock) _store.Clear(); }
}

/// <summary>
/// One node of the tree the framework sees. Usually wraps a cached UIA element;
/// occasionally synthetic, because Windows has no per-process root element and
/// exposes some menus without the container node macOS would have.
/// </summary>
abstract class Node
{
    public abstract Props Props { get; }
    public abstract IUIAutomationElement? Element { get; }
    public abstract List<Node> Children();
    public abstract string Ref();
    public abstract bool SameAs(Node other);
}

sealed class ElementNode : Node
{
    readonly IUIAutomationElement _el;
    readonly Props _props;
    public ElementNode(IUIAutomationElement el, Props? parent = null)
    {
        _el = el;
        _props = Props.Read(el, parent);
    }
    public override Props Props => _props;
    public override IUIAutomationElement Element => _el;
    public override string Ref() => Registry.Shared.Put(_el);
    public override bool SameAs(Node other) => other is ElementNode o && Uia.Same(_el, o._el);

    public override List<Node> Children()
    {
        var kids = Uia.Children(_el).Select(k => (Node)new ElementNode(k, _props)).ToList();
        if (_props.Role is "AXMenuItem" or "AXMenuBarItem")
        {
            // WinForms and Win32 menus attach an expanded item's entries directly
            // under the item, with no Menu node between. AppKit always has an
            // AXMenu there, and TrayPopup.click waits for one — so graft it.
            if (kids.Count > 0 && kids.All(k => k.Props.Role is "AXMenuItem" or "AXSplitter"))
                return new List<Node> { new SyntheticNode("AXMenu", null, () => kids, new Grafted(_el)) };
            // More often the open submenu is a separate top-level popup window
            // that UIA does not link to the item at all; find it by geometry.
            if (kids.Count == 0)
            {
                var popup = Popups.ForItem(_props);
                var el = popup == IntPtr.Zero ? null : Popups.Element(popup);
                if (el != null) return new List<Node> { new ElementNode(el, _props) };
            }
        }
        return kids;
    }
}

/// <summary>Registry key for a grafted AXMenu, so the ref resolves back to a searchable root.</summary>
sealed record Grafted(IUIAutomationElement Owner);

/// <summary>Registry key for a process root.</summary>
sealed record AppRoot(uint Pid);

sealed class SyntheticNode : Node
{
    readonly Props _props;
    readonly Func<List<Node>> _kids;
    readonly object _key;
    public SyntheticNode(string role, string? title, Func<List<Node>> kids, object key)
    {
        _props = new Props { Role = role, Title = title };
        _kids = kids;
        _key = key;
    }
    public override Props Props => _props;
    public override IUIAutomationElement? Element => null;
    public override List<Node> Children() => _kids();
    public override string Ref() => Registry.Shared.Put(_key);
    public override bool SameAs(Node other) => other is SyntheticNode o && ReferenceEquals(_key, o._key);
}

struct SerializeOptions
{
    public int MaxDepth = 12;
    /// <summary>Menus and browsers can be enormous; a node cap keeps a `tree` call bounded.</summary>
    public int MaxNodes = 4000;
    public SerializeOptions() { }
}

sealed class Serializer
{
    int _emitted;
    readonly SerializeOptions _o;
    public Serializer(SerializeOptions o) { _o = o; }

    public Dictionary<string, object?> Node(Node n, int depth = 0)
    {
        _emitted++;
        var p = n.Props;
        var o = p.Summary();
        o["ref"] = n.Ref();
        if (p.Focused is bool f) o["focused"] = f;
        if (p.Selected is bool s) o["selected"] = s;
        if (p.Actions.Count > 0) o["actions"] = p.Actions;

        if (depth < _o.MaxDepth && _emitted < _o.MaxNodes)
        {
            var kids = n.Children();
            o["childCount"] = kids.Count;
            var ser = new List<object?>(kids.Count);
            foreach (var k in kids)
            {
                if (_emitted >= _o.MaxNodes) { o["truncated"] = true; break; }
                ser.Add(Node(k, depth + 1));
            }
            if (ser.Count > 0) o["children"] = ser;
        }
        else
        {
            // Fetching the count would cost a round trip per leaf; a tree cut
            // at maxDepth reports truncation instead, which is what callers act on.
            o["truncated"] = true;
        }
        return o;
    }
}

enum Step { Continue, SkipChildren, Stop }

static class Walk
{
    /// <summary>Depth-first walk with a node budget. Returns false from `visit` to stop.</summary>
    public static void Run(Node root, int maxDepth, int maxNodes, Func<Node, int, bool> visit)
        => Run(root, maxDepth, maxNodes, (n, d) => visit(n, d) ? Step.Continue : Step.Stop);

    public static void Run(Node root, int maxDepth, Func<Node, int, bool> visit) => Run(root, maxDepth, 20000, visit);

    /// <summary>The same walk, with the option to skip a subtree without ending the search.</summary>
    public static void Run(Node root, int maxDepth, int maxNodes, Func<Node, int, Step> visit)
    {
        int budget = maxNodes;
        bool Rec(Node n, int d)
        {
            if (--budget <= 0) return false;
            var step = visit(n, d);
            if (step == Step.Stop) return false;
            if (step == Step.SkipChildren || d >= maxDepth) return true;
            foreach (var k in n.Children()) if (!Rec(k, d + 1)) return false;
            return true;
        }
        Rec(root, 0);
    }
}
