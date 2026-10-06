import Foundation

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
