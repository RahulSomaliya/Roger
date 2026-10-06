import CoreAudio
import Darwin
import Foundation

// `roger-audio monitor`: which apps use the mic, which devices Roger hears and plays through, and
// a relaunch of Roger if it dies while recording (M2 D6, D7). Main's reader is MeetingAppMonitor
// (M2-T17a), through HelperProcess (M2-T10); it decides which apps are call apps (callApps.ts).
//
// `roger-audio monitor --parent-pid <pid> [--relaunch-dry-run]`
//
// stdout carries one JSON object per line, "event" first. `mic_users` and `route` are sent once at
// start and then only when they change; Core Audio is polled every second, because its process
// listeners stop firing on macOS 26 (home-assistant/iOS#5635):
//   mic_users  {users: [{pid, bundleId, path, name}]}: every process with audio input running,
//              sorted by pid. A process inside an app is named by its outermost `.app`
//              (`bundleId` its CFBundleIdentifier, `path` the .app folder), any other process by
//              its executable (`bundleId` null, `path` the executable: FaceTime and phone calls
//              show as /usr/libexec/avconferenced). Roger's own processes are listed like any
//              other: its renderer holds the mic, and the `tap` helper probably shows too, since
//              its private aggregate device has the tap as an input (unverified). Main leaves its
//              own pids out.
//   route      {output, input}: the default devices, each {name, transport} or null when there is
//              none. Transports in MonitorTransport (Route.swift).
//   recording  {on}: main's last `recording on` or `recording off`, sent when it changes the state.
//   relaunch   {dryRun: true, command}: only with --relaunch-dry-run, in place of running
//              `command` (ParentWatch.swift).
//   alive      {}: after every poll, changed or not, so once a second. While nothing changes it
//              is the only line, and HelperProcess (M2-T10) SIGKILLs a helper that writes no stdout
//              byte and no event for 3 s: a change-only monitor on a quiet Mac would be killed
//              every 3 s and spend its 5 restarts in about 15 s, leaving no call detection and no
//              relaunch. A monitor stuck in a Core Audio read sends none and is killed as hung.
//
// stderr carries HelperEvent lines (Protocol.swift): `warning` when a read fails (once until it
// works again) or for an unknown stdin command, `error` before a failed exit.
//
// stdin takes `recording on` and `recording off`, one per line. Main must send `recording off`
// before it quits on purpose, or the monitor takes the quit for a crash and relaunches Roger. An
// unpackaged dev build must pass --relaunch-dry-run: `open -b ai.linkt.roger` starts the installed
// /Applications/Roger.app, not the dev build that died.
//
// Exits: when the parent exits (after relaunching Roger once, if it was recording), when the
// pipes close (see ParentWatch.swift for why that waits while recording), and on SIGTERM, SIGINT
// or SIGHUP, which never relaunch.
//
// `roger-audio monitor --resolve-pid <pid>` prints that process as `mic_users` would list it, as
// one `process` line {pid, bundleId, path, name}, and exits; `error {code: "no_such_process"}`
// when there is none.
//
// Reads only: process objects and device properties, never IO on a device, so the monitor needs no
// permission and raises no privacy prompt. `make check` runs it (monitorRelaunch.mac.test.ts). The
// tccd log still shows coreaudiod asking about Microphone, ScreenCapture and AudioCapture for each
// monitor: it does that for every new Core Audio client, with `preflight=yes`, a query that never
// shows a dialog (checked on macOS 26.6, 2026-10-06). Starting IO on an input device would prompt.

/// The monitor's command line.
enum MonitorMode: Equatable {
  case watch(parent: pid_t, relaunchDryRun: Bool)
  case resolve(pid: pid_t)

  static let usage =
    "usage: roger-audio monitor --parent-pid <pid> [--relaunch-dry-run]"
    + " | roger-audio monitor --resolve-pid <pid>"

  init(arguments: [String]) throws {
    let options = try CommandOptions(
      arguments, valueOptions: ["--parent-pid", "--resolve-pid"],
      flagOptions: ["--relaunch-dry-run"])
    // CommandOptions has no required options. -1 is outside the range every given pid is checked
    // against, so it can only mean "not given". Pid 1 is launchd: an orphaned monitor's parent.
    let pids = 2...Int(Int32.max)
    let parent = try options.int("--parent-pid", default: -1, in: pids)
    let resolve = try options.int("--resolve-pid", default: -1, in: pids)
    switch (parent, resolve) {
    case (-1, -1):
      throw UsageError("--parent-pid is required")
    case (_, -1):
      self = .watch(parent: pid_t(parent), relaunchDryRun: options.has("--relaunch-dry-run"))
    case (-1, _):
      guard !options.has("--relaunch-dry-run") else {
        throw UsageError("--relaunch-dry-run goes with --parent-pid")
      }
      self = .resolve(pid: pid_t(resolve))
    default:
      throw UsageError("--parent-pid and --resolve-pid do not go together")
    }
  }
}

/// A command main writes to the monitor's stdin.
enum MonitorCommand: Equatable {
  case recording(Bool)
  case unknown(String)

  /// Nil for a blank line. Surrounding whitespace is ignored.
  init?(line: String) {
    let command = line.trimmingCharacters(in: .whitespaces)
    switch command {
    case "": return nil
    case "recording on": self = .recording(true)
    case "recording off": self = .recording(false)
    default: self = .unknown(command)
    }
  }
}

/// A process with audio input running, as `mic_users` lists it.
struct MicUser: Equatable {
  let pid: pid_t
  /// The outermost app's CFBundleIdentifier; nil outside an app, or for an app without one.
  let bundleId: String?
  /// The outermost `.app` folder for a process inside one, else the executable; nil when neither
  /// could be read.
  let path: String?
  /// For people and logs: the app's display name, or the executable's file name.
  let name: String

  var fields: [(String, MonitorJSON)] {
    [
      ("pid", .number(Double(pid))),
      ("bundleId", bundleId.map(MonitorJSON.string) ?? .null),
      ("path", path.map(MonitorJSON.string) ?? .null),
      ("name", .string(name)),
    ]
  }
}

/// Who a process is (M2 D6): its outermost `.app`, or its executable when it is in none.
///
/// Outermost, because the process that holds the mic is often a helper app inside the one people
/// know: in Chrome a "Google Chrome Helper.app" nested deep inside "Google Chrome.app", and main's
/// allowlist names the outer app.
/// Outside any app, by executable path: FaceTime and phone call audio runs in
/// /usr/libexec/avconferenced and callservicesd, which have no `.app` around them (anarlog
/// `crates/detect/src/list/macos.rs`, APPLE_CALL_DAEMON_IDS).
enum ProcessIdentity {
  /// Nil when no process has `pid` (it exited).
  static func resolve(pid: pid_t) -> MicUser? {
    switch executablePath(of: pid) {
    case .path(let path):
      return identify(pid: pid, executablePath: path)
    case .gone:
      return nil
    case .unreadable:
      // A live process whose path the kernel would not give: Core Audio's own bundle id for it
      // (the process itself, not its outermost app) is all there is.
      let bundleId = MicUserScanner.coreAudioBundleID(of: pid)
      return MicUser(pid: pid, bundleId: bundleId, path: nil, name: bundleId ?? "pid \(pid)")
    }
  }

  /// Names the process from its executable's path; reads the outermost app's Info.plist.
  static func identify(pid: pid_t, executablePath: String) -> MicUser {
    let components = (executablePath as NSString).pathComponents
    // The executable's own name never makes it an app, so the last component is left out.
    guard
      let appIndex = components.dropLast().firstIndex(where: {
        $0.count > 4 && $0.lowercased().hasSuffix(".app")
      })
    else {
      return MicUser(
        pid: pid, bundleId: nil, path: executablePath,
        name: (executablePath as NSString).lastPathComponent)
    }
    let appPath = NSString.path(withComponents: Array(components[...appIndex]))
    let info = infoPlist(ofApp: appPath)
    let name =
      nonEmptyString(info["CFBundleDisplayName"]) ?? nonEmptyString(info["CFBundleName"])
      ?? (components[appIndex] as NSString).deletingPathExtension
    return MicUser(
      pid: pid, bundleId: nonEmptyString(info["CFBundleIdentifier"]), path: appPath, name: name)
  }

  enum ExecutablePath: Equatable {
    case path(String)
    /// No process has the pid.
    case gone
    /// The process exists but its path could not be read.
    case unreadable
  }

  static func executablePath(of pid: pid_t) -> ExecutablePath {
    // PROC_PIDPATHINFO_MAXSIZE (libproc.h) is a macro Swift does not import.
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
    let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard length > 0 else { return errno == ESRCH ? .gone : .unreadable }
    return .path(
      String(decoding: buffer.prefix(Int(length)).map { UInt8(bitPattern: $0) }, as: UTF8.self))
  }

  /// Another app's Info.plist, or an empty dictionary when it has none or it cannot be parsed: the
  /// app is then named by its folder and has no bundle id, which main's allowlist cannot match.
  /// That is the app's state, not the monitor's failure, so it is no warning.
  private static func infoPlist(ofApp appPath: String) -> [String: Any] {
    let url = URL(fileURLWithPath: appPath).appendingPathComponent("Contents/Info.plist")
    guard let data = FileManager.default.contents(atPath: url.path),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil)
        as? [String: Any]
    else { return [:] }
    return plist
  }

  private static func nonEmptyString(_ value: Any?) -> String? {
    guard let text = value as? String, !text.isEmpty else { return nil }
    return text
  }
}

/// Reads which processes run audio input, from Core Audio's process objects (macOS 14.2+).
enum MicUserScanner {
  private static let system = AudioObjectID(kAudioObjectSystemObject)

  /// Throws a `mic_users_failed` HelperFailure when the process list cannot be read.
  static func scan() throws -> [MicUser] {
    var address = globalAddress(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    try check(
      AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size),
      "could not size the audio process list")
    let stride = MemoryLayout<AudioObjectID>.stride
    var objects = [AudioObjectID](repeating: 0, count: Int(size) / stride)
    try check(
      AudioObjectGetPropertyData(system, &address, 0, nil, &size, &objects),
      "could not read the audio process list")
    // The list can shrink between the two calls; `size` then says how much was written.
    objects.removeLast(objects.count - min(objects.count, Int(size) / stride))

    var users: [MicUser] = []
    for object in objects {
      // Each process object is read separately, and its process can quit in between: Core Audio
      // then answers with an error ('!obj'), and that process is simply no longer a mic user. The
      // same for a process the kernel no longer knows (`resolve` is nil).
      guard readUInt32(object, kAudioProcessPropertyIsRunningInput) == 1,
        let pid = readPID(object), let user = ProcessIdentity.resolve(pid: pid)
      else { continue }
      users.append(user)
    }
    return users.sorted { $0.pid < $1.pid }
  }

  /// Core Audio's bundle id for the process, when it has a process object and one.
  static func coreAudioBundleID(of pid: pid_t) -> String? {
    var address = globalAddress(kAudioHardwarePropertyTranslatePIDToProcessObject)
    var qualifier = pid
    var object = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(
      system, &address, UInt32(MemoryLayout<pid_t>.size), &qualifier, &size, &object)
    guard status == noErr, object != AudioObjectID(kAudioObjectUnknown) else { return nil }
    var bundleAddress = globalAddress(kAudioProcessPropertyBundleID)
    var bundleID: Unmanaged<CFString>?
    var bundleSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard
      AudioObjectGetPropertyData(object, &bundleAddress, 0, nil, &bundleSize, &bundleID) == noErr,
      // The caller owns the returned string (AudioHardware.h, kAudioProcessPropertyBundleID).
      let text = bundleID?.takeRetainedValue() as String?, !text.isEmpty
    else { return nil }
    return text
  }

  private static func readUInt32(
    _ object: AudioObjectID, _ selector: AudioObjectPropertySelector
  ) -> UInt32? {
    var address = globalAddress(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr else {
      return nil
    }
    return value
  }

  private static func readPID(_ object: AudioObjectID) -> pid_t? {
    var address = globalAddress(kAudioProcessPropertyPID)
    var pid: pid_t = 0
    var size = UInt32(MemoryLayout<pid_t>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &pid) == noErr, pid > 0 else {
      return nil
    }
    return pid
  }

  private static func check(_ status: OSStatus, _ what: String) throws {
    guard status != noErr else { return }
    throw HelperFailure(
      code: "mic_users_failed",
      message: "\(what) (OSStatus \(status) \(fourCharCode(UInt32(bitPattern: status))))",
      status: status)
  }

  private static func globalAddress(
    _ selector: AudioObjectPropertySelector
  ) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
      mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
  }
}

/// One stdout line of the monitor. See the top of this file.
enum MonitorLine {
  case micUsers([MicUser])
  case route(MonitorRoute)
  case recording(on: Bool)
  case relaunch(command: [String])
  case process(MicUser)
  case alive

  var jsonLine: String {
    MonitorJSON.object(fields).encoded + "\n"
  }

  private var fields: [(String, MonitorJSON)] {
    switch self {
    case .micUsers(let users):
      return [
        ("event", .string("mic_users")),
        ("users", .array(users.map { MonitorJSON.object($0.fields) })),
      ]
    case .route(let route):
      return [
        ("event", .string("route")),
        ("output", route.output?.json ?? .null),
        ("input", route.input?.json ?? .null),
      ]
    case .recording(let on):
      return [("event", .string("recording")), ("on", .bool(on))]
    case .relaunch(let command):
      return [
        ("event", .string("relaunch")), ("dryRun", .bool(true)),
        ("command", .array(command.map(MonitorJSON.string))),
      ]
    case .process(let user):
      return [("event", .string("process"))] + user.fields
    case .alive:
      return [("event", .string("alive"))]
    }
  }
}

/// The JSON the monitor's lines need. Protocol.swift's encoder for the tap's events is private to
/// that file and has no arrays, booleans or null; this one keeps its rules: a fixed key order
/// ("event" first) and an encoding that cannot fail.
enum MonitorJSON {
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  case array([MonitorJSON])
  case object([(String, MonitorJSON)])

  var encoded: String {
    switch self {
    case .string(let text):
      return Self.quote(text)
    case .number(let value):
      guard value.isFinite else { return "null" }
      // Whole numbers print without ".0": a pid is 4242, not 4242.0.
      if value == value.rounded(), abs(value) < 1e15 { return String(Int64(value)) }
      return String(value)
    case .bool(let value):
      return value ? "true" : "false"
    case .null:
      return "null"
    case .array(let items):
      return "[" + items.map(\.encoded).joined(separator: ",") + "]"
    case .object(let fields):
      return "{" + fields.map { Self.quote($0.0) + ":" + $0.1.encoded }.joined(separator: ",") + "}"
    }
  }

  private static func quote(_ text: String) -> String {
    var out = "\""
    for scalar in text.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      case _ where scalar.value < 0x20: out += String(format: "\\u%04x", scalar.value)
      default: out.unicodeScalars.append(scalar)
      }
    }
    return out + "\""
  }
}

/// One `roger-audio monitor --parent-pid` run: polls, reports changes, takes stdin commands, and
/// leaves the end to ParentWatch. Control queue only.
final class MonitorSession {
  /// How often Core Audio is read. Main's call detection counts in seconds (5 s of mic use before
  /// an offer, M2 D6), so a second is the coarsest that keeps those numbers honest. It is also how
  /// often `alive` goes out, which must stay well under HelperProcess's 3 s watchdog.
  static let pollInterval: DispatchTimeInterval = .seconds(1)

  private let queue: DispatchQueue
  private let stdin: Int32
  private let events: EventSink
  private let parentWatch: ParentWatch
  private let writeLine: (String) throws -> Void
  private let scanMicUsers: () throws -> [MicUser]
  private let readRoute: () throws -> MonitorRoute
  private var timer: DispatchSourceTimer?
  private var lastUsers: [MicUser]?
  private var lastRoute: MonitorRoute?
  /// Codes of the reads failing now: each warns once, not every second.
  private var failing: Set<String> = []

  init(
    queue: DispatchQueue, stdin: Int32, events: EventSink, parentWatch: ParentWatch,
    writeLine: @escaping (String) throws -> Void,
    scanMicUsers: @escaping () throws -> [MicUser] = MicUserScanner.scan,
    readRoute: @escaping () throws -> MonitorRoute = RouteReader.read
  ) {
    self.queue = queue
    self.stdin = stdin
    self.events = events
    self.parentWatch = parentWatch
    self.writeLine = writeLine
    self.scanMicUsers = scanMicUsers
    self.readRoute = readRoute
  }

  func start() {
    parentWatch.start()
    LineReader(
      fd: stdin, queue: queue,
      onLine: { [weak self] line in self?.handle(line) },
      onEnd: { [weak self] end in self?.stdinEnded(end) }
    ).start()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: Self.pollInterval)
    timer.setEventHandler { [weak self] in self?.poll() }
    timer.resume()
    self.timer = timer
  }

  private func poll() {
    guard parentWatch.parentAlive else {
      timer?.cancel()
      return
    }
    read("mic_users_failed", scanMicUsers) { users in
      guard users != lastUsers else { return }
      lastUsers = users
      publish(.micUsers(users))
    }
    read("route_failed", readRoute) { route in
      guard route != lastRoute else { return }
      lastRoute = route
      publish(.route(route))
    }
    // Every poll, even one whose reads failed: the watchdog asks whether the monitor runs, and the
    // warnings say how well (top of this file).
    publish(.alive)
  }

  /// Runs one read; on failure warns once per spell and keeps the last value, which the next poll
  /// may replace.
  private func read<Value>(
    _ code: String, _ reader: () throws -> Value, _ use: (Value) -> Void
  ) {
    do {
      let value = try reader()
      failing.remove(code)
      use(value)
    } catch {
      let failure = HelperFailure(wrapping: error, code: code)
      guard failing.insert(failure.code).inserted else { return }
      events.emit(
        .warning(code: failure.code, message: "\(failure.message); reading again every second"))
    }
  }

  private func publish(_ line: MonitorLine) {
    do {
      try writeLine(line.jsonLine)
    } catch OutputError.closed {
      parentWatch.pipesClosed()
    } catch {
      events.emit(.warning(code: "stdout_failed", message: "writing stdout failed: \(error)"))
      parentWatch.pipesClosed()
    }
  }

  private func handle(_ line: String) {
    switch MonitorCommand(line: line) {
    case nil:
      return
    case .recording(let on)?:
      if parentWatch.setRecording(on) { publish(.recording(on: on)) }
    case .unknown(let text)?:
      events.emit(
        .warning(code: "unknown_command", message: "unknown stdin command: \(text.prefix(80))"))
    }
  }

  private func stdinEnded(_ end: InputEnd) {
    if case .failed(let code) = end {
      events.emit(.warning(code: "stdin_failed", message: "reading stdin failed: errno \(code)"))
    }
    parentWatch.pipesClosed()
  }
}

/// Writes one line to stdout. Throws OutputError (`.closed` once the reader is gone).
private func writeStdout(_ line: String) throws {
  try Array(line.utf8).withUnsafeBytes { try writeAll(fd: STDOUT_FILENO, $0) }
}

/// `roger-audio monitor`: see the top of this file.
func runMonitor(arguments: [String]) -> Int32 {
  let events = StderrEventSink()
  let mode: MonitorMode
  do {
    mode = try MonitorMode(arguments: arguments)
  } catch {
    events.emit(.error(code: "usage", message: "\(error). \(MonitorMode.usage)", status: nil))
    return ExitCode.usage.rawValue
  }
  // A reader that went away must come back as EPIPE from write(2), not end the process: Roger's
  // death closes the pipes, and the relaunch still has to happen after that.
  signal(SIGPIPE, SIG_IGN)

  switch mode {
  case .resolve(let pid):
    guard let user = ProcessIdentity.resolve(pid: pid) else {
      events.emit(
        .error(code: "no_such_process", message: "no process has pid \(pid)", status: nil))
      return ExitCode.failure.rawValue
    }
    do {
      try writeStdout(MonitorLine.process(user).jsonLine)
    } catch {
      events.emit(
        .error(code: "stdout_failed", message: "writing stdout failed: \(error)", status: nil))
      return ExitCode.failure.rawValue
    }
    return ExitCode.ok.rawValue

  case .watch(let parent, let relaunchDryRun):
    let queue = DispatchQueue(label: "ai.linkt.roger.audio.monitor")
    let relauncher: Relauncher =
      relaunchDryRun ? DryRunRelauncher(writeLine: writeStdout) : OpenRelauncher()
    let parentWatch = ParentWatch(parent: parent, queue: queue, relauncher: relauncher) { code in
      exit(code.rawValue)
    }
    let session = MonitorSession(
      queue: queue, stdin: STDIN_FILENO, events: events, parentWatch: parentWatch,
      writeLine: writeStdout)
    let signals = TerminationSignals(queue: queue) { _ in parentWatch.finish(.ok) }
    events.onWriteFailure = { _ in queue.async { parentWatch.pipesClosed() } }
    queue.async { session.start() }
    withExtendedLifetime((signals, session)) { dispatchMain() }
  }
}
