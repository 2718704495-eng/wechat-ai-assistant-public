import Foundation
import ImageIO
import Vision

struct OCRBounds: Codable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct OCRLine: Codable, Equatable {
    let text: String
    let confidence: Double
    let bounds: OCRBounds
    let alternatives: [String]?

    init(text: String, confidence: Double, bounds: OCRBounds, alternatives: [String]? = nil) {
        self.text = text
        self.confidence = confidence
        self.bounds = bounds
        self.alternatives = alternatives
    }
}

enum VisionOCR {
    static func recognize(fileURL: URL) throws -> [OCRLine] {
        guard
            let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw BridgeError("IMAGE_NOT_READABLE")
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])

        let lines = (request.results ?? []).compactMap { observation -> OCRLine? in
            let candidates = observation.topCandidates(5)
            guard let candidate = candidates.first else {
                return nil
            }
            let box = observation.boundingBox
            return OCRLine(
                text: candidate.string,
                confidence: Double(candidate.confidence),
                bounds: OCRBounds(
                    x: box.origin.x,
                    y: box.origin.y,
                    width: box.width,
                    height: box.height
                ),
                alternatives: candidates.dropFirst().map(\.string)
            )
        }
        return sortTopToBottom(lines)
    }

    static func sortTopToBottom(_ lines: [OCRLine]) -> [OCRLine] {
        lines.sorted { left, right in
            if abs(left.bounds.y - right.bounds.y) > 0.005 {
                return left.bounds.y > right.bounds.y
            }
            return left.bounds.x < right.bounds.x
        }
    }
}
