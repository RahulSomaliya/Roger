import AVFoundation
import CoreAudio
import Foundation

// `roger-audio tap`: call audio from one mono global Core Audio process tap. The audio path is
//
//   IO block (Core Audio's real-time thread) -> AudioRing (2 s) -> FrameWriter thread:
//   FramePipeline (AVAudioConverter to 16 kHz Int16, frames with capture times) -> stdout
//
// The IO block only copies; everything that can block or allocate runs on the writer thread.

/// Maps Core Audio host time (`AudioTimeStamp.mHostTime`, in mach_absolute_time ticks) to
/// wall-clock ms since the Unix epoch.
///
/// Convert on the IO thread, as the buffer arrives: mach_absolute_time stops while the Mac sleeps,
/// so a host time converted after a sleep would be stamped late by the length of the sleep. Both
/// clock reads are commpage reads, safe on the real-time thread.
struct HostClock {
  private let nanosPerTick: Double

  init() {
    var timebase = mach_timebase_info_data_t()
    mach_timebase_info(&timebase)
    nanosPerTick = Double(timebase.numer) / Double(timebase.denom)
  }

  func nowWallMs() -> Double {
    Double(clock_gettime_nsec_np(CLOCK_REALTIME)) / 1_000_000
  }

  func wallMs(hostTime: UInt64) -> Double {
    let nowHost = mach_absolute_time()
    let nowWall = nowWallMs()
    // Signed: a host time a hair in the future maps just past now instead of wrapping.
    let ticksAgo = Double(Int64(bitPattern: nowHost &- hostTime))
    return nowWall - ticksAgo * nanosPerTick / 1_000_000
  }
}

extension TapFormat {
  /// The IO block's work: hands one input buffer list to the ring as mono Float32, mixing
  /// several channels down into `scratch` (sized to the ring's span). Real-time safe: no
  /// allocation, no lock but the ring's.
  func deliver(
    _ buffers: UnsafeMutableAudioBufferListPointer, captureWallMs: Double,
    scratch: UnsafeMutableBufferPointer<Float>, to ring: AudioRing
  ) {
    guard let first = buffers.first, let firstData = first.mData else { return }
    let sampleBytes = MemoryLayout<Float>.size
    if channels == 1 {
      let frames = Int(first.mDataByteSize) / sampleBytes
      ring.write(
        UnsafeBufferPointer(start: firstData.assumingMemoryBound(to: Float.self), count: frames),
        sampleRate: sampleRate, captureWallMs: captureWallMs)
      return
    }
    // A mono global tap has one channel; several are mixed down rather than refused, in case a
    // route ever hands the tap a stereo format.
    let frames: Int
    if interleaved {
      frames = Int(first.mDataByteSize) / (sampleBytes * channels)
    } else {
      guard buffers.count >= channels else { return }
      frames = Int(first.mDataByteSize) / sampleBytes
    }
    guard let mixed = scratch.baseAddress, scratch.count > 0 else { return }
    let scale = 1 / Float(channels)
    var done = 0
    while done < frames {
      let count = min(scratch.count, frames - done)
      for frame in 0..<count {
        var sum: Float = 0
        for channel in 0..<channels {
          if interleaved {
            sum += firstData.assumingMemoryBound(to: Float.self)[(done + frame) * channels + channel]
          } else if let data = buffers[channel].mData {
            sum += data.assumingMemoryBound(to: Float.self)[done + frame]
          }
        }
        mixed[frame] = sum * scale
      }
      ring.write(
        UnsafeBufferPointer(start: mixed, count: count), sampleRate: sampleRate,
        captureWallMs: captureWallMs + Double(done) / sampleRate * 1_000)
      done += count
    }
  }
}

/// Turns tap audio into protocol frames: converts each span to the output format with
/// AVAudioConverter, cuts the result into chunks and stamps each frame with the capture time of
/// its first sample. Writer thread only.
///
/// A run of contiguous audio goes through one converter. A discontinuity flag, a new tap rate or a
/// tap clock that jumps by more than `gapToleranceMs` ends the run: the converter is flushed, the
/// frame in progress goes out short, and the next frame starts at the new span's capture time. So a
/// frame never spans a gap, and main's AudioTimeline sees each gap at its true length.
final class FramePipeline {
  typealias FrameSink = (UnsafeRawBufferPointer) throws -> Void

  /// How far a span's capture time may sit from where the previous span ended before it counts as
  /// a gap that nothing flagged (the tap skipped IO cycles). Host timestamps jitter by far less;
  /// a smaller gap is absorbed, which shifts later frames by under 5 ms, far inside main's 250 ms
  /// run threshold and the ±700 ms echo window. Too small would split runs on jitter, and every
  /// split flushes the converter and sends a short frame.
  static let gapToleranceMs = 5.0

  let output: OutputFormat
  private let outputFormat: AVAudioFormat
  private let outputBuffer: AVAudioPCMBuffer
  private let sink: FrameSink
  private var run: Run?
  /// Header plus payload of the frame in progress; `pendingSamples` of it are filled.
  private var frame: [UInt8]
  private var pendingSamples = 0
  private var pendingWallMs = 0.0
  private var peak = 0
  private var framesWritten = 0

  init(output: OutputFormat, sink: @escaping FrameSink) throws {
    guard
      let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: Double(output.sampleRate), channels: 1,
        interleaved: true),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4_096)
    else {
      throw HelperFailure(
        code: "converter_failed",
        message: "could not set up \(output.sampleRate) Hz Int16 output buffers")
    }
    self.output = output
    outputFormat = format
    outputBuffer = buffer
    self.sink = sink
    frame = [UInt8](repeating: 0, count: FrameHeader.byteCount + output.payloadBytes)
  }

  /// Converts one span and writes every frame it completes.
  func push(_ samples: UnsafeBufferPointer<Float>, span: AudioSpan) throws {
    guard let base = samples.baseAddress, !samples.isEmpty else { return }
    let current = try runFor(span)
    current.anchors.append((current.inputFrames, span.captureWallMs))
    current.inputFrames += samples.count
    current.nextWallMs = span.captureWallMs + Double(samples.count) / span.sampleRate * 1_000

    guard
      let input = AVAudioPCMBuffer(
        pcmFormat: current.inputFormat, frameCapacity: AVAudioFrameCount(samples.count)),
      let channel = input.floatChannelData?[0]
    else {
      throw HelperFailure(
        code: "converter_failed", message: "could not allocate \(samples.count) input frames")
    }
    channel.update(from: base, count: samples.count)
    input.frameLength = AVAudioFrameCount(samples.count)
    var supplied = false
    try convert(current) { _, status in
      // Each push supplies its span once; "no data now" keeps the converter's state for the next
      // span of the run, where "end of stream" would flush it.
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return input
    }
  }

  /// Ends the current run: flushes the converter and writes the last, possibly short, frame.
  func finish() throws {
    guard let current = run else { return }
    try convert(current) { _, status in
      status.pointee = .endOfStream
      return nil
    }
    if pendingSamples > 0 { try writeFrame() }
    run = nil
  }

  /// The largest |sample| and the frames written since the last call.
  func takeStats() -> (peak: Int, frames: Int) {
    defer {
      peak = 0
      framesWritten = 0
    }
    return (peak, framesWritten)
  }

  private func runFor(_ span: AudioSpan) throws -> Run {
    if let current = run, !span.discontinuity, span.sampleRate == current.inputRate,
      abs(span.captureWallMs - current.nextWallMs) <= Self.gapToleranceMs
    {
      return current
    }
    try finish()
    let next = try Run(inputRate: span.sampleRate, outputFormat: outputFormat)
    run = next
    return next
  }

  private func convert(_ current: Run, input: @escaping AVAudioConverterInputBlock) throws {
    while true {
      var failure: NSError?
      let status = current.converter.convert(to: outputBuffer, error: &failure, withInputFrom: input)
      if status == .error {
        throw HelperFailure(
          code: "converter_failed",
          message: "converting \(current.inputRate) Hz to \(output.sampleRate) Hz failed: "
            + (failure?.localizedDescription ?? "no reason given"))
      }
      let produced = Int(outputBuffer.frameLength)
      if produced > 0, let converted = outputBuffer.int16ChannelData?[0] {
        try append(UnsafeBufferPointer(start: converted, count: produced), current)
      }
      // A full output buffer may leave converted audio inside; anything less means the input
      // supplied so far is used up.
      if status != .haveData || produced < Int(outputBuffer.frameCapacity) { return }
    }
  }

  private func append(_ converted: UnsafeBufferPointer<Int16>, _ current: Run) throws {
    for sample in converted {
      if pendingSamples == 0 {
        pendingWallMs = current.wallMs(
          atOutputFrame: current.outputFrames, outputRate: Double(output.sampleRate))
      }
      frame.withUnsafeMutableBytes {
        $0.storeBytes(
          of: sample.littleEndian, toByteOffset: FrameHeader.byteCount + 2 * pendingSamples,
          as: Int16.self)
      }
      pendingSamples += 1
      current.outputFrames += 1
      peak = max(peak, abs(Int(sample)))
      if pendingSamples == output.samplesPerFrame { try writeFrame() }
    }
  }

  private func writeFrame() throws {
    let length = FrameHeader.byteCount + 2 * pendingSamples
    try frame.withUnsafeMutableBytes { bytes in
      FrameHeader(payloadBytes: UInt32(2 * pendingSamples), captureWallMs: pendingWallMs)
        .write(to: bytes)
      try sink(UnsafeRawBufferPointer(rebasing: bytes[0..<length]))
    }
    pendingSamples = 0
    framesWritten += 1
  }

  /// One run of contiguous tap audio and its converter.
  private final class Run {
    let inputRate: Double
    let inputFormat: AVAudioFormat
    let converter: AVAudioConverter
    var inputFrames = 0
    var outputFrames = 0
    var nextWallMs = 0.0
    /// (input frame offset in the run, capture time) of each span still needed to time output.
    var anchors: [(offset: Int, wallMs: Double)] = []

    init(inputRate: Double, outputFormat: AVAudioFormat) throws {
      guard
        let format = AVAudioFormat(
          commonFormat: .pcmFormatFloat32, sampleRate: inputRate, channels: 1, interleaved: false),
        let converter = AVAudioConverter(from: format, to: outputFormat)
      else {
        throw HelperFailure(
          code: "converter_failed",
          message: "no converter from \(inputRate) Hz float to \(outputFormat.sampleRate) Hz Int16")
      }
      // Zero latency: output frame n is input time n / output rate. The selftest's click case
      // checks this; another prime method would shift every capture time by the filter delay.
      converter.primeMethod = .normal
      self.inputRate = inputRate
      inputFormat = format
      self.converter = converter
    }

    /// The capture time of output frame `index` of this run, from the span that holds its input.
    func wallMs(atOutputFrame index: Int, outputRate: Double) -> Double {
      let inputOffset = Double(index) * inputRate / outputRate
      var anchor = 0
      while anchor + 1 < anchors.count, Double(anchors[anchor + 1].offset) <= inputOffset {
        anchor += 1
      }
      // Output only moves forward, so spans before this one are never needed again.
      if anchor > 0 { anchors.removeFirst(anchor) }
      guard let span = anchors.first else { return nextWallMs }
      return span.wallMs + (inputOffset - Double(span.offset)) / inputRate * 1_000
    }
  }
}

/// The writer thread: every `pollInterval` it drains the ring through the pipeline to stdout, and
/// every `statsInterval` it sends a `stats` event.
///
/// WHY stats come from this thread and not a timer elsewhere: a writer stuck in write(2) (main
/// stopped reading) or deadlocked then also stops the events, so main's 3 s watchdog
/// (HelperProcess, M2-T10) sees a silent helper and restarts it. Stats from another thread would
/// keep a helper with dead audio looking alive.
///
/// WHY stats are timed by `uptime` (monotonic) and never by `Date()`: the wall clock steps back
/// when the user sets it back or NTP corrects it after a wake, and a schedule on it then sends no
/// stats for as long as the step, breaking the 1 s `stats` contract main reads the helper's
/// health from. Capture times are the opposite case: they must be wall clock (HostClock).
final class FrameWriter: @unchecked Sendable {
  enum StopCause: Equatable {
    /// `stop(timeout:)` was called.
    case requested
    /// stdout was closed (EPIPE): main is gone or stopped listening.
    case outputClosed
    case failed(HelperFailure)

    static func == (lhs: StopCause, rhs: StopCause) -> Bool {
      switch (lhs, rhs) {
      case (.requested, .requested), (.outputClosed, .outputClosed): return true
      case (.failed(let left), .failed(let right)): return left.code == right.code
      default: return false
      }
    }
  }

  /// Spans drained per pass, so a ring that keeps refilling cannot starve the stats line.
  private static let spansPerPass = 256

  private let ring: AudioRing
  private let pipeline: FramePipeline
  private let events: EventSink
  private let statsInterval: TimeInterval
  private let pollInterval: TimeInterval
  private let uptime: () -> TimeInterval
  private let stopRequested = Locked(false)
  private let running = DispatchGroup()

  init(
    ring: AudioRing, pipeline: FramePipeline, events: EventSink, statsInterval: TimeInterval = 1,
    pollInterval: TimeInterval = 0.01,
    uptime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.ring = ring
    self.pipeline = pipeline
    self.events = events
    self.statsInterval = statsInterval
    self.pollInterval = pollInterval
    self.uptime = uptime
  }

  /// Starts the thread. `onStopped` runs on it once, as its last act.
  func start(onStopped: @escaping (StopCause) -> Void) {
    running.enter()
    let thread = Thread { [self] in
      let cause = loop()
      onStopped(cause)
      running.leave()
    }
    thread.name = "roger-audio writer"
    thread.qualityOfService = .userInteractive
    thread.start()
  }

  /// Asks the thread to write what the ring holds, close the last frame and stop. Returns false
  /// when it has not stopped within `timeout` (stuck writing to a stdout nobody reads).
  func stop(timeout: TimeInterval) -> Bool {
    stopRequested.withValue { $0 = true }
    return running.wait(timeout: .now() + timeout) == .success
  }

  private func loop() -> StopCause {
    let buffer = UnsafeMutableBufferPointer<Float>.allocate(capacity: ring.maxSpanFrames)
    defer { buffer.deallocate() }
    var nextStats = uptime() + statsInterval
    var cause = StopCause.requested
    do {
      while true {
        let stopping = stopRequested.value
        let more = try drainPass(buffer)
        // On stop, everything the ring holds is written first: the last 100 ms are not lost.
        if stopping && !more { break }
        if uptime() >= nextStats {
          emitStats()
          nextStats = uptime() + statsInterval
        }
        if !more { Thread.sleep(forTimeInterval: pollInterval) }
      }
      try pipeline.finish()
    } catch OutputError.closed {
      cause = .outputClosed
    } catch let failure as HelperFailure {
      cause = .failed(failure)
    } catch {
      cause = .failed(HelperFailure(code: "writer_failed", message: "writing frames failed: \(error)"))
    }
    emitStats()
    return cause
  }

  /// Drains up to `spansPerPass` spans; true when there may be more.
  private func drainPass(_ buffer: UnsafeMutableBufferPointer<Float>) throws -> Bool {
    for _ in 0..<Self.spansPerPass {
      guard let span = ring.read(into: buffer) else { return false }
      try pipeline.push(UnsafeBufferPointer(rebasing: buffer[0..<span.frameCount]), span: span)
    }
    return true
  }

  private func emitStats() {
    let stats = pipeline.takeStats()
    // Rounded up, so a drop of a fraction of a ms still shows.
    let droppedMs = Int(ring.takeDroppedMs().rounded(.up))
    events.emit(.stats(peak: stats.peak, frames: stats.frames, droppedMs: droppedMs))
  }
}

/// Coalesces route and format changes into one tap rebuild, `delay` after the last change. AirPods
/// change the default output, then the tap's format, then sometimes the output again within a
/// few hundred ms; rebuilding on each would restart the tap three times. Control queue only.
final class RebuildDebouncer {
  private let delay: DispatchTimeInterval
  private let queue: DispatchQueue
  private let rebuild: (RestartReason) -> Void
  private var pending: DispatchWorkItem?
  private var pendingReason: RestartReason?

  init(delay: DispatchTimeInterval, queue: DispatchQueue, rebuild: @escaping (RestartReason) -> Void) {
    self.delay = delay
    self.queue = queue
    self.rebuild = rebuild
  }

  /// A change seen: rebuild `delay` from now, unless another change comes first.
  func changed(_ reason: RestartReason) {
    if let current = pendingReason, current.priority > reason.priority {
      pendingReason = current
    } else {
      pendingReason = reason
    }
    pending?.cancel()
    let item = DispatchWorkItem { [weak self] in
      guard let self, let reason = self.pendingReason else { return }
      self.pending = nil
      self.pendingReason = nil
      self.rebuild(reason)
    }
    pending = item
    queue.asyncAfter(deadline: .now() + delay, execute: item)
  }

  /// Rebuilds now, replacing any change still waiting.
  func rebuildNow(_ reason: RestartReason) {
    cancel()
    rebuild(reason)
  }

  func cancel() {
    pending?.cancel()
    pending = nil
    pendingReason = nil
  }
}

/// The audio device side of a tap session. `SystemAudioTap` is the real one; the selftest drives
/// TapSession with a fake, since a real tap needs the System Audio Recording permission.
protocol TapDevice: AnyObject {
  /// Builds the tap and starts it delivering into the ring; returns the tap's format.
  func build() throws -> TapFormat
  /// Stops and destroys whatever `build()` made. Safe to call when nothing is built.
  func teardown()
  /// Calls `onChange`, on the control queue, when the default output device or the tap's format
  /// changes, until `stopWatching()`.
  func watchRoute(onChange: @escaping (RestartReason) -> Void) throws
  func stopWatching()
}

/// One `roger-audio tap` run: builds the tap, rebuilds it on route changes and on `rebuild`, and
/// shuts everything down on any of the exits in Lifecycle.swift. Control queue only.
final class TapSession {
  struct Timing {
    /// A route change waits this long for the next one (see RebuildDebouncer).
    var debounce: DispatchTimeInterval = .milliseconds(300)
    /// A failed rebuild is retried after this long, up to `maxBuildAttempts` in all: right after
    /// a device switch the new output may not be ready for a tap yet.
    var retryDelay: DispatchTimeInterval = .seconds(1)
    var maxBuildAttempts = 3
    /// How long shutdown waits for the writer to flush before it exits anyway.
    var writerStopTimeout: TimeInterval = 1
  }

  private let output: OutputFormat
  private let device: TapDevice
  private let ring: AudioRing
  private let writer: FrameWriter
  private let events: EventSink
  private let queue: DispatchQueue
  private let stdin: Int32
  private let parent: pid_t
  private let timing: Timing
  private let exitProcess: (ExitCode) -> Void
  private lazy var debouncer = RebuildDebouncer(delay: timing.debounce, queue: queue) {
    [weak self] reason in self?.rebuild(reason)
  }
  private var parentWatch: ProcessExitWatch?
  private var retry: DispatchWorkItem?
  private var shuttingDown = false

  /// `exitProcess` ends the process with the code; the selftest records it instead.
  init(
    output: OutputFormat, device: TapDevice, ring: AudioRing, writer: FrameWriter,
    events: EventSink, queue: DispatchQueue, stdin: Int32, parent: pid_t,
    timing: Timing = Timing(), exitProcess: @escaping (ExitCode) -> Void
  ) {
    self.output = output
    self.device = device
    self.ring = ring
    self.writer = writer
    self.events = events
    self.queue = queue
    self.stdin = stdin
    self.parent = parent
    self.timing = timing
    self.exitProcess = exitProcess
  }

  func start() {
    parentWatch = ProcessExitWatch(pid: parent, queue: queue) { [weak self] in
      self?.shutdown(.ok)
    }
    writer.start { [weak self, queue] cause in queue.async { self?.writerStopped(cause) } }
    LineReader(
      fd: stdin, queue: queue,
      onLine: { [weak self] line in self?.handle(line) },
      onEnd: { [weak self] end in self?.stdinEnded(end) }
    ).start()

    do {
      let format = try device.build()
      events.emit(.ready(format: output, tapFormat: format))
    } catch {
      events.emit(HelperFailure(wrapping: error, code: "tap_failed").errorEvent)
      shutdown(.failure)
      return
    }
    do {
      try device.watchRoute { [weak self] reason in self?.debouncer.changed(reason) }
    } catch {
      let failure = HelperFailure(wrapping: error, code: "route_watch_failed")
      events.emit(
        .warning(
          code: failure.code,
          message: "\(failure.message); the tap will not follow output device changes"))
    }
  }

  /// Tears the tap down, lets the writer flush, and exits. Runs once; later calls do nothing.
  func shutdown(_ code: ExitCode) {
    guard !shuttingDown else { return }
    shuttingDown = true
    debouncer.cancel()
    retry?.cancel()
    parentWatch?.cancel()
    device.stopWatching()
    device.teardown()
    if !writer.stop(timeout: timing.writerStopTimeout) {
      events.emit(
        .warning(
          code: "writer_stuck",
          message: "the last frames were not written within \(timing.writerStopTimeout) s"))
    }
    exitProcess(code)
  }

  private func handle(_ line: String) {
    guard !shuttingDown, let command = TapCommand(line: line) else { return }
    switch command {
    case .rebuild:
      debouncer.rebuildNow(.rebuildRequested)
    case .unknown(let text):
      events.emit(
        .warning(code: "unknown_command", message: "unknown stdin command: \(text.prefix(80))"))
    }
  }

  private func stdinEnded(_ end: InputEnd) {
    switch end {
    case .endOfFile:
      shutdown(.ok)
    case .failed(let code):
      events.emit(
        .error(code: "stdin_failed", message: "reading stdin failed: errno \(code)", status: nil))
      shutdown(.failure)
    }
  }

  private func writerStopped(_ cause: FrameWriter.StopCause) {
    switch cause {
    case .requested:
      return
    case .outputClosed:
      shutdown(.ok)
    case .failed(let failure):
      events.emit(failure.errorEvent)
      shutdown(.failure)
    }
  }

  private func rebuild(_ reason: RestartReason, attempt: Int = 1) {
    guard !shuttingDown else { return }
    retry?.cancel()
    retry = nil
    device.teardown()
    // The old tap's last audio and the new tap's first must not be joined into one run.
    ring.markDiscontinuity()
    do {
      let format = try device.build()
      events.emit(.restarted(reason: reason, tapFormat: format))
    } catch {
      let failure = HelperFailure(wrapping: error, code: "rebuild_failed")
      guard attempt < timing.maxBuildAttempts else {
        events.emit(failure.errorEvent)
        shutdown(.failure)
        return
      }
      events.emit(
        .warning(
          code: failure.code,
          message: "\(failure.message); retrying (attempt \(attempt) of \(timing.maxBuildAttempts))"))
      let next = DispatchWorkItem { [weak self] in self?.rebuild(reason, attempt: attempt + 1) }
      retry = next
      queue.asyncAfter(deadline: .now() + timing.retryDelay, execute: next)
    }
  }
}

/// The Core Audio side of `tap`: one private mono global process tap, a private aggregate device
/// that holds only that tap, and an IO proc that hands the tap's input to the ring. Everything but
/// the IO block runs on the control queue.
///
/// Build-only in the selftest: creating a tap asks for System Audio Recording, and a tap that is
/// refused or still waiting on the prompt delivers silence with no error. It is checked by
/// `selftest --route-switch` (M2-T7b) and on real calls.
final class SystemAudioTap: TapDevice {
  private static let unknown = AudioObjectID(kAudioObjectUnknown)
  private static let tapName = "Roger call audio"

  private let ring: AudioRing
  private let queue: DispatchQueue
  private let events: EventSink
  private let clock = HostClock()
  /// The IO block's mixdown buffer. Lives as long as this object, which outlives every IO proc.
  private let scratch: UnsafeMutableBufferPointer<Float>
  private var tapID = unknown
  private var aggregateID = unknown
  private var procID: AudioDeviceIOProcID?
  private var formatListener: AudioObjectPropertyListenerBlock?
  private var outputListener: AudioObjectPropertyListenerBlock?
  private var onChange: ((RestartReason) -> Void)?

  init(ring: AudioRing, queue: DispatchQueue, events: EventSink) {
    self.ring = ring
    self.queue = queue
    self.events = events
    scratch = .allocate(capacity: ring.maxSpanFrames)
    scratch.initialize(repeating: 0)
  }

  deinit {
    teardown()
    stopWatching()
    scratch.deallocate()
  }

  func build() throws -> TapFormat {
    teardown()
    do {
      return try buildTap()
    } catch {
      teardown()
      throw error
    }
  }

  private func buildTap() throws -> TapFormat {
    // A mono mix of every process's output: whatever the call app plays. Private: no other process
    // sees it. Unmuted: the user still hears the call.
    let description = CATapDescription(monoGlobalTapButExcludeProcesses: [])
    description.name = Self.tapName
    description.isPrivate = true
    description.muteBehavior = .unmuted
    var tap = Self.unknown
    try check(
      AudioHardwareCreateProcessTap(description, &tap), "tap_create_failed",
      "could not create the system audio tap")
    tapID = tap
    let format = try TapFormat(readFormat(of: tap))
    listenForFormatChanges(of: tap)

    // Only the tap, no sub-device: with the output device in it too, an output that also has
    // inputs (AirPods, a USB headset) would add its mic to the aggregate's input. Values are
    // CFNumbers, as AudioHardware.h specifies for these keys. `tapautostart` stays 0: with it,
    // the device waits for a tapped process to play before it runs, and the helper must deliver
    // digital silence while nothing plays (main tells a quiet call from a dead tap that way).
    let composition: [String: Any] = [
      kAudioAggregateDeviceNameKey: Self.tapName,
      kAudioAggregateDeviceUIDKey: "ai.linkt.roger.audio.tap.\(UUID().uuidString)",
      kAudioAggregateDeviceIsPrivateKey: 1,
      kAudioAggregateDeviceIsStackedKey: 0,
      kAudioAggregateDeviceTapAutoStartKey: 0,
      kAudioAggregateDeviceTapListKey: [
        [kAudioSubTapUIDKey: description.uuid.uuidString, kAudioSubTapDriftCompensationKey: 1]
      ],
    ]
    var aggregate = Self.unknown
    try check(
      AudioHardwareCreateAggregateDevice(composition as CFDictionary, &aggregate),
      "aggregate_create_failed", "could not create the tap's aggregate device")
    aggregateID = aggregate

    var proc: AudioDeviceIOProcID?
    try check(
      AudioDeviceCreateIOProcIDWithBlock(&proc, aggregate, nil, ioBlock(for: format)),
      "io_proc_failed", "could not attach to the tap's aggregate device")
    procID = proc
    try check(
      AudioDeviceStart(aggregate, proc), "device_start_failed", "could not start the tap")
    return format
  }

  /// Runs on Core Audio's real-time IO thread (queue nil): copy into the ring and nothing else.
  /// No allocation, no lock but the ring's, no Swift runtime calls that could take one.
  private func ioBlock(for format: TapFormat) -> AudioDeviceIOBlock {
    let ring = self.ring
    let clock = self.clock
    let scratch = self.scratch
    return { _, inputData, inputTime, _, _ in
      let time = inputTime.pointee
      let wallMs =
        time.mFlags.contains(.hostTimeValid)
        ? clock.wallMs(hostTime: time.mHostTime) : clock.nowWallMs()
      format.deliver(
        UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData)),
        captureWallMs: wallMs, scratch: scratch, to: ring)
    }
  }

  func teardown() {
    if aggregateID != Self.unknown, let proc = procID {
      warnIfFailed(AudioDeviceStop(aggregateID, proc), "stopping the tap")
      warnIfFailed(AudioDeviceDestroyIOProcID(aggregateID, proc), "detaching from the tap")
    }
    procID = nil
    if aggregateID != Self.unknown {
      warnIfFailed(AudioHardwareDestroyAggregateDevice(aggregateID), "destroying the aggregate")
      aggregateID = Self.unknown
    }
    if tapID != Self.unknown {
      if let listener = formatListener {
        var address = Self.address(kAudioTapPropertyFormat)
        warnIfFailed(
          AudioObjectRemovePropertyListenerBlock(tapID, &address, queue, listener),
          "removing the tap format listener")
        formatListener = nil
      }
      warnIfFailed(AudioHardwareDestroyProcessTap(tapID), "destroying the tap")
      tapID = Self.unknown
    }
  }

  func watchRoute(onChange: @escaping (RestartReason) -> Void) throws {
    self.onChange = onChange
    guard outputListener == nil else { return }
    var address = Self.address(kAudioHardwarePropertyDefaultOutputDevice)
    let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
      self?.onChange?(.outputDeviceChanged)
    }
    try check(
      AudioObjectAddPropertyListenerBlock(
        AudioObjectID(kAudioObjectSystemObject), &address, queue, listener),
      "route_watch_failed", "could not watch the default output device")
    outputListener = listener
  }

  func stopWatching() {
    onChange = nil
    guard let listener = outputListener else { return }
    var address = Self.address(kAudioHardwarePropertyDefaultOutputDevice)
    warnIfFailed(
      AudioObjectRemovePropertyListenerBlock(
        AudioObjectID(kAudioObjectSystemObject), &address, queue, listener),
      "removing the output device listener")
    outputListener = nil
  }

  /// AirPods and sample-rate switches change the tap's format in place; the IO block was built for
  /// the old one, so the tap is rebuilt. Not fatal when it fails: the output device listener
  /// still catches most route changes.
  private func listenForFormatChanges(of tap: AudioObjectID) {
    var address = Self.address(kAudioTapPropertyFormat)
    let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
      self?.onChange?(.tapFormatChanged)
    }
    let status = AudioObjectAddPropertyListenerBlock(tap, &address, queue, listener)
    if status == noErr {
      formatListener = listener
    } else {
      events.emit(
        .warning(
          code: "format_watch_failed",
          message: "could not watch the tap's format (OSStatus \(status) \(fourCharCode(UInt32(bitPattern: status))))"))
    }
  }

  private func readFormat(of tap: AudioObjectID) throws -> AudioStreamBasicDescription {
    var address = Self.address(kAudioTapPropertyFormat)
    var description = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    try check(
      AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &description),
      "tap_format_failed", "could not read the tap's format")
    return description
  }

  private func check(_ status: OSStatus, _ code: String, _ what: String) throws {
    guard status != noErr else { return }
    throw HelperFailure(
      code: code,
      message: "\(what) (OSStatus \(status) \(fourCharCode(UInt32(bitPattern: status))))",
      status: status)
  }

  /// Teardown carries on past a failure (there is nothing better to do with a half-dead tap than
  /// to destroy the rest), but main still hears about it.
  private func warnIfFailed(_ status: OSStatus, _ what: String) {
    guard status != noErr else { return }
    events.emit(
      .warning(
        code: "teardown_failed",
        message: "\(what) failed (OSStatus \(status) \(fourCharCode(UInt32(bitPattern: status))))"))
  }

  private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
      mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
  }
}

/// `roger-audio tap`: see Protocol.swift for what it writes and reads.
func runTap(arguments: [String]) -> Int32 {
  let events = StderrEventSink()
  let output: OutputFormat
  do {
    output = try OutputFormat(tapArguments: arguments)
  } catch {
    events.emit(.error(code: "usage", message: "\(error). \(OutputFormat.tapUsage)", status: nil))
    return ExitCode.usage.rawValue
  }
  // Reparented to launchd: the parent died before this line, and nobody would read the audio.
  let parent = getppid()
  guard parent != 1 else { return ExitCode.ok.rawValue }
  // A reader that went away must come back as EPIPE from write(2), not end the process before
  // the tap is torn down.
  signal(SIGPIPE, SIG_IGN)

  let queue = DispatchQueue(label: "ai.linkt.roger.audio.control")
  let ring = AudioRing()
  let pipeline: FramePipeline
  do {
    pipeline = try FramePipeline(output: output) { try writeAll(fd: STDOUT_FILENO, $0) }
  } catch {
    events.emit(HelperFailure(wrapping: error, code: "converter_failed").errorEvent)
    return ExitCode.failure.rawValue
  }
  let session = TapSession(
    output: output, device: SystemAudioTap(ring: ring, queue: queue, events: events), ring: ring,
    writer: FrameWriter(ring: ring, pipeline: pipeline, events: events), events: events,
    queue: queue, stdin: STDIN_FILENO, parent: parent
  ) { code in exit(code.rawValue) }
  let signals = TerminationSignals(queue: queue) { _ in session.shutdown(.ok) }
  events.onWriteFailure = { _ in queue.async { session.shutdown(.ok) } }
  queue.async { session.start() }
  withExtendedLifetime(signals) { dispatchMain() }
}
