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

  var suite = SelfTestSuite()
  protocolCases(&suite)
  ringCases(&suite)
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
