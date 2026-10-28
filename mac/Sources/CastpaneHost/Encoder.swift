import Foundation
import VideoToolbox
import CoreMedia

// H.264 on the hardware encoder, tuned for remote control: real time, no
// B-frames (a frame never waits for a later one), a key frame at least every few
// seconds, and a data-rate cap so a busy screen cannot flood the link. H.264 rather
// than HEVC because every browser's WebCodecs decodes it in hardware.
///
/// Frames come in on the capture queue, key-frame requests from the session, the end
/// from the session too: `session` and `forceKey` are behind a lock. Encoded output
/// arrives on VideoToolbox's own thread, one frame after the other.
final class H264Encoder: @unchecked Sendable {
    struct Settings: Equatable { var width: Int; var height: Int; var fps: Int; var bitrate: Int }
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
                                                codecType: kCMVideoCodecType_H264, encoderSpecification: spec,
                                                imageBufferAttributes: nil, compressedDataAllocator: nil,
                                                outputCallback: nil, refcon: nil, compressionSessionOut: &made)
        guard status == noErr, let s = made else { throw NSError(domain: "Castpane.Encoder", code: Int(status)) }
        session = s
        func set(_ key: CFString, _ value: CFTypeRef) { VTSessionSetProperty(s, key: key, value: value) }
        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
        set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel)
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

    private func emit(_ sample: CMSampleBuffer) {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let key = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        var out = Data()
        var codec: String?
        if key, let format = CMSampleBufferGetFormatDescription(sample) {
            var count = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                               parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
            for i in 0..<count {
                var pointer: UnsafePointer<UInt8>?
                var size = 0
                CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i, parameterSetPointerOut: &pointer,
                                                                   parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
                guard let pointer else { continue }
                out.append(contentsOf: Self.startCode)
                out.append(pointer, count: size)
                // The SPS (the first set) names the profile and level the page decodes with.
                if i == 0 && size >= 4 {
                    let c = String(format: "avc1.%02x%02x%02x", pointer[1], pointer[2], pointer[3])
                    if c != lastCodec { lastCodec = c; codec = c }
                }
            }
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
