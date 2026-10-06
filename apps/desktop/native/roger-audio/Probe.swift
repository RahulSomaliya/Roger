import Foundation

// Stub from M2-T7; owned by M2-T7b, which replaces this body. main.swift already dispatches
// `roger-audio probe` here, so M2-T7b never edits main.swift.
//
// `roger-audio probe --seconds 2` listens to system audio through the tap while Roger plays a short
// system sound and prints the peak it heard: heard means System Audio Recording is granted (no
// public API reads that permission). Contract: "Helper protocol" and the "Permission check for
// system audio" row in docs/plans/M2-capture-you-can-trust.md.
func runProbe(arguments: [String]) -> Int32 {
  StderrEventSink().emit(
    .error(code: "not_built", message: "roger-audio probe is not built yet (M2-T7b)", status: nil))
  return ExitCode.unavailable.rawValue
}
