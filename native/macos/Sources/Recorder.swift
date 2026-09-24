import Foundation
import ApplicationServices
import AppKit
import CoreGraphics

// MARK: - Recorder
//
// Watches real user input through a CGEvent tap and reports *what* was
// interacted with, not where. Every mouse-down is resolved to the accessibility
// element under the pointer, along with its ancestry and the OS surface it
// belongs to (tray, tray menu, menu bar, dialog, notification, window). The
// Node side turns that into test steps; this file only observes.
//
// Events are pushed asynchronously on stdout as
//   {"event": "record", "data": {...}}
// interleaved with ordinary responses. That is safe because every write goes
// through `emit`, which serialises on a lock.
//
// Two design constraints shape the code:
//
//  * The tap callback runs on the input path. Anything slow in it — and an AX
//    query into a busy app can take seconds — freezes the user's mouse and
//    keyboard system-wide. So the callback only copies the event's scalars and
//    hands them to a serial queue; the accessibility lookup happens there.
//
//  * macOS disables a tap whose callback is too slow, and does so silently.
//    The callback re-enables it when it sees `tapDisabledByTimeout`.

final class Recorder {
    static let shared = Recorder()

    private var tap: CFMachPort?
    private var thread: Thread?
    private var runLoop: CFRunLoop?
    private let queue = DispatchQueue(label: "dtf.recorder", qos: .userInitiated)
    private let stateLock = NSLock()
    private var _pickArmed = false
    private var swallowingPickUp = false
    private var seq = 0

    private(set) var running = false

    var pickArmed: Bool {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _pickArmed }
        set { stateLock.lock(); _pickArmed = newValue; stateLock.unlock() }
    }

    func start() throws {
        if running { return }
        let mask: CGEventMask =
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.leftMouseUp.rawValue) |
            (1 << CGEventType.rightMouseDown.rawValue) |
            (1 << CGEventType.rightMouseUp.rawValue) |
            (1 << CGEventType.keyDown.rawValue)

        // A .defaultTap (rather than .listenOnly) is what lets pick mode swallow
        // the click that selects an element for an assertion.
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: recorderTapCallback,
            userInfo: nil
        ) else {
            throw OpError("tapFailed",
                          "could not create an event tap. The process running dtf needs the Accessibility " +
                          "permission (and on recent macOS, Input Monitoring) to record.")
        }
        self.tap = tap

        let ready = DispatchSemaphore(value: 0)
        let t = Thread { [weak self] in
            guard let self else { return }
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            self.runLoop = CFRunLoopGetCurrent()
            CFRunLoopAddSource(self.runLoop, source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            ready.signal()
            CFRunLoopRun()
        }
        t.name = "dtf.recorder.tap"
        t.start()
        thread = t
        _ = ready.wait(timeout: .now() + 2)
        running = true
    }

    func stop() {
        guard running else { return }
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let rl = runLoop { CFRunLoopStop(rl) }
        tap = nil
        runLoop = nil
        thread = nil
        running = false
        pickArmed = false
    }

    fileprivate func reenable() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
    }

    /// Called on the tap thread. Must stay cheap. Returns true to swallow.
    fileprivate func handle(type: CGEventType, event: CGEvent) -> Bool {
        let loc = event.location
        let flags = modifierNames(event.flags)

        switch type {
        case .leftMouseDown, .rightMouseDown:
            let isPick = pickArmed && type == .leftMouseDown
            if isPick {
                pickArmed = false
                swallowingPickUp = true
            }
            let button = type == .rightMouseDown ? "right" : "left"
            let count = Int(event.getIntegerValueField(.mouseEventClickState))
            let n = nextSeq()
            queue.async { self.describeClick(seq: n, at: loc, button: button, count: count,
                                             modifiers: flags, pick: isPick) }
            return isPick

        case .leftMouseUp, .rightMouseUp:
            if swallowingPickUp && type == .leftMouseUp {
                swallowingPickUp = false
                return true
            }
            return false

        case .keyDown:
            let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
            var len = 0
            var chars = [UniChar](repeating: 0, count: 8)
            event.keyboardGetUnicodeString(maxStringLength: 8, actualStringLength: &len, unicodeString: &chars)
            let text = String(utf16CodeUnits: chars, count: len)
            let target = Int(event.getIntegerValueField(.eventTargetUnixProcessID))
            let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
            let n = nextSeq()
            queue.async { self.describeKey(seq: n, keyCode: keyCode, text: text, modifiers: flags,
                                           targetPid: target, isRepeat: isRepeat) }
            return false

        default:
            return false
        }
    }

    private func nextSeq() -> Int {
        stateLock.lock(); defer { stateLock.unlock() }
        seq += 1
        return seq
    }

    // MARK: Describing events (recorder queue)

    private func describeClick(seq: Int, at p: CGPoint, button: String, count: Int,
                               modifiers: [String], pick: Bool) {
        var data: [String: Any] = [
            "seq": seq,
            "type": pick ? "pick" : "click",
            "button": button,
            "count": max(1, count),
            "modifiers": modifiers,
            "x": p.x, "y": p.y,
            "at": Date().timeIntervalSince1970 * 1000,
        ]
        if let el = elementAt(p) {
            data.merge(describe(el), uniquingKeysWith: { a, _ in a })
        } else {
            data["surface"] = "unknown"
        }
        emitEvent(data)
    }

    private func describeKey(seq: Int, keyCode: CGKeyCode, text: String, modifiers: [String],
                             targetPid rawPid: Int, isRepeat: Bool) {
        // The tap does not always annotate key events with their target. The
        // system-wide focused application is the authoritative fallback (and,
        // unlike NSWorkspace.frontmostApplication, is never a stale snapshot).
        var targetPid = rawPid
        if targetPid <= 0 {
            let sys = AXUIElementCreateSystemWide()
            AXUIElementSetMessagingTimeout(sys, 0.5)
            if let f = axAttr(sys, kAXFocusedApplicationAttribute as String), let p = axPid(f as! AXUIElement) {
                targetPid = Int(p)
            }
        }
        var data: [String: Any] = [
            "seq": seq,
            "type": "key",
            "key": keyName(keyCode) ?? text.lowercased(),
            "text": text,
            "modifiers": modifiers,
            "repeat": isRepeat,
            "pid": targetPid,
            "at": Date().timeIntervalSince1970 * 1000,
        ]
        if let app = runningApp(pid: pid_t(targetPid)) {
            data["app"] = app.localizedName ?? ""
            data["bundleId"] = app.bundleIdentifier ?? ""
        }
        // The focused element is what typed text lands in; the Node side uses it
        // to turn a run of keystrokes into `find(field).fill(text)`.
        if targetPid > 0 {
            let appEl = appElement(pid: pid_t(targetPid))
            AXUIElementSetMessagingTimeout(appEl, 0.5)
            if let f = axAttr(appEl, kAXFocusedUIElementAttribute as String) {
                let fe = f as! AXUIElement
                data["focus"] = describe(fe)
            }
        }
        emitEvent(data)
    }

    private func emitEvent(_ data: [String: Any]) {
        emit(["event": "record", "data": data])
    }
}

// MARK: - Element description

/// The accessibility element under a screen point, or nil.
///
/// The system-wide element answers across every process. It gets a short
/// messaging timeout: a hung app would otherwise stall the recorder queue for
/// the AX default of six seconds per click.
func elementAt(_ p: CGPoint) -> AXUIElement? {
    let sys = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(sys, 0.5)
    var el: AXUIElement?
    guard AXUIElementCopyElementAtPosition(sys, Float(p.x), Float(p.y), &el) == .success else { return nil }
    return el
}

/// The fields that identify an element in a selector, without its subtree.
func elementSummary(_ e: AXUIElement) -> [String: Any] {
    var o: [String: Any] = ["role": axString(e, kAXRoleAttribute as String) ?? "AXUnknown"]
    if let v = axString(e, kAXSubroleAttribute as String), !v.isEmpty { o["subrole"] = v }
    if let v = axString(e, kAXTitleAttribute as String), !v.isEmpty { o["title"] = v }
    if let v = axString(e, kAXDescriptionAttribute as String), !v.isEmpty { o["description"] = v }
    if let v = axString(e, kAXHelpAttribute as String), !v.isEmpty { o["help"] = v }
    if let v = axString(e, kAXIdentifierAttribute as String), !v.isEmpty { o["identifier"] = v }
    if let v = axString(e, kAXPlaceholderValueAttribute as String), !v.isEmpty { o["placeholder"] = v }
    if let v = axString(e, kAXValueAttribute as String), !v.isEmpty { o["value"] = String(v.prefix(200)) }
    if let v = axBool(e, kAXEnabledAttribute as String) { o["enabled"] = v }
    if let p = axPoint(e, kAXPositionAttribute as String), let s = axSize(e, kAXSizeAttribute as String) {
        o["rect"] = ["x": p.x, "y": p.y, "width": s.width, "height": s.height]
    }
    return o
}

private func parentOf(_ e: AXUIElement) -> AXUIElement? {
    guard let p = axAttr(e, kAXParentAttribute as String) else { return nil }
    return (p as! AXUIElement)
}

/// Full description of an interacted element: identity, ancestry, owning app,
/// and which OS surface it lives on.
///
/// `surface` is the platform-neutral contract with the Node side. Each native
/// driver decides it with whatever that OS offers; here it comes from walking
/// the parent chain and comparing against the app's extras menu bar.
func describe(_ e: AXUIElement) -> [String: Any] {
    var out: [String: Any] = [:]
    out["element"] = elementSummary(e)

    var ancestors: [AXUIElement] = []
    var cur = parentOf(e)
    while let c = cur, ancestors.count < 40 {
        ancestors.append(c)
        cur = parentOf(c)
    }
    // Closest ancestor first; the application element is dropped.
    let meaningful = ancestors.filter { axString($0, kAXRoleAttribute as String) != "AXApplication" }
    out["ancestors"] = meaningful.map { elementSummary($0) }

    let pid = axPid(e) ?? 0
    out["pid"] = Int(pid)
    let app = runningApp(pid: pid)
    out["app"] = app?.localizedName ?? ""
    out["bundleId"] = app?.bundleIdentifier ?? ""

    let chain = [e] + ancestors
    let roles = chain.map { axString($0, kAXRoleAttribute as String) ?? "" }
    let appEl = appElement(pid: pid)
    let extras = axAttr(appEl, "AXExtrasMenuBar").map { $0 as! AXUIElement }

    func title(_ x: AXUIElement) -> String {
        axString(x, kAXTitleAttribute as String) ?? axString(x, kAXDescriptionAttribute as String) ?? ""
    }

    // Menu path: titles of every menu item / menu bar item from the top down.
    let menuPath: [String] = chain
        .filter {
            let r = axString($0, kAXRoleAttribute as String)
            return r == "AXMenuItem" || r == "AXMenuBarItem"
        }
        .map(title)
        .reversed()

    let bundle = app?.bundleIdentifier ?? ""

    if bundle == "com.apple.notificationcenterui" {
        out["surface"] = "notification"
        var texts: [String] = []
        let group = chain.first {
            axString($0, kAXRoleAttribute as String) == "AXGroup"
                && !(axString($0, kAXDescriptionAttribute as String) ?? "").isEmpty
        }
        if let g = group {
            axWalk(g, maxDepth: 6) { c, _ in
                if axString(c, kAXRoleAttribute as String) == "AXStaticText",
                   let v = axString(c, kAXValueAttribute as String), !v.isEmpty { texts.append(v) }
                return true
            }
            out["notification"] = ["raw": axString(g, kAXDescriptionAttribute as String) ?? "", "texts": texts]
        }
        return out
    }

    if let extras, chain.contains(where: { CFEqual($0, extras) }) {
        // A click on the status item itself, or inside its NSMenu (which AppKit
        // parents under the status item).
        let inMenu = roles.contains("AXMenu")
        out["surface"] = inMenu ? "trayMenu" : "tray"
        if let item = axChildren(extras).first(where: { it in chain.contains { CFEqual($0, it) } }) {
            out["trayItem"] = elementSummary(item)
        }
        if inMenu {
            // Drop the status item itself from the path; only menu items remain.
            out["menuPath"] = chain
                .filter { axString($0, kAXRoleAttribute as String) == "AXMenuItem" }
                .map(title).reversed() as [String]
        }
        return out
    }

    if roles.contains("AXMenuBar") && (roles.contains("AXMenuItem") || roles.contains("AXMenuBarItem")) {
        out["surface"] = "menuBar"
        out["menuPath"] = menuPath
        return out
    }

    if roles.contains("AXMenu") {
        // A context menu or a popup button's menu: not addressable by a menu
        // bar path, but its item titles still identify it.
        out["surface"] = "contextMenu"
        out["menuPath"] = menuPath
        return out
    }

    let win = chain.first { axString($0, kAXRoleAttribute as String) == "AXWindow" }
    let sheet = chain.first { axString($0, kAXRoleAttribute as String) == "AXSheet" }
    if let w = win { out["window"] = elementSummary(w) }

    let isPanelService = bundle == "com.apple.appkit.xpc.openAndSavePanelService"
    let winId = win.flatMap { axString($0, kAXIdentifierAttribute as String) } ?? ""
    let winSub = win.flatMap { axString($0, kAXSubroleAttribute as String) } ?? ""

    if sheet != nil || isPanelService || winId == "save-panel" || winId == "open-panel"
        || winSub == "AXDialog" || winSub == "AXSystemDialog" {
        out["surface"] = "dialog"
        let root = sheet ?? win
        var texts: [String] = []
        if let r = root {
            axWalk(r, maxDepth: 10) { c, _ in
                if axString(c, kAXRoleAttribute as String) == "AXStaticText",
                   let v = axString(c, kAXValueAttribute as String), !v.isEmpty { texts.append(v) }
                return true
            }
        }
        out["dialog"] = [
            "kind": (isPanelService || winId == "save-panel" || winId == "open-panel") ? "filePanel"
                : (sheet != nil ? "sheet" : "dialog"),
            "title": root.flatMap { axString($0, kAXTitleAttribute as String) } ?? "",
            "texts": Array(texts.prefix(8)),
        ]
        return out
    }

    out["surface"] = win != nil ? "window" : "unknown"
    return out
}

// MARK: - Key naming

private let keyNamesByCode: [CGKeyCode: String] = {
    var m: [CGKeyCode: String] = [:]
    for (name, code) in Input.keyCodes where m[code] == nil || name.count > (m[code]?.count ?? 0) {
        m[code] = name
    }
    // Prefer the canonical names the `key` op documents.
    m[36] = "enter"; m[51] = "backspace"; m[53] = "escape"; m[48] = "tab"; m[49] = "space"
    m[117] = "forwarddelete"
    return m
}()

/// Names for keys whose meaning is not the character they produce.
private let specialKeys: Set<CGKeyCode> = [36, 48, 49, 51, 53, 115, 116, 117, 119, 121, 123, 124, 125, 126,
                                          122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111]

func keyName(_ code: CGKeyCode) -> String? {
    guard let name = keyNamesByCode[code] else { return nil }
    return specialKeys.contains(code) || name.count == 1 ? name : nil
}

func modifierNames(_ f: CGEventFlags) -> [String] {
    var out: [String] = []
    if f.contains(.maskControl) { out.append("ctrl") }
    if f.contains(.maskAlternate) { out.append("alt") }
    if f.contains(.maskShift) { out.append("shift") }
    if f.contains(.maskCommand) { out.append("cmd") }
    return out
}

// MARK: - Tap callback

private func recorderTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent,
                                 userInfo: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        Recorder.shared.reenable()
        return Unmanaged.passUnretained(event)
    }
    let swallow = Recorder.shared.handle(type: type, event: event)
    return swallow ? nil : Unmanaged.passUnretained(event)
}
