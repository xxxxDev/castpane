import Foundation

/// A child's output, cut into lines. One per launch: what one run left without a newline
/// never runs into the next run's first line.
public struct LineSplitter: Sendable {
    private var buffer = Data()
    /// A line longer than this is dropped rather than held without end.
    public let limit: Int

    public init(limit: Int = 65536) { self.limit = limit }

    /// The complete lines in `data` (with what came before it), empty ones left out.
    public mutating func append(_ data: Data) -> [String] {
        buffer.append(data)
        var lines: [String] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<nl]
            if !line.isEmpty { lines.append(String(decoding: line, as: UTF8.self)) }
            buffer.removeSubrange(buffer.startIndex...nl)
        }
        if buffer.count > limit { buffer.removeAll() }
        return lines
    }

    /// At the end of the output: whatever is left without a newline is the last line.
    public mutating func finish() -> String? {
        defer { buffer.removeAll() }
        return buffer.isEmpty ? nil : String(decoding: buffer, as: UTF8.self)
    }
}
