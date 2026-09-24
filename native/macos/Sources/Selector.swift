import Foundation
import ApplicationServices

/// A single predicate over one accessibility element.
///
/// Everything is optional and ANDed together. `text` is the loose escape hatch:
/// it matches if any of title/value/description/help contains the substring,
/// which is what you want for the many controls that put their label in a
/// different attribute than you'd guess.
struct Selector {
    var role: String?
    var subrole: String?
    var title: String?
    var titleContains: String?
    var titleMatch: String?
    var description: String?
    var descriptionContains: String?
    var value: String?
    var valueContains: String?
    var identifier: String?
    var help: String?
    var helpContains: String?
    var text: String?
    var enabled: Bool?
    var focused: Bool?
    var nth: Int?
    var maxDepth: Int = 20

    init(_ d: [String: Any]) {
        role = d["role"] as? String
        subrole = d["subrole"] as? String
        title = d["title"] as? String
        titleContains = d["titleContains"] as? String
        titleMatch = d["titleMatch"] as? String
        description = d["description"] as? String
        descriptionContains = d["descriptionContains"] as? String
        value = d["value"] as? String
        valueContains = d["valueContains"] as? String
        identifier = d["identifier"] as? String
        help = d["help"] as? String
        helpContains = d["helpContains"] as? String
        text = d["text"] as? String
        enabled = d["enabled"] as? Bool
        focused = d["focused"] as? Bool
        nth = d["nth"] as? Int
        if let md = d["maxDepth"] as? Int { maxDepth = md }
    }

    private func ci(_ haystack: String?, _ needle: String) -> Bool {
        guard let h = haystack else { return false }
        return h.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
    }

    func matches(_ e: AXUIElement) -> Bool {
        if let r = role, axString(e, kAXRoleAttribute as String) != r { return false }
        if let s = subrole, axString(e, kAXSubroleAttribute as String) != s { return false }
        if let t = title, axString(e, kAXTitleAttribute as String) != t { return false }
        if let t = titleContains, !ci(axString(e, kAXTitleAttribute as String), t) { return false }
        if let t = titleMatch {
            let s = axString(e, kAXTitleAttribute as String) ?? ""
            guard let rx = try? NSRegularExpression(pattern: t),
                  rx.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil else { return false }
        }
        if let d = description, axString(e, kAXDescriptionAttribute as String) != d { return false }
        if let d = descriptionContains, !ci(axString(e, kAXDescriptionAttribute as String), d) { return false }
        if let v = value, axString(e, kAXValueAttribute as String) != v { return false }
        if let v = valueContains, !ci(axString(e, kAXValueAttribute as String), v) { return false }
        if let i = identifier, axString(e, kAXIdentifierAttribute as String) != i { return false }
        if let h = help, axString(e, kAXHelpAttribute as String) != h { return false }
        if let h = helpContains, !ci(axString(e, kAXHelpAttribute as String), h) { return false }
        if let en = enabled, (axBool(e, kAXEnabledAttribute as String) ?? true) != en { return false }
        if let f = focused, (axBool(e, kAXFocusedAttribute as String) ?? false) != f { return false }
        if let t = text {
            let hit = ci(axString(e, kAXTitleAttribute as String), t)
                || ci(axString(e, kAXValueAttribute as String), t)
                || ci(axString(e, kAXDescriptionAttribute as String), t)
                || ci(axString(e, kAXHelpAttribute as String), t)
                || ci(axString(e, kAXPlaceholderValueAttribute as String), t)
            if !hit { return false }
        }
        return true
    }
}

/// Find every descendant of `root` matching `sel` (root itself included).
func axFindAll(_ root: AXUIElement, _ sel: Selector, limit: Int = 200) -> [AXUIElement] {
    var found: [AXUIElement] = []
    axWalk(root, maxDepth: sel.maxDepth) { e, _ in
        if sel.matches(e) {
            found.append(e)
            if found.count >= limit { return false }
        }
        return true
    }
    return found
}

/// Resolve a chained selector path. Each step searches within the previous match,
/// so `[{role: AXWindow}, {role: AXButton, title: OK}]` scopes the button to the window.
func axFindPath(_ root: AXUIElement, _ path: [Selector]) -> AXUIElement? {
    var current = root
    for (i, sel) in path.enumerated() {
        // The first step may match the root itself; later steps must descend.
        let candidates = axFindAll(current, sel)
        let pool = i == 0 ? candidates : candidates.filter { !CFEqual($0, current) }
        guard !pool.isEmpty else { return nil }
        let idx = sel.nth ?? 0
        guard idx >= 0 && idx < pool.count else { return nil }
        current = pool[idx]
    }
    return current
}

func parseSelectorPath(_ arg: Any?) -> [Selector] {
    if let arr = arg as? [[String: Any]] { return arr.map { Selector($0) } }
    if let one = arg as? [String: Any] { return [Selector(one)] }
    return []
}
