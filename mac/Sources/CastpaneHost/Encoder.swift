import Foundation
import VideoToolbox
import CoreMedia

// H.264 or HEVC on the hardware encoder, tuned for remote control: real time, no
// B-frames (a frame never waits for a later one), a key frame at least every few
// seconds, and a data-rate cap so a busy screen cannot flood the link. HEVC only when
// the page says its browser decodes it: the same bits then give a sharper picture;
// H.264 otherwise, which every browser's WebCodecs decodes in hardware.
///
/// Frames come in on the capture queue, key-frame requests from the session, the end
/// from the session too: `session` and `forceKey` are behind a lock. Encoded output
/// arrives on VideoToolbox's own thread, one frame after the other.
final class ScreenEncoder: @unchecked Sendable {
    struct Settings: Equatable { var width: Int; var height: Int; var fps: Int; var bitrate: Int; var hevc = false }
    typealias Output = @Sendable (Data, Bool, UInt64, String?) -> Void

    private let lock = NSLock()
    private var session: VTCompressionSession?
    let settings: Settings
    private var forceKey = true
    /// Touched only by `emit`, which VideoToolbox calls one frame at a time.
    private var lastCodec = ""
    /// (Annex B bytes, is key frame, timestamp µs, codec string when it changed)
    private let output: Output

    init(_ settings: Settings, output: @escaping Output) throws {
        self.settings = settings
        self.output = output
        var made: VTCompressionSession?
        let spec = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue] as CFDictionary
        let status = VTCompressionSessionCreate(allocator: nil, width: Int32(settings.width), height: Int32(settings.height),
                                                codecType: settings.hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264,
                                                encoderSpecification: spec,
                                                imageBufferAttributes: nil, compressedDataAllocator: nil,
                                                outputCallback: nil, refcon: nil, compressionSessionOut: &made)
        guard status == noErr, let s = made else { throw NSError(domain: "Castpane.Encoder", code: Int(status)) }
        session = s
        func set(_ key: CFString, _ value: CFTypeRef) { VTSessionSetProperty(s, key: key, value: value) }
        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
        set(kVTCompressionPropertyKey_ProfileLevel, settings.hevc ? kVTProfileLevel_HEVC_Main_AutoLevel : kVTProfileLevel_H264_High_AutoLevel)
        set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, (settings.fps * 4) as CFNumber)
        set(kVTCompressionPropertyKey_ExpectedFrameRate, settings.fps as CFNumber)
        set(kVTCompressionPropertyKey_AverageBitRate, settings.bitrate as CFNumber)
        set(kVTCompressionPropertyKey_DataRateLimits, [settings.bitrate / 8 * 3 / 2, 1] as CFArray)
        set(kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, kCFBooleanTrue)
        VTCompressionSessionPrepareToEncodeFrames(s)
    }

    func requestKeyFrame() { lock.withLock { forceKey = true } }

    func encode(_ pixels: CVPixelBuffer, at time: CMTime) {
        let (current, key) = lock.withLock { () -> (VTCompressionSession?, Bool) in
            defer { if self.session != nil { forceKey = false } }
            return (self.session, forceKey)
        }
        guard let session = current else { return }
        let props: CFDictionary? = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary : nil
        VTCompressionSessionEncodeFrame(session, imageBuffer: pixels, presentationTimeStamp: time, duration: .invalid,
                                        frameProperties: props, infoFlagsOut: nil) { [weak self] status, _, sample in
            guard status == noErr, let sample, let self else { return }
            self.emit(sample)
        }
    }

    func invalidate() {
        let s = lock.withLock { () -> VTCompressionSession? in defer { session = nil }; return session }
        if let s { VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid); VTCompressionSessionInvalidate(s) }
    }

    private static let startCode: [UInt8] = [0, 0, 0, 1]

    /// The format's parameter sets in order (H.264: SPS, PPS; HEVC: VPS, SPS, PPS).
    private static func parameterSets(_ format: CMFormatDescription, hevc: Bool) -> [[UInt8]] {
        var count = 0
        if hevc { CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil) }
        else { CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil) }
        return (0..<count).compactMap { i in
            var pointer: UnsafePointer<UInt8>?
            var size = 0
            if hevc { CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(format, parameterSetIndex: i, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) }
            else { CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) }
            guard let pointer, size > 0 else { return nil }
            return Array(UnsafeBufferPointer(start: pointer, count: size))
        }
    }

    /// WebCodecs' name for an H.264 stream: avc1 and the SPS's profile, flags and level.
    static func avcCodec(sps: [UInt8]) -> String? {
        sps.count >= 4 ? String(format: "avc1.%02x%02x%02x", sps[1], sps[2], sps[3]) : nil
    }

    /// WebCodecs' name for an HEVC stream (ISO/IEC 14496-15 annex E), from the SPS's
    /// profile_tier_level: hvc1.<space><profile>.<compatibility, bits reversed>.<tier><level>
    /// and the constraint bytes up to the last that is not zero, e.g. hvc1.1.6.L153.B0.
    static func hevcCodec(sps raw: [UInt8]) -> String? {
        // Without the emulation-prevention bytes (00 00 03 is 00 00 in the stream's data).
        var b: [UInt8] = []
        var zeros = 0
        for x in raw {
            if zeros >= 2 && x == 3 { zeros = 0; continue }
            b.append(x)
            zeros = x == 0 ? zeros + 1 : 0
        }
        // Two bytes of NAL header, one of ids and sub-layers, then profile_tier_level.
        guard b.count >= 15 else { return nil }
        let p = b[3]
        let space = ["", "A", "B", "C"][Int(p >> 6)], tier = p & 0x20 != 0 ? "H" : "L", profile = p & 0x1f
        let flags = b[4..<8].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        var reversed: UInt32 = 0
        for i in 0..<32 where flags & (1 << i) != 0 { reversed |= 1 << (31 - i) }
        var constraints = Array(b[8..<14])
        while constraints.last == 0 { constraints.removeLast() }
        return "hvc1.\(space)\(profile).\(String(reversed, radix: 16, uppercase: true)).\(tier)\(b[14])" + constraints.map { String(format: ".%02X", $0) }.joined()
    }

    private func emit(_ sample: CMSampleBuffer) {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let key = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        var out = Data()
        var codec: String?
        if key, let format = CMSampleBufferGetFormatDescription(sample) {
            let sets = Self.parameterSets(format, hevc: settings.hevc)
            for set in sets {
                out.append(contentsOf: Self.startCode)
                out.append(contentsOf: set)
            }
            // The SPS names the profile and level the page decodes with.
            let sps = sets.first { settings.hevc ? ($0.first ?? 0) >> 1 & 0x3f == 33 : ($0.first ?? 0) & 0x1f == 7 }
            if let sps, let c = settings.hevc ? Self.hevcCodec(sps: sps) : Self.avcCodec(sps: sps), c != lastCodec { lastCodec = c; codec = c }
        }
        // AVCC (4-byte lengths) to Annex B (start codes).
        var length = 0
        var pointer: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
              let pointer else { return }
        var offset = 0
        while offset + 4 <= length {
            var nal: UInt32 = 0
            memcpy(&nal, pointer + offset, 4)
            let n = Int(CFSwapInt32BigToHost(nal))
            offset += 4
            guard n > 0, offset + n <= length else { break }
            out.append(contentsOf: Self.startCode)
            pointer.advanced(by: offset).withMemoryRebound(to: UInt8.self, capacity: n) { out.append($0, count: n) }
            offset += n
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let micros = pts.isValid ? UInt64(max(0, CMTimeGetSeconds(pts)) * 1_000_000) : 0
        output(out, key, micros, codec)
    }
}
