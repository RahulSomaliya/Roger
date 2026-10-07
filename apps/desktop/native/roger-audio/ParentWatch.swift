import Foundation
import os

// What `roger-audio monitor` does when Roger goes away (M2 D7). While Roger records, the monitor
// is the one process left that can notice Roger was killed, so it starts Roger again, once, with
// `open -g -b ai.linkt.roger --args --relaunched` (RelaunchCommand), and Roger resumes the same
// meeting (CrashRecovery, M2-T23). When Roger is not recording, Roger going away is just the end
// of the monitor.
//
// After a kill -9, Roger "goes away" twice: its exit (ProcessExitWatch) and the end of the pipes
// (stdin EOF, EPIPE on stdout or stderr). The kernel closes a dying process's files before it
// reports the exit, so the EOF comes first: in every run on macOS 26.6. The end of the pipes while
// recording is therefore never a stop on its own: the monitor waits `lostPipeGrace` for the exit,
// and only a parent still alive after that counts as main closing the pipes on purpose. Exiting at
// the EOF would skip the relaunch on exactly the kill -9 it exists for
// (monitorRelaunch.mac.test.ts, "relaunches Roger once and exits when Roger is killed").
//
// The decision is made `relaunchDelay` after the exit, from the recording state at that moment:
// - Lines main wrote just before it died can still be unread when the monitor sees the exit (its
//   stdin thread late under load). A quit sends `recording off` and exits at once; deciding at the
//   exit could relaunch Roger after the user quit it.
// - LaunchServices may still list the dead Roger for a moment, and `open -b` would then only
//   "reopen" it and start nothing. Unverified; the exit check's kill -9 call checks the relaunch.
//
// Once per monitor: it relaunches at most once, then exits. "Once per meeting" is main's (D7):
// main must not send `recording on` again in a meeting it was relaunched into, or a Roger that
// crashes on every resume relaunches itself forever.

/// Where the relaunch is written down: Roger, the reader of the monitor's stdout and stderr, is
/// dead by then. Read it with
/// `/usr/bin/log show --last 1h --predicate 'subsystem == "ai.linkt.roger.audio"'`.
private let relaunchLog = Logger(subsystem: "ai.linkt.roger.audio", category: "monitor")

enum RelaunchCommand {
  /// `ai.linkt.roger` is `appId` in apps/desktop/electron-builder.yml; change the two together.
  /// `-g` starts Roger without taking the focus from the call.
  ///
  /// `--args --relaunched` puts `--relaunched` in the new Roger's argv. It is the only sign Roger
  /// has that this launch is the relaunch and not the user opening it: `open` starts Roger through
  /// LaunchServices, so nothing of the monitor (environment, parent) passes over, and the monitor
  /// writes no file. CrashRecovery (M2-T23) needs it to resume a meeting no call app holds the mic
  /// for (M2 D7: a meeting started by hand, a browser call whose mic use paused); without it that
  /// meeting is ended and one call becomes two meetings. Electron's `app.relaunch()` without
  /// `args` passes the current argv on, flag included: a Roger that restarts itself must drop it.
  static let arguments = [
    "/usr/bin/open", "-g", "-b", "ai.linkt.roger", "--args", "--relaunched",
  ]
}

/// Starts Roger again. Calls `done` once, on any thread, with whether that worked.
protocol Relauncher: AnyObject {
  func relaunch(done: @escaping (Bool) -> Void)
}

/// Runs `RelaunchCommand`.
final class OpenRelauncher: Relauncher {
  func relaunch(done: @escaping (Bool) -> Void) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: RelaunchCommand.arguments[0])
    process.arguments = Array(RelaunchCommand.arguments.dropFirst())
    // Not the monitor's own stdio: those pipes led to the dead Roger. `open` prints at most a line
    // or two on failure, so reading its stderr only after it exits cannot fill the pipe.
    let errors = Pipe()
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = errors
    process.terminationHandler = { finished in
      let said = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      let worked = finished.terminationReason == .exit && finished.terminationStatus == 0
      if worked {
        relaunchLog.notice("relaunch: open started Roger")
      } else {
        let status = finished.terminationStatus
        relaunchLog.error(
          "relaunch failed: open ended with status \(status, privacy: .public): \(said, privacy: .public)")
      }
      done(worked)
    }
    do {
      try process.run()
    } catch {
      let reason = String(describing: error)
      relaunchLog.error("relaunch failed: could not run open: \(reason, privacy: .public)")
      done(false)
    }
  }
}

/// `--relaunch-dry-run`: prints the relaunch line on stdout instead of running the command, so a
/// test can watch the decision without starting Roger.
final class DryRunRelauncher: Relauncher {
  private let writeLine: (String) throws -> Void

  init(writeLine: @escaping (String) throws -> Void) {
    self.writeLine = writeLine
  }

  func relaunch(done: @escaping (Bool) -> Void) {
    do {
      try writeLine(MonitorLine.relaunch(command: RelaunchCommand.arguments).jsonLine)
      done(true)
    } catch {
      let reason = String(describing: error)
      relaunchLog.error("relaunch dry run: could not print the line: \(reason, privacy: .public)")
      done(false)
    }
  }
}

/// The monitor's lifecycle: whether Roger is recording, and what Roger going away means. See the
/// top of this file. Control queue only.
final class ParentWatch {
  struct Timing {
    /// From the parent's exit to the decision. Drains the stdin lines main wrote before it died.
    var relaunchDelay: DispatchTimeInterval = .seconds(1)
    /// How long the end of the pipes while recording waits for the parent's exit.
    var lostPipeGrace: DispatchTimeInterval = .seconds(2)
    /// How long `open` may take before the monitor gives up on it and exits.
    var relaunchTimeout: DispatchTimeInterval = .seconds(10)
  }

  private let parent: pid_t
  private let queue: DispatchQueue
  private let relauncher: Relauncher
  private let timing: Timing
  private let exitProcess: (ExitCode) -> Void
  private var exitWatch: ProcessExitWatch?
  /// The lost-pipe grace, the relaunch delay or the relaunch timeout; one at a time.
  private var pending: DispatchWorkItem?
  private(set) var recording = false
  private var parentGone = false
  private var relaunching = false
  private var finished = false

  /// `exitProcess` ends the process with the code.
  init(
    parent: pid_t, queue: DispatchQueue, relauncher: Relauncher, timing: Timing = Timing(),
    exitProcess: @escaping (ExitCode) -> Void
  ) {
    self.parent = parent
    self.queue = queue
    self.relauncher = relauncher
    self.timing = timing
    self.exitProcess = exitProcess
  }

  /// Whether Roger is still there to report to; the monitor stops polling once it is not.
  var parentAlive: Bool { !parentGone && !finished }

  func start() {
    exitWatch = ProcessExitWatch(pid: parent, queue: queue) { [weak self] in self?.parentExited() }
  }

  /// `recording on` or `recording off` from main. Returns whether the state changed. Still taken
  /// after the parent's exit, until the relaunch decision (see the top of this file).
  @discardableResult
  func setRecording(_ on: Bool) -> Bool {
    guard !relaunching, !finished, recording != on else { return false }
    recording = on
    return true
  }

  /// stdin ended, or stdout or stderr cannot be written: nobody reads the monitor any more.
  func pipesClosed() {
    guard !parentGone, !finished, pending == nil else { return }
    guard recording else {
      finish(.ok)
      return
    }
    schedule(after: timing.lostPipeGrace) { [weak self, parent] in
      relaunchLog.notice(
        "Roger (pid \(parent, privacy: .public)) closed the monitor's pipes while recording and still runs: no relaunch")
      self?.finish(.ok)
    }
  }

  /// Ends the monitor now, never relaunching: a termination signal, or nothing left to do. Runs
  /// once; later calls do nothing.
  func finish(_ code: ExitCode) {
    guard !finished else { return }
    finished = true
    pending?.cancel()
    pending = nil
    exitWatch?.cancel()
    exitProcess(code)
  }

  private func parentExited() {
    guard !parentGone, !finished else { return }
    parentGone = true
    // A lost-pipe grace that was waiting for this exit.
    pending?.cancel()
    pending = nil
    schedule(after: timing.relaunchDelay) { [weak self] in self?.decide() }
  }

  private func decide() {
    pending = nil
    guard recording else {
      finish(.ok)
      return
    }
    relaunching = true
    let command = RelaunchCommand.arguments.joined(separator: " ")
    relaunchLog.notice(
      "Roger (pid \(self.parent, privacy: .public)) ended while recording: \(command, privacy: .public)")
    schedule(after: timing.relaunchTimeout) { [weak self] in
      relaunchLog.error("relaunch: open did not finish in time; exiting anyway")
      self?.finish(.failure)
    }
    relauncher.relaunch { [weak self, queue] worked in
      queue.async { self?.finish(worked ? .ok : .failure) }
    }
  }

  private func schedule(after delay: DispatchTimeInterval, _ body: @escaping () -> Void) {
    pending?.cancel()
    let item = DispatchWorkItem(block: body)
    pending = item
    queue.asyncAfter(deadline: .now() + delay, execute: item)
  }
}
