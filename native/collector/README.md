# macOS collector launcher

A small signed app remains the parent of the existing Bun collector. It does
not extract, transform, or store source data. Its only job is to give macOS a
stable application identity with an Apple Events declaration and usage text.

Launching Bun directly fails under its hardened runtime: the distributed Bun
executable lacks `com.apple.security.automation.apple-events`. macOS then denies
osxphotos' child-process AppleScript requests without offering a prompt, even
when Photos is open and Full Disk Access has been granted.

Mini-cloud compiles this source into `Solenoid Collector.app`, generates its
Info.plist with `NSAppleEventsUsageDescription` and fixed runtime/entry paths,
and signs the app locally with the included entitlement. It does not modify or
re-sign the user's Bun installation. The entitlement permits requesting user
approval; it does not grant Photos access or Full Disk Access automatically.

The user grants the app Full Disk Access and approves its request to control
Photos. The LaunchAgent starts the app binary; the app keeps its run loop alive
while the existing Bun → osxphotos process tree does the collection.

Missing originals use osxphotos’ supported PhotoKit backend because Photos can
time out resolving media items through AppleScript even after authorization.
The app declares the Photos Library entitlement and NSPhotoLibraryUsageDescription
so macOS can request normal Photos access for the collector.
