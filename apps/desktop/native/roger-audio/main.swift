import Foundation

// roger-audio: Roger's audio helper. Roger's main process spawns it (HelperProcess, M2-T10); the
// wire contract is in Protocol.swift.
//
// Every subcommand is dispatched here, so the tasks that fill one in (M2-T7b: `probe` and
// `selftest --route-switch`; M2-T8: `monitor`) replace a function body in their own file and never
// edit this one.
enum RogerAudio {
  static let usage = """
    usage: roger-audio <command> [options]

      tap [--sample-rate 16000] [--chunk-ms 100]
          Call audio from a Core Audio process tap: framed PCM on stdout, JSON events on stderr.
          stdin: "rebuild" rebuilds the tap; end of input exits. Exits when its parent does.
      monitor --parent-pid <pid> [--relaunch-dry-run]
          Which apps use the mic and which output is in use, as JSON lines on stdout.
      probe [--seconds 2]
          Listens to system audio and prints the peak it heard.
      selftest [--route-switch]
          The helper's own tests; no audio permission needed. --route-switch is opt-in and
          audible: it switches the default output device while a tone plays.
    """

  static func run(_ arguments: [String]) -> Int32 {
    let rest = Array(arguments.dropFirst())
    switch arguments.first {
    case "tap": return runTap(arguments: rest)
    case "monitor": return runMonitor(arguments: rest)
    case "probe": return runProbe(arguments: rest)
    case "selftest": return runSelfTest(arguments: rest)
    case "help", "--help", "-h":
      print(usage)
      return ExitCode.ok.rawValue
    default:
      printError(usage)
      return ExitCode.usage.rawValue
    }
  }
}

exit(RogerAudio.run(Array(CommandLine.arguments.dropFirst())))
