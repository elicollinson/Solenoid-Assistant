import AppKit
import Foundation

// Keep this signed app alive as the responsible process. Replacing it with
// exec() would make Bun responsible again, losing Apple Events authorization.
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let bundle = Bundle.main
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
guard let bun = bundle.object(forInfoDictionaryKey: "SolenoidBunPath") as? String,
      let entry = bundle.object(forInfoDictionaryKey: "SolenoidCollectorEntry") as? String,
      bun.hasPrefix("/"), entry.hasPrefix("/"),
      FileManager.default.isExecutableFile(atPath: bun),
      FileManager.default.fileExists(atPath: entry) else {
    fail("Solenoid Collector installation is incomplete; re-run mini-cloud apply.")
}
let child = Process()
child.executableURL = URL(fileURLWithPath: bun)
child.arguments = [entry]
child.standardInput = FileHandle.nullDevice
child.standardOutput = FileHandle.standardOutput
child.standardError = FileHandle.standardError
// launchd provides the collector environment; credentials are loaded by the
// existing TypeScript launcher and never passed through the command line.
child.environment = ProcessInfo.processInfo.environment
child.terminationHandler = { process in
    exit(process.terminationStatus)
}
do {
    try child.run()
} catch {
    fail("Solenoid Collector could not start its Bun process.")
}
// A GUI run loop lets macOS present the normal user-controlled privacy prompt.
application.run()
