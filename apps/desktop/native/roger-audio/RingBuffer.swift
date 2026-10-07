import Darwin

/// A stretch of tap audio as the IO thread handed it over.
struct AudioSpan: Equatable {
  /// Mono Float32 samples in the span.
  var frameCount: Int
  var sampleRate: Double
  /// Wall-clock ms since the Unix epoch of the span's first sample.
  var captureWallMs: Double
  /// The audio right before this span is missing (dropped, or the tap was rebuilt), so the writer
  /// must not join the two: it closes the frame in progress and starts a fresh converter.
  var discontinuity: Bool
}

/// The bounded buffer between Core Audio's IO thread (the one producer) and the writer thread (the
/// one consumer). It holds at most `maxDurationSeconds` of audio at the rate being written, plus
/// each write's capture time.
///
/// It never makes the IO thread wait for the writer. When the writer falls behind (main stopped
/// reading stdout and the pipe filled, or the writer is stuck), a write that does not fit is
/// dropped whole, its length is added to `takeDroppedMs()` (the `dropped` field of `stats`), and
/// the next write that fits is flagged as a discontinuity. Writing stdout from the IO block instead
/// (openwhispr `macos-audio-tap.swift`) blocks the audio thread as soon as main stops reading.
///
/// WHY a lock and not atomics: `Synchronization.Atomic` needs macOS 15 and the helper targets 14.2,
/// and swift-atomics needs SwiftPM, which the build does not use. The os_unfair_lock guards only the
/// indices and counters, never a copy or a syscall, and it lends the waiter's priority to its
/// owner, so the real-time thread waits a few instructions at most. Do not take it around a copy.
final class AudioRing: @unchecked Sendable {
  /// Storage is sized for this rate, so `maxDurationSeconds` holds at any tap rate up to it.
  static let maxSampleRate = 192_000.0

  let maxDurationSeconds: Double
  /// Longer writes are split into spans of at most this many frames; `read(into:)` needs room
  /// for one span.
  let maxSpanFrames: Int

  private struct Slot {
    var sampleStart: Int
    var span: AudioSpan
  }

  private let samples: UnsafeMutablePointer<Float>
  private let sampleCapacity: Int
  private let slots: UnsafeMutablePointer<Slot>
  private let slotCapacity: Int
  private let lock: UnsafeMutablePointer<os_unfair_lock>

  // Guarded by `lock`. Totals since the start; they never wrap (an Int64 of samples is millennia).
  private var samplesWritten = 0
  private var samplesRead = 0
  private var spansWritten = 0
  private var spansRead = 0
  private var droppedMs = 0.0
  private var discontinuityPending = true

  init(maxDurationSeconds: Double = 2, maxSpanFrames: Int = 16_384, spanCapacity: Int = 4_096) {
    self.maxDurationSeconds = maxDurationSeconds
    self.maxSpanFrames = maxSpanFrames
    sampleCapacity = Int((maxDurationSeconds * Self.maxSampleRate).rounded(.up))
    slotCapacity = spanCapacity
    samples = .allocate(capacity: sampleCapacity)
    samples.initialize(repeating: 0, count: sampleCapacity)
    let empty = AudioSpan(frameCount: 0, sampleRate: 0, captureWallMs: 0, discontinuity: false)
    slots = .allocate(capacity: slotCapacity)
    slots.initialize(repeating: Slot(sampleStart: 0, span: empty), count: slotCapacity)
    lock = .allocate(capacity: 1)
    lock.initialize(to: os_unfair_lock())
  }

  deinit {
    samples.deallocate()
    slots.deallocate()
    lock.deallocate()
  }

  /// Producer only (the IO thread). Never allocates and never waits beyond the index lock.
  /// Returns false when the audio was dropped because the ring is full.
  @discardableResult
  func write(_ source: UnsafeBufferPointer<Float>, sampleRate: Double, captureWallMs: Double) -> Bool
  {
    guard let base = source.baseAddress, source.count > 0, sampleRate > 0 else { return true }
    let count = source.count
    let spanCount = (count + maxSpanFrames - 1) / maxSpanFrames
    let limit = min(sampleCapacity, Int(maxDurationSeconds * sampleRate))

    os_unfair_lock_lock(lock)
    let fits =
      samplesWritten - samplesRead + count <= limit
      && spansWritten - spansRead + spanCount <= slotCapacity
    guard fits else {
      droppedMs += Double(count) / sampleRate * 1_000
      discontinuityPending = true
      os_unfair_lock_unlock(lock)
      return false
    }
    var discontinuity = discontinuityPending
    discontinuityPending = false
    let sampleStart = samplesWritten
    let spanStart = spansWritten
    os_unfair_lock_unlock(lock)

    // The free space past the write index belongs to this thread until it is published below, so
    // the copy runs without the lock.
    copyIn(base, count: count, at: sampleStart)
    var offset = 0
    for index in 0..<spanCount {
      let length = min(maxSpanFrames, count - offset)
      slots[(spanStart + index) % slotCapacity] = Slot(
        sampleStart: sampleStart + offset,
        span: AudioSpan(
          frameCount: length, sampleRate: sampleRate,
          captureWallMs: captureWallMs + Double(offset) / sampleRate * 1_000,
          discontinuity: discontinuity))
      discontinuity = false
      offset += length
    }

    os_unfair_lock_lock(lock)
    samplesWritten = sampleStart + count
    spansWritten = spanStart + spanCount
    os_unfair_lock_unlock(lock)
    return true
  }

  /// Flags the next write as a discontinuity. Called between tearing a tap down and building the
  /// next one, while no IO block runs.
  func markDiscontinuity() {
    os_unfair_lock_lock(lock)
    discontinuityPending = true
    os_unfair_lock_unlock(lock)
  }

  /// Consumer only (the writer thread). Copies the oldest span into `destination`, which must hold
  /// `maxSpanFrames`, and frees its space; nil when the ring is empty.
  func read(into destination: UnsafeMutableBufferPointer<Float>) -> AudioSpan? {
    precondition(destination.count >= maxSpanFrames, "read(into:) needs room for one span")
    os_unfair_lock_lock(lock)
    guard spansRead < spansWritten else {
      os_unfair_lock_unlock(lock)
      return nil
    }
    let slot = slots[spansRead % slotCapacity]
    os_unfair_lock_unlock(lock)

    // The producer does not touch published space until the read index moves past it below.
    if let target = destination.baseAddress {
      copyOut(into: target, count: slot.span.frameCount, from: slot.sampleStart)
    }

    os_unfair_lock_lock(lock)
    samplesRead = slot.sampleStart + slot.span.frameCount
    spansRead += 1
    os_unfair_lock_unlock(lock)
    return slot.span
  }

  /// The ms of audio dropped since the last call.
  func takeDroppedMs() -> Double {
    os_unfair_lock_lock(lock)
    defer { os_unfair_lock_unlock(lock) }
    let dropped = droppedMs
    droppedMs = 0
    return dropped
  }

  private func copyIn(_ source: UnsafePointer<Float>, count: Int, at start: Int) {
    let index = start % sampleCapacity
    let first = min(count, sampleCapacity - index)
    (samples + index).update(from: source, count: first)
    if first < count { samples.update(from: source + first, count: count - first) }
  }

  private func copyOut(into target: UnsafeMutablePointer<Float>, count: Int, from start: Int) {
    let index = start % sampleCapacity
    let first = min(count, sampleCapacity - index)
    target.update(from: samples + index, count: first)
    if first < count { (target + first).update(from: samples, count: count - first) }
  }
}
