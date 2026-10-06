import CoreAudio
import Foundation

// `roger-audio selftest`: the helper's own tests. `make check` runs them on a Mac.
//
// They cover everything that needs no audio permission: the frame header and capture times, the
// ring and its overflow count, the converter, the writer thread, the IO block's mixdown, stdin
// commands, the parent watch, signals, the rebuild debounce, and the tap session driven through a
// fake TapDevice. The IO block's shut-off on a tap format change is checked through TapInput and
// the format listener's block, called by hand. Nothing here creates a process tap, registers a
// Core Audio listener or opens an audio device, so it never raises a macOS privacy prompt and
// runs unattended; keep it that way, since `make check` runs it on every pass. The real tap is
// exercised by `selftest --route-switch` (`make test-native-route`: opt-in, audible, M2-T7b) and
// by the probe.

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
  lifecycleCases(&suite)
  sessionCases(&suite)
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

  suite.run("writer: stats run on the uptime clock, so setting the wall clock back never stops them") {
    t in
    let pipe = try makePipe()
    let ring = AudioRing()
    let events = RecordingEventSink()
    let pipeline = try FramePipeline(output: output16k) { try writeAll(fd: pipe.write, $0) }
    // Moves only when the case moves it, while the wall clock runs on: stats must follow this one.
    let uptime = Locked<TimeInterval>(1_000)
    let writer = FrameWriter(
      ring: ring, pipeline: pipeline, events: events, statsInterval: 0.2, pollInterval: 0.005,
      uptime: { uptime.value })
    let reader = PipeDrain(fd: pipe.read)
    writer.start { _ in }
    writeToRing(ring, tone(rate: 48_000, seconds: 0.3, hz: 440, amplitude: 0.25), rate: 48_000)

    usleep(600_000)
    t.expectEqual(events.stats.count, 0, "no stats in 0.6 s of wall time while uptime stands still")
    uptime.withValue { $0 += 0.25 }
    t.expect(waitUntil(seconds: 5) { events.stats.count == 1 }, "one stats line once uptime moves")
    usleep(100_000)
    t.expectEqual(events.stats.count, 1, "and only one per interval of uptime")
    uptime.withValue { $0 += 0.25 }
    t.expect(waitUntil(seconds: 5) { events.stats.count == 2 }, "the next after another interval")

    t.expect(writer.stop(timeout: 2), "stops")
    close(pipe.write)
    _ = reader.finish()
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

  suite.run("tap input: a format change shuts the IO block at once, not at the debounced rebuild") {
    t in
    let ring = AudioRing()
    let clock = HostClock()
    let scratch = UnsafeMutableBufferPointer<Float>.allocate(capacity: ring.maxSpanFrames)
    defer { scratch.deallocate() }
    let read = UnsafeMutableBufferPointer<Float>.allocate(capacity: ring.maxSpanFrames)
    defer { read.deallocate() }
    let list = AudioBufferList.allocate(maximumBuffers: 1)
    defer { free(list.unsafeMutablePointer) }
    var samples = [Float](repeating: 0.25, count: 480)
    var timebase = mach_timebase_info_data_t()
    mach_timebase_info(&timebase)
    let ticksPerSecond = UInt64(1e9 * Double(timebase.denom) / Double(timebase.numer))
    /// One IO callback, as Core Audio makes it: 480 mono frames whose first sample is 1 s old.
    func callback(_ input: TapInput) {
      samples.withUnsafeMutableBytes { bytes in
        list.count = 1
        list[0] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(bytes.count), mData: bytes.baseAddress)
        var time = AudioTimeStamp()
        time.mHostTime = mach_absolute_time() - ticksPerSecond
        time.mFlags = .hostTimeValid
        input.receive(list.unsafePointer, at: time)
      }
    }
    func input(_ rate: Double) -> TapInput {
      TapInput(
        format: TapFormat(sampleRate: rate, channels: 1, interleaved: true), ring: ring,
        clock: clock, scratch: scratch)
    }

    let built = input(48_000)
    callback(built)
    let first = ring.read(into: read)
    t.expectEqual(first?.sampleRate, 48_000, "delivered in the format the tap was built with")
    t.expectEqual(first?.frameCount, 480, "all of it")
    t.expectNear(
      first?.captureWallMs ?? 0, clock.nowWallMs() - 1_000, within: 5, "stamped by its host time")

    // AirPods take the tap from 48 to 24 kHz: Core Audio calls the tap's format listener.
    var rebuildsAsked = 0
    let listener = SystemAudioTap.formatListener(closing: built) { rebuildsAsked += 1 }
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    withUnsafePointer(to: &address) { listener(1, $0) }
    t.expectEqual(rebuildsAsked, 1, "the listener asks for the rebuild")
    callback(built)
    callback(built)
    t.expect(
      ring.read(into: read) == nil,
      "the IO block built for 48 kHz writes nothing more: its audio would be labelled 48 kHz")
    t.expectEqual(ring.takeDroppedMs(), 0, "not counted as ring overflow: `restarted` explains it")

    // What the rebuild does: a discontinuity, then a new input in the format it reads.
    ring.markDiscontinuity()
    callback(input(24_000))
    let next = ring.read(into: read)
    t.expectEqual(next?.sampleRate, 24_000, "the rebuilt tap's audio carries the new rate")
    t.expectEqual(next?.discontinuity, true, "and starts a new run")
  }
}

// MARK: - Lifecycle

private func lifecycleCases(_ suite: inout SelfTestSuite) {
  suite.run("stdin: lines split across reads, CR LF, an overlong line cut, the last line at EOF") {
    t in
    var splitter = LineSplitter()
    var lines: [String] = []
    for chunk in ["rebu", "ild\nhello\r\n\n  rebuild  \nla", "st"] {
      lines += Array(chunk.utf8).withUnsafeBytes { splitter.append($0) }
    }
    t.expectEqual(lines, ["rebuild", "hello", "", "  rebuild  "], "complete lines")
    t.expectEqual(splitter.finish(), "last", "the unterminated last line")
    t.expectEqual(splitter.finish(), nil, "nothing after that")

    var long = LineSplitter()
    let overlong = String(repeating: "a", count: 5_000) + "\nrebuild\n"
    let cut = Array(overlong.utf8).withUnsafeBytes { long.append($0) }
    t.expectEqual(cut.map(\.count), [LineSplitter.maxLineBytes, 7], "cut at 4,096 bytes, rest dropped")

    t.expectEqual(TapCommand(line: "rebuild"), .rebuild, "rebuild")
    t.expectEqual(TapCommand(line: "  rebuild  "), .rebuild, "whitespace ignored")
    t.expectEqual(TapCommand(line: "hello"), .unknown("hello"), "anything else is unknown")
    t.expectEqual(TapCommand(line: " "), nil, "blank lines are ignored")
  }

  suite.run("stdin reader: lines, then the end of input, arrive on the queue in order") { t in
    let pipe = try makePipe()
    let queue = DispatchQueue(label: "selftest.stdin")
    let seen = Locked<[String]>([])
    let ended = DispatchSemaphore(value: 0)
    LineReader(
      fd: pipe.read, queue: queue,
      onLine: { line in seen.withValue { $0.append(line) } },
      onEnd: { end in
        seen.withValue { $0.append(end == .endOfFile ? "<eof>" : "<error>") }
        ended.signal()
      }
    ).start()
    try Array("rebuild\nhello\nno newline".utf8).withUnsafeBytes { try writeAll(fd: pipe.write, $0) }
    close(pipe.write)
    t.expect(ended.wait(timeout: .now() + 5) == .success, "end of input reported")
    t.expectEqual(seen.value, ["rebuild", "hello", "no newline", "<eof>"], "in order")
    close(pipe.read)
  }

  suite.run("parent watch: an exit is noticed, also one before the watch (zombie or reaped)") {
    t in
    let queue = DispatchQueue(label: "selftest.watch")
    let sleeper = Process()
    sleeper.executableURL = URL(fileURLWithPath: "/bin/sleep")
    sleeper.arguments = ["0.2"]
    try sleeper.run()
    let exited = DispatchSemaphore(value: 0)
    let fired = Locked(0)
    let watch = ProcessExitWatch(pid: sleeper.processIdentifier, queue: queue) {
      fired.withValue { $0 += 1 }
      exited.signal()
    }
    t.expect(exited.wait(timeout: .now() + 5) == .success, "its exit is noticed")

    // Exited and not yet reaped, like a parent that died while the helper was starting.
    var zombie: pid_t = 0
    var arguments: [UnsafeMutablePointer<CChar>?] = [strdup("/usr/bin/true"), nil]
    defer { free(arguments[0]) }
    guard posix_spawn(&zombie, "/usr/bin/true", nil, nil, &arguments, environ) == 0 else {
      throw SelfTestError(description: "posix_spawn /usr/bin/true failed: errno \(errno)")
    }
    usleep(200_000)
    let zombieSeen = DispatchSemaphore(value: 0)
    let zombieWatch = ProcessExitWatch(pid: zombie, queue: queue) { zombieSeen.signal() }
    t.expect(zombieSeen.wait(timeout: .now() + 5) == .success, "a zombie counts as exited")
    var status: Int32 = 0
    waitpid(zombie, &status, 0)

    let quick = Process()
    quick.executableURL = URL(fileURLWithPath: "/usr/bin/true")
    try quick.run()
    quick.waitUntilExit()
    let gone = DispatchSemaphore(value: 0)
    let late = ProcessExitWatch(pid: quick.processIdentifier, queue: queue) { gone.signal() }
    t.expect(gone.wait(timeout: .now() + 5) == .success, "so does a process already reaped")
    queue.sync {}
    t.expectEqual(fired.value, 1, "the first watch fired once")
    withExtendedLifetime((watch, zombieWatch, late)) {}
  }

  suite.run("signals: SIGHUP becomes a call on the queue, and cancel restores the default") { t in
    let queue = DispatchQueue(label: "selftest.signals")
    let received = DispatchSemaphore(value: 0)
    let number = Locked<Int32>(0)
    let signals = TerminationSignals(queue: queue) { signal in
      number.withValue { $0 = signal }
      received.signal()
    }
    kill(getpid(), SIGHUP)
    t.expect(received.wait(timeout: .now() + 5) == .success, "the handler ran")
    t.expectEqual(number.value, SIGHUP, "with the signal's number")
    signals.cancel()
    var action = sigaction()
    sigaction(SIGHUP, nil, &action)
    // SIG_DFL is the null handler.
    t.expect(action.__sigaction_u.__sa_handler == nil, "SIGHUP's default action is back")
  }

  suite.run("debounce: changes within 300 ms rebuild once under the most telling reason") { t in
    let queue = DispatchQueue(label: "selftest.debounce")
    let rebuilds = Locked<[(reason: RestartReason, at: DispatchTime)]>([])
    let debouncer = RebuildDebouncer(delay: .milliseconds(300), queue: queue) { reason in
      rebuilds.withValue { $0.append((reason, .now())) }
    }
    queue.async { debouncer.changed(.tapFormatChanged) }
    usleep(100_000)
    queue.async { debouncer.changed(.outputDeviceChanged) }
    usleep(100_000)
    let lastChange = Locked(DispatchTime.now())
    queue.async {
      lastChange.withValue { $0 = .now() }
      debouncer.changed(.tapFormatChanged)
    }
    usleep(150_000)
    t.expect(rebuilds.value.isEmpty, "nothing before 300 ms of quiet")
    t.expect(waitUntil(seconds: 3) { !rebuilds.value.isEmpty }, "then one rebuild")
    usleep(400_000)
    let first = rebuilds.value
    t.expectEqual(first.map(\.reason), [.outputDeviceChanged], "once, as an output device change")
    if let rebuilt = first.first {
      let quietMs = Double(rebuilt.at.uptimeNanoseconds - lastChange.value.uptimeNanoseconds) / 1e6
      t.expect(quietMs >= 290, "300 ms after the last change, got \(quietMs) ms")
    }

    queue.sync {
      debouncer.changed(.tapFormatChanged)
      debouncer.rebuildNow(.rebuildRequested)
    }
    t.expectEqual(
      rebuilds.value.map(\.reason), [.outputDeviceChanged, .rebuildRequested],
      "a requested rebuild runs at once")
    usleep(500_000)
    t.expectEqual(rebuilds.value.count, 2, "and cancels the change pending before it")
    queue.sync { debouncer.changed(.tapFormatChanged) }
    queue.sync { debouncer.cancel() }
    usleep(500_000)
    t.expectEqual(rebuilds.value.count, 2, "cancel drops a pending change")
  }
}

// MARK: - Tap session (with a fake device: no Core Audio)

private func sessionCases(_ suite: inout SelfTestSuite) {
  suite.run("tap session: ready, stdin rebuild at once, unknown command warned, EOF exits clean") {
    t in
    let harness = try SessionHarness()
    harness.start()
    t.expect(harness.waitFor { if case .ready = $0 { return true } else { return false } }, "ready")
    t.expect(
      harness.events.all.contains {
        guard case .ready(let format, let tapFormat) = $0 else { return false }
        return format == output16k && tapFormat == FakeTapDevice.format
      }, "ready names the output and the tap format")
    t.expectEqual(harness.device.log.value, ["build", "watch"], "built, then watching the route")

    let quarter = tone(rate: 48_000, seconds: 0.25, hz: 440, amplitude: 0.25)
    writeToRing(harness.ring, quarter, rate: 48_000)
    try harness.send("rebuild")
    t.expect(harness.waitFor(restartedBecause: .rebuildRequested), "restarted on request")
    t.expectEqual(
      harness.device.log.value, ["build", "watch", "teardown", "build"],
      "the old tap goes before the new one")
    // On time to the ms, but from the rebuilt tap: it must not join the old tap's run.
    writeToRing(harness.ring, quarter, rate: 48_000, from: startMs + 250)

    try harness.send("make coffee")
    t.expect(
      harness.waitFor {
        guard case .warning(let code, _) = $0 else { return false }
        return code == "unknown_command"
      }, "an unknown command is warned about")

    harness.closeStdin()
    t.expectEqual(harness.waitForExit(), .ok, "end of stdin exits with 0")
    t.expectEqual(
      Array(harness.device.log.value.suffix(2)), ["stop watching", "teardown"],
      "the tap is torn down before the exit")
    checkRuns(
      t, try decodeFrames(harness.finish()), [(startMs, 250), (startMs + 250, 250)],
      "the rebuild splits the audio into two runs, each written in full")
  }

  suite.run("tap session: route changes rebuild once; a failed rebuild warns and is retried") { t in
    let harness = try SessionHarness()
    harness.start()
    t.expect(harness.waitFor { if case .ready = $0 { return true } else { return false } }, "ready")
    harness.device.routeChanged(.tapFormatChanged)
    harness.device.routeChanged(.outputDeviceChanged)
    t.expect(harness.waitFor(restartedBecause: .outputDeviceChanged), "restarted for the route")
    usleep(200_000)
    t.expectEqual(harness.restarts, 1, "once for both changes")

    harness.device.failNextBuilds.withValue { $0 = 1 }
    try harness.send("rebuild")
    t.expect(harness.waitFor(restartedBecause: .rebuildRequested), "restarted after one retry")
    t.expect(
      harness.events.all.contains {
        guard case .warning(let code, _) = $0 else { return false }
        return code == "tap_create_failed"
      }, "the failed attempt is a warning")
    harness.closeStdin()
    t.expectEqual(harness.waitForExit(), .ok, "exits")
    harness.finish()
  }

  suite.run("tap session: a rebuild that keeps failing ends with an error event and code 1") { t in
    let harness = try SessionHarness()
    harness.start()
    t.expect(harness.waitFor { if case .ready = $0 { return true } else { return false } }, "ready")
    harness.device.failNextBuilds.withValue { $0 = TapSession.Timing().maxBuildAttempts }
    try harness.send("rebuild")
    t.expectEqual(harness.waitForExit(), .failure, "exit code 1")
    t.expect(
      harness.events.all.contains {
        guard case .error(let code, _, let status) = $0 else { return false }
        return code == "tap_create_failed" && status == -50
      }, "an error event with the OSStatus")
    t.expectEqual(harness.device.log.value.last, "teardown", "nothing left running")
    harness.closeStdin()
    harness.finish()
  }

  suite.run("tap session: a first build that fails exits with the error, never ready") { t in
    let harness = try SessionHarness()
    harness.device.failNextBuilds.withValue { $0 = 1 }
    harness.start()
    t.expectEqual(harness.waitForExit(), .failure, "exit code 1")
    t.expect(
      !harness.events.all.contains { if case .ready = $0 { return true } else { return false } },
      "no ready event")
    t.expect(
      harness.events.all.contains { if case .error = $0 { return true } else { return false } },
      "an error event")
    harness.closeStdin()
    harness.finish()
  }

  suite.run("tap session: the parent's exit ends it, and so does a closed stdout") { t in
    let parent = Process()
    parent.executableURL = URL(fileURLWithPath: "/bin/sleep")
    parent.arguments = ["0.3"]
    try parent.run()
    let orphan = try SessionHarness(parent: parent.processIdentifier)
    orphan.start()
    t.expectEqual(orphan.waitForExit(), .ok, "parent gone: exit 0")
    orphan.closeStdin()
    orphan.finish()

    let deaf = try SessionHarness(readStdout: false)
    deaf.start()
    t.expect(deaf.waitFor { if case .ready = $0 { return true } else { return false } }, "ready")
    writeToRing(
      deaf.ring, tone(rate: 48_000, seconds: 0.3, hz: 440, amplitude: 0.25), rate: 48_000)
    t.expectEqual(deaf.waitForExit(), .ok, "stdout closed: exit 0")
    t.expectEqual(deaf.device.log.value.last, "teardown", "torn down")
    deaf.closeStdin()
    deaf.finish()
  }
}

/// A tap that records what the session asks of it and fails builds on demand.
private final class FakeTapDevice: TapDevice, @unchecked Sendable {
  static let format = TapFormat(sampleRate: 48_000, channels: 1, interleaved: true)
  let log = Locked<[String]>([])
  let failNextBuilds = Locked(0)
  private let onChange = Locked<((RestartReason) -> Void)?>(nil)
  private let queue: DispatchQueue

  init(queue: DispatchQueue) { self.queue = queue }

  func build() throws -> TapFormat {
    let fail = failNextBuilds.withValue { remaining -> Bool in
      guard remaining > 0 else { return false }
      remaining -= 1
      return true
    }
    if fail {
      log.withValue { $0.append("build failed") }
      throw HelperFailure(code: "tap_create_failed", message: "fake tap refused", status: -50)
    }
    log.withValue { $0.append("build") }
    return Self.format
  }

  func teardown() { log.withValue { $0.append("teardown") } }

  func watchRoute(onChange: @escaping (RestartReason) -> Void) throws {
    log.withValue { $0.append("watch") }
    self.onChange.withValue { $0 = onChange }
  }

  func stopWatching() {
    log.withValue { $0.append("stop watching") }
    onChange.withValue { $0 = nil }
  }

  /// What a Core Audio property listener does: call back on the control queue.
  func routeChanged(_ reason: RestartReason) {
    queue.async { [onChange] in onChange.value?(reason) }
  }
}

/// A TapSession wired to pipes, a fake device and an exit that is recorded instead of taken.
private final class SessionHarness {
  let queue = DispatchQueue(label: "selftest.session")
  let device: FakeTapDevice
  let events = RecordingEventSink()
  let ring = AudioRing()
  private let session: TapSession
  private let stdin: (read: Int32, write: Int32)
  private let stdout: (read: Int32, write: Int32)
  private let stdoutDrain: PipeDrain?
  private var stdinOpen = true
  private let exitCode = Locked<ExitCode?>(nil)

  /// `readStdout: false` closes stdout's read end at once, as a main that went away would.
  init(parent: pid_t = getpid(), readStdout: Bool = true) throws {
    device = FakeTapDevice(queue: queue)
    stdin = try makePipe()
    stdout = try makePipe()
    let stdoutWrite = stdout.write
    let pipeline = try FramePipeline(output: output16k) { try writeAll(fd: stdoutWrite, $0) }
    let writer = FrameWriter(
      ring: ring, pipeline: pipeline, events: events, statsInterval: 0.2, pollInterval: 0.005)
    var timing = TapSession.Timing()
    timing.debounce = .milliseconds(50)
    timing.retryDelay = .milliseconds(50)
    session = TapSession(
      output: output16k, device: device, ring: ring, writer: writer, events: events, queue: queue,
      stdin: stdin.read, parent: parent, timing: timing
    ) { [exitCode] code in exitCode.withValue { $0 = code } }
    if readStdout {
      stdoutDrain = PipeDrain(fd: stdout.read)
    } else {
      stdoutDrain = nil
      close(stdout.read)
    }
  }

  func start() { queue.async { [session] in session.start() } }

  func send(_ line: String) throws {
    try Array((line + "\n").utf8).withUnsafeBytes { try writeAll(fd: stdin.write, $0) }
  }

  func closeStdin() {
    guard stdinOpen else { return }
    stdinOpen = false
    close(stdin.write)
  }

  var restarts: Int {
    events.all.filter { if case .restarted = $0 { return true } else { return false } }.count
  }

  func waitFor(_ match: @escaping (HelperEvent) -> Bool) -> Bool {
    waitUntil(seconds: 5) { self.events.all.contains(where: match) }
  }

  func waitFor(restartedBecause reason: RestartReason) -> Bool {
    waitFor {
      guard case .restarted(let why, _) = $0 else { return false }
      return why == reason
    }
  }

  func waitForExit() -> ExitCode? {
    _ = waitUntil(seconds: 5) { self.exitCode.value != nil }
    return exitCode.value
  }

  /// Ends the stdout drain and returns what the session wrote there. Call once it has exited.
  @discardableResult
  func finish() -> [UInt8] {
    close(stdout.write)
    let written = stdoutDrain?.finish() ?? []
    queue.sync {}
    return written
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

/// Writes samples to a ring in `spanMs` callbacks, as the IO block does, from `from` on.
private func writeToRing(
  _ ring: AudioRing, _ samples: [Float], rate: Double, spanMs: Double = 10,
  from wallMs: Double = startMs
) {
  let spanFrames = Int(rate * spanMs / 1_000)
  samples.withUnsafeBufferPointer { all in
    for offset in stride(from: 0, to: all.count, by: spanFrames) {
      let count = min(spanFrames, all.count - offset)
      ring.write(
        UnsafeBufferPointer(rebasing: all[offset..<offset + count]), sampleRate: rate,
        captureWallMs: wallMs + Double(offset) / rate * 1_000)
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
