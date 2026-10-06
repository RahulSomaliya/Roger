import CoreAudio
import Foundation

// `roger-audio selftest`: the helper's own tests. `make check` runs them on a Mac.
//
// They cover everything that needs no audio permission: the frame header and capture times, the
// ring and its overflow count, the converter, the writer thread, stdin commands, the parent watch
// and the rebuild debounce. Nothing here creates a process tap or opens an audio device, so it
// never raises a macOS privacy prompt and runs unattended. The tap itself is exercised by
// `selftest --route-switch` (`make test-native-route`: opt-in, audible, M2-T7b) and by the probe.

func runSelfTest(arguments: [String]) -> Int32 {
  switch arguments {
  case []:
    break
  case ["--route-switch"]:
    return runRouteSwitchSelfTest()
  default:
    printError("usage: roger-audio selftest [--route-switch]")
    return ExitCode.usage.rawValue
  }
  // Line-buffered, so a case that crashes the process still leaves the cases before it on screen.
  setvbuf(stdout, nil, _IOLBF, 0)
  // The writer cases close a pipe on purpose: that must come back as EPIPE, as it does in `tap`.
  signal(SIGPIPE, SIG_IGN)

  var suite = SelfTestSuite()
  protocolCases(&suite)
  ringCases(&suite)
  converterCases(&suite)
  writerCases(&suite)
  tapInputCases(&suite)
  suite.skip(
    "Core Audio tap",
    because: "it needs the System Audio Recording permission; `make test-native-route` runs it")
  return suite.finish()
}

/// The audible route-switch test: a temporary multi-output device, a tone through `afplay`, a
/// switch of the default output, and non-zero audio plus a `restarted` event within 2 s.
///
/// Stub from M2-T7; owned by M2-T7b, which replaces this body (`runSelfTest` and the
/// `make test-native-route` target already call it). Until then it checks nothing and says so.
func runRouteSwitchSelfTest() -> Int32 {
  print("roger-audio selftest --route-switch: not built yet (M2-T7b); nothing was checked")
  return ExitCode.unavailable.rawValue
}

// MARK: - Protocol

private func protocolCases(_ suite: inout SelfTestSuite) {
  suite.run("frame header: RGA1, payload bytes as u32 LE, capture time as f64 LE") { t in
    let header = FrameHeader(payloadBytes: 3_200, captureWallMs: 1_000.5)
    let bytes = header.bytes
    t.expectEqual(bytes.count, FrameHeader.byteCount, "header size")
    t.expectEqual(FrameHeader.byteCount, 16, "header size constant")
    t.expectEqual(Array(bytes[0..<4]), [0x52, 0x47, 0x41, 0x31], "magic RGA1")
    t.expectEqual(Array(bytes[4..<8]), [0x80, 0x0C, 0x00, 0x00], "3,200 as u32 LE")
    // 1000.5 is 0x408F440000000000 as an IEEE 754 double.
    t.expectEqual(Array(bytes[8..<16]), [0, 0, 0, 0, 0, 0x44, 0x8F, 0x40], "1000.5 as f64 LE")
    t.expectEqual(FrameHeader(bytes: bytes), header, "decodes back")

    let epoch = FrameHeader(payloadBytes: 3_200, captureWallMs: 1_759_752_000_123.25)
    t.expectEqual(FrameHeader(bytes: epoch.bytes), epoch, "a real wall-clock time round-trips")
    t.expect(FrameHeader(bytes: Array("RGA2".utf8) + bytes[4...]) == nil, "wrong magic refused")
    t.expect(FrameHeader(bytes: Array(bytes.prefix(15))) == nil, "short header refused")
  }

  suite.run("events: one JSON line each, \"event\" first, fields as the protocol names them") { t in
    let output = OutputFormat(sampleRate: 16_000, chunkMs: 100)
    t.expectEqual(
      HelperEvent.ready(
        format: output, tapFormat: TapFormat(sampleRate: 48_000, channels: 1, interleaved: true)
      ).jsonLine,
      #"{"event":"ready","format":{"encoding":"linear16","sampleRate":16000,"channels":1,"chunkMs":100},"tapFormat":{"sampleRate":48000,"channels":1}}"#
        + "\n",
      "ready")
    t.expectEqual(
      HelperEvent.restarted(
        reason: .outputDeviceChanged,
        tapFormat: TapFormat(sampleRate: 44_100, channels: 1, interleaved: true)
      ).jsonLine,
      #"{"event":"restarted","reason":"output_device_changed","tapFormat":{"sampleRate":44100,"channels":1}}"#
        + "\n",
      "restarted")
    t.expectEqual(
      HelperEvent.stats(peak: 32_768, frames: 10, droppedMs: 0).jsonLine,
      #"{"event":"stats","peak":32768,"frames":10,"dropped":0}"# + "\n",
      "stats")
    t.expectEqual(
      HelperEvent.warning(code: "unknown_command", message: "say \"hi\"\\\n\u{1}").jsonLine,
      #"{"event":"warning","code":"unknown_command","message":"say \"hi\"\\\n\u0001"}"# + "\n",
      "warning, with quotes, a backslash and control characters escaped")
    t.expectEqual(
      HelperEvent.error(code: "tap_create_failed", message: "no tap", status: -50).jsonLine,
      #"{"event":"error","code":"tap_create_failed","message":"no tap","status":-50}"# + "\n",
      "error with an OSStatus")
    t.expectEqual(
      HelperEvent.error(code: "usage", message: "bad", status: nil).jsonLine,
      #"{"event":"error","code":"usage","message":"bad"}"# + "\n",
      "error without a status")
    t.expectEqual(RestartReason.tapFormatChanged.rawValue, "tap_format_changed", "reason name")
    t.expectEqual(RestartReason.rebuildRequested.rawValue, "rebuild_requested", "reason name")
  }

  suite.run("tap options: defaults, explicit values, bad values refused") { t in
    let defaults = try OutputFormat(tapArguments: [])
    t.expectEqual(defaults, OutputFormat(sampleRate: 16_000, chunkMs: 100), "defaults")
    t.expectEqual(defaults.samplesPerFrame, 1_600, "100 ms at 16 kHz")
    t.expectEqual(defaults.payloadBytes, 3_200, "Int16 payload")
    t.expectEqual(
      try OutputFormat(tapArguments: ["--sample-rate", "16000", "--chunk-ms", "100"]), defaults,
      "explicit")
    t.expectEqual(
      try OutputFormat(tapArguments: ["--chunk-ms", "20"]).samplesPerFrame, 320, "20 ms chunks")
    for bad in [
      ["--sample-rate", "abc"], ["--sample-rate"], ["--chunk-ms", "5"], ["--sample-rate", "96000"],
      ["--bogus"], ["--chunk-ms", "100", "--chunk-ms", "100"],
      // 15 ms at 44.1 kHz is 661.5 samples: a frame must hold whole samples.
      ["--sample-rate", "44100", "--chunk-ms", "15"],
    ] {
      t.expectThrows("refuses \(bad)") { _ = try OutputFormat(tapArguments: bad) }
    }
  }
}

// MARK: - Ring

private func ringCases(_ suite: inout SelfTestSuite) {
  suite.run("ring: audio comes back in order with its capture time, across the wrap") { t in
    // 0.001 s at the 192 kHz storage rate: 192 samples, so the writes below wrap around.
    let ring = AudioRing(maxDurationSeconds: 0.001, maxSpanFrames: 64, spanCapacity: 8)
    let rate = AudioRing.maxSampleRate
    var next: Float = 0
    var expected: [Float] = []
    func write(_ count: Int, wallMs: Double) -> Bool {
      let block = (0..<count).map { Float($0) + next }
      next += Float(count)
      let accepted = block.withUnsafeBufferPointer {
        ring.write($0, sampleRate: rate, captureWallMs: wallMs)
      }
      if accepted { expected += block }
      return accepted
    }
    var got: [Float] = []
    var spans: [AudioSpan] = []
    let buffer = UnsafeMutableBufferPointer<Float>.allocate(capacity: ring.maxSpanFrames)
    defer { buffer.deallocate() }
    func read(_ spanCount: Int) {
      for _ in 0..<spanCount {
        guard let span = ring.read(into: buffer) else { return }
        spans.append(span)
        got += buffer[0..<span.frameCount]
      }
    }

    t.expect(write(50, wallMs: 1_000), "first write fits")
    t.expect(write(50, wallMs: 2_000), "second write fits")
    t.expect(write(50, wallMs: 3_000), "third write fits")
    read(2)
    t.expect(write(50, wallMs: 4_000), "fits once space was read")
    t.expect(write(50, wallMs: 5_000), "wraps past the end of storage")
    read(10)
    t.expectEqual(got, expected, "samples in order")
    t.expectEqual(spans.map(\.captureWallMs), [1_000, 2_000, 3_000, 4_000, 5_000], "capture times")
    t.expectEqual(spans.map(\.frameCount), [50, 50, 50, 50, 50], "span lengths")
    t.expectEqual(
      spans.map(\.discontinuity), [true, false, false, false, false],
      "only the first span ever starts a new run")
    t.expect(ring.read(into: buffer) == nil, "empty after reading everything")
    t.expectEqual(ring.takeDroppedMs(), 0, "nothing dropped")
  }

  suite.run("ring: past 2 s it drops, counts the loss in ms and flags the next span") { t in
    let ring = AudioRing()
    let rate = 48_000.0
    let block = [Float](repeating: 0.25, count: 480)
    var accepted = 0
    var droppedFrames = 0
    for i in 0..<250 {  // 2.5 s in 10 ms callbacks, nothing reading
      let ok = block.withUnsafeBufferPointer {
        ring.write($0, sampleRate: rate, captureWallMs: Double(i) * 10)
      }
      if ok { accepted += block.count } else { droppedFrames += block.count }
    }
    t.expectEqual(accepted, 96_000, "holds exactly 2 s at 48 kHz")
    t.expectEqual(droppedFrames, 24_000, "the other 0.5 s is dropped")
    t.expectNear(ring.takeDroppedMs(), 500, within: 0.001, "dropped ms")
    t.expectEqual(ring.takeDroppedMs(), 0, "taking the count resets it")

    let buffer = UnsafeMutableBufferPointer<Float>.allocate(capacity: ring.maxSpanFrames)
    defer { buffer.deallocate() }
    _ = ring.read(into: buffer)
    let afterDrop = block.withUnsafeBufferPointer {
      ring.write($0, sampleRate: rate, captureWallMs: 9_000)
    }
    t.expect(afterDrop, "fits again once a span was read")
    var last: AudioSpan?
    while let span = ring.read(into: buffer) { last = span }
    t.expectEqual(last?.captureWallMs, 9_000, "the write after the drop is the last span")
    t.expectEqual(last?.discontinuity, true, "and it is flagged: audio before it is missing")

    // The limit is time, not samples: at 16 kHz the same ring also holds 2 s.
    let slow = AudioRing()
    let small = [Float](repeating: 0, count: 160)
    var slowAccepted = 0
    for i in 0..<300 {
      if small.withUnsafeBufferPointer({
        slow.write($0, sampleRate: 16_000, captureWallMs: Double(i) * 10)
      }) {
        slowAccepted += small.count
      }
    }
    t.expectEqual(slowAccepted, 32_000, "2 s at 16 kHz")
  }

  suite.run("ring: a long write is split into spans with advancing capture times") { t in
    let ring = AudioRing(maxDurationSeconds: 2, maxSpanFrames: 64, spanCapacity: 16)
    let samples = (0..<150).map(Float.init)
    t.expect(
      samples.withUnsafeBufferPointer {
        ring.write($0, sampleRate: 48_000, captureWallMs: 1_000)
      }, "accepted")
    ring.markDiscontinuity()
    t.expect(
      [Float](repeating: 0, count: 10).withUnsafeBufferPointer {
        ring.write($0, sampleRate: 48_000, captureWallMs: 2_000)
      }, "accepted")
    let buffer = UnsafeMutableBufferPointer<Float>.allocate(capacity: ring.maxSpanFrames)
    defer { buffer.deallocate() }
    var spans: [AudioSpan] = []
    var got: [Float] = []
    while let span = ring.read(into: buffer) {
      spans.append(span)
      got += buffer[0..<span.frameCount]
    }
    t.expectEqual(spans.map(\.frameCount), [64, 64, 22, 10], "split at 64 frames")
    t.expectEqual(Array(got.prefix(150)), samples, "samples in order")
    t.expectNear(spans[1].captureWallMs, 1_000 + 64 / 48.0, within: 1e-9, "second piece's time")
    t.expectNear(spans[2].captureWallMs, 1_000 + 128 / 48.0, within: 1e-9, "third piece's time")
    t.expectEqual(
      spans.map(\.discontinuity), [true, false, false, true],
      "a rebuild (markDiscontinuity) flags the next write")
  }
}

// MARK: - Converter

/// A realistic wall-clock start for the converter and writer cases (2025-10-06).
private let startMs = 1_759_752_000_000.0
private let output16k = OutputFormat(sampleRate: 16_000, chunkMs: 100)

private func converterCases(_ suite: inout SelfTestSuite) {
  suite.run("converter: 1 s of 48 kHz float becomes ten 100 ms frames of 16 kHz Int16") { t in
    let collector = FrameCollector()
    let pipeline = try FramePipeline(output: output16k, sink: collector.sink)
    try feed(pipeline, tone(rate: 48_000, seconds: 1, hz: 1_000, amplitude: 0.5), rate: 48_000)
    try pipeline.finish()
    let frames = try decodeFrames(collector.bytes)
    t.expect(frames.count >= 10, "at least ten frames, got \(frames.count)")
    for (index, frame) in frames.prefix(9).enumerated() {
      t.expectEqual(frame.samples.count, 1_600, "frame \(index) holds 100 ms")
      t.expectNear(
        frame.header.captureWallMs, startMs + 100 * Double(index), within: 0.5,
        "frame \(index) capture time")
    }
    let samples = frames.flatMap(\.samples)
    t.expectNear(Double(samples.count), 16_000, within: 2, "one second in, one second out")
    let peak = samples.map { abs(Int($0)) }.max() ?? 0
    t.expectNear(Double(peak), 16_384, within: 500, "amplitude 0.5 is half of full scale")
    let stats = pipeline.takeStats()
    t.expectEqual(stats.frames, frames.count, "stats count the frames written")
    t.expectEqual(stats.peak, peak, "stats peak is the largest sample written")
    t.expectEqual(pipeline.takeStats().frames, 0, "taking stats resets them")
  }

  suite.run("converter: 44.1, 24 and 16 kHz taps give the same frames and times") { t in
    for rate in [44_100.0, 24_000, 16_000] {
      let collector = FrameCollector()
      let pipeline = try FramePipeline(output: output16k, sink: collector.sink)
      try feed(pipeline, tone(rate: rate, seconds: 1, hz: 300, amplitude: 0.5), rate: rate)
      try pipeline.finish()
      let frames = try decodeFrames(collector.bytes)
      checkRuns(t, frames, [(startMs, 1_000)], "\(Int(rate)) Hz")
      let peak = frames.flatMap(\.samples).map { abs(Int($0)) }.max() ?? 0
      t.expectNear(Double(peak), 16_384, within: 600, "\(Int(rate)) Hz amplitude")
    }
  }

  suite.run("converter: capture time is exact: a click at 250 ms lands 4,000 samples in") { t in
    for rate in [48_000.0, 44_100] {
      var input = [Float](repeating: 0, count: Int(rate / 2))
      input[Int(rate / 4)] = 1
      let collector = FrameCollector()
      let pipeline = try FramePipeline(output: output16k, sink: collector.sink)
      try feed(pipeline, input, rate: rate)
      try pipeline.finish()
      let frames = try decodeFrames(collector.bytes)
      let samples = frames.flatMap(\.samples)
      let loudest = samples.indices.max { abs(Int(samples[$0])) < abs(Int(samples[$1])) } ?? -1
      t.expectNear(Double(loudest), 4_000, within: 2, "\(Int(rate)) Hz: the click's output sample")
      // The same, read the way main reads it: frame header plus position in the frame.
      var frameStart = 0
      for frame in frames {
        if loudest < frameStart + frame.samples.count {
          let clickMs = frame.header.captureWallMs + Double(loudest - frameStart) / 16
          t.expectNear(clickMs, startMs + 250, within: 0.2, "\(Int(rate)) Hz: the click's time")
          break
        }
        frameStart += frame.samples.count
      }
    }
  }

  suite.run("converter: a gap, a rebuilt tap or dropped audio closes the frame; the next starts on time") {
    t in
    let collector = FrameCollector()
    let pipeline = try FramePipeline(output: output16k, sink: collector.sink)
    let tone48 = tone(rate: 48_000, seconds: 0.25, hz: 300, amplitude: 0.5)
    try feed(pipeline, tone48, rate: 48_000)
    // The tap clock jumped 750 ms with no flag (a device hiccup): a new run.
    try feed(pipeline, tone48, rate: 48_000, wallMs: startMs + 1_000)
    // Right on time, but a new rate: the tap was rebuilt for AirPods.
    try feed(
      pipeline, tone(rate: 24_000, seconds: 0.15, hz: 300, amplitude: 0.5), rate: 24_000,
      wallMs: startMs + 1_250)
    // Right on time and the same rate, but flagged: the ring dropped audio before it.
    try feed(
      pipeline, tone(rate: 24_000, seconds: 0.1, hz: 300, amplitude: 0.5), rate: 24_000,
      wallMs: startMs + 1_400, discontinuity: true)
    try pipeline.finish()
    checkRuns(
      t, try decodeFrames(collector.bytes),
      [(startMs, 250), (startMs + 1_000, 250), (startMs + 1_250, 150), (startMs + 1_400, 100)],
      "four runs")
  }
}

// MARK: - Writer thread

private func writerCases(_ suite: inout SelfTestSuite) {
  suite.run("writer: frames reach stdout and stats report peak, frames and dropped") { t in
    let pipe = try makePipe()
    let ring = AudioRing()
    let events = RecordingEventSink()
    let pipeline = try FramePipeline(output: output16k) { try writeAll(fd: pipe.write, $0) }
    let writer = FrameWriter(
      ring: ring, pipeline: pipeline, events: events, statsInterval: 0.2, pollInterval: 0.005)
    let reader = PipeDrain(fd: pipe.read)
    let cause = Locked<FrameWriter.StopCause?>(nil)
    writer.start { stopped in cause.withValue { $0 = stopped } }

    writeToRing(ring, tone(rate: 48_000, seconds: 1, hz: 440, amplitude: 0.25), rate: 48_000)
    t.expect(
      waitUntil(seconds: 5) { events.stats.reduce(0) { $0 + $1.frames } >= 9 },
      "frames flowed within 5 s")
    t.expect(writer.stop(timeout: 2), "stops when asked")
    close(pipe.write)
    let frames = try decodeFrames(reader.finish())

    t.expectEqual(cause.value, .requested, "stop cause")
    checkRuns(t, frames, [(startMs, 1_000)], "one run")
    t.expectEqual(events.stats.reduce(0) { $0 + $1.frames }, frames.count, "stats count every frame")
    t.expectNear(
      Double(events.stats.map(\.peak).max() ?? 0), 8_192, within: 300, "stats peak, amplitude 0.25")
    t.expectEqual(events.stats.reduce(0) { $0 + $1.dropped }, 0, "nothing dropped")
  }

  suite.run("writer: stop writes everything the ring holds first, the short last frame included") {
    t in
    let pipe = try makePipe()
    let ring = AudioRing()
    let pipeline = try FramePipeline(output: output16k) { try writeAll(fd: pipe.write, $0) }
    let writer = FrameWriter(
      ring: ring, pipeline: pipeline, events: RecordingEventSink(), statsInterval: 0.2,
      pollInterval: 0.005)
    let reader = PipeDrain(fd: pipe.read)
    // 2 ms callbacks: more spans than one drain pass takes, so stop has to keep draining.
    writeToRing(
      ring, tone(rate: 48_000, seconds: 1.05, hz: 440, amplitude: 0.25), rate: 48_000, spanMs: 2)
    writer.start { _ in }
    t.expect(writer.stop(timeout: 3), "stops")
    close(pipe.write)
    checkRuns(t, try decodeFrames(reader.finish()), [(startMs, 1_050)], "all of it, in one run")
  }

  suite.run("writer: a stdout nobody reads never blocks the IO thread; the loss is counted") { t in
    let pipe = try makePipe()
    let ring = AudioRing()
    let events = RecordingEventSink()
    let pipeline = try FramePipeline(output: output16k) { try writeAll(fd: pipe.write, $0) }
    let writer = FrameWriter(
      ring: ring, pipeline: pipeline, events: events, statsInterval: 0.2, pollInterval: 0.005)
    writer.start { _ in }

    // 10 s of audio in about half a second, with nothing reading stdout: the pipe fills, the
    // writer blocks in write(2), the ring fills, and the rest must be dropped, not waited on. A
    // write that waited on the writer would hang here for good.
    let block = tone(rate: 48_000, seconds: 0.01, hz: 440, amplitude: 0.25)
    var droppedMs = 0.0
    var slowestWrite = 0.0
    for index in 0..<1_000 {
      let before = DispatchTime.now().uptimeNanoseconds
      let accepted = block.withUnsafeBufferPointer {
        ring.write($0, sampleRate: 48_000, captureWallMs: startMs + Double(index) * 10)
      }
      slowestWrite = max(
        slowestWrite, Double(DispatchTime.now().uptimeNanoseconds - before) / 1_000_000)
      if !accepted { droppedMs += 10 }
      if index.isMultiple(of: 2) { usleep(1_000) }
    }
    t.expect(droppedMs >= 4_000, "most of the 10 s was dropped, got \(droppedMs) ms")
    // Loose on purpose: the point is that no write waits on the blocked writer.
    t.expect(slowestWrite < 250, "a ring write took \(slowestWrite) ms")

    let reader = PipeDrain(fd: pipe.read)
    t.expect(writer.stop(timeout: 3), "stops once stdout drains")
    close(pipe.write)
    let frames = try decodeFrames(reader.finish())
    t.expect(frames.count >= 20, "what fit was written, got \(frames.count) frames")
    let reported = events.stats.reduce(0) { $0 + $1.dropped }
    // Each stats line rounds its share up to a whole ms.
    t.expectNear(
      Double(reported), droppedMs, within: Double(events.stats.count) + 1,
      "stats.dropped adds up to what the ring dropped")
  }

  suite.run("writer: a closed stdout stops the writer with outputClosed") { t in
    let pipe = try makePipe()
    close(pipe.read)
    let ring = AudioRing()
    let pipeline = try FramePipeline(output: output16k) { try writeAll(fd: pipe.write, $0) }
    let writer = FrameWriter(
      ring: ring, pipeline: pipeline, events: RecordingEventSink(), statsInterval: 0.2,
      pollInterval: 0.005)
    let stopped = DispatchSemaphore(value: 0)
    let cause = Locked<FrameWriter.StopCause?>(nil)
    writer.start { why in
      cause.withValue { $0 = why }
      stopped.signal()
    }
    writeToRing(ring, tone(rate: 48_000, seconds: 0.3, hz: 440, amplitude: 0.25), rate: 48_000)
    t.expect(stopped.wait(timeout: .now() + 5) == .success, "the writer stopped by itself")
    t.expectEqual(cause.value, .outputClosed, "because stdout closed")
    t.expect(writer.stop(timeout: 1), "stop afterwards returns at once")
    close(pipe.write)
  }
}

// MARK: - Tap input (the IO block's half, without a tap)

private func tapInputCases(_ suite: inout SelfTestSuite) {
  suite.run("host clock: Core Audio host time maps to wall-clock ms") { t in
    let clock = HostClock()
    var timebase = mach_timebase_info_data_t()
    mach_timebase_info(&timebase)
    let ticksPerSecond = 1e9 * Double(timebase.denom) / Double(timebase.numer)
    t.expectNear(
      clock.nowWallMs(), Date().timeIntervalSince1970 * 1_000, within: 5, "now is the wall clock")
    t.expectNear(
      clock.wallMs(hostTime: mach_absolute_time()), clock.nowWallMs(), within: 5, "host time now")
    t.expectNear(
      clock.wallMs(hostTime: mach_absolute_time() - UInt64(ticksPerSecond)),
      clock.nowWallMs() - 1_000, within: 5, "a host time one second ago")
  }

  suite.run("tap format: Float32 taken, interleaving read, anything else refused") { t in
    func description(_ flags: AudioFormatFlags, bits: UInt32 = 32, channels: UInt32 = 2)
      -> AudioStreamBasicDescription
    {
      AudioStreamBasicDescription(
        mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM, mFormatFlags: flags,
        mBytesPerPacket: bits / 8 * channels, mFramesPerPacket: 1,
        mBytesPerFrame: bits / 8 * channels, mChannelsPerFrame: channels, mBitsPerChannel: bits,
        mReserved: 0)
    }
    let float = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked
    t.expectEqual(
      try TapFormat(description(float)),
      TapFormat(sampleRate: 48_000, channels: 2, interleaved: true), "interleaved stereo")
    t.expectEqual(
      try TapFormat(description(float | kAudioFormatFlagIsNonInterleaved)).interleaved, false,
      "planar")
    t.expectThrows("Int16 refused") {
      _ = try TapFormat(description(kAudioFormatFlagIsSignedInteger, bits: 16))
    }
  }

  suite.run("tap input: mono passes through, stereo is mixed down, as the IO block does it") { t in
    let ring = AudioRing()
    let scratch = UnsafeMutableBufferPointer<Float>.allocate(capacity: ring.maxSpanFrames)
    defer { scratch.deallocate() }
    let read = UnsafeMutableBufferPointer<Float>.allocate(capacity: ring.maxSpanFrames)
    defer { read.deallocate() }
    let list = AudioBufferList.allocate(maximumBuffers: 2)
    defer { free(list.unsafeMutablePointer) }

    var mono: [Float] = [0.5, -0.5, 1]
    var interleaved: [Float] = [1, 0, 0.5, 0.5, -1, 1]
    var left: [Float] = [1, 0.5, -1]
    var right: [Float] = [0, 0.5, 1]
    mono.withUnsafeMutableBytes { bytes in
      list.count = 1
      list[0] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(bytes.count), mData: bytes.baseAddress)
      TapFormat(sampleRate: 48_000, channels: 1, interleaved: true)
        .deliver(list, captureWallMs: 1_000, scratch: scratch, to: ring)
    }
    interleaved.withUnsafeMutableBytes { bytes in
      list.count = 1
      list[0] = AudioBuffer(mNumberChannels: 2, mDataByteSize: UInt32(bytes.count), mData: bytes.baseAddress)
      TapFormat(sampleRate: 48_000, channels: 2, interleaved: true)
        .deliver(list, captureWallMs: 2_000, scratch: scratch, to: ring)
    }
    left.withUnsafeMutableBytes { leftBytes in
      right.withUnsafeMutableBytes { rightBytes in
        list.count = 2
        list[0] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(leftBytes.count), mData: leftBytes.baseAddress)
        list[1] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(rightBytes.count), mData: rightBytes.baseAddress)
        TapFormat(sampleRate: 48_000, channels: 2, interleaved: false)
          .deliver(list, captureWallMs: 3_000, scratch: scratch, to: ring)
      }
    }
    var got: [[Float]] = []
    var times: [Double] = []
    while let span = ring.read(into: read) {
      got.append(Array(read[0..<span.frameCount]))
      times.append(span.captureWallMs)
    }
    t.expectEqual(got, [[0.5, -0.5, 1], [0.5, 0.5, 0], [0.5, 0.5, 0]], "mono, then two mixdowns")
    t.expectEqual(times, [1_000, 2_000, 3_000], "capture times")
  }
}

// MARK: - Helpers

/// One frame as main would parse it from stdout.
private struct DecodedFrame {
  var header: FrameHeader
  var samples: [Int16]
  var durationMs: Double { Double(samples.count) * 1_000 / Double(output16k.sampleRate) }
}

private struct SelfTestError: Error, CustomStringConvertible {
  let description: String
}

/// Parses a stdout byte stream into frames, refusing anything malformed.
private func decodeFrames(_ bytes: [UInt8]) throws -> [DecodedFrame] {
  var frames: [DecodedFrame] = []
  var offset = 0
  while offset < bytes.count {
    let headerEnd = min(offset + FrameHeader.byteCount, bytes.count)
    guard let header = FrameHeader(bytes: Array(bytes[offset..<headerEnd])) else {
      throw SelfTestError(description: "no frame header at byte \(offset)")
    }
    let end = headerEnd + Int(header.payloadBytes)
    guard header.payloadBytes > 0, header.payloadBytes.isMultiple(of: 2), end <= bytes.count else {
      throw SelfTestError(description: "bad payload length \(header.payloadBytes) at \(offset)")
    }
    let samples = stride(from: headerEnd, to: end, by: 2).map {
      Int16(bitPattern: UInt16(bytes[$0]) | UInt16(bytes[$0 + 1]) << 8)
    }
    frames.append(DecodedFrame(header: header, samples: samples))
    offset = end
  }
  return frames
}

/// Checks that frames form exactly these runs of contiguous audio. Within a run every frame starts
/// where the one before it ended and only the last may be short; a short frame ends its run.
private func checkRuns(
  _ t: SelfTestCase, _ frames: [DecodedFrame], _ runs: [(startMs: Double, durationMs: Double)],
  _ what: String, line: UInt = #line
) {
  var groups: [[DecodedFrame]] = []
  for frame in frames {
    if let previous = groups.last?.last, previous.samples.count == output16k.samplesPerFrame,
      abs(previous.header.captureWallMs + previous.durationMs - frame.header.captureWallMs) < 0.5
    {
      groups[groups.count - 1].append(frame)
    } else {
      groups.append([frame])
    }
  }
  t.expectEqual(groups.count, runs.count, "\(what): runs", line: line)
  for (index, (group, run)) in zip(groups, runs).enumerated() {
    t.expectNear(
      group[0].header.captureWallMs, run.startMs, within: 0.5, "\(what): run \(index) start",
      line: line)
    let durationMs = group.reduce(0) { $0 + $1.durationMs }
    t.expectNear(durationMs, run.durationMs, within: 0.25, "\(what): run \(index) length", line: line)
  }
}

private final class FrameCollector {
  private(set) var bytes: [UInt8] = []
  func sink(_ frame: UnsafeRawBufferPointer) { bytes += frame }
}

private func tone(rate: Double, seconds: Double, hz: Double, amplitude: Float) -> [Float] {
  (0..<Int(rate * seconds)).map {
    amplitude * Float(sin(2 * Double.pi * hz * Double($0) / rate))
  }
}

/// Feeds samples to a pipeline in 10 ms spans, as the ring hands them over.
private func feed(
  _ pipeline: FramePipeline, _ samples: [Float], rate: Double, wallMs: Double = startMs,
  discontinuity: Bool = false
) throws {
  let spanFrames = Int(rate / 100)
  try samples.withUnsafeBufferPointer { all in
    for offset in stride(from: 0, to: all.count, by: spanFrames) {
      let count = min(spanFrames, all.count - offset)
      try pipeline.push(
        UnsafeBufferPointer(rebasing: all[offset..<offset + count]),
        span: AudioSpan(
          frameCount: count, sampleRate: rate,
          captureWallMs: wallMs + Double(offset) / rate * 1_000,
          discontinuity: discontinuity && offset == 0))
    }
  }
}

/// Writes samples to a ring in `spanMs` callbacks, as the IO block does, from `startMs` on.
private func writeToRing(_ ring: AudioRing, _ samples: [Float], rate: Double, spanMs: Double = 10) {
  let spanFrames = Int(rate * spanMs / 1_000)
  samples.withUnsafeBufferPointer { all in
    for offset in stride(from: 0, to: all.count, by: spanFrames) {
      let count = min(spanFrames, all.count - offset)
      ring.write(
        UnsafeBufferPointer(rebasing: all[offset..<offset + count]), sampleRate: rate,
        captureWallMs: startMs + Double(offset) / rate * 1_000)
    }
  }
}

private func makePipe() throws -> (read: Int32, write: Int32) {
  var fds: [Int32] = [0, 0]
  guard pipe(&fds) == 0 else {
    throw SelfTestError(description: "pipe() failed: errno \(errno)")
  }
  return (fds[0], fds[1])
}

/// Reads a file descriptor on its own thread until end of file.
private final class PipeDrain: @unchecked Sendable {
  private let bytes = Locked<[UInt8]>([])
  private let done = DispatchSemaphore(value: 0)

  init(fd: Int32) {
    Thread { [bytes, done] in
      var buffer = [UInt8](repeating: 0, count: 65_536)
      while true {
        let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
        if count > 0 {
          bytes.withValue { $0 += buffer[0..<count] }
        } else if count < 0, errno == EINTR {
          continue
        } else {
          break
        }
      }
      close(fd)
      done.signal()
    }.start()
  }

  /// Waits for end of file (close the write end first) and returns everything read.
  func finish() -> [UInt8] {
    done.wait()
    return bytes.value
  }
}

/// Polls every 10 ms until `condition` holds or `seconds` pass.
private func waitUntil(seconds: Double, _ condition: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if condition() { return true }
    usleep(10_000)
  }
  return condition()
}

/// Records events for the cases to inspect, from any thread.
private final class RecordingEventSink: EventSink, @unchecked Sendable {
  private let events = Locked<[HelperEvent]>([])

  func emit(_ event: HelperEvent) {
    events.withValue { $0.append(event) }
  }

  var all: [HelperEvent] { events.value }

  var stats: [(peak: Int, frames: Int, dropped: Int)] {
    all.compactMap {
      guard case .stats(let peak, let frames, let dropped) = $0 else { return nil }
      return (peak, frames, dropped)
    }
  }
}

// MARK: - Harness

/// A minimal test runner: Command Line Tools ship no XCTest to link against.
struct SelfTestSuite {
  private var passed = 0
  private var failed = 0
  private var skipped = 0

  mutating func run(_ name: String, _ body: (SelfTestCase) throws -> Void) {
    let check = SelfTestCase()
    do {
      try body(check)
    } catch {
      check.fail("threw \(error)")
    }
    if check.failures.isEmpty {
      passed += 1
      print("ok    \(name)")
    } else {
      failed += 1
      print("FAIL  \(name)")
      for failure in check.failures { print("      \(failure)") }
    }
  }

  mutating func skip(_ name: String, because reason: String) {
    skipped += 1
    print("skip  \(name): \(reason)")
  }

  func finish() -> Int32 {
    print("roger-audio selftest: \(passed) passed, \(failed) failed, \(skipped) skipped")
    return failed == 0 ? ExitCode.ok.rawValue : ExitCode.failure.rawValue
  }
}

final class SelfTestCase {
  private(set) var failures: [String] = []

  func fail(_ message: String, line: UInt = #line) {
    failures.append("\(message) (SelfTest.swift:\(line))")
  }

  func expect(_ condition: Bool, _ message: @autoclosure () -> String, line: UInt = #line) {
    if !condition { fail(message(), line: line) }
  }

  func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ what: String, line: UInt = #line) {
    if actual != expected { fail("\(what): got \(actual), expected \(expected)", line: line) }
  }

  func expectNear(
    _ actual: Double, _ expected: Double, within tolerance: Double, _ what: String,
    line: UInt = #line
  ) {
    if !(abs(actual - expected) <= tolerance) {
      fail("\(what): got \(actual), expected \(expected) ± \(tolerance)", line: line)
    }
  }

  func expectThrows(_ what: String, line: UInt = #line, _ body: () throws -> Void) {
    do {
      try body()
      fail("\(what): did not throw", line: line)
    } catch {
      return
    }
  }
}
