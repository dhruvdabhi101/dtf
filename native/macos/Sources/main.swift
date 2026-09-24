import Foundation
import ApplicationServices

// dtfd-macos — the macOS native driver for the Desktop Testing Framework.
//
// Protocol: newline-delimited JSON over stdin/stdout. One request per line:
//   {"id": 1, "op": "tray.list", "args": {}}
// One response per line:
//   {"id": 1, "ok": true, "result": ...}
//   {"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}
//
// Diagnostics go to stderr so they never corrupt the stream.

setvbuf(stdout, nil, _IOLBF, 0)

/// Responses (main loop) and recorder events (recorder queue) share stdout, so
/// every write is serialised: an interleaved half-line would corrupt the stream.
let emitLock = NSLock()

func emit(_ payload: [String: Any]) {
    emitLock.lock(); defer { emitLock.unlock() }
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.fragmentsAllowed]) else {
        let fallback = #"{"ok":false,"error":{"code":"encodeFailed","message":"result was not JSON-encodable"}}"#
        FileHandle.standardOutput.write(Data((fallback + "\n").utf8))
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func warn(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
}

emit(["event": "ready", "version": "1.1.0", "platform": "darwin", "protocol": 1, "trusted": AXIsProcessTrusted()])

while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }

    guard let data = line.data(using: .utf8),
          let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        emit(["ok": false, "error": ["code": "badRequest", "message": "line was not a JSON object"]])
        continue
    }

    let id = req["id"] as? Int ?? -1
    guard let op = req["op"] as? String else {
        emit(["id": id, "ok": false, "error": ["code": "badRequest", "message": "missing 'op'"]])
        continue
    }
    let args = (req["args"] as? [String: Any]) ?? [:]

    if op == "shutdown" {
        Recorder.shared.stop()
        emit(["id": id, "ok": true, "result": ["ok": true]])
        exit(0)
    }
    if op == "gc" {
        // Element refs pin AXUIElements; tests call this between cases.
        Registry.shared.clear()
        emit(["id": id, "ok": true, "result": ["ok": true]])
        continue
    }

    do {
        let result = try dispatch(op: op, args: args)
        emit(["id": id, "ok": true, "result": result])
    } catch let e as OpError {
        emit(["id": id, "ok": false, "error": ["code": e.code, "message": e.message]])
    } catch {
        emit(["id": id, "ok": false,
              "error": ["code": "internal", "message": String(describing: error)]])
    }
}
