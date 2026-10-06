import Foundation

// How the helper learns it must stop. It must never outlive Roger: a tap or a private aggregate
// device left running records call audio nobody asked for. So `tap` exits on any of
// - the end of stdin: main closes it on Stop, and the kernel closes it when Roger dies, even of
//   kill -9 (LineReader);
// - the death of its parent, for the case where stdin stays open because another process
//   inherited it (ProcessExitWatch);
// - SIGTERM, SIGINT or SIGHUP: HelperProcess closes stdin, then sends SIGTERM, then SIGKILL after
//   5 s (TerminationSignals);
// - a closed stdout or stderr (EPIPE): nobody is listening any more (FrameWriter, StderrEventSink).
// Each path tears the tap down first (TapSession.shutdown).

/// A value shared between threads, behind a lock. Not for the IO thread: NSLock can block for
/// as long as its holder runs, so the IO thread only ever touches AudioRing.
final class Locked<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Value

  init(_ value: Value) { stored = value }

  var value: Value {
    lock.lock()
    defer { lock.unlock() }
    return stored
  }

  @discardableResult
  func withValue<Result>(_ body: (inout Value) throws -> Result) rethrows -> Result {
    lock.lock()
    defer { lock.unlock() }
    return try body(&stored)
  }
}

/// Splits a byte stream into lines: `\n` ends a line and a trailing `\r` is dropped. A line longer
/// than `maxLineBytes` is cut there and the rest of it, up to the next newline, is dropped, so a
/// writer that never sends a newline cannot grow memory without bound.
struct LineSplitter {
  static let maxLineBytes = 4_096
  private var pending: [UInt8] = []
  private var discarding = false

  mutating func append(_ bytes: UnsafeRawBufferPointer) -> [String] {
    var lines: [String] = []
    for byte in bytes {
      if byte == UInt8(ascii: "\n") {
        if !discarding { lines.append(Self.decode(pending)) }
        pending.removeAll(keepingCapacity: true)
        discarding = false
      } else if !discarding {
        pending.append(byte)
        if pending.count == Self.maxLineBytes {
          lines.append(Self.decode(pending))
          pending.removeAll(keepingCapacity: true)
          discarding = true
        }
      }
    }
    return lines
  }

  /// The last line when the input ended without a newline.
  mutating func finish() -> String? {
    defer {
      pending.removeAll()
      discarding = false
    }
    return pending.isEmpty || discarding ? nil : Self.decode(pending)
  }

  private static func decode(_ bytes: [UInt8]) -> String {
    let line = bytes.last == UInt8(ascii: "\r") ? bytes.dropLast() : bytes[...]
    return String(decoding: line, as: UTF8.self)
  }
}

/// How a LineReader's input ended.
enum InputEnd: Equatable {
  case endOfFile
  case failed(errno: Int32)
}

/// Reads newline-separated commands from a file descriptor on its own thread and hands each line,
/// then the end of the input, to `queue`, in order. For `tap` the descriptor is stdin: how main
/// steers the helper (`rebuild`), and, by its end, the main way the helper learns to stop.
final class LineReader: @unchecked Sendable {
  private let fd: Int32
  private let queue: DispatchQueue
  private let onLine: (String) -> Void
  private let onEnd: (InputEnd) -> Void

  init(
    fd: Int32, queue: DispatchQueue, onLine: @escaping (String) -> Void,
    onEnd: @escaping (InputEnd) -> Void
  ) {
    self.fd = fd
    self.queue = queue
    self.onLine = onLine
    self.onEnd = onEnd
  }

  func start() {
    let thread = Thread { [fd, queue, onLine, onEnd] in
      var splitter = LineSplitter()
      var buffer = [UInt8](repeating: 0, count: 4_096)
      while true {
        let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
        if count > 0 {
          let lines = buffer.withUnsafeBytes {
            splitter.append(UnsafeRawBufferPointer(rebasing: $0[0..<count]))
          }
          for line in lines { queue.async { onLine(line) } }
        } else if count == 0 {
          if let last = splitter.finish() { queue.async { onLine(last) } }
          queue.async { onEnd(.endOfFile) }
          return
        } else if errno != EINTR {
          let code = errno
          queue.async { onEnd(.failed(errno: code)) }
          return
        }
      }
    }
    thread.name = "roger-audio stdin"
    thread.start()
  }
}

/// Calls `onExit` once, on `queue`, when process `pid` exits; for `tap`, its parent, Roger.
///
/// A process that already exited before the watch was armed (a parent that died while the helper
/// started is a zombie or reaped by then) fires at once too: libdispatch delivers the exit for
/// both, so no separate "is it still running" check is needed. Checked on macOS 26.6; the
/// selftest's parent watch case keeps it checked on every `make check`.
final class ProcessExitWatch {
  private let source: DispatchSourceProcess

  init(pid: pid_t, queue: DispatchQueue, onExit: @escaping () -> Void) {
    let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: queue)
    source.setEventHandler { [weak source] in
      source?.cancel()
      onExit()
    }
    source.resume()
    self.source = source
  }

  func cancel() { source.cancel() }
}

/// Turns SIGTERM, SIGINT and SIGHUP into a call on `queue`, so the helper tears the tap down
/// before it exits instead of dying with it running.
final class TerminationSignals {
  static let handled: [Int32] = [SIGTERM, SIGINT, SIGHUP]
  private var sources: [DispatchSourceSignal] = []

  init(queue: DispatchQueue, handler: @escaping (Int32) -> Void) {
    for number in Self.handled {
      // The default action would end the process before the dispatch source saw the signal.
      signal(number, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
      source.setEventHandler { handler(number) }
      source.resume()
      sources.append(source)
    }
  }

  /// Stops handling and restores each signal's default action.
  func cancel() {
    for source in sources { source.cancel() }
    sources.removeAll()
    for number in Self.handled { signal(number, SIG_DFL) }
  }
}
