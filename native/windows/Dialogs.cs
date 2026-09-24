using System.Diagnostics;
using Interop.UIAutomationClient;
using static Dtf.Native;

namespace Dtf;

/// <summary>Registry key for a dialog the OS will not let us drive (UAC on the secure desktop).</summary>
sealed record Unautomatable(string Title);

/// <summary>
/// Native modals. Simpler than macOS: a dialog is a top-level window, in the
/// app's own process (file pickers included — IFileDialog runs in-process).
/// Detected by window class `#32770`, by UIA's IsDialog property, or by the
/// one signal WinForms/WPF modals share with everything else: a modal dialog
/// disables its owner window while it is up.
///
/// There is no sheet on Windows; `kind: 'sheet'` never occurs.
/// </summary>
static class Dialogs
{
    public static List<Dictionary<string, object?>> List(uint? pid)
    {
        var out_ = new List<Dictionary<string, object?>>();
        var wins = pid is uint p ? Apps.Windows(p, includeTools: true) : Apps.AllVisibleWindows();
        foreach (var h in wins)
        {
            if (!Apps.IsDialogWindow(h))
            {
                var probe = Uia.FromHandle(h);
                if (probe == null || Uia.Bool(probe, P.IsDialog) != true) continue;
            }
            var el = Uia.FromHandle(h);
            if (el == null) continue;
            var d = Describe.DialogEntry(el, h);
            if (d != null) out_.Add(d);
        }

        // A UAC prompt lives on the secure desktop: no UIA, no input, no way
        // to answer it from here. Report it so a test fails with the reason
        // instead of waiting for a dialog that never becomes visible.
        if (pid == null || true)
        {
            foreach (var proc in Process.GetProcessesByName("consent"))
            {
                using (proc)
                {
                    out_.Add(new()
                    {
                        ["kind"] = "dialog",
                        ["ref"] = Registry.Shared.Put(new Unautomatable("User Account Control")),
                        ["pid"] = proc.Id,
                        ["app"] = "consent.exe",
                        ["bundleId"] = "consent.exe",
                        ["title"] = "User Account Control",
                        ["subrole"] = "AXSystemDialog",
                        ["buttons"] = new List<object?>(),
                        ["texts"] = new List<object?> { "A UAC elevation prompt is showing on the secure desktop. It cannot be automated; answer it by hand or run the app non-elevated." },
                        ["root"] = new Dictionary<string, object?> { ["role"] = "AXWindow", ["title"] = "User Account Control" },
                        ["automatable"] = false,
                    });
                }
            }
        }
        return out_;
    }

    /// <summary>
    /// Types a path into a file picker's filename box and confirms.
    ///
    /// IFileDialog's "File name:" control is an Edit with AutomationId 1001
    /// inside a ComboBox (1148); setting its value and pressing Enter is what a
    /// user does, and it accepts a full path — no Go-To-Folder detour needed.
    /// </summary>
    public static Dictionary<string, object?> SetFilePath(IUIAutomationElement dialog, string path)
    {
        var root = new ElementNode(Uia.Refresh(dialog) ?? dialog);
        Node? field = null;
        Walk.Run(root, 12, 3000, (n, _) =>
        {
            var p = n.Props;
            if (p.ControlType == CT.Edit && (p.Identifier == "1001" || Uia.Ci(p.Title, "File name") || Uia.Ci(p.Title, "Filename") || Uia.Ci(p.Title, "Folder:")))
            { field = n; return false; }
            return true;
        });
        if (field == null)
        {
            Walk.Run(root, 12, 3000, (n, _) => { if (n.Props.ControlType == CT.Edit && n.Props.Enabled != false) { field = n; return false; } return true; });
        }
        if (field?.Element == null) throw new OpError("notFound", "no filename field in this dialog");
        var h = Apps.TopLevelHwndOf(field.Element);
        if (h != IntPtr.Zero) Apps.Activate(Pid(h));
        try { field.Element.SetFocus(); } catch { }
        Thread.Sleep(100);
        // Typed, not set: ValuePattern.SetValue writes the edit's text but the
        // dialog's autocomplete keeps its own idea of the name and saves the
        // old one. Keystrokes update both, exactly as a user would.
        Input.Key("ctrl+a");
        Input.Type(path, 4);
        Thread.Sleep(150);
        Input.Key("enter");
        return new() { ["ok"] = true };
    }
}
