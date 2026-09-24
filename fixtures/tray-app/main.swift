import Cocoa
import UserNotifications

// DTF Fixture — a deliberately small app that exercises every OS surface the
// framework claims to test: a status item with a nested menu, native alerts,
// a save panel, OS notifications, and a close-to-tray lifecycle.
//
// It exists so the framework's own test suite has something real to drive.

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var statusItem: NSStatusItem!
    var window: NSWindow!
    var counterLabel: NSTextField!
    var count = 0
    var notificationsAuthorized = false
    var signedInAs: String? = nil

    func application(_ app: NSApplication, open urls: [URL]) {
        for url in urls { handleDeepLink(url) }
    }

    /// The other half of a browser sign-in: the app is re-entered through its
    /// custom scheme carrying whatever the identity provider handed back.
    func handleDeepLink(_ url: URL) {
        print("deeplink-received url=\(url.absoluteString)")
        guard url.host == "auth" else { return }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let token = items.first(where: { $0.name == "token" })?.value, !token.isEmpty else {
            print("auth-failed reason=missing-token")
            return
        }
        signedInAs = items.first(where: { $0.name == "email" })?.value ?? "unknown"
        print("auth-success user=\(signedInAs!)")
        rebuildStatusMenu()
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        // A cold launch carries the URL in argv rather than through open-url.
        for arg in CommandLine.arguments where arg.hasPrefix("dtffixture://") {
            if let url = URL(string: arg) { handleDeepLink(url) }
        }
        setUpMainMenu()
        setUpStatusItem()
        setUpWindow()
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { [weak self] granted, err in
            self?.notificationsAuthorized = granted
            FileHandle.standardError.write(Data("notif-auth granted=\(granted) err=\(String(describing: err))\n".utf8))
        }
        print("fixture-ready")
    }

    // MARK: Main menu

    /// A conventional application menu bar. AppKit does not create one for you,
    /// and the framework's menu tests need something real to walk.
    func setUpMainMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "DTF Fixture")
        appMenu.addItem(withTitle: "About DTF Fixture", action: nil, keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit DTF Fixture", action: #selector(quit), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "New Note", action: #selector(increment), keyEquivalent: "n")
        fileMenu.addItem(withTitle: "Save…", action: #selector(showSavePanel), keyEquivalent: "s")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Close Window", action: #selector(closeWindow), keyEquivalent: "w")
        fileItem.submenu = fileMenu
        mainMenu.addItem(fileItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Show Window", action: #selector(showWindow), keyEquivalent: "")
        windowItem.submenu = windowMenu
        mainMenu.addItem(windowItem)

        for menu in [appMenu, fileMenu, windowMenu] {
            for item in menu.items where item.action != nil && item.target == nil {
                if item.action == #selector(NSWindow.performMiniaturize(_:)) { continue }
                item.target = self
            }
        }
        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = windowMenu
    }

    @objc func closeWindow() {
        window.orderOut(nil)
        print("window-hidden")
    }

    // MARK: Status item

    func setUpStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "DTF"
        // The accessibility label is what shows up as AXDescription, which is how
        // a test finds this icon among everything else in the menu bar.
        statusItem.button?.setAccessibilityLabel("DTF Fixture")
        statusItem.button?.toolTip = "DTF Fixture tray"

        let menu = NSMenu()
        menu.addItem(withTitle: "Show Window", action: #selector(showWindow), keyEquivalent: "")
        menu.addItem(withTitle: "Send Notification", action: #selector(sendNotification), keyEquivalent: "")

        let counter = NSMenuItem(title: "Increment Counter", action: #selector(increment), keyEquivalent: "")
        menu.addItem(counter)

        let submenuItem = NSMenuItem(title: "Advanced", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        submenu.addItem(withTitle: "Nested Action", action: #selector(nestedAction), keyEquivalent: "")
        submenu.addItem(withTitle: "Disabled Item", action: nil, keyEquivalent: "")
        submenuItem.submenu = submenu
        menu.addItem(submenuItem)

        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items where item.action != nil { item.target = self }
        submenu.items.forEach { if $0.action != nil { $0.target = self } }
        statusItem.menu = menu
        rebuildStatusMenu()
    }

    /// Mirrors the auth state into the tray, the way a real tray app does.
    func rebuildStatusMenu() {
        guard let menu = statusItem?.menu else { return }
        menu.items.removeAll { $0.title == "Sign in" || $0.title.hasPrefix("Signed in as ") }
        let item: NSMenuItem
        if let email = signedInAs {
            item = NSMenuItem(title: "Signed in as \(email)", action: nil, keyEquivalent: "")
            item.isEnabled = false
        } else {
            item = NSMenuItem(title: "Sign in", action: #selector(signIn), keyEquivalent: "")
            item.target = self
        }
        menu.insertItem(item, at: 0)
    }

    // MARK: Window

    func setUpWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 320),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "DTF Fixture"
        window.delegate = self
        window.center()

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false

        counterLabel = NSTextField(labelWithString: "Count: 0")
        counterLabel.setAccessibilityIdentifier("counter-label")
        stack.addArrangedSubview(counterLabel)

        let field = NSTextField(string: "")
        field.placeholderString = "Type something"
        field.setAccessibilityIdentifier("demo-field")
        field.widthAnchor.constraint(equalToConstant: 260).isActive = true
        stack.addArrangedSubview(field)

        for (title, sel) in [
            ("Increment", #selector(increment)),
            ("Send Notification", #selector(sendNotification)),
            ("Show Alert", #selector(showAlert)),
            ("Save File…", #selector(showSavePanel)),
        ] {
            let b = NSButton(title: title, target: self, action: sel)
            b.setAccessibilityIdentifier("btn-\(title.lowercased().replacingOccurrences(of: " ", with: "-"))")
            stack.addArrangedSubview(b)
        }

        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
        ])
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Closing hides the window instead of quitting — the classic tray-app
    /// behaviour, and exactly the lifecycle an in-process test cannot verify.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        window.orderOut(nil)
        print("window-hidden")
        return false
    }

    // MARK: Actions

    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        print("window-shown")
    }

    @objc func increment() {
        count += 1
        counterLabel.stringValue = "Count: \(count)"
        print("count=\(count)")
    }

    @objc func nestedAction() { print("nested-action-fired") }

    /// Hands off to the system browser exactly as a real OAuth client would.
    @objc func signIn() {
        var c = URLComponents(string: "https://example.com/oauth/authorize")!
        c.queryItems = [
            .init(name: "client_id", value: "dtf-fixture"),
            .init(name: "redirect_uri", value: "dtffixture://auth"),
            .init(name: "response_type", value: "code"),
            .init(name: "scope", value: "openid profile"),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "code_challenge", value: "fake-pkce-challenge"),
        ]
        print("signin-opening-browser url=\(c.url!.absoluteString)")
        NSWorkspace.shared.open(c.url!)
    }

    /// Posts an OS notification.
    ///
    /// UNUserNotificationCenter refuses to register an ad-hoc-signed app, which
    /// this fixture is — macOS only lets properly signed applications post.
    /// Rather than require a signing identity to run the framework's own tests,
    /// the fixture falls back to the scripting bridge, which produces a real
    /// banner delivered by the same notification server. What is exercised
    /// end-to-end either way is the part under test: the OS delivers a banner
    /// and the framework reads and dismisses it.
    @objc func sendNotification() {
        let body = "Notification body \(count)"
        if notificationsAuthorized {
            let content = UNMutableNotificationContent()
            content.title = "DTF Fixture"
            content.subtitle = "Subtitle line"
            content.body = body
            let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(req) { err in
                FileHandle.standardError.write(Data("notif-post err=\(String(describing: err))\n".utf8))
            }
            print("notification-sent via=UNUserNotificationCenter")
        } else {
            let script = "display notification \"\(body)\" with title \"DTF Fixture\" subtitle \"Subtitle line\""
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            task.arguments = ["-e", script]
            try? task.run()
            print("notification-sent via=osascript")
        }
    }

    @objc func showAlert() {
        let alert = NSAlert()
        alert.messageText = "Are you sure?"
        alert.informativeText = "This is a native alert from the DTF fixture."
        alert.addButton(withTitle: "Confirm")
        alert.addButton(withTitle: "Cancel")
        window.makeKeyAndOrderFront(nil)
        alert.beginSheetModal(for: window) { resp in
            print("alert-result=\(resp == .alertFirstButtonReturn ? "confirm" : "cancel")")
        }
    }

    @objc func showSavePanel() {
        let panel = NSSavePanel()
        panel.title = "Save Fixture File"
        panel.nameFieldStringValue = "fixture.txt"
        panel.begin { resp in
            print("save-result=\(resp == .OK ? (panel.url?.path ?? "?") : "cancelled")")
        }
    }

    @objc func quit() {
        print("quitting")
        NSApp.terminate(nil)
    }
}

setvbuf(stdout, nil, _IOLBF, 0)
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
