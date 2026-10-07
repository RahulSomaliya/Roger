import CoreAudio
import Foundation

// The Mac's default input and output devices, for `roger-audio monitor` (Monitor.swift): which mic
// Roger hears and where call audio plays. Main turns the echo filter off only on known headphones
// (M2 D2) and gives a Bluetooth mic a longer dead-signal wait (D4), so the transport is the point.
//
// Property reads only: nothing here starts IO on a device, so it needs no permission and never
// raises a privacy prompt. `make check` runs the monitor; keep it that way.

/// How the default device is connected, as `route` reports it.
enum MonitorTransport: String, Equatable {
  /// AirPods and other Bluetooth or Bluetooth LE devices.
  case bluetooth
  /// The Mac's own speakers: built in, data source 'ispk'.
  case builtInSpeaker = "built_in_speaker"
  /// Headphones in the Mac's own jack: built in, data source 'hdpn'.
  case builtInHeadphones = "built_in_headphones"
  /// Built in and neither of those: the built-in mic, or a data source this code does not know.
  case builtIn = "built_in"
  case usb
  /// Everything else: HDMI, DisplayPort, AirPlay, Thunderbolt, Continuity, virtual and aggregate
  /// devices (a "Multi-Output Device" made in Audio MIDI Setup is one).
  case other

  /// 'ispk' and 'hdpn', the data sources of a built-in output (AudioHardwareBase.h names none).
  /// Apple silicon Macs show the speakers and the headphone jack as two devices, each with its own
  /// data source; Intel Macs show one device whose data source flips when headphones go in.
  static let internalSpeakerSource: UInt32 = 0x6973_706B
  static let headphonesSource: UInt32 = 0x6864_706E

  init(transportType: UInt32, dataSource: UInt32?) {
    switch transportType {
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE:
      self = .bluetooth
    case kAudioDeviceTransportTypeUSB:
      self = .usb
    case kAudioDeviceTransportTypeBuiltIn:
      switch dataSource {
      case Self.internalSpeakerSource: self = .builtInSpeaker
      case Self.headphonesSource: self = .builtInHeadphones
      default: self = .builtIn
      }
    default:
      self = .other
    }
  }
}

/// One default device.
struct RouteDevice: Equatable {
  /// For people: "MacBook Pro Speakers", "AirPods Pro".
  let name: String
  let transport: MonitorTransport

  var json: MonitorJSON {
    .object([("name", .string(name)), ("transport", .string(transport.rawValue))])
  }
}

/// The default output and input; nil where the Mac has none (a Mac mini with nothing plugged in
/// has no input).
struct MonitorRoute: Equatable {
  let output: RouteDevice?
  let input: RouteDevice?
}

/// Reads the default devices from Core Audio.
enum RouteReader {
  /// Throws a `route_failed` HelperFailure when a device cannot be read, for example one that
  /// vanished mid-read while AirPods connect; the monitor warns and reads again on its next poll.
  static func read() throws -> MonitorRoute {
    MonitorRoute(
      output: try defaultDevice(
        kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeOutput),
      input: try defaultDevice(
        kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeInput))
  }

  private static func defaultDevice(
    _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope
  ) throws -> RouteDevice? {
    let side = scope == kAudioObjectPropertyScopeOutput ? "output" : "input"
    var deviceAddress = globalAddress(selector)
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    try check(
      AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &deviceAddress, 0, nil, &size, &device),
      "could not read the default \(side) device")
    guard device != AudioObjectID(kAudioObjectUnknown) else { return nil }

    var nameAddress = globalAddress(kAudioObjectPropertyName)
    var name: Unmanaged<CFString>?
    var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    try check(
      AudioObjectGetPropertyData(device, &nameAddress, 0, nil, &nameSize, &name),
      "could not read the name of the default \(side) device")
    // The caller owns the returned string (AudioHardwareBase.h, kAudioObjectPropertyName).
    guard let deviceName = name?.takeRetainedValue() as String? else {
      throw HelperFailure(code: "route_failed", message: "the default \(side) device has no name")
    }
    var transportAddress = globalAddress(kAudioDevicePropertyTransportType)
    var transport: UInt32 = 0
    var transportSize = UInt32(MemoryLayout<UInt32>.size)
    try check(
      AudioObjectGetPropertyData(device, &transportAddress, 0, nil, &transportSize, &transport),
      "could not read how the default \(side) device is connected")
    return RouteDevice(
      name: deviceName,
      transport: MonitorTransport(
        transportType: transport, dataSource: dataSource(of: device, scope)))
  }

  /// A device's current data source in `scope`, or nil when it has none. A failed read is nil too:
  /// an unknown data source makes a built-in device plain `built_in`, which is not known
  /// headphones, so the echo filter stays on (`OutputRoute` in src/shared/capture.ts). That is the
  /// safe side of the guess.
  private static func dataSource(
    of device: AudioObjectID, _ scope: AudioObjectPropertyScope
  ) -> UInt32? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyDataSource, mScope: scope,
      mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectHasProperty(device, &address) else { return nil }
    var source: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &source) == noErr else {
      return nil
    }
    return source
  }

  private static func check(_ status: OSStatus, _ what: String) throws {
    guard status != noErr else { return }
    throw HelperFailure(
      code: "route_failed",
      message: "\(what) (OSStatus \(status) \(fourCharCode(UInt32(bitPattern: status))))",
      status: status)
  }

  private static func globalAddress(
    _ selector: AudioObjectPropertySelector
  ) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
      mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
  }
}
