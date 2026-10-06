import Foundation

// Stub from M2-T7; owned by M2-T8, which replaces this body. main.swift already dispatches
// `roger-audio monitor` here, so M2-T8 never edits main.swift.
//
// `roger-audio monitor --parent-pid <pid> [--relaunch-dry-run]` writes JSON lines on stdout
// (`mic_users`, `route`) when they change, takes stdin `recording on` and `recording off`, and when
// its parent dies while recording runs `open -g -b ai.linkt.roger` once. Contract: "Helper
// protocol" in docs/plans/M2-capture-you-can-trust.md.
func runMonitor(arguments: [String]) -> Int32 {
  StderrEventSink().emit(
    .error(code: "not_built", message: "roger-audio monitor is not built yet (M2-T8)", status: nil))
  return ExitCode.unavailable.rawValue
}
