import Foundation
import FoundationModels

/// What you said, as the parameters Brainy picks by. Apple's on-device model fills it in
/// directly ("guided generation"): it can only answer in this shape.
@Generable
struct ParsedIntent {
    @Guide(description: "Minutes they have to read or listen, or 0 if they didn't say or imply it. A commute is about 20.")
    var minutes: Int
    @Guide(description: "Their energy right now: low, medium, high, or unknown")
    var energy: String
    @Guide(description: "One to three words for how they feel, such as tired, socially drained, curious, stressed")
    var moods: [String]
    @Guide(description: "Where they are: commute, home, bed, work, break, travel, or unknown")
    var setting: String
    @Guide(description: "Two to four vibes that would suit them now, only from: light, deep, calming, energising, inspiring, funny, practical, visual, analytical, narrative, creative, technical, reflective")
    var vibes: [String]
    @Guide(description: "Subjects they asked for, using the known topics given where one fits")
    var topics: [String]
    @Guide(description: "Subjects they said they don't want")
    var avoid: [String]
    @Guide(description: "True if they can listen to audio; false if they said they have no headphones or can't listen")
    var canListen: Bool
}

/// Apple's on-device language model (Apple Intelligence), which runs on the iPhone's
/// Neural Engine with no connection and nothing to download from us.
@MainActor
final class OnDeviceModel {
    var availability: String {
        switch SystemLanguageModel.default.availability {
        case .available: return "available"
        case .unavailable(.deviceNotEligible): return "unavailable: this device can't run Apple Intelligence"
        case .unavailable(.appleIntelligenceNotEnabled): return "unavailable: turn on Apple Intelligence in Settings"
        case .unavailable(.modelNotReady): return "unavailable: the model is still downloading"
        case .unavailable(let other): return "unavailable: \(other)"
        }
    }

    private static let instructions = """
    You turn what a person says about their moment into parameters for picking something to read.
    Infer what would suit them: tired or socially drained suggests light, calming; curious or energised suggests deep.
    Never invent topics they didn't mention.
    """

    func intent(for text: String, topics: [String]) async throws -> [String: Any] {
        let session = LanguageModelSession(instructions: Self.instructions)
        let prompt = "Known topics: \(topics.prefix(60).joined(separator: ", "))\n\nThey said: \(text)"
        let parsed = try await session.respond(to: prompt, generating: ParsedIntent.self).content
        let unknown: (String) -> Any = { $0.isEmpty || $0.lowercased() == "unknown" ? NSNull() : $0.lowercased() }
        return [
            "minutes": parsed.minutes > 0 ? parsed.minutes : NSNull(),
            "energy": unknown(parsed.energy),
            "moods": parsed.moods,
            "setting": unknown(parsed.setting),
            "vibes": parsed.vibes,
            "topics": parsed.topics,
            "avoid": parsed.avoid,
            "audioOk": parsed.canListen,
        ]
    }

    func say(system: String, prompt: String) async throws -> String {
        let session = LanguageModelSession(instructions: system)
        return try await session.respond(to: prompt).content
    }
}
