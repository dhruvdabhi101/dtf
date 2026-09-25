import Foundation
import ApplicationServices
import AppKit

// MARK: - Element registry
// AXUIElement handles are opaque and not JSON-serializable, so we hand the Node
// side short string refs and keep the real handles here for the helper's lifetime.

final class Registry {
    static let shared = Registry()
    private var store: [String: AXUIElement] = [:]
    private var counter = 0
    private let lock = NSLock()

    func put(_ e: AXUIElement) -> String {
        lock.lock(); defer { lock.unlock() }
        counter += 1
        let ref = "e\(counter)"
        store[ref] = e
        return ref
    }

    func get(_ ref: String) -> AXUIElement? {
        lock.lock(); defer { lock.unlock() }
        return store[ref]
    }

    /// Refs are only valid while the UI they point at is alive. Callers re-query
    /// after any action that can rebuild the tree.
    func clear() {
        lock.lock(); defer { lock.unlock() }
        store.removeAll()
    }
}

// MARK: - Raw attribute access

@inline(__always)
func axAttr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success else { return nil }
    return value
}

func axString(_ e: AXUIElement, _ key: String) -> String? {
    guard let v = axAttr(e, key) else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    if CFGetTypeID(v) == AXValueGetTypeID() { return nil }
    return nil
}

func axBool(_ e: AXUIElement, _ key: String) -> Bool? {
    (axAttr(e, key) as? NSNumber)?.boolValue
}

func axChildren(_ e: AXUIElement) -> [AXUIElement] {
    (axAttr(e, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func axActions(_ e: AXUIElement) -> [String] {
    var actions: CFArray?
    guard AXUIElementCopyActionNames(e, &actions) == .success else { return [] }
    return (actions as? [String]) ?? []
}

func axPoint(_ e: AXUIElement, _ key: String) -> CGPoint? {
    guard let v = axAttr(e, key), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    guard AXValueGetValue(v as! AXValue, .cgPoint, &p) else { return nil }
    return p
}

func axSize(_ e: AXUIElement, _ key: String) -> CGSize? {
    guard let v = axAttr(e, key), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    guard AXValueGetValue(v as! AXValue, .cgSize, &s) else { return nil }
    return s
}

/// AXValue attributes come back opaque; render the ones we care about as JSON-safe values.
func axAnyValue(_ e: AXUIElement, _ key: String) -> Any? {
    guard let v = axAttr(e, key) else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n }
    if let arr = v as? [Any] { return "[\(arr.count) items]" }
    if CFGetTypeID(v) == AXValueGetTypeID() {
        let av = v as! AXValue
        switch AXValueGetType(av) {
        case .cgPoint:
            var p = CGPoint.zero; AXValueGetValue(av, .cgPoint, &p)
            return ["x": p.x, "y": p.y]
        case .cgSize:
            var s = CGSize.zero; AXValueGetValue(av, .cgSize, &s)
            return ["width": s.width, "height": s.height]
        case .cgRect:
            var r = CGRect.zero; AXValueGetValue(av, .cgRect, &r)
            return ["x": r.origin.x, "y": r.origin.y, "width": r.width, "height": r.height]
        default:
            return nil
        }
    }
    return nil
}

func axPid(_ e: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(e, &pid) == .success ? pid : nil
}

// MARK: - Serialization

struct SerializeOptions {
    var maxDepth: Int = 12
    var includeActions: Bool = true
    /// Menus can be enormous; a node cap keeps a `tree` call bounded.
    var maxNodes: Int = 4000
}

final class Serializer {
    private var emitted = 0
    private let opts: SerializeOptions

    init(_ opts: SerializeOptions) { self.opts = opts }

    func node(_ e: AXUIElement, depth: Int = 0) -> [String: Any] {
        emitted += 1
        var out: [String: Any] = [:]
        out["ref"] = Registry.shared.put(e)
        out["role"] = axString(e, kAXRoleAttribute as String) ?? "AXUnknown"
        if let v = axString(e, kAXSubroleAttribute as String) { out["subrole"] = v }
        if let v = axString(e, kAXTitleAttribute as String), !v.isEmpty { out["title"] = v }
        if let v = axString(e, kAXDescriptionAttribute as String), !v.isEmpty { out["description"] = v }
        if let v = axString(e, kAXHelpAttribute as String), !v.isEmpty { out["help"] = v }
        if let v = axIdentifier(e) { out["identifier"] = v }
        if let v = axString(e, kAXPlaceholderValueAttribute as String), !v.isEmpty { out["placeholder"] = v }
        if let v = axAnyValue(e, kAXValueAttribute as String) { out["value"] = v }
        if let v = axBool(e, kAXEnabledAttribute as String) { out["enabled"] = v }
        if let v = axBool(e, kAXFocusedAttribute as String) { out["focused"] = v }
        if let v = axBool(e, kAXSelectedAttribute as String) { out["selected"] = v }
        if let p = axPoint(e, kAXPositionAttribute as String), let s = axSize(e, kAXSizeAttribute as String) {
            out["rect"] = ["x": p.x, "y": p.y, "width": s.width, "height": s.height]
        }
        if opts.includeActions {
            let a = axActions(e)
            if !a.isEmpty { out["actions"] = a }
        }

        let kids = axChildren(e)
        out["childCount"] = kids.count
        if depth < opts.maxDepth && emitted < opts.maxNodes {
            var serialized: [[String: Any]] = []
            serialized.reserveCapacity(kids.count)
            for k in kids {
                if emitted >= opts.maxNodes { out["truncated"] = true; break }
                serialized.append(node(k, depth: depth + 1))
            }
            if !serialized.isEmpty { out["children"] = serialized }
        } else if !kids.isEmpty {
            out["truncated"] = true
        }
        return out
    }
}

// MARK: - Traversal

/// Depth-first walk with a node budget. Returns false from `visit` to stop.
func axWalk(_ root: AXUIElement, maxDepth: Int = 16, maxNodes: Int = 20000,
            _ visit: (AXUIElement, Int) -> Bool) {
    var budget = maxNodes
    func rec(_ e: AXUIElement, _ d: Int) -> Bool {
        budget -= 1
        if budget <= 0 { return false }
        if !visit(e, d) { return false }
        if d >= maxDepth { return true }
        for k in axChildren(e) {
            if !rec(k, d + 1) { return false }
        }
        return true
    }
    _ = rec(root, 0)
}

// MARK: - Application lookup

func appElement(pid: pid_t) -> AXUIElement { AXUIElementCreateApplication(pid) }

func runningApp(pid: pid_t) -> NSRunningApplication? {
    NSRunningApplication(processIdentifier: pid)
}

/// Refreshes NSWorkspace's view of running applications.
///
/// `NSWorkspace.runningApplications` is a cached snapshot kept up to date by
/// notifications delivered on the run loop. This helper is a blocking
/// read-a-line-and-respond process with no run loop of its own, so without this
/// the list is frozen at whatever it was the first time it was touched — and
/// every app launched after the helper started is invisible to it. That shows up
/// as a tray icon that "does not exist" on the second and later launches of the
/// same app, which is exactly the shape of a long test run.
func refreshWorkspace() {
    RunLoop.current.run(until: Date().addingTimeInterval(0.03))
}

/// Every running application, freshly enumerated.
func liveApplications() -> [NSRunningApplication] {
    refreshWorkspace()
    return NSWorkspace.shared.runningApplications
}

func findApps(bundleId: String?, name: String?) -> [NSRunningApplication] {
    liveApplications().filter { app in
        if let b = bundleId, app.bundleIdentifier != b { return false }
        if let n = name, app.localizedName != n { return false }
        return true
    }
}

/// The element's identifier: AXIdentifier for native controls, falling back to
/// AXDOMIdentifier, which is where Chromium (Electron, Chrome) publishes the
/// HTML `id`. Without the fallback `#signInBtn` can never match a web button.
func axIdentifier(_ e: AXUIElement) -> String? {
    if let v = axString(e, kAXIdentifierAttribute as String), !v.isEmpty { return v }
    if let v = axString(e, "AXDOMIdentifier"), !v.isEmpty { return v }
    return nil
}
