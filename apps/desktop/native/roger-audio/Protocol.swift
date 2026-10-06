import CoreAudio
import Foundation

// The wire contract between roger-audio and Roger's main process. The reader is HelperProcess and
// TapSystemAudio (M2-T10), with a fake helper (test/fixtures/fake-roger-audio.mjs) that mimics this
// file. Change the three together: a mismatch shows up as call audio that never arrives.
//
// `roger-audio tap --sample-rate 16000 --chunk-ms 100`
//
// stdout carries binary frames and nothing else, ever. A frame is a 16-byte header, then its payload:
//   bytes 0..<4    ASCII "RGA1"
//   bytes 4..<8    payload length in bytes, UInt32 little endian
//   bytes 8..<16   wall-clock time of the payload's first sample, ms since the Unix epoch, Float64 LE
//   payload        mono Int16 little-endian PCM at the output rate (16 kHz: `linear16`)
// A frame is one chunk long (100 ms, 3,200 bytes) except the last frame before a discontinuity (the
// tap was rebuilt, the ring dropped audio, the tap clock jumped) and the last one at exit, which
// are shorter. So a frame never spans a gap: each sample's time follows from its frame's header.
//
// stderr carries one JSON object per line, "event" first:
//   ready      {format: {encoding, sampleRate, channels, chunkMs}, tapFormat: {sampleRate, channels}}
//              once, when the tap runs. `format` is what stdout carries.
//   restarted  {reason, tapFormat}: the tap was rebuilt (reasons in RestartReason).
//   stats      {peak, frames, dropped} every second from the writer thread, each about the second
//              since the previous line: `peak` is the largest |sample| written (0 to 32768, so 0
//              is digital silence), `frames` the frames written, `dropped` the ms of tap audio the
//              ring dropped because the writer fell behind. A writer stuck on a full stdout sends
//              no stats either, which is what main's 3 s watchdog relies on.
//   warning    {code, message}: something degraded; the helper carries on.
//   error      {code, message, status?}: the helper is about to exit with a failure code.
//              `status` is the Core Audio OSStatus when there is one.
//
// stdin takes one command per line: `rebuild` rebuilds the tap now (main sends it after the user
// grants System Audio Recording, because a tap built while the prompt was up stays silent). End of
// input exits, and so does the death of the parent process, so no tap outlives Roger.
//
// `monitor` (M2-T8) and `probe` (M2-T7b) define their own output in their files.

/// The helper's exit codes. HelperProcess restarts the helper on any code but `ok`.
enum ExitCode: Int32 {
  case ok = 0
  /// A runtime failure, reported first as an `error` event; or a failed selftest.
  case failure = 1
  /// A bad command line (sysexits EX_USAGE).
  case usage = 64
  /// A subcommand this build does not have yet (sysexits EX_UNAVAILABLE).
  case unavailable = 69
}

/// The PCM `tap` writes to stdout.
struct OutputFormat: Equatable {
  /// The name main uses for this PCM (`PCM_ENCODING` in apps/desktop/src/shared/ipc.ts).
  static let encoding = "linear16"
  static let channels = 1
  static let tapUsage = "usage: roger-audio tap [--sample-rate 16000] [--chunk-ms 100]"

  let sampleRate: Int
  let chunkMs: Int

  var samplesPerFrame: Int { sampleRate * chunkMs / 1_000 }
  var payloadBytes: Int { samplesPerFrame * MemoryLayout<Int16>.size }

  init(sampleRate: Int, chunkMs: Int) {
    self.sampleRate = sampleRate
    self.chunkMs = chunkMs
  }

  /// Parses `tap`'s options. The helper can produce other rates; main refuses to start on any
  /// format but 16 kHz `linear16` (the one the STT stream settings name).
  init(tapArguments: [String]) throws {
    let options = try CommandOptions(tapArguments, valueOptions: ["--sample-rate", "--chunk-ms"])
    let sampleRate = try options.int("--sample-rate", default: 16_000, in: 8_000...48_000)
    let chunkMs = try options.int("--chunk-ms", default: 100, in: 10...1_000)
    guard (sampleRate * chunkMs) % 1_000 == 0 else {
      throw UsageError("\(chunkMs) ms at \(sampleRate) Hz is not a whole number of samples")
    }
    self.init(sampleRate: sampleRate, chunkMs: chunkMs)
  }
}

/// A frame's 16-byte header. See the top of this file.
struct FrameHeader: Equatable {
  static let magic: [UInt8] = Array("RGA1".utf8)
  static let byteCount = 16

  var payloadBytes: UInt32
  /// Wall-clock ms since the Unix epoch of the payload's first sample.
  var captureWallMs: Double

  init(payloadBytes: UInt32, captureWallMs: Double) {
    self.payloadBytes = payloadBytes
    self.captureWallMs = captureWallMs
  }

  /// Decodes the first 16 bytes; nil when there are fewer or the magic is wrong.
  init?(bytes: [UInt8]) {
    guard bytes.count >= Self.byteCount, Array(bytes[0..<4]) == Self.magic else { return nil }
    var length: UInt32 = 0
    var timeBits: UInt64 = 0
    for index in 0..<4 { length |= UInt32(bytes[4 + index]) << (8 * index) }
    for index in 0..<8 { timeBits |= UInt64(bytes[8 + index]) << (8 * index) }
    self.init(payloadBytes: length, captureWallMs: Double(bitPattern: timeBits))
  }

  var bytes: [UInt8] {
    var out = [UInt8](repeating: 0, count: Self.byteCount)
    out.withUnsafeMutableBytes { write(to: $0) }
    return out
  }

  /// Writes the header into the first 16 bytes of `destination`.
  func write(to destination: UnsafeMutableRawBufferPointer) {
    precondition(destination.count >= Self.byteCount, "a frame header needs 16 bytes")
    for (index, byte) in Self.magic.enumerated() { destination[index] = byte }
    destination.storeBytes(of: payloadBytes.littleEndian, toByteOffset: 4, as: UInt32.self)
    destination.storeBytes(
      of: captureWallMs.bitPattern.littleEndian, toByteOffset: 8, as: UInt64.self)
  }
}

/// Why the tap was rebuilt (the `reason` of a `restarted` event).
enum RestartReason: String {
  /// The default output device changed (AirPods connected, speakers picked in Control Center).
  case outputDeviceChanged = "output_device_changed"
  /// The tap's stream format changed, typically its sample rate after a route change.
  case tapFormatChanged = "tap_format_changed"
  /// Main wrote `rebuild` to stdin.
  case rebuildRequested = "rebuild_requested"

  /// Several changes within one debounce window rebuild once, under the most telling reason:
  /// AirPods change the output device and then the tap format.
  var priority: Int {
    switch self {
    case .rebuildRequested: return 2
    case .outputDeviceChanged: return 1
    case .tapFormatChanged: return 0
    }
  }
}

/// One stderr line. See the top of this file for when each is sent.
enum HelperEvent {
  case ready(format: OutputFormat, tapFormat: TapFormat)
  case restarted(reason: RestartReason, tapFormat: TapFormat)
  case stats(peak: Int, frames: Int, droppedMs: Int)
  case warning(code: String, message: String)
  case error(code: String, message: String, status: OSStatus?)

  var jsonLine: String {
    JSONValue.object(fields).encoded + "\n"
  }

  private var fields: [(String, JSONValue)] {
    switch self {
    case .ready(let format, let tapFormat):
      return [
        ("event", .string("ready")),
        (
          "format",
          .object([
            ("encoding", .string(OutputFormat.encoding)),
            ("sampleRate", .number(Double(format.sampleRate))),
            ("channels", .number(Double(OutputFormat.channels))),
            ("chunkMs", .number(Double(format.chunkMs))),
          ])
        ),
        ("tapFormat", Self.describe(tapFormat)),
      ]
    case .restarted(let reason, let tapFormat):
      return [
        ("event", .string("restarted")),
        ("reason", .string(reason.rawValue)),
        ("tapFormat", Self.describe(tapFormat)),
      ]
    case .stats(let peak, let frames, let droppedMs):
      return [
        ("event", .string("stats")),
        ("peak", .number(Double(peak))),
        ("frames", .number(Double(frames))),
        ("dropped", .number(Double(droppedMs))),
      ]
    case .warning(let code, let message):
      return [("event", .string("warning")), ("code", .string(code)), ("message", .string(message))]
    case .error(let code, let message, let status):
      var fields: [(String, JSONValue)] = [
        ("event", .string("error")), ("code", .string(code)), ("message", .string(message)),
      ]
      if let status { fields.append(("status", .number(Double(status)))) }
      return fields
    }
  }

  private static func describe(_ tapFormat: TapFormat) -> JSONValue {
    .object([
      ("sampleRate", .number(tapFormat.sampleRate)),
      ("channels", .number(Double(tapFormat.channels))),
    ])
  }
}

/// Where events go: stderr in the helper, a recorder in the selftest.
protocol EventSink: AnyObject {
  func emit(_ event: HelperEvent)
}

/// Writes events to stderr, one whole line per write, from any thread.
final class StderrEventSink: EventSink, @unchecked Sendable {
  private let lock = NSLock()
  private var failureReported = false
  /// Called once when stderr cannot be written (main closed it, or is gone). stderr is the only
  /// place to report anything, so the owner decides: `tap` shuts down, since a main that stopped
  /// reading its events would never hear about a dead tap either.
  var onWriteFailure: ((OutputError) -> Void)?

  func emit(_ event: HelperEvent) {
    let line = Array(event.jsonLine.utf8)
    lock.lock()
    defer { lock.unlock() }
    do {
      try line.withUnsafeBytes { try writeAll(fd: STDERR_FILENO, $0) }
    } catch let error as OutputError {
      guard !failureReported else { return }
      failureReported = true
      onWriteFailure?(error)
    } catch {
      preconditionFailure("writeAll throws only OutputError, got \(error)")
    }
  }
}

/// The tap's stream format, as Core Audio reports it (`kAudioTapPropertyFormat`). Only Float32
/// linear PCM is taken: the IO block copies samples as they come and cannot convert.
struct TapFormat: Equatable {
  let sampleRate: Double
  let channels: Int
  let interleaved: Bool

  init(sampleRate: Double, channels: Int, interleaved: Bool) {
    self.sampleRate = sampleRate
    self.channels = channels
    self.interleaved = interleaved
  }

  init(_ description: AudioStreamBasicDescription) throws {
    let flags = description.mFormatFlags
    guard description.mFormatID == kAudioFormatLinearPCM,
      flags & kAudioFormatFlagIsFloat != 0,
      flags & kAudioFormatFlagIsBigEndian == 0,
      description.mBitsPerChannel == 32,
      description.mChannelsPerFrame > 0,
      description.mSampleRate > 0, description.mSampleRate <= AudioRing.maxSampleRate
    else {
      let got =
        "format \(fourCharCode(description.mFormatID)), flags \(flags), "
        + "\(description.mBitsPerChannel) bits, \(description.mChannelsPerFrame) channels, "
        + "\(description.mSampleRate) Hz"
      let supported = "32-bit float PCM up to \(Int(AudioRing.maxSampleRate)) Hz"
      throw HelperFailure(
        code: "unsupported_tap_format",
        message: "the tap delivers \(got); only \(supported) is supported")
    }
    self.init(
      sampleRate: description.mSampleRate, channels: Int(description.mChannelsPerFrame),
      interleaved: flags & kAudioFormatFlagIsNonInterleaved == 0)
  }
}

/// A failure the helper reports as an `error` event (or a `warning`, when it can carry on).
struct HelperFailure: Error, CustomStringConvertible {
  let code: String
  let message: String
  /// The Core Audio OSStatus behind it, when there is one.
  let status: OSStatus?

  init(code: String, message: String, status: OSStatus? = nil) {
    self.code = code
    self.message = message
    self.status = status
  }

  /// Keeps a HelperFailure as it is; wraps any other error under `code`.
  init(wrapping error: Error, code: String) {
    if let failure = error as? HelperFailure {
      self = failure
    } else {
      self.init(code: code, message: String(describing: error))
    }
  }

  var description: String { message }
  var errorEvent: HelperEvent { .error(code: code, message: message, status: status) }
}

/// Core Audio packs many codes as four ASCII characters ('nope', 'who?'); shows them that way
/// when they are printable, else as the plain number.
func fourCharCode(_ code: UInt32) -> String {
  let bytes = (0..<4).map { UInt8(truncatingIfNeeded: code >> (8 * (3 - $0))) }
  guard bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7F }) else { return String(code) }
  return "'" + String(decoding: bytes, as: UTF8.self) + "'"
}

/// Why a write to stdout or stderr failed.
enum OutputError: Error, Equatable {
  /// The reader closed its end (EPIPE): main is gone or stopped listening.
  case closed
  case failed(errno: Int32)
}

/// Writes every byte, retrying short writes and EINTR. Blocks while the pipe is full: that is the
/// writer thread's back-pressure, and the ring absorbs it (RingBuffer.swift). Needs SIGPIPE
/// ignored, or a closed pipe kills the process instead of throwing `.closed`.
func writeAll(fd: Int32, _ bytes: UnsafeRawBufferPointer) throws {
  guard let base = bytes.baseAddress else { return }
  var offset = 0
  while offset < bytes.count {
    let written = write(fd, base + offset, bytes.count - offset)
    if written >= 0 {
      offset += written
      continue
    }
    switch errno {
    case EINTR: continue
    case EPIPE: throw OutputError.closed
    case let code: throw OutputError.failed(errno: code)
    }
  }
}

/// A command main writes to `tap`'s stdin.
enum TapCommand: Equatable {
  case rebuild
  case unknown(String)

  /// Nil for a blank line. Surrounding whitespace is ignored.
  init?(line: String) {
    let command = line.trimmingCharacters(in: .whitespaces)
    if command.isEmpty { return nil }
    self = command == "rebuild" ? .rebuild : .unknown(command)
  }
}

struct UsageError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

/// `--name value` options of one subcommand. Anything not declared is refused, and so is an
/// option given twice, so a typo never silently falls back to a default.
struct CommandOptions {
  private var values: [String: String] = [:]
  private var flags: Set<String> = []

  init(_ arguments: [String], valueOptions: Set<String>, flagOptions: Set<String> = []) throws {
    var index = 0
    while index < arguments.count {
      let name = arguments[index]
      guard values[name] == nil, !flags.contains(name) else {
        throw UsageError("\(name) is given twice")
      }
      if valueOptions.contains(name) {
        guard index + 1 < arguments.count else { throw UsageError("\(name) needs a value") }
        values[name] = arguments[index + 1]
        index += 2
      } else if flagOptions.contains(name) {
        flags.insert(name)
        index += 1
      } else {
        throw UsageError("unknown option \(name)")
      }
    }
  }

  func int(_ name: String, default fallback: Int, in range: ClosedRange<Int>) throws -> Int {
    guard let text = values[name] else { return fallback }
    guard let value = Int(text), range.contains(value) else {
      throw UsageError("\(name) must be a whole number from \(range.lowerBound) to \(range.upperBound)")
    }
    return value
  }

  func has(_ flag: String) -> Bool { flags.contains(flag) }
}

/// Prints a line to stderr for a human (usage text). Machine-readable output goes through
/// `EventSink`.
func printError(_ text: String) {
  fputs(text + "\n", stderr)
}

/// The JSON the event lines need. Hand-rolled so the key order is fixed ("event" first, which keeps
/// the log readable) and encoding cannot fail at runtime.
private enum JSONValue {
  case string(String)
  case number(Double)
  case object([(String, JSONValue)])

  var encoded: String {
    switch self {
    case .string(let text):
      return Self.quote(text)
    case .number(let value):
      guard value.isFinite else { return "null" }
      // Whole numbers print without ".0": 16000, not 16000.0.
      if value == value.rounded(), abs(value) < 1e15 { return String(Int64(value)) }
      return String(value)
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
