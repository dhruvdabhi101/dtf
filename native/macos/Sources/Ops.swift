import Foundation
import ApplicationServices
import AppKit
import CoreGraphics

struct OpError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

typealias Args = [String: Any]

// MARK: - Argument helpers

private func requireInt(_ a: Args, _ k: String) throws -> Int {
    guard let v = a[k] as? Int else { throw OpError("badArgs", "missing integer arg '\(k)'") }
    return v
}
private func requireString(_ a: Args, _ k: String) throws -> String {
    guard let v = a[k] as? String else { throw OpError("badArgs", "missing string arg '\(k)'") }
    return v
}
private func requireElement(_ a: Args) throws -> AXUIElement {
    let ref = try requireString(a, "ref")
    guard let e = Registry.shared.get(ref) else {
        throw OpError("staleRef", "element ref '\(ref)' is not known to this helper; re-query the tree")
    }
    return e
}

/// Most ops accept either an app pid or an existing element ref as their root.
private func resolveRoot(_ a: Args) throws -> AXUIElement {
    if let ref = a["ref"] as? String {
        guard let e = Registry.shared.get(ref) else {
            throw OpError("staleRef", "element ref '\(ref)' is stale; re-query the tree")
        }
        return e
    }
    if let pid = a["pid"] as? Int { return appElement(pid: pid_t(pid)) }
    throw OpError("badArgs", "expected either 'pid' or 'ref'")
}

private func center(of e: AXUIElement) throws -> CGPoint {
    guard let p = axPoint(e, kAXPositionAttribute as String),
          let s = axSize(e, kAXSizeAttribute as String) else {
        throw OpError("noGeometry", "element has no on-screen position; it may be offscreen or not yet drawn")
    }
    return CGPoint(x: p.x + s.width / 2, y: p.y + s.height / 2)
}

private func serialize(_ e: AXUIElement, _ a: Args) -> [String: Any] {
    var o = SerializeOptions()
    if let d = a["maxDepth"] as? Int { o.maxDepth = d }
    if let n = a["maxNodes"] as? Int { o.maxNodes = n }
    return Serializer(o).node(e)
}

/// Poll until `check` returns non-nil or the deadline passes.
private func waitFor<T>(timeoutMs: Int, intervalMs: Int = 100, _ check: () -> T?) -> T? {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
    while true {
        if let v = check() { return v }
        if Date() >= deadline { return nil }
        usleep(UInt32(intervalMs * 1000))
    }
}

// MARK: - Dispatch

func dispatch(op: String, args: Args) throws -> Any {
    switch op {

    // ── Health ───────────────────────────────────────────────────────────────
    case "ping":
        return ["ok": true, "pid": ProcessInfo.processInfo.processIdentifier]

    case "perm.accessibility":
        let prompt = args["prompt"] as? Bool ?? false
        if prompt {
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            return ["trusted": AXIsProcessTrustedWithOptions(opts)]
        }
        return ["trusted": AXIsProcessTrusted()]

    case "perm.screenRecording":
        // Preflight is the only non-prompting way to read this.
        return ["granted": CGPreflightScreenCaptureAccess()]

    case "perm.requestScreenRecording":
        return ["requested": CGRequestScreenCaptureAccess()]

    // ── Applications ─────────────────────────────────────────────────────────
    case "app.list":
        let apps = liveApplications().filter { $0.activationPolicy != .prohibited }
        return apps.map { a in
            [
                "pid": Int(a.processIdentifier),
                "name": a.localizedName ?? "",
                "bundleId": a.bundleIdentifier ?? "",
                "active": a.isActive,
                "hidden": a.isHidden,
                "policy": a.activationPolicy == .accessory ? "accessory" : "regular",
            ] as [String: Any]
        }

    case "app.find":
        let apps = findApps(bundleId: args["bundleId"] as? String, name: args["name"] as? String)
        return apps.map { ["pid": Int($0.processIdentifier), "name": $0.localizedName ?? "",
                           "bundleId": $0.bundleIdentifier ?? ""] as [String: Any] }

    case "app.info":
        let pid = try requireInt(args, "pid")
        guard let a = runningApp(pid: pid_t(pid)) else { throw OpError("noApp", "no running app with pid \(pid)") }
        let el = appElement(pid: pid_t(pid))
        return [
            "pid": pid,
            "name": a.localizedName ?? "",
            "bundleId": a.bundleIdentifier ?? "",
            "active": a.isActive,
            "hidden": a.isHidden,
            "terminated": a.isTerminated,
            "windowCount": ((axAttr(el, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []).count,
            "hasMenuBarExtra": axAttr(el, "AXExtrasMenuBar") != nil,
        ]

    case "app.enableElectronAccessibility":
        // Chromium-based apps (Electron, and Chrome itself) do not expose their
        // render tree to the accessibility layer by default — they build it
        // lazily, only once an assistive client asks. Setting
        // AXManualAccessibility on the application element is the documented
        // signal Chromium listens for. Without it, every Electron window looks
        // like an empty box from the outside, which is exactly what makes people
        // conclude that desktop UI "cannot be tested" at the OS level.
        let pid = try requireInt(args, "pid")
        let el = appElement(pid: pid_t(pid))
        let manual = AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        let enhanced = AXUIElementSetAttributeValue(el, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        return [
            "manualAccessibility": manual == .success,
            "enhancedUserInterface": enhanced == .success,
        ]

    case "app.activate":
        let pid = try requireInt(args, "pid")
        guard let a = runningApp(pid: pid_t(pid)) else { throw OpError("noApp", "no running app with pid \(pid)") }
        a.activate(options: [.activateAllWindows])
        return ["ok": true]

    case "app.hide":
        let pid = try requireInt(args, "pid")
        return ["ok": runningApp(pid: pid_t(pid))?.hide() ?? false]

    case "app.terminate":
        let pid = try requireInt(args, "pid")
        guard let a = runningApp(pid: pid_t(pid)) else { return ["ok": true, "alreadyGone": true] }
        let force = args["force"] as? Bool ?? false
        return ["ok": force ? a.forceTerminate() : a.terminate()]

    // ── Tree / query ─────────────────────────────────────────────────────────
    case "tree":
        return serialize(try resolveRoot(args), args)

    case "find":
        let root = try resolveRoot(args)
        let path = parseSelectorPath(args["selector"])
        guard !path.isEmpty else { throw OpError("badArgs", "missing 'selector'") }
        let timeout = args["timeoutMs"] as? Int ?? 0

        if args["all"] as? Bool == true {
            // `all` only ever applies to the final step of the path.
            let scope = path.count > 1 ? axFindPath(root, Array(path.dropLast())) : root
            guard let scope else { return [] }
            let matches = axFindAll(scope, path[path.count - 1])
            return matches.map { serialize($0, args) }
        }

        let found = waitFor(timeoutMs: timeout) { axFindPath(root, path) }
        guard let found else {
            if timeout > 0 { throw OpError("notFound", "no element matched selector within \(timeout)ms") }
            throw OpError("notFound", "no element matched selector")
        }
        return serialize(found, args)

    case "exists":
        let root = try resolveRoot(args)
        let path = parseSelectorPath(args["selector"])
        return ["exists": axFindPath(root, path) != nil]

    // ── Element interaction ──────────────────────────────────────────────────
    case "element.get":
        return serialize(try requireElement(args), args)

    case "element.attributes":
        let e = try requireElement(args)
        var names: CFArray?
        AXUIElementCopyAttributeNames(e, &names)
        var out: [String: Any] = [:]
        for n in (names as? [String]) ?? [] {
            out[n] = axAnyValue(e, n) ?? NSNull()
        }
        return ["attributes": out, "actions": axActions(e)]

    case "element.action":
        let e = try requireElement(args)
        let action = args["action"] as? String ?? kAXPressAction as String
        let available = axActions(e)
        guard available.contains(action) else {
            throw OpError("noAction", "element does not support '\(action)'; it supports \(available)")
        }
        if args["nonBlocking"] as? Bool == true {
            // Pressing anything that opens a menu blocks until that menu closes.
            // Callers that intend to inspect the opened menu ask for a fire-and-
            // forget press and poll for the result themselves.
            DispatchQueue.global(qos: .userInitiated).async {
                AXUIElementPerformAction(e, action as CFString)
            }
            return ["ok": true, "dispatched": true]
        }
        let err = AXUIElementPerformAction(e, action as CFString)
        guard err == .success else {
            throw OpError("actionFailed", "AXUIElementPerformAction(\(action)) failed with code \(err.rawValue)")
        }
        return ["ok": true]

    case "element.setValue":
        let e = try requireElement(args)
        guard let v = args["value"] else { throw OpError("badArgs", "missing 'value'") }
        let cf: CFTypeRef
        if let s = v as? String { cf = s as CFString }
        else if let b = v as? Bool { cf = b as CFBoolean }
        else if let n = v as? NSNumber { cf = n }
        else { throw OpError("badArgs", "unsupported value type") }
        let err = AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, cf)
        guard err == .success else { throw OpError("setValueFailed", "code \(err.rawValue)") }
        return ["ok": true]

    case "element.click":
        let e = try requireElement(args)
        Input.click(try center(of: e),
                    button: args["button"] as? String ?? "left",
                    count: args["count"] as? Int ?? 1,
                    modifiers: args["modifiers"] as? [String] ?? [])
        return ["ok": true]

    case "element.hover":
        Input.move(try center(of: try requireElement(args)))
        return ["ok": true]

    case "element.focus":
        let e = try requireElement(args)
        AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        return ["ok": true]

    case "element.rect":
        let e = try requireElement(args)
        guard let p = axPoint(e, kAXPositionAttribute as String),
              let s = axSize(e, kAXSizeAttribute as String) else {
            throw OpError("noGeometry", "element has no position/size")
        }
        return ["x": p.x, "y": p.y, "width": s.width, "height": s.height]

    // ── Menu bar extras (the "tray") ─────────────────────────────────────────
    case "tray.list":
        return trayItems(pid: args["pid"] as? Int)

    case "tray.open":
        return try trayOpen(args)

    case "tray.close":
        // Escape reliably dismisses a tracking menu; AXCancel does not always.
        _ = Input.key("escape")
        return ["ok": true]

    // ── Application menu bar ─────────────────────────────────────────────────
    case "menu.tree":
        let pid = try requireInt(args, "pid")
        guard let bar = axAttr(appElement(pid: pid_t(pid)), kAXMenuBarAttribute as String) else {
            throw OpError("noMenuBar", "app \(pid) exposes no AXMenuBar")
        }
        var a = args; a["maxDepth"] = args["maxDepth"] as? Int ?? 4
        return serialize(bar as! AXUIElement, a)

    case "menu.click":
        return try menuClick(args)

    // ── Windows ──────────────────────────────────────────────────────────────
    case "window.list":
        let pid = try requireInt(args, "pid")
        let el = appElement(pid: pid_t(pid))
        let wins = (axAttr(el, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
        return wins.enumerated().map { (i, w) -> [String: Any] in
            var o: [String: Any] = [
                "index": i,
                "ref": Registry.shared.put(w),
                "title": axString(w, kAXTitleAttribute as String) ?? "",
                "subrole": axString(w, kAXSubroleAttribute as String) ?? "",
                "minimized": axBool(w, kAXMinimizedAttribute as String) ?? false,
                "main": axBool(w, kAXMainAttribute as String) ?? false,
                "focused": axBool(w, kAXFocusedAttribute as String) ?? false,
            ]
            if let p = axPoint(w, kAXPositionAttribute as String), let s = axSize(w, kAXSizeAttribute as String) {
                o["rect"] = ["x": p.x, "y": p.y, "width": s.width, "height": s.height]
                if let wid = cgWindowId(pid: pid_t(pid), rect: CGRect(origin: p, size: s)) { o["windowId"] = wid }
            }
            if let sheets = axAttr(w, "AXSheets") as? [AXUIElement], !sheets.isEmpty {
                o["sheetCount"] = sheets.count
            }
            return o
        }

    case "window.setBounds":
        let e = try requireElement(args)
        if let x = args["x"] as? Double, let y = args["y"] as? Double {
            var p = CGPoint(x: x, y: y)
            if let v = AXValueCreate(.cgPoint, &p) {
                AXUIElementSetAttributeValue(e, kAXPositionAttribute as CFString, v)
            }
        }
        if let w = args["width"] as? Double, let h = args["height"] as? Double {
            var s = CGSize(width: w, height: h)
            if let v = AXValueCreate(.cgSize, &s) {
                AXUIElementSetAttributeValue(e, kAXSizeAttribute as CFString, v)
            }
        }
        return ["ok": true]

    case "window.setMinimized":
        let e = try requireElement(args)
        let on = args["minimized"] as? Bool ?? true
        AXUIElementSetAttributeValue(e, kAXMinimizedAttribute as CFString, (on ? kCFBooleanTrue : kCFBooleanFalse))
        return ["ok": true]

    // ── Notifications ────────────────────────────────────────────────────────
    case "notification.list":
        return notificationList()

    case "notification.act":
        return try notificationAct(args)

    // ── Dialogs, sheets, and the open/save panel ──────────────────────────────
    case "dialog.list":
        return dialogList(pid: args["pid"] as? Int)

    // ── Raw input ────────────────────────────────────────────────────────────
    case "key":
        let combo = try requireString(args, "combo")
        guard Input.key(combo) else { throw OpError("badKey", "could not parse key combo '\(combo)'") }
        return ["ok": true]

    case "type":
        Input.type(try requireString(args, "text"), delayMs: args["delayMs"] as? Int ?? 8)
        return ["ok": true]

    case "click":
        let x = args["x"] as? Double ?? 0, y = args["y"] as? Double ?? 0
        Input.click(CGPoint(x: x, y: y),
                    button: args["button"] as? String ?? "left",
                    count: args["count"] as? Int ?? 1,
                    modifiers: args["modifiers"] as? [String] ?? [])
        return ["ok": true]

    case "move":
        Input.move(CGPoint(x: args["x"] as? Double ?? 0, y: args["y"] as? Double ?? 0))
        return ["ok": true]

    case "drag":
        Input.drag(from: CGPoint(x: args["fromX"] as? Double ?? 0, y: args["fromY"] as? Double ?? 0),
                   to: CGPoint(x: args["toX"] as? Double ?? 0, y: args["toY"] as? Double ?? 0))
        return ["ok": true]

    case "scroll":
        Input.scroll(CGPoint(x: args["x"] as? Double ?? 0, y: args["y"] as? Double ?? 0),
                     dx: args["dx"] as? Int ?? 0, dy: args["dy"] as? Int ?? 0)
        return ["ok": true]

    case "mouse.location":
        let p = Input.mouseLocation
        return ["x": p.x, "y": p.y]

    case "screen.info":
        return NSScreen.screens.map { s in
            [
                "frame": ["x": s.frame.origin.x, "y": s.frame.origin.y,
                          "width": s.frame.width, "height": s.frame.height],
                "scale": s.backingScaleFactor,
                "main": s == NSScreen.main,
            ] as [String: Any]
        }

    // ── Recording ────────────────────────────────────────────────────────────
    case "record.start":
        try Recorder.shared.start()
        return ["ok": true]

    case "record.stop":
        Recorder.shared.stop()
        return ["ok": true]

    case "record.pick":
        // The next left click is swallowed and reported as a `pick` event
        // instead of reaching the app — how the recorder selects an element
        // to assert on without also clicking it.
        guard Recorder.shared.running else { throw OpError("notRecording", "record.start first") }
        Recorder.shared.pickArmed = args["armed"] as? Bool ?? true
        return ["ok": true, "armed": Recorder.shared.pickArmed]

    case "element.atPoint":
        let x = args["x"] as? Double ?? Double(args["x"] as? Int ?? 0)
        let y = args["y"] as? Double ?? Double(args["y"] as? Int ?? 0)
        guard let e = elementAt(CGPoint(x: x, y: y)) else {
            throw OpError("notFound", "no accessible element at (\(x), \(y))")
        }
        var d = describe(e)
        d["ref"] = Registry.shared.put(e)
        return d

    default:
        throw OpError("unknownOp", "unknown op '\(op)'")
    }
}

// MARK: - Menu bar extras

/// Every status item ("tray icon") on macOS lives in its owning app's
/// AXExtrasMenuBar, not in a shared system process. Enumerating apps and reading
/// that attribute is the only reliable way to see them all.
func trayItems(pid: Int?) -> [[String: Any]] {
    var out: [[String: Any]] = []
    // A pid is looked up directly rather than filtered out of the workspace
    // list: the direct lookup is authoritative and never stale.
    let apps: [NSRunningApplication]
    if let p = pid {
        apps = runningApp(pid: pid_t(p)).map { [$0] } ?? []
    } else {
        apps = liveApplications().filter { $0.activationPolicy != .prohibited }
    }
    for app in apps {
        let el = appElement(pid: app.processIdentifier)
        guard let extras = axAttr(el, "AXExtrasMenuBar") else { continue }
        let bar = extras as! AXUIElement
        for (i, item) in axChildren(bar).enumerated() {
            var o: [String: Any] = [
                "ref": Registry.shared.put(item),
                "index": i,
                "pid": Int(app.processIdentifier),
                "app": app.localizedName ?? "",
                "bundleId": app.bundleIdentifier ?? "",
                "role": axString(item, kAXRoleAttribute as String) ?? "",
                "actions": axActions(item),
            ]
            // Status items rarely set a title; the label usually lands in
            // AXDescription (accessibilityLabel) or AXHelp (tooltip).
            if let v = axString(item, kAXTitleAttribute as String), !v.isEmpty { o["title"] = v }
            if let v = axString(item, kAXDescriptionAttribute as String), !v.isEmpty { o["description"] = v }
            if let v = axString(item, kAXHelpAttribute as String), !v.isEmpty { o["help"] = v }
            if let v = axString(item, kAXIdentifierAttribute as String), !v.isEmpty { o["identifier"] = v }
            if let p = axPoint(item, kAXPositionAttribute as String),
               let s = axSize(item, kAXSizeAttribute as String) {
                o["rect"] = ["x": p.x, "y": p.y, "width": s.width, "height": s.height]
            }
            o["label"] = (o["title"] as? String) ?? (o["description"] as? String) ?? (o["help"] as? String) ?? ""
            out.append(o)
        }
    }
    return out
}

/// Opens a status item and returns whatever it produced.
///
/// Status items behave in two different ways and tests should not have to care:
/// an NSMenu attaches an AXMenu child to the item, while a popover/custom window
/// shows up as a new window on the owning app. We wait for either.
func trayOpen(_ args: Args) throws -> [String: Any] {
    let item: AXUIElement
    if let ref = args["ref"] as? String {
        guard let e = Registry.shared.get(ref) else { throw OpError("staleRef", "stale tray ref '\(ref)'") }
        item = e
    } else {
        throw OpError("badArgs", "tray.open needs a 'ref' from tray.list")
    }
    guard let pid = axPid(item) else { throw OpError("noApp", "tray item has no owning process") }

    let appEl = appElement(pid: pid)
    let windowsBefore = Set(((axAttr(appEl, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [])
        .map { ObjectIdentifier($0 as AnyObject) })

    let button = args["button"] as? String ?? "left"
    if button == "right" || args["useMouse"] as? Bool == true {
        // Right-click menus and some Electron trays only respond to real clicks.
        guard let p = axPoint(item, kAXPositionAttribute as String),
              let s = axSize(item, kAXSizeAttribute as String) else {
            throw OpError("noGeometry", "tray item is not on screen")
        }
        Input.click(CGPoint(x: p.x + s.width / 2, y: p.y + s.height / 2), button: button)
    } else {
        // Pressing a status item that owns an NSMenu does not return until the
        // menu closes: AppKit runs a modal tracking loop inside the action, and
        // the accessibility call eventually gives up with kAXErrorCannotComplete
        // (-25204) even though the menu opened correctly. Dispatching the press
        // and polling for the result is the only way to observe an open menu.
        DispatchQueue.global(qos: .userInitiated).async {
            AXUIElementPerformAction(item, kAXPressAction as CFString)
        }
    }

    let timeout = args["timeoutMs"] as? Int ?? 3000
    let deadline = Date().addingTimeInterval(Double(timeout) / 1000)

    while Date() < deadline {
        // 1. NSMenu case — an AXMenu child appears under the status item.
        if let menu = axChildren(item).first(where: { axString($0, kAXRoleAttribute as String) == "AXMenu" }) {
            var o = SerializeOptions(); o.maxDepth = args["maxDepth"] as? Int ?? 6
            return ["kind": "menu", "root": Serializer(o).node(menu)]
        }
        // 2. Popover/panel case — a window the app did not have before.
        let now = (axAttr(appEl, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
        if let fresh = now.first(where: { !windowsBefore.contains(ObjectIdentifier($0 as AnyObject)) }) {
            var o = SerializeOptions(); o.maxDepth = args["maxDepth"] as? Int ?? 8
            return ["kind": "window", "root": Serializer(o).node(fresh)]
        }
        usleep(100_000)
    }
    throw OpError("trayNoContent",
                  "tray item was pressed but produced no menu or window within \(timeout)ms")
}

// MARK: - Application menu

/// Walks a titled path like ["File", "New", "Window"] through the app menu bar
/// and presses the leaf. Submenus are traversed structurally rather than by
/// hovering, so this does not depend on menu tracking timing.
func menuClick(_ args: Args) throws -> [String: Any] {
    let pid = args["pid"] as? Int ?? 0
    guard let path = args["path"] as? [String], !path.isEmpty else {
        throw OpError("badArgs", "menu.click needs a non-empty 'path'")
    }
    guard let barRef = axAttr(appElement(pid: pid_t(pid)), kAXMenuBarAttribute as String) else {
        throw OpError("noMenuBar", "app \(pid) exposes no AXMenuBar")
    }

    var current = barRef as! AXUIElement
    for (i, title) in path.enumerated() {
        let isLeaf = i == path.count - 1
        // Menu items hang off an AXMenu child, except at the menu bar itself.
        let container: AXUIElement = {
            if i == 0 { return current }
            return axChildren(current).first { axString($0, kAXRoleAttribute as String) == "AXMenu" } ?? current
        }()
        guard let match = axChildren(container).first(where: {
            axString($0, kAXTitleAttribute as String) == title
        }) else {
            let available = axChildren(container).compactMap { axString($0, kAXTitleAttribute as String) }
                .filter { !$0.isEmpty }
            throw OpError("menuItemNotFound",
                          "no menu item titled '\(title)' at path \(path.prefix(i + 1).joined(separator: " > ")); available: \(available)")
        }
        if isLeaf {
            if axBool(match, kAXEnabledAttribute as String) == false {
                throw OpError("menuItemDisabled", "menu item '\(title)' is disabled")
            }
            let err = AXUIElementPerformAction(match, kAXPressAction as CFString)
            guard err == .success else { throw OpError("actionFailed", "press '\(title)' failed (\(err.rawValue))") }
            return ["ok": true, "clicked": path.joined(separator: " > ")]
        }
        current = match
    }
    throw OpError("menuItemNotFound", "unreachable")
}

// MARK: - Notifications

/// Reads currently-visible banners and Notification Center entries from the
/// notificationcenterui process's accessibility tree.
///
/// This is deliberately not the usernoted SQLite database: that file is
/// TCC-protected and needs Full Disk Access, whereas the AX route only needs the
/// Accessibility permission the framework already requires.
func notificationList() -> [[String: Any]] {
    guard let nc = liveApplications()
        .first(where: { $0.bundleIdentifier == "com.apple.notificationcenterui" }) else { return [] }
    let el = appElement(pid: nc.processIdentifier)
    var out: [[String: Any]] = []

    for window in (axAttr(el, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [] {
        axWalk(window, maxDepth: 12) { e, _ in
            guard axString(e, kAXRoleAttribute as String) == "AXGroup",
                  let desc = axString(e, kAXDescriptionAttribute as String), !desc.isEmpty else { return true }

            // The banner group's AXDescription is the flattened
            // "App, Title, Subtitle, Body" string; the child static texts hold
            // the same fields individually and are more reliable to assert on.
            var texts: [String] = []
            axWalk(e, maxDepth: 6) { c, _ in
                if axString(c, kAXRoleAttribute as String) == "AXStaticText",
                   let v = axString(c, kAXValueAttribute as String), !v.isEmpty {
                    texts.append(v)
                }
                return true
            }
            guard !texts.isEmpty else { return true }

            var buttons: [[String: Any]] = []
            axWalk(e, maxDepth: 6) { c, _ in
                if axString(c, kAXRoleAttribute as String) == "AXButton" {
                    buttons.append([
                        "ref": Registry.shared.put(c),
                        "title": axString(c, kAXTitleAttribute as String)
                            ?? axString(c, kAXDescriptionAttribute as String) ?? "",
                    ])
                }
                return true
            }

            let parts = desc.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            out.append([
                "ref": Registry.shared.put(e),
                "index": out.count,
                "app": parts.first ?? "",
                "title": texts.count > 0 ? texts[0] : "",
                "subtitle": texts.count > 2 ? texts[1] : "",
                "body": texts.count > 2 ? texts[2] : (texts.count > 1 ? texts[1] : ""),
                "texts": texts,
                "raw": desc,
                "buttons": buttons,
                "actions": axActions(e),
            ])
            return true
        }
    }
    return out
}

func notificationAct(_ args: Args) throws -> [String: Any] {
    let list = notificationList()
    let idx = args["index"] as? Int ?? 0
    guard idx < list.count, let ref = list[idx]["ref"] as? String,
          let e = Registry.shared.get(ref) else {
        throw OpError("noNotification", "no notification at index \(idx) (\(list.count) visible)")
    }
    let action = args["action"] as? String ?? "press"

    switch action {
    case "press", "click":
        // Notifications respond to a real click far more reliably than AXPress.
        guard let p = axPoint(e, kAXPositionAttribute as String),
              let s = axSize(e, kAXSizeAttribute as String) else {
            throw OpError("noGeometry", "notification is not on screen")
        }
        Input.click(CGPoint(x: p.x + s.width / 2, y: p.y + s.height / 2))
        return ["ok": true]

    case "close", "dismiss":
        // Close/action buttons only materialise while the pointer is over the banner.
        if let p = axPoint(e, kAXPositionAttribute as String), let s = axSize(e, kAXSizeAttribute as String) {
            Input.move(CGPoint(x: p.x + s.width / 2, y: p.y + s.height / 2))
            usleep(400_000)
        }
        let refreshed = notificationList()
        guard idx < refreshed.count else { return ["ok": true, "alreadyGone": true] }
        let buttons = (refreshed[idx]["buttons"] as? [[String: Any]]) ?? []
        let closeTitles = ["Close", "Clear", "Dismiss"]
        if let close = buttons.first(where: { closeTitles.contains(($0["title"] as? String) ?? "") }),
           let bref = close["ref"] as? String, let be = Registry.shared.get(bref) {
            AXUIElementPerformAction(be, kAXPressAction as CFString)
            return ["ok": true]
        }
        throw OpError("noCloseButton", "no close button on notification \(idx); buttons: \(buttons.map { $0["title"] ?? "" })")

    default:
        // Treat any other action string as a named button on the banner.
        if let p = axPoint(e, kAXPositionAttribute as String), let s = axSize(e, kAXSizeAttribute as String) {
            Input.move(CGPoint(x: p.x + s.width / 2, y: p.y + s.height / 2))
            usleep(400_000)
        }
        let refreshed = notificationList()
        guard idx < refreshed.count else { throw OpError("noNotification", "notification disappeared") }
        let buttons = (refreshed[idx]["buttons"] as? [[String: Any]]) ?? []
        guard let btn = buttons.first(where: { ($0["title"] as? String) == action }),
              let bref = btn["ref"] as? String, let be = Registry.shared.get(bref) else {
            throw OpError("noButton", "no notification button '\(action)'; available: \(buttons.map { $0["title"] ?? "" })")
        }
        AXUIElementPerformAction(be, kAXPressAction as CFString)
        return ["ok": true]
    }
}

// MARK: - Dialogs

/// Native modals show up in three different places depending on how the app is
/// built, and a test should not have to know which:
///   * an AXSheet attached to one of the app's own windows,
///   * a standalone AXDialog/AXSystemDialog window on the app,
///   * a window on a *different* process entirely — sandboxed apps get their
///     open/save panels from com.apple.appkit.xpc.openAndSavePanelService.
func dialogList(pid: Int?) -> [[String: Any]] {
    var out: [[String: Any]] = []

    func describe(_ w: AXUIElement, kind: String, owner: NSRunningApplication) {
        var o = SerializeOptions(); o.maxDepth = 8; o.maxNodes = 1200
        var entry: [String: Any] = [
            "kind": kind,
            "ref": Registry.shared.put(w),
            "pid": Int(owner.processIdentifier),
            "app": owner.localizedName ?? "",
            "bundleId": owner.bundleIdentifier ?? "",
            "title": axString(w, kAXTitleAttribute as String) ?? "",
            "subrole": axString(w, kAXSubroleAttribute as String) ?? "",
        ]
        var buttons: [[String: Any]] = []
        var texts: [String] = []
        axWalk(w, maxDepth: 10) { e, _ in
            let role = axString(e, kAXRoleAttribute as String)
            if role == "AXButton" {
                buttons.append([
                    "ref": Registry.shared.put(e),
                    "title": axString(e, kAXTitleAttribute as String)
                        ?? axString(e, kAXDescriptionAttribute as String) ?? "",
                    "enabled": axBool(e, kAXEnabledAttribute as String) ?? true,
                ])
            } else if role == "AXStaticText", let v = axString(e, kAXValueAttribute as String), !v.isEmpty {
                texts.append(v)
            }
            return true
        }
        entry["buttons"] = buttons
        entry["texts"] = texts
        entry["root"] = Serializer(o).node(w)
        out.append(entry)
    }

    let apps = liveApplications().filter { app in
        if let p = pid {
            // Always include the panel service: for a sandboxed app under test,
            // its save dialog belongs to that process, not to the app's pid.
            return app.processIdentifier == pid_t(p)
                || app.bundleIdentifier == "com.apple.appkit.xpc.openAndSavePanelService"
        }
        return app.activationPolicy != .prohibited
    }

    var seen = Set<String>()
    func describeOnce(_ w: AXUIElement, kind: String, owner: NSRunningApplication) {
        // A sheet is reachable both as an AXSheets entry and as a child node, so
        // identity-dedupe before reporting it.
        let key = "\(owner.processIdentifier):\(axString(w, kAXTitleAttribute as String) ?? "")" +
            ":\(axPoint(w, kAXPositionAttribute as String)?.debugDescription ?? "")"
        if seen.contains(key) { return }
        seen.insert(key)
        describe(w, kind: kind, owner: owner)
    }

    for app in apps {
        let el = appElement(pid: app.processIdentifier)
        let isPanelService = app.bundleIdentifier == "com.apple.appkit.xpc.openAndSavePanelService"

        for w in (axAttr(el, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [] {
            // Sheets are exposed inconsistently: AppKit publishes an AXSheets
            // attribute on some windows, and on others the sheet only appears as
            // an AXSheet child node. Both are checked.
            for sheet in (axAttr(w, "AXSheets") as? [AXUIElement]) ?? [] {
                describeOnce(sheet, kind: "sheet", owner: app)
            }
            axWalk(w, maxDepth: 3) { e, d in
                if d > 0, axString(e, kAXRoleAttribute as String) == "AXSheet" {
                    describeOnce(e, kind: "sheet", owner: app)
                }
                return true
            }

            let subrole = axString(w, kAXSubroleAttribute as String) ?? ""
            let identifier = axString(w, kAXIdentifierAttribute as String) ?? ""

            // A non-sandboxed app hosts its own open/save panel in-process,
            // where it is an ordinary AXStandardWindow and would otherwise look
            // like any other window. A sandboxed app gets the same panel from
            // the system XPC service, under a different pid entirely. Apple sets
            // a stable identifier in both cases, so match on that.
            if isPanelService || identifier == "save-panel" || identifier == "open-panel" {
                describeOnce(w, kind: "filePanel", owner: app)
            } else if subrole == "AXDialog" || subrole == "AXSystemDialog" {
                describeOnce(w, kind: "dialog", owner: app)
            }
        }
    }
    return out
}

// MARK: - CGWindowID lookup

/// Matches an AX window to its CGWindowID by owner pid and bounds so the Node
/// side can hand the id to `screencapture -l` for a window-scoped screenshot.
func cgWindowId(pid: pid_t, rect: CGRect) -> Int? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] else { return nil }
    for info in list {
        guard let owner = info[kCGWindowOwnerPID as String] as? Int, pid_t(owner) == pid,
              let b = info[kCGWindowBounds as String] as? [String: Any],
              let id = info[kCGWindowNumber as String] as? Int else { continue }
        let x = (b["X"] as? Double) ?? 0, y = (b["Y"] as? Double) ?? 0
        let w = (b["Width"] as? Double) ?? 0, h = (b["Height"] as? Double) ?? 0
        if abs(x - rect.origin.x) < 4 && abs(y - rect.origin.y) < 4
            && abs(w - rect.width) < 4 && abs(h - rect.height) < 4 {
            return id
        }
    }
    return nil
}
