import Foundation

// `roger-audio probe [--seconds 2]`: is System Audio Recording granted? No public API reads that
// permission, and a tap that is refused, or built while the macOS dialog is still up, records
// digital silence with no error. So main plays a short system sound (`/usr/bin/afplay`) while the
// probe listens through a real tap, and reads the peak: heard means granted. M2-T19's setup screen
// runs it; the "Permission check for system audio" row of docs/plans/M2-capture-you-can-trust.md
// has the whole check.
//
// stdout carries two JSON lines, "event" first:
//   listening  {seconds}: the tap runs and listening starts now, for `seconds`. Main starts the
//              sound on this line: started earlier, its first part plays before the tap exists.
//   result     {peak, audioMs}: `peak` is the largest |sample| heard, on the 0 to 32768 scale of
//              `tap`'s `stats.peak`. Above 0, the tap heard something, so the permission is
//              granted (any app's sound counts, not only main's). 0: refused, the dialog still
//              up, or nothing played. `audioMs` is how much tap audio arrived, silent or not; 0
//              means the tap never ran, a helper failure and no answer about the permission (a
//              `no_audio` warning says so too).
// stderr carries `warning` and `error` events as `tap` writes them (Protocol.swift). Exit codes are
// `tap`'s: 0 after a result line, and 0 with no result after a termination signal or a closed
// stdout (both deliberate); 1 after an `error` event (no tap could be built); 64 for a bad command
// line.
//
// Unlike `tap` it neither reads stdin nor watches its parent: it tears its tap down after at most
// 10 s whatever happens, so no tap it builds outlives Roger by longer than that.

/// `probe`'s options.
struct ProbeOptions: Equatable {
  static let usage = "usage: roger-audio probe [--seconds 2]"

  /// How long the probe listens once its tap runs: whole seconds, 1 to 10.
  let seconds: Int

  init(seconds: Int) {
    self.seconds = seconds
  }

  init(arguments: [String]) throws {
    let options = try CommandOptions(arguments, valueOptions: ["--seconds"])
    self.init(seconds: try options.int("--seconds", default: 2, in: 1...10))
  }
}

/// What the probe heard. See the top of this file.
struct ProbeResult: Equatable {
  var peak: Int
  var audioMs: Int
}

/// One stdout line of `probe`. See the top of this file.
enum ProbeOutput: Equatable {
  case listening(seconds: Int)
  case result(ProbeResult)

  /// Whole numbers only, so nothing needs escaping (events go through Protocol.swift's encoder).
  var jsonLine: String {
    switch self {
    case .listening(let seconds):
      return #"{"event":"listening","seconds":\#(seconds)}"# + "\n"
    case .result(let result):
      return #"{"event":"result","peak":\#(result.peak),"audioMs":\#(result.audioMs)}"# + "\n"
    }
  }
}

/// The loudest sample a probe heard, and how much audio it got.
struct PeakMeter {
  /// The largest |sample| so far. NaN never compares larger, so it is never the loudest.
  private var loudest: Float = 0
  private var audioMs = 0.0

  /// `sampleRate` is a span's, which AudioRing never lets be 0.
  mutating func add(_ samples: UnsafeBufferPointer<Float>, sampleRate: Double) {
    precondition(sampleRate > 0, "a span's sample rate is above 0")
    for sample in samples where abs(sample) > loudest {
      loudest = abs(sample)
    }
    audioMs += Double(samples.count) / sampleRate * 1_000
  }

  /// The peak on `stats.peak`'s scale: |sample| times 32768, rounded, at most full scale. Under
  /// half a 16-bit step is 0, as it is in `tap`'s Int16 output.
  var result: ProbeResult {
    ProbeResult(peak: Int((min(loudest, 1) * 32_768).rounded()), audioMs: Int(audioMs.rounded()))
  }
}

/// One probe: builds the tap, says it listens, keeps the loudest sample for `seconds`, and tears
/// the tap down on every way out. `run` blocks its caller's thread, which does the listening; tap
/// calls go to `queue`, where the tap's Core Audio listeners run, so never call `run` on `queue`.
final class PeakProbe: @unchecked Sendable {
  private let device: TapDevice
  private let ring: AudioRing
  private let queue: DispatchQueue
  private let events: EventSink
  private let seconds: Int
  private let pollInterval: TimeInterval
  private let uptime: () -> TimeInterval
  private let cancelled = Locked(false)
  private var meter = PeakMeter()

  init(
    device: TapDevice, ring: AudioRing, queue: DispatchQueue, events: EventSink, seconds: Int,
    pollInterval: TimeInterval = 0.01,
    uptime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.device = device
    self.ring = ring
    self.queue = queue
    self.events = events
    self.seconds = seconds
    self.pollInterval = pollInterval
    self.uptime = uptime
  }

  /// Ends the listening early (a termination signal): `run` tears the tap down and returns nil.
  /// Any thread.
  func cancel() {
    cancelled.withValue { $0 = true }
  }

  /// Call once. `report` writes a line to stdout: the `listening` line goes through it as soon as
  /// the tap runs. Returns what was heard, or nil once cancelled; throws the tap's failure or
  /// `report`'s.
  func run(report: (String) throws -> Void) throws -> ProbeResult? {
    defer { queue.sync { device.teardown() } }
    _ = try queue.sync { try device.build() }
    if cancelled.value { return nil }
    try report(ProbeOutput.listening(seconds: seconds).jsonLine)

    let buffer = UnsafeMutableBufferPointer<Float>.allocate(capacity: ring.maxSpanFrames)
    defer { buffer.deallocate() }
    // Timed on the uptime clock, as FrameWriter's stats are: the wall clock can step back (set by
    // hand, or by NTP after a wake) and would stretch the listening by as much.
    let deadline = uptime() + TimeInterval(seconds)
    while !cancelled.value && uptime() < deadline {
      drain(into: buffer)
      Thread.sleep(forTimeInterval: pollInterval)
    }
    if cancelled.value { return nil }
    // What arrived since the last pass, up to a poll's worth.
    drain(into: buffer)

    let heard = meter.result
    if heard.audioMs == 0 {
      events.emit(
        .warning(
          code: "no_audio",
          message: "the tap delivered no audio in \(seconds) s: its device never ran, so the "
            + "probe says nothing about the permission"))
    }
    return heard
  }

  private func drain(into buffer: UnsafeMutableBufferPointer<Float>) {
    while let span = ring.read(into: buffer) {
      meter.add(UnsafeBufferPointer(rebasing: buffer[0..<span.frameCount]), sampleRate: span.sampleRate)
    }
  }
}

/// `roger-audio probe`: see the top of this file.
func runProbe(arguments: [String]) -> Int32 {
  let events = StderrEventSink()
  let options: ProbeOptions
  do {
    options = try ProbeOptions(arguments: arguments)
  } catch {
    events.emit(.error(code: "usage", message: "\(error). \(ProbeOptions.usage)", status: nil))
    return ExitCode.usage.rawValue
  }
  // A main that stopped reading must come back as EPIPE from write(2), so the tap is torn down,
  // not end the process with the tap still built.
  signal(SIGPIPE, SIG_IGN)

  let queue = DispatchQueue(label: "ai.linkt.roger.audio.probe")
  let ring = AudioRing()
  let probe = PeakProbe(
    device: SystemAudioTap(ring: ring, queue: queue, events: events), ring: ring, queue: queue,
    events: events, seconds: options.seconds)
  let signals = TerminationSignals(queue: queue) { _ in probe.cancel() }
  defer { signals.cancel() }
  do {
    guard let heard = try probe.run(report: writeStdoutLine) else { return ExitCode.ok.rawValue }
    try writeStdoutLine(ProbeOutput.result(heard).jsonLine)
    return ExitCode.ok.rawValue
  } catch OutputError.closed {
    // Nobody reads the answer any more: main is gone or gave up on the probe.
    return ExitCode.ok.rawValue
  } catch {
    events.emit(HelperFailure(wrapping: error, code: "probe_failed").errorEvent)
    return ExitCode.failure.rawValue
  }
}

private func writeStdoutLine(_ line: String) throws {
  try Array(line.utf8).withUnsafeBytes { try writeAll(fd: STDOUT_FILENO, $0) }
}
