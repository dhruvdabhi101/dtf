import Foundation
import CoreGraphics
import AppKit

/// Synthetic mouse/keyboard events.
///
/// These go through CGEvent at the HID tap level, so they behave like real user
/// input: they drive menu tracking loops, native panels, and anything else that
/// ignores AXPress. Requires the Accessibility permission.
enum Input {

    // MARK: Keycodes (US layout virtual keycodes)

    static let keyCodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
        "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
        "enter": 36, "return": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
        "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
        "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51,
        "escape": 53, "esc": 53,
        "capslock": 57,
        "f17": 64, "f18": 79, "f19": 80, "f20": 90,
        "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101, "f11": 103,
        "f13": 105, "f16": 106, "f14": 107, "f10": 109, "f12": 111, "f15": 113,
        "help": 114, "home": 115, "pageup": 116, "forwarddelete": 117,
        "f4": 118, "end": 119, "f2": 120, "pagedown": 121, "f1": 122,
        "left": 123, "right": 124, "down": 125, "up": 126,
    ]

    static let modifierFlags: [String: CGEventFlags] = [
        "cmd": .maskCommand, "command": .maskCommand, "meta": .maskCommand,
        // The platform's primary shortcut modifier: Command here, Control on
        // Windows. Lets one test say "mod+s" and mean Save on both.
        "mod": .maskCommand, "primary": .maskCommand,
        "shift": .maskShift,
        "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate,
        "ctrl": .maskControl, "control": .maskControl,
        "fn": .maskSecondaryFn,
    ]

    /// Parses "cmd+shift+n" into flags plus the terminal key.
    static func parseCombo(_ combo: String) -> (CGEventFlags, CGKeyCode)? {
        let parts = combo.lowercased().split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
        guard let last = parts.last else { return nil }
        var flags: CGEventFlags = []
        for p in parts.dropLast() {
            guard let f = modifierFlags[p] else { return nil }
            flags.insert(f)
        }
        guard let code = keyCodes[last] else { return nil }
        return (flags, code)
    }

    // MARK: Keyboard

    static func key(_ combo: String) -> Bool {
        guard let (flags, code) = parseCombo(combo) else { return false }
        let src = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else { return false }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        usleep(12_000)
        up.post(tap: .cghidEventTap)
        usleep(12_000)
        return true
    }

    /// Types arbitrary text (including emoji and non-US characters) without
    /// needing a keycode for each character.
    static func type(_ text: String, delayMs: Int = 8) {
        let src = CGEventSource(stateID: .hidSystemState)
        for ch in text {
            let s = String(ch)
            var utf16 = Array(s.utf16)
            guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { continue }
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            usleep(UInt32(max(0, delayMs) * 1000))
        }
    }

    // MARK: Mouse

    static func move(_ p: CGPoint) {
        let src = CGEventSource(stateID: .hidSystemState)
        CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?
            .post(tap: .cghidEventTap)
    }

    static func click(_ p: CGPoint, button: String = "left", count: Int = 1, modifiers: [String] = []) {
        let src = CGEventSource(stateID: .hidSystemState)
        var flags: CGEventFlags = []
        for m in modifiers { if let f = modifierFlags[m.lowercased()] { flags.insert(f) } }

        let (downType, upType, cgButton): (CGEventType, CGEventType, CGMouseButton) = {
            switch button.lowercased() {
            case "right": return (.rightMouseDown, .rightMouseUp, .right)
            case "middle": return (.otherMouseDown, .otherMouseUp, .center)
            default: return (.leftMouseDown, .leftMouseUp, .left)
            }
        }()

        move(p)
        usleep(20_000)
        for i in 1...max(1, count) {
            guard let down = CGEvent(mouseEventSource: src, mouseType: downType, mouseCursorPosition: p, mouseButton: cgButton),
                  let up = CGEvent(mouseEventSource: src, mouseType: upType, mouseCursorPosition: p, mouseButton: cgButton) else { return }
            // Click count drives double/triple-click recognition in AppKit.
            down.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            if !flags.isEmpty { down.flags = flags; up.flags = flags }
            down.post(tap: .cghidEventTap)
            usleep(15_000)
            up.post(tap: .cghidEventTap)
            usleep(40_000)
        }
    }

    static func drag(from: CGPoint, to: CGPoint, steps: Int = 20) {
        let src = CGEventSource(stateID: .hidSystemState)
        move(from)
        usleep(30_000)
        CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)?
            .post(tap: .cghidEventTap)
        usleep(30_000)
        for i in 1...max(1, steps) {
            let t = CGFloat(i) / CGFloat(steps)
            let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
            CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)?
                .post(tap: .cghidEventTap)
            usleep(10_000)
        }
        CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)?
            .post(tap: .cghidEventTap)
    }

    static func scroll(_ p: CGPoint, dx: Int, dy: Int) {
        move(p)
        usleep(15_000)
        let src = CGEventSource(stateID: .hidSystemState)
        CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2,
                wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)?
            .post(tap: .cghidEventTap)
    }

    static var mouseLocation: CGPoint {
        // NSEvent uses a bottom-left origin; CGEvent uses top-left. Flip so every
        // coordinate crossing the RPC boundary is in the same (AX) space.
        let p = NSEvent.mouseLocation
        let screenHeight = NSScreen.screens.first?.frame.height ?? 0
        return CGPoint(x: p.x, y: screenHeight - p.y)
    }
}
