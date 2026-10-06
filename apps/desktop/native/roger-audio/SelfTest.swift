import AVFoundation
import CoreAudio
import Foundation

// `roger-audio selftest`: the helper's own tests. `make check` runs them on a Mac.
//
// They cover everything that needs no audio permission: the frame header and capture times, the
// ring and its overflow count, the converter, the writer thread, the IO block's mixdown, stdin
// commands, the parent watch, signals, the rebuild debounce, and the tap session and the probe
// driven through a fake TapDevice. The IO block's shut-off on a tap format change is checked
// through TapInput and the format listener's block, called by hand. Nothing here creates a process
// tap, registers a Core Audio listener or opens an audio device, so it never raises a macOS
// privacy prompt and runs unattended; keep it that way, since `make check` runs it on every pass.
// The real tap and the real probe are exercised by `selftest --route-switch` (`make
// test-native-route`: opt-in and audible; "Route switch" below).

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
  probeCases(&suite)
  routeSwitchCases(&suite)
  suite.skip(
    "Core Audio tap and probe",
    because: "they need the System Audio Recording permission; `make test-native-route` runs both")
  return suite.finish()
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

/// A tap that records what the session asks of it and fails builds, or the route watch, on demand.
private final class FakeTapDevice: TapDevice, @unchecked Sendable {
  static let format = TapFormat(sampleRate: 48_000, channels: 1, interleaved: true)
  let log = Locked<[String]>([])
  let failNextBuilds = Locked(0)
  let failWatch = Locked(false)
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
    if failWatch.value {
      log.withValue { $0.append("watch failed") }
      throw HelperFailure(
        code: "route_watch_failed", message: "fake route watch refused", status: -50)
    }
    log.withValue { $0.append("watch") }
    self.onChange.withValue { $0 = onChange }
  }

  func stopWatching() {
    log.withValue { $0.append("stop watching") }
    onChange.withValue { $0 = nil }
  }

  /// What a Core Audio property listener does: call back on the control queue. The real tap's
  /// format listener also closes the tap's input first (SystemAudioTap.formatListener), so after a
  /// `.tapFormatChanged` nothing more arrives until a rebuild; the cases here write no audio after
  /// one.
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

// MARK: - Probe (with a fake device: no Core Audio)

private func probeCases(_ suite: inout SelfTestSuite) {
  /// What a probe that got as far as listening asks of its tap, in order.
  let probeLog = ["build", "watch", "stop watching", "teardown"]

  suite.run("probe options: 2 s by default, 1 to 10 whole seconds, anything else refused") { t in
    t.expectEqual(try ProbeOptions(arguments: []), ProbeOptions(seconds: 2), "default")
    t.expectEqual(try ProbeOptions(arguments: ["--seconds", "10"]).seconds, 10, "explicit")
    for bad in [
      ["--seconds"], ["--seconds", "0"], ["--seconds", "11"], ["--seconds", "1.5"],
      ["--seconds", "2", "--seconds", "2"], ["--sample-rate", "16000"],
    ] {
      t.expectThrows("refuses \(bad)") { _ = try ProbeOptions(arguments: bad) }
    }
  }

  suite.run("probe lines: one JSON line each, \"event\" first") { t in
    t.expectEqual(
      ProbeOutput.listening(seconds: 2).jsonLine, #"{"event":"listening","seconds":2}"# + "\n",
      "listening")
    t.expectEqual(
      ProbeOutput.result(ProbeResult(peak: 8_192, audioMs: 2_000)).jsonLine,
      #"{"event":"result","peak":8192,"audioMs":2000}"# + "\n", "result")
  }

  suite.run("probe meter: the loudest sample on the stats scale, and how much audio came") { t in
    var meter = PeakMeter()
    t.expectEqual(meter.result, ProbeResult(peak: 0, audioMs: 0), "nothing heard yet")
    var click = [Float](repeating: 0, count: 480)
    click[100] = -0.5
    click.withUnsafeBufferPointer { meter.add($0, sampleRate: 48_000) }
    t.expectEqual(
      meter.result, ProbeResult(peak: 16_384, audioMs: 10), "|-0.5| is half of full scale")
    [Float](repeating: 0.25, count: 160).withUnsafeBufferPointer {
      meter.add($0, sampleRate: 16_000)
    }
    t.expectEqual(
      meter.result, ProbeResult(peak: 16_384, audioMs: 20), "quieter audio adds only time")
    [Float.nan, 1.5, -Float.infinity].withUnsafeBufferPointer { meter.add($0, sampleRate: 48_000) }
    t.expectEqual(meter.result.peak, 32_768, "past full scale is full scale; NaN is never loudest")

    var faint = PeakMeter()
    [Float(0.4 / 32_768)].withUnsafeBufferPointer { faint.add($0, sampleRate: 48_000) }
    t.expectEqual(faint.result.peak, 0, "under half a 16-bit step is silence, as in tap's output")
    [Float(0.6 / 32_768)].withUnsafeBufferPointer { faint.add($0, sampleRate: 48_000) }
    t.expectEqual(faint.result.peak, 1, "over half a step is heard")
  }

  suite.run("probe: builds the tap, says it listens, hears for all its seconds, then tears down") {
    t in
    let probe = ProbeHarness(seconds: 2)
    probe.start()
    t.expect(probe.waitForListening(), "says it listens once the tap runs")
    t.expectEqual(
      probe.lines.value, [ProbeOutput.listening(seconds: 2).jsonLine], "the listening line, once")
    writeToRing(probe.ring, [Float](repeating: 0.25, count: 12_000), rate: 48_000)
    usleep(100_000)
    t.expect(!probe.finished, "still listening: 2 s have not passed on the uptime clock")
    probe.uptime.withValue { $0 += 2 }
    guard case .success(let heard)? = probe.finish() else {
      t.fail("did not finish with a result: \(String(describing: probe.finish()))")
      return
    }
    t.expectEqual(heard, ProbeResult(peak: 8_192, audioMs: 250), "peak and length of what it heard")
    t.expectEqual(
      probe.device.log.value, probeLog, "watches the route, and is torn down before it answers")
    t.expect(probe.events.all.isEmpty, "no warning")
  }

  suite.run("probe: digital silence is peak 0; a tap that delivers nothing also warns no_audio") {
    t in
    let silent = ProbeHarness(seconds: 1)
    silent.start()
    t.expect(silent.waitForListening(), "listening")
    writeToRing(silent.ring, [Float](repeating: 0, count: 4_800), rate: 48_000)
    silent.uptime.withValue { $0 += 1 }
    guard case .success(let quiet)? = silent.finish() else {
      t.fail("silence: no result: \(String(describing: silent.finish()))")
      return
    }
    t.expectEqual(quiet, ProbeResult(peak: 0, audioMs: 100), "100 ms of zeros")
    t.expect(silent.events.all.isEmpty, "silence is an answer, not a warning")

    let dead = ProbeHarness(seconds: 1)
    dead.start()
    t.expect(dead.waitForListening(), "listening")
    dead.uptime.withValue { $0 += 1 }
    guard case .success(let nothing)? = dead.finish() else {
      t.fail("no audio: no result: \(String(describing: dead.finish()))")
      return
    }
    t.expectEqual(nothing, ProbeResult(peak: 0, audioMs: 0), "no audio at all")
    t.expect(
      dead.events.all.contains {
        guard case .warning(let code, _) = $0 else { return false }
        return code == "no_audio"
      }, "a tap that never ran is warned about: it is a helper failure, not a permission answer")
  }

  suite.run("probe: a tap that cannot be built is the error; no listening line, nothing left") {
    t in
    let probe = ProbeHarness()
    probe.device.failNextBuilds.withValue { $0 = 1 }
    probe.start()
    guard case .failure(let error)? = probe.finish() else {
      t.fail("did not fail: \(String(describing: probe.finish()))")
      return
    }
    t.expectEqual((error as? HelperFailure)?.code, "tap_create_failed", "the tap's own failure")
    t.expectEqual((error as? HelperFailure)?.status, -50, "with its OSStatus")
    t.expect(probe.lines.value.isEmpty, "never said it listens")
    t.expectEqual(probe.device.log.value.last, "teardown", "nothing left built")
  }

  suite.run("probe: cancel (a termination signal) ends it early, torn down, with no result") { t in
    let probe = ProbeHarness(seconds: 10)
    probe.start()
    t.expect(probe.waitForListening(), "listening")
    probe.probe.cancel()
    t.expect(waitUntil(seconds: 1) { probe.finished }, "ends within a poll, not after 10 s")
    guard case .success(let heard)? = probe.finish() else {
      t.fail("cancel is not a failure: \(String(describing: probe.finish()))")
      return
    }
    t.expectEqual(heard, nil, "no result")
    t.expectEqual(probe.device.log.value, probeLog, "torn down")
  }

  suite.run("probe: a closed stdout ends it at once, torn down") { t in
    let probe = ProbeHarness(stdoutClosed: true)
    probe.start()
    guard case .failure(let error)? = probe.finish() else {
      t.fail("did not stop: \(String(describing: probe.finish()))")
      return
    }
    t.expectEqual(error as? OutputError, .closed, "the write's own error")
    t.expectEqual(probe.device.log.value, probeLog, "torn down")
  }

  // AirPods connecting or a sample-rate switch mid-listen: the real tap's format listener closes
  // its input (TapInput), so the probe would sit out its seconds on a deaf tap and answer peak 0,
  // which main reads as "pending" or "not allowed" although the permission is granted.
  suite.run("probe: a route change with nothing heard yet is no answer: route_changed, at once") {
    t in
    for reason in [RestartReason.tapFormatChanged, .outputDeviceChanged] {
      let probe = ProbeHarness(seconds: 10)
      probe.start()
      t.expect(probe.waitForListening(), "\(reason): listening")
      writeToRing(probe.ring, [Float](repeating: 0, count: 4_800), rate: 48_000)
      probe.device.routeChanged(reason)
      t.expect(
        waitUntil(seconds: 1) { probe.finished }, "\(reason): ends within a poll, not after 10 s")
      guard case .failure(let error)? = probe.finish() else {
        t.fail("\(reason): answered anyway: \(String(describing: probe.finish()))")
        continue
      }
      let failure = error as? HelperFailure
      t.expectEqual(failure?.code, "route_changed", "\(reason): the error code main reads")
      t.expect(
        failure?.message.contains(reason.rawValue) == true,
        "\(reason): names the change: \(failure?.message ?? "\(error)")")
      t.expectEqual(
        probe.lines.value, [ProbeOutput.listening(seconds: 10).jsonLine],
        "\(reason): no result line")
      t.expectEqual(probe.device.log.value, probeLog, "\(reason): torn down")
    }
  }

  suite.run("probe: a route change after the sound was heard keeps the answer, at once") { t in
    let probe = ProbeHarness(seconds: 10)
    probe.start()
    t.expect(probe.waitForListening(), "listening")
    writeToRing(probe.ring, [Float](repeating: 0.25, count: 4_800), rate: 48_000)
    probe.device.routeChanged(.tapFormatChanged)
    t.expect(waitUntil(seconds: 1) { probe.finished }, "ends within a poll, not after 10 s")
    guard case .success(let heard)? = probe.finish() else {
      t.fail("no result: \(String(describing: probe.finish()))")
      return
    }
    t.expectEqual(
      heard, ProbeResult(peak: 8_192, audioMs: 100),
      "heard is granted, whatever the route did after")
    t.expectEqual(probe.device.log.value, probeLog, "torn down")
    t.expect(probe.events.all.isEmpty, "no warning: the answer stands")
  }

  suite.run("probe: a route it cannot watch is the error; no listening line, nothing left") { t in
    let probe = ProbeHarness()
    probe.device.failWatch.withValue { $0 = true }
    probe.start()
    guard case .failure(let error)? = probe.finish() else {
      t.fail("did not fail: \(String(describing: probe.finish()))")
      return
    }
    t.expectEqual((error as? HelperFailure)?.code, "route_watch_failed", "the watch's own failure")
    t.expect(probe.lines.value.isEmpty, "never said it listens")
    t.expectEqual(
      probe.device.log.value, ["build", "watch failed", "stop watching", "teardown"],
      "nothing left built")
  }
}

/// A PeakProbe on a fake tap, run on its own thread, with an uptime clock that moves only when a
/// case moves it and a stdout that records its lines (or is closed).
private final class ProbeHarness: @unchecked Sendable {
  let queue = DispatchQueue(label: "selftest.probe")
  let ring = AudioRing()
  let device: FakeTapDevice
  let events = RecordingEventSink()
  let uptime = Locked<TimeInterval>(1_000)
  let lines = Locked<[String]>([])
  let probe: PeakProbe
  private let stdoutClosed: Bool
  private let outcome = Locked<Result<ProbeResult?, Error>?>(nil)

  init(seconds: Int = 2, stdoutClosed: Bool = false) {
    device = FakeTapDevice(queue: queue)
    self.stdoutClosed = stdoutClosed
    probe = PeakProbe(
      device: device, ring: ring, queue: queue, events: events, seconds: seconds,
      pollInterval: 0.005, uptime: { [uptime] in uptime.value })
  }

  func start() {
    Thread { [self] in
      let result = Result {
        try probe.run { line in
          if stdoutClosed { throw OutputError.closed }
          lines.withValue { $0.append(line) }
        }
      }
      outcome.withValue { $0 = result }
    }.start()
  }

  func waitForListening() -> Bool { waitUntil(seconds: 5) { !self.lines.value.isEmpty } }

  var finished: Bool { outcome.value != nil }

  /// Waits up to 5 s for `run` to return; nil when it has not.
  func finish() -> Result<ProbeResult?, Error>? {
    _ = waitUntil(seconds: 5) { self.finished }
    return outcome.value
  }
}

// MARK: - Route switch (opt-in and audible: `make test-native-route`)

/// The route test's pieces that need no device, checked on every `make check`: the test itself
/// cannot run there, so a mistake in what it judges by would otherwise show only on a Mac run.
private func routeSwitchCases(_ suite: inout SelfTestSuite) {
  suite.run("route test device: published multi-output over the current output, fixed UID") { t in
    let composition = RouteSwitchTest.multiOutputComposition(wrapping: "BuiltInSpeakerDevice")
    t.expectEqual(RouteSwitchTest.deviceUID, "ai.linkt.roger.audio.route-test", "the fixed UID")
    t.expectEqual(
      composition[kAudioAggregateDeviceUIDKey] as? String, RouteSwitchTest.deviceUID,
      "under the fixed UID, so a later run finds one a killed run left behind")
    t.expectEqual(composition[kAudioAggregateDeviceNameKey] as? String, "Roger route test", "name")
    t.expectEqual(
      composition[kAudioAggregateDeviceIsPrivateKey] as? Int, 0,
      "published: afplay can play only to an output it can see")
    t.expectEqual(composition[kAudioAggregateDeviceIsStackedKey] as? Int, 1, "multi-output")
    t.expectEqual(
      composition[kAudioAggregateDeviceMainSubDeviceKey] as? String, "BuiltInSpeakerDevice",
      "clocked by the output it wraps")
    let subDevices = composition[kAudioAggregateDeviceSubDeviceListKey] as? [[String: Any]]
    t.expectEqual(
      subDevices?.compactMap { $0[kAudioSubDeviceUIDKey] as? String }, ["BuiltInSpeakerDevice"],
      "the current output is its one sub-device")
  }

  suite.run("route test tone: a quiet 48 kHz sine for afplay, fading in and out, no click") { t in
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(
      "roger-selftest-tone-\(getpid()).caf")
    defer {
      if FileManager.default.fileExists(atPath: file.path) {
        do {
          try FileManager.default.removeItem(at: file)
        } catch {
          t.fail("deleting \(file.path): \(error)")
        }
      }
    }
    try writeTone(to: file, seconds: 0.5, hz: 440, amplitude: 0.1)
    let written = try AVAudioFile(forReading: file)
    t.expectEqual(written.fileFormat.sampleRate, 48_000, "48 kHz")
    t.expectEqual(written.fileFormat.channelCount, 1, "mono")
    t.expectEqual(written.length, 24_000, "0.5 s")
    guard
      let buffer = AVAudioPCMBuffer(pcmFormat: written.processingFormat, frameCapacity: 4_800),
      let channel = buffer.floatChannelData?[0]
    else {
      t.fail("no float buffer to read the tone into")
      return
    }
    // A read may return fewer frames than the buffer holds, so read to the end of the file.
    var samples: [Float] = []
    while written.framePosition < written.length {
      try written.read(into: buffer)
      guard buffer.frameLength > 0 else { break }
      samples += UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength))
    }
    t.expectEqual(samples.count, 24_000, "all of it reads back")
    t.expectNear(
      Double(samples.map { abs($0) }.max() ?? 0), 0.1, within: 0.001, "amplitude 0.1: quiet")
    t.expectEqual(samples.first, 0, "starts from silence")
    t.expectEqual(samples.last, 0, "ends in silence")
    t.expect(
      (samples.prefix(240).map { abs($0) }.max() ?? 1) <= 0.025,
      "the first 5 ms are at most a quarter of the way up the 20 ms fade")
    t.expect(
      (samples.suffix(240).map { abs($0) }.max() ?? 1) <= 0.025,
      "and the last 5 ms a quarter of the way down")
  }

  suite.run("route test levels: a frame counts from its capture time; zeros never count") { t in
    let levels = FrameLevels()
    let pipeline = try FramePipeline(output: output16k, sink: levels.record)
    try feed(pipeline, tone(rate: 48_000, seconds: 0.1, hz: 440, amplitude: 0.5), rate: 48_000)
    // A second run a second later, as after a rebuild, and silent.
    try feed(pipeline, [Float](repeating: 0, count: 9_600), rate: 48_000, wallMs: startMs + 1_000)
    try pipeline.finish()
    t.expect(levels.heard(since: startMs), "the tone, from its capture time on")
    t.expect(
      !levels.heard(since: startMs + 500),
      "after it only silence: the tone's frames are older, though written in the same pass")
    t.expectThrows("a malformed frame is an error, not a silent frame") {
      try [UInt8](repeating: 0, count: 20).withUnsafeBytes { try levels.record($0) }
    }
  }

  suite.run("route test leftover: the output moved off it first; kept when the move stalls") { t in
    let speakers = FakeOutputs.speakers
    let leftover = FakeOutputs.leftover
    let none = FakeOutputs(current: speakers, hasLeftover: false)
    t.expectEqual(try RouteSwitchTest.removeLeftover(none), false, "no leftover: nothing done")
    t.expectEqual(none.log, [], "nothing changed")

    let aside = FakeOutputs(current: speakers, hasLeftover: true)
    t.expectEqual(try RouteSwitchTest.removeLeftover(aside), true, "a leftover aside")
    t.expectEqual(aside.log, ["destroy \(leftover)"], "removed, the output untouched")

    let inUse = FakeOutputs(current: leftover, hasLeftover: true)
    t.expectEqual(try RouteSwitchTest.removeLeftover(inUse), true, "a leftover in use")
    t.expectEqual(
      inUse.log, ["set \(speakers)", "destroy \(leftover)"],
      "the output handed back to the device it wraps before it goes")
    t.expectEqual(inUse.current, speakers, "the user's own output is the default again")

    // Removing the default output leaves macOS to pick any output; setup would take that one for
    // the user's own, and the final cleanup would "restore" it.
    let stalled = FakeOutputs(current: leftover, hasLeftover: true, moves: false)
    t.expectThrows("a move that does not land stops the run") {
      _ = try RouteSwitchTest.removeLeftover(stalled)
    }
    t.expectEqual(
      stalled.log, ["set \(speakers)"], "kept: it still plays to the output it wraps")

    let orphan = FakeOutputs(current: leftover, hasLeftover: true, wrapsUID: "unplugged")
    t.expectEqual(try RouteSwitchTest.removeLeftover(orphan), true, "a leftover over a gone output")
    t.expectEqual(orphan.log, ["destroy \(leftover)"], "removed: there is no output to hand back")
  }
}

/// Output devices in memory for `RouteSwitchTest.removeLeftover`: the speakers and, when asked, the
/// route test's leftover over them. Setting the default moves it, unless `moves` is false.
private final class FakeOutputs: OutputControl {
  static let speakers: AudioDeviceID = 10
  static let leftover: AudioDeviceID = 90
  private(set) var log: [String] = []
  private(set) var current: AudioDeviceID
  private let hasLeftover: Bool
  private let moves: Bool
  private let wrapsUID: String

  init(
    current: AudioDeviceID, hasLeftover: Bool, moves: Bool = true, wrapsUID: String = "speakers"
  ) {
    self.current = current
    self.hasLeftover = hasLeftover
    self.moves = moves
    self.wrapsUID = wrapsUID
  }

  func device(withUID uid: String) -> AudioDeviceID? {
    switch uid {
    case "speakers": return Self.speakers
    case RouteSwitchTest.deviceUID: return hasLeftover ? Self.leftover : nil
    default: return nil
    }
  }

  func defaultOutput() -> AudioDeviceID { current }

  func setDefaultOutput(_ device: AudioDeviceID) {
    log.append("set \(device)")
    if moves { current = device }
  }

  func defaultOutput(becoming device: AudioDeviceID, within seconds: Double) -> AudioDeviceID {
    current
  }

  func mainSubDeviceUID(of aggregate: AudioDeviceID) -> String { wrapsUID }

  func name(of device: AudioDeviceID) -> String { "device \(device)" }

  func destroy(_ device: AudioDeviceID) { log.append("destroy \(device)") }
}

/// `selftest --route-switch`: the tap follows a switch of the default output (the "Tap rebuild on
/// device change" row of docs/plans/M2-capture-you-can-trust.md). While afplay plays a quiet tone,
/// it checks that the probe and a live tap session hear it, then makes a temporary multi-output
/// device over the current output the default (the same speakers, so the tone keeps sounding, but
/// another device) and expects a `restarted` event and non-zero audio from the rebuilt tap within
/// 2 s; then it moves the output back and expects the same again.
///
/// Opt-in, never in `make check`: it is audible, it moves the Mac's output for a few seconds, and
/// its taps need System Audio Recording, which the first run asks for on behalf of whatever runs
/// it (the terminal). The output is moved back and the temporary device removed on every way out
/// it can catch, Ctrl-C included; a run killed outright leaves the device for the next run to
/// remove.
func runRouteSwitchSelfTest() -> Int32 {
  // Line-buffered, so the cases before a hang stay on screen.
  setvbuf(stdout, nil, _IOLBF, 0)
  signal(SIGPIPE, SIG_IGN)
  print(
    "roger-audio selftest --route-switch: plays a quiet 440 Hz tone and moves the default output "
      + "to a temporary device and back, about 10 s")
  let test = RouteSwitchTest()
  let signalQueue = DispatchQueue(label: "selftest.route.signals")
  let signals = TerminationSignals(queue: signalQueue) { number in
    test.cleanUp()
    print("roger-audio selftest --route-switch: stopped by signal \(number), after its cleanup")
    exit(ExitCode.failure.rawValue)
  }
  var suite = SelfTestSuite()
  test.run(&suite)
  // The last case cleans up; this covers a run that stopped before it, and does nothing otherwise.
  test.cleanUp()
  signals.cancel()
  return suite.finish()
}

/// The route test's steps, and everything it changes on the Mac, so `cleanUp` can undo it from the
/// signal handler as well as at the end.
private final class RouteSwitchTest: @unchecked Sendable {
  /// Fixed, so a run killed before its cleanup leaves a device the next run can find.
  static let deviceUID = "ai.linkt.roger.audio.route-test"
  static let deviceName = "Roger route test"
  /// The design row's bound: a `restarted` event and the rebuilt tap's audio within 2 s.
  static let followSeconds = 2.0
  /// Longer than all the steps together; the cleanup stops it.
  static let toneSeconds = 20.0

  /// What the test changed. Every change and the cleanup hold the lock, so a cleanup from the
  /// signal handler never runs between a change and its note here, and nothing changes after it.
  private struct Changes {
    var cleanedUp = false
    var original: AudioDeviceID?
    var testDevice: AudioDeviceID?
    var player: Process?
    var toneFile: URL?
  }

  private let changes = Locked(Changes())

  /// The temporary device: multi-output (stacked), with the current output as its one sub-device,
  /// so it plays what that output plays.
  ///
  /// Published (`private` 0), although the plan says private: a private aggregate exists only for
  /// the process that made it (AudioHardware.h), and afplay, like any call app, can play only to an
  /// output it can see, so it could not follow the switch onto a private one. A published device
  /// outlives a run killed with SIGKILL, hence the fixed UID and `removeLeftover`.
  static func multiOutputComposition(wrapping outputUID: String) -> [String: Any] {
    [
      kAudioAggregateDeviceNameKey: deviceName,
      kAudioAggregateDeviceUIDKey: deviceUID,
      kAudioAggregateDeviceIsPrivateKey: 0,
      kAudioAggregateDeviceIsStackedKey: 1,
      kAudioAggregateDeviceMainSubDeviceKey: outputUID,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
    ]
  }

  func run(_ suite: inout SelfTestSuite) {
    var original = AudioDeviceID(kAudioObjectUnknown)
    var originalUID = ""
    let setUp = passes(&suite, "setup: the current output read, the tone playing") { _ in
      try change { made in
        if try Self.removeLeftover(CoreAudioOutputs()) {
          print("      removed the \(Self.deviceName) device a killed run left behind")
        }
        original = try OutputDevices.defaultOutput()
        originalUID = try OutputDevices.uid(of: original)
        made.original = original
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(
          "roger-route-test-\(getpid()).caf")
        made.toneFile = file
        try writeTone(to: file, seconds: Self.toneSeconds, hz: 440, amplitude: 0.1)
        let player = Process()
        player.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
        player.arguments = [file.path]
        try player.run()
        made.player = player
      }
      print("      output: \(OutputDevices.name(of: original))")
    }
    guard setUp else { return skipRest(&suite, because: "the setup failed") }

    let probed = passes(&suite, "probe: a real tap hears the tone") { t in
      let queue = DispatchQueue(label: "selftest.route.probe")
      let ring = AudioRing()
      let events = RecordingEventSink()
      let probe = PeakProbe(
        device: SystemAudioTap(ring: ring, queue: queue, events: events), ring: ring, queue: queue,
        events: events, seconds: 2)
      let heard = try probe.run { _ in }
      t.expect(
        (heard?.audioMs ?? 0) > 0, "the tap delivered audio; events: \(describe(events.all))")
      t.expect(
        (heard?.peak ?? 0) > 0,
        "the tap heard nothing (peak 0). Allow System Audio Recording for the app running this "
          + "(System Settings > Privacy & Security > Screen & System Audio Recording > System "
          + "Audio Recording Only; a first run has just asked), check the Mac is not muted, and "
          + "run again")
    }
    guard probed else {
      return skipRest(&suite, because: "the tap hears nothing, so a switch would prove nothing")
    }

    var session: LiveTapSession?
    let listening = passes(&suite, "tap: ready, and the tone heard within 2 s") { t in
      let tap = try LiveTapSession()
      session = tap
      tap.start()
      t.expect(tap.waitForReady(), "ready within 5 s; events: \(describe(tap.events.all))")
      t.expect(
        waitUntil(seconds: Self.followSeconds) { tap.levels.heard(since: 0) },
        "non-zero audio within 2 s of ready")
    }
    guard listening, let tap = session else {
      if let tap = session { print("      tap session stopped: \(String(describing: tap.stop()))") }
      return skipRest(&suite, because: "the tap session did not hear the tone")
    }

    var moved = false
    passes(&suite, "switch to a temporary multi-output device: the tap follows within 2 s") { t in
      let device = try change { made -> AudioDeviceID in
        let device = try OutputDevices.createAggregate(
          Self.multiOutputComposition(wrapping: originalUID),
          "creating \(Self.deviceName) over \(OutputDevices.name(of: original)) (if that output is "
            + "itself an aggregate or multi-output device, pick a plain one and run again)")
        made.testDevice = device
        return device
      }
      t.expect(
        waitUntil(seconds: 2) { OutputDevices.hasOutputStreams(device) },
        "\(Self.deviceName) came up with output streams within 2 s")
      moved = try follow(t, tap, to: device)
    }
    if moved {
      passes(&suite, "back to the original output: the tap follows within 2 s") { t in
        _ = try follow(t, tap, to: original)
      }
    } else {
      suite.skip("back to the original output", because: "the output never moved")
    }

    passes(&suite, "tap: ends at the end of stdin with code 0 and no error event") { t in
      t.expectEqual(tap.stop(), .ok, "exit code")
      let errors = tap.events.all.filter {
        if case .error = $0 { return true } else { return false }
      }
      t.expect(errors.isEmpty, "error events: \(describe(errors))")
    }

    passes(&suite, "cleanup: the original output is the default again, the test device gone") { t in
      let problems = cleanUp()
      t.expect(problems.isEmpty, "could not undo: \(problems.joined(separator: "; "))")
      t.expectEqual(try OutputDevices.defaultOutput(), original, "the default output")
      t.expectEqual(
        try OutputDevices.device(withUID: Self.deviceUID), nil, "\(Self.deviceName) removed")
    }
  }

  /// Undoes what the test changed: stops the tone, moves the output back, removes the test device
  /// and the tone file. Runs once; later calls do nothing. Returns, and prints, what it could not
  /// undo.
  @discardableResult
  func cleanUp() -> [String] {
    changes.withValue { made in
      guard !made.cleanedUp else { return [] }
      made.cleanedUp = true
      var problems: [String] = []
      if let player = made.player, player.isRunning {
        // SIGKILL, not terminate(): while TerminationSignals runs, this process ignores SIGTERM,
        // and a child can inherit an ignored signal across exec.
        kill(player.processIdentifier, SIGKILL)
        player.waitUntilExit()
      }
      if let device = made.testDevice, let original = made.original {
        // Set even when the default already reads as the original: a switch to the test device
        // may still be on its way (setDefaultOutput), and that stale read would skip the restore.
        // The device goes only once the original is back: removing the default output leaves
        // macOS to pick any output.
        do {
          try OutputDevices.setDefaultOutput(original)
          let current = try OutputDevices.defaultOutput(becoming: original, within: 2)
          if current != original {
            problems.append(
              "the default output is \(OutputDevices.name(of: current)), not "
                + OutputDevices.name(of: original))
          }
        } catch {
          problems.append("moving the output back to \(OutputDevices.name(of: original)): \(error)")
        }
        do {
          try OutputDevices.destroy(device)
        } catch {
          problems.append("removing \(Self.deviceName): \(error)")
        }
      }
      if let file = made.toneFile, FileManager.default.fileExists(atPath: file.path) {
        do {
          try FileManager.default.removeItem(at: file)
        } catch {
          problems.append("deleting \(file.path): \(error)")
        }
      }
      for problem in problems { print("      cleanup failed: \(problem)") }
      return problems
    }
  }

  /// Makes `device` the default output and checks that the live tap follows: a `restarted` event
  /// for the output change, then non-zero audio captured by the rebuilt tap, both within 2 s of the
  /// switch. Returns whether the default output moved.
  private func follow(_ t: SelfTestCase, _ tap: LiveTapSession, to device: AudioDeviceID) throws
    -> Bool
  {
    let name = OutputDevices.name(of: device)
    let eventsBefore = tap.events.all.count
    let deadline = ProcessInfo.processInfo.systemUptime + Self.followSeconds
    func remaining() -> Double { max(0, deadline - ProcessInfo.processInfo.systemUptime) }

    try change { _ in try OutputDevices.setDefaultOutput(device) }
    let current = try OutputDevices.defaultOutput(becoming: device, within: remaining())
    t.expectEqual(current, device, "macOS made \(name) the default output within 2 s")
    guard current == device else { return false }

    let restarted = waitUntil(seconds: remaining()) {
      tap.restartReasons(after: eventsBefore).contains(.outputDeviceChanged)
    }
    t.expect(
      restarted,
      "restarted (output_device_changed) within 2 s; events since the switch: "
        + describe(Array(tap.events.all.dropFirst(eventsBefore))))
    // The build behind that event is the last one begun. The old tap was torn down before it, so
    // audio captured from its start on is the rebuilt tap's.
    guard restarted, let rebuiltAt = tap.device.buildStarts.value.last else { return true }
    t.expect(
      waitUntil(seconds: remaining()) { tap.levels.heard(since: rebuiltAt) },
      "non-zero audio from the rebuilt tap within 2 s of the switch (afplay has to follow the "
        + "default output for the tap to hear it)")
    return true
  }

  /// A change to the Mac, made under the lock `cleanUp` takes; refused once the cleanup has run.
  private func change<Value>(_ body: (inout Changes) throws -> Value) throws -> Value {
    try changes.withValue { made in
      guard !made.cleanedUp else {
        throw SelfTestError(description: "stopped: the test has cleaned up")
      }
      return try body(&made)
    }
  }

  /// A run killed outright (kill -9) leaves its published device behind, maybe as the default
  /// output. Moves the output to the device it wraps, then removes it. True when there was one.
  ///
  /// Throws, and keeps the device, when the output has not moved within 2 s: removing the default
  /// output leaves macOS to pick any output, which setup would then read as the user's own and the
  /// final cleanup would "restore". Kept, it still plays to the output it wraps. With that output
  /// gone there is nothing to hand back to, so it goes.
  static func removeLeftover(_ outputs: OutputControl) throws -> Bool {
    guard let leftover = try outputs.device(withUID: deviceUID) else { return false }
    if try outputs.defaultOutput() == leftover,
      let wrapped = try outputs.device(withUID: outputs.mainSubDeviceUID(of: leftover))
    {
      try outputs.setDefaultOutput(wrapped)
      let current = try outputs.defaultOutput(becoming: wrapped, within: 2)
      guard current == wrapped else {
        let wrappedName = outputs.name(of: wrapped)
        throw SelfTestError(
          description: "\(deviceName), left by a killed run, is the default output, and moving "
            + "the output back to \(wrappedName), the device it plays to, did not land within 2 s "
            + "(the default is \(outputs.name(of: current))). It is kept, so macOS does not pick "
            + "an output: make \(wrappedName) the output in System Settings > Sound and run again")
      }
    }
    try outputs.destroy(leftover)
    return true
  }

  private func skipRest(_ suite: inout SelfTestSuite, because reason: String) {
    suite.skip("the rest of the route test", because: reason)
  }
}

/// Runs one case and says whether it passed, for a step the rest depend on.
@discardableResult
private func passes(
  _ suite: inout SelfTestSuite, _ name: String, _ body: (SelfTestCase) throws -> Void
) -> Bool {
  var passed = false
  suite.run(name) { t in
    try body(t)
    passed = t.failures.isEmpty
  }
  return passed
}

/// A real tap session in this process, wired as `roger-audio tap` wires one, except that its frames
/// go to `levels`, its events to `events`, and its stdin is a pipe this side holds.
private final class LiveTapSession {
  let events = RecordingEventSink()
  let levels = FrameLevels()
  let device: TimedTapDevice
  private let queue = DispatchQueue(label: "selftest.route.tap")
  private let session: TapSession
  private let stdin: (read: Int32, write: Int32)
  private let exitCode = Locked<ExitCode?>(nil)
  private var stdinOpen = true

  init() throws {
    let ring = AudioRing()
    device = TimedTapDevice(SystemAudioTap(ring: ring, queue: queue, events: events))
    stdin = try makePipe()
    let pipeline = try FramePipeline(output: output16k, sink: levels.record)
    session = TapSession(
      output: output16k, device: device, ring: ring,
      writer: FrameWriter(ring: ring, pipeline: pipeline, events: events), events: events,
      queue: queue, stdin: stdin.read, parent: getpid()
    ) { [exitCode] code in exitCode.withValue { $0 = code } }
  }

  func start() { queue.async { [session] in session.start() } }

  func waitForReady() -> Bool {
    waitUntil(seconds: 5) {
      self.events.all.contains { if case .ready = $0 { return true } else { return false } }
    }
  }

  /// The reasons of the `restarted` events after the first `count` events.
  func restartReasons(after count: Int) -> [RestartReason] {
    events.all.dropFirst(count).compactMap {
      guard case .restarted(let reason, _) = $0 else { return nil }
      return reason
    }
  }

  /// Ends stdin, as main does on Stop, and waits up to 5 s for the session's exit code.
  func stop() -> ExitCode? {
    if stdinOpen {
      stdinOpen = false
      close(stdin.write)
    }
    _ = waitUntil(seconds: 5) { self.exitCode.value != nil }
    return exitCode.value
  }
}

/// Passes every call to the real tap and notes when each build begins, on the wall clock frame
/// capture times use: audio captured after a build began is that build's, which tells the rebuilt
/// tap's audio from the old tap's last frames.
private final class TimedTapDevice: TapDevice {
  let buildStarts = Locked<[Double]>([])
  private let tap: TapDevice
  private let clock = HostClock()

  init(_ tap: TapDevice) { self.tap = tap }

  func build() throws -> TapFormat {
    buildStarts.withValue { $0.append(clock.nowWallMs()) }
    return try tap.build()
  }

  func teardown() { tap.teardown() }

  func watchRoute(onChange: @escaping (RestartReason) -> Void) throws {
    try tap.watchRoute(onChange: onChange)
  }

  func stopWatching() { tap.stopWatching() }
}

/// The capture time and peak of each frame a tap session wrote, decoded from its bytes as main
/// decodes them.
private final class FrameLevels: @unchecked Sendable {
  private let frames = Locked<[(captureWallMs: Double, peak: Int)]>([])

  /// A FramePipeline sink. A frame that does not decode throws, which stops the writer with an
  /// error event: a test that judged by frames it cannot read would judge nothing.
  func record(_ frame: UnsafeRawBufferPointer) throws {
    for decoded in try decodeFrames(Array(frame)) {
      let peak = decoded.samples.map { abs(Int($0)) }.max() ?? 0
      frames.withValue { $0.append((decoded.header.captureWallMs, peak)) }
    }
  }

  /// True when a frame captured at `wallMs` or later holds a non-zero sample.
  func heard(since wallMs: Double) -> Bool {
    frames.value.contains { $0.captureWallMs >= wallMs && $0.peak > 0 }
  }
}

/// The output device calls `RouteSwitchTest.removeLeftover` makes: Core Audio on a Mac, a fake in
/// `make check`, which runs its decisions on every pass.
private protocol OutputControl {
  func device(withUID uid: String) throws -> AudioDeviceID?
  func defaultOutput() throws -> AudioDeviceID
  func setDefaultOutput(_ device: AudioDeviceID) throws
  func defaultOutput(becoming device: AudioDeviceID, within seconds: Double) throws
    -> AudioDeviceID
  func mainSubDeviceUID(of aggregate: AudioDeviceID) throws -> String
  func name(of device: AudioDeviceID) -> String
  func destroy(_ device: AudioDeviceID) throws
}

/// OutputControl on Core Audio: each call is OutputDevices' own.
private struct CoreAudioOutputs: OutputControl {
  func device(withUID uid: String) throws -> AudioDeviceID? {
    try OutputDevices.device(withUID: uid)
  }

  func defaultOutput() throws -> AudioDeviceID { try OutputDevices.defaultOutput() }

  func setDefaultOutput(_ device: AudioDeviceID) throws {
    try OutputDevices.setDefaultOutput(device)
  }

  func defaultOutput(becoming device: AudioDeviceID, within seconds: Double) throws
    -> AudioDeviceID
  {
    try OutputDevices.defaultOutput(becoming: device, within: seconds)
  }

  func mainSubDeviceUID(of aggregate: AudioDeviceID) throws -> String {
    try OutputDevices.mainSubDeviceUID(of: aggregate)
  }

  func name(of device: AudioDeviceID) -> String { OutputDevices.name(of: device) }

  func destroy(_ device: AudioDeviceID) throws { try OutputDevices.destroy(device) }
}

/// The Core Audio calls of the route test. A failure is a HelperFailure that names what was
/// attempted and carries the OSStatus.
private enum OutputDevices {
  private static let system = AudioObjectID(kAudioObjectSystemObject)
  private static let unknown = AudioDeviceID(kAudioObjectUnknown)

  static func defaultOutput() throws -> AudioDeviceID {
    var device = unknown
    try getProperty(
      system, kAudioHardwarePropertyDefaultOutputDevice, into: &device,
      "reading the default output device")
    return device
  }

  /// Asks for `device` as the default output. The switch may land after this returns: read it
  /// back with `defaultOutput(becoming:within:)`, never with a single `defaultOutput()`.
  static func setDefaultOutput(_ device: AudioDeviceID) throws {
    var address = Self.address(kAudioHardwarePropertyDefaultOutputDevice)
    var value = device
    try check(
      AudioObjectSetPropertyData(
        system, &address, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &value),
      "making \(name(of: device)) the default output")
  }

  /// The default output, read again until it is `device` or `seconds` pass. AudioHardware.h:
  /// a property "should not be considered changed until the HAL has called the listeners as many
  /// properties values are changed asynchronously", so a read right after the set can be stale.
  static func defaultOutput(becoming device: AudioDeviceID, within seconds: Double) throws
    -> AudioDeviceID
  {
    var current = try defaultOutput()
    var failure: Error?
    _ = waitUntil(seconds: seconds) {
      if current == device { return true }
      do {
        current = try defaultOutput()
      } catch {
        failure = error
        return true
      }
      return current == device
    }
    if let failure { throw failure }
    return current
  }

  static func uid(of device: AudioDeviceID) throws -> String {
    try string(device, kAudioDevicePropertyDeviceUID, "reading the UID of device \(device)")
  }

  /// For messages: the device's name, or its id and why the name could not be read.
  static func name(of device: AudioDeviceID) -> String {
    do {
      return try string(device, kAudioObjectPropertyName, "reading the name of device \(device)")
    } catch {
      return "device \(device) (\(error))"
    }
  }

  /// The device with this UID, or nil when there is none.
  static func device(withUID uid: String) throws -> AudioDeviceID? {
    var address = Self.address(kAudioHardwarePropertyTranslateUIDToDevice)
    var device = unknown
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = withUnsafePointer(to: uid as CFString) { qualifier in
      AudioObjectGetPropertyData(
        system, &address, UInt32(MemoryLayout<CFString>.size), qualifier, &size, &device)
    }
    try check(status, "looking up the device with UID \(uid)")
    return device == unknown ? nil : device
  }

  static func mainSubDeviceUID(of aggregate: AudioDeviceID) throws -> String {
    try string(
      aggregate, kAudioAggregateDevicePropertyMainSubDevice,
      "reading which output device \(aggregate) wraps")
  }

  static func createAggregate(_ composition: [String: Any], _ what: String) throws -> AudioDeviceID
  {
    var device = unknown
    try check(AudioHardwareCreateAggregateDevice(composition as CFDictionary, &device), what)
    return device
  }

  static func destroy(_ device: AudioDeviceID) throws {
    try check(AudioHardwareDestroyAggregateDevice(device), "removing device \(device)")
  }

  /// False until the device answers with output streams. One still coming up answers with an
  /// error, so this is polled, and the caller reports a device that never comes up.
  static func hasOutputStreams(_ device: AudioDeviceID) -> Bool {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeOutput,
      mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    return AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr && size > 0
  }

  private static func getProperty<Value>(
    _ object: AudioObjectID, _ selector: AudioObjectPropertySelector, into value: inout Value,
    _ what: String
  ) throws {
    var address = Self.address(selector)
    var size = UInt32(MemoryLayout<Value>.size)
    try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value), what)
  }

  /// A CFString property. The HAL hands it over retained, so it is taken retained.
  private static func string(
    _ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ what: String
  ) throws -> String {
    var value: Unmanaged<CFString>?
    try getProperty(object, selector, into: &value, what)
    guard let value else {
      throw HelperFailure(code: "core_audio_failed", message: "\(what): no value")
    }
    return value.takeRetainedValue() as String
  }

  private static func address(_ selector: AudioObjectPropertySelector)
    -> AudioObjectPropertyAddress
  {
    AudioObjectPropertyAddress(
      mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
  }

  private static func check(_ status: OSStatus, _ what: String) throws {
    guard status != noErr else { return }
    throw HelperFailure(
      code: "core_audio_failed",
      message: "\(what) failed (OSStatus \(status) \(fourCharCode(UInt32(bitPattern: status))))",
      status: status)
  }
}

/// Writes a mono 48 kHz Float32 sine for afplay to `url` (its extension picks the file type), with
/// 20 ms fades so it starts and stops without a click.
private func writeTone(to url: URL, seconds: Double, hz: Double, amplitude: Float) throws {
  let rate = 48_000.0
  let samples = tone(rate: rate, seconds: seconds, hz: hz, amplitude: amplitude)
  guard
    let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1),
    let buffer = AVAudioPCMBuffer(
      pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
    let channel = buffer.floatChannelData?[0]
  else {
    throw SelfTestError(description: "could not set up a buffer for a \(seconds) s tone")
  }
  let fade = Int(rate * 0.02)
  for (index, sample) in samples.enumerated() {
    let edge = min(index, samples.count - 1 - index)
    channel[index] = edge < fade ? sample * Float(edge) / Float(fade) : sample
  }
  buffer.frameLength = AVAudioFrameCount(samples.count)
  // The file format: one Float32 channel. No "non-interleaved" key, which describes buffers, not
  // a file.
  let settings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVSampleRateKey: rate,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 32,
    AVLinearPCMIsFloatKey: true,
    AVLinearPCMIsBigEndianKey: false,
  ]
  // AVAudioFile finishes the file only when it is released (it has no close() before macOS 15).
  // The pool makes that happen here: an autoreleased reference would otherwise keep the file open
  // and unfinished past this function, since this tool never drains a pool of its own, and afplay
  // or the selftest would read it half written.
  try autoreleasepool {
    let file = try AVAudioFile(
      forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    try file.write(from: buffer)
  }
}

/// Events for a failure message, one JSON line each, without the `stats` lines.
private func describe(_ events: [HelperEvent]) -> String {
  let lines = events.compactMap { event -> String? in
    if case .stats = event { return nil }
    return event.jsonLine.trimmingCharacters(in: .newlines)
  }
  return lines.isEmpty ? "none" : lines.joined(separator: " ")
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
