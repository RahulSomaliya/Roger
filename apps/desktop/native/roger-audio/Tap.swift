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
  private let stopRequested = Locked(false)
  private let running = DispatchGroup()

  init(
    ring: AudioRing, pipeline: FramePipeline, events: EventSink, statsInterval: TimeInterval = 1,
    pollInterval: TimeInterval = 0.01
  ) {
    self.ring = ring
    self.pipeline = pipeline
    self.events = events
    self.statsInterval = statsInterval
    self.pollInterval = pollInterval
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
    var nextStats = Date().addingTimeInterval(statsInterval)
    var cause = StopCause.requested
    do {
      while true {
        let stopping = stopRequested.value
        let more = try drainPass(buffer)
        // On stop, everything the ring holds is written first: the last 100 ms are not lost.
        if stopping && !more { break }
        if Date() >= nextStats {
          emitStats()
          nextStats = Date().addingTimeInterval(statsInterval)
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
