import AVFoundation
import Foundation
import Speech

/// On-device speech recognition: what you say, as text, without a connection. Words are sent
/// to the page as they're heard; a second and a half of quiet ends it.
@MainActor
final class Listener {
    private let send: ([String: Any]) -> Void
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var quiet: Timer?
    private var text = ""

    init(send: @escaping ([String: Any]) -> Void) { self.send = send }

    static var availability: String {
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else { return "unavailable" }
        return recognizer.supportsOnDeviceRecognition ? "on-device" : "needs-network"
    }

    func start() async throws {
        stop()
        guard await Self.authorize() else { throw ListenerError.notAllowed }
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable else { throw ListenerError.unavailable }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .duckOthers])
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // Stay on the phone: no audio goes to Apple's servers, and it works in airplane mode.
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        request.addsPunctuation = true
        self.request = request
        text = ""

        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        try engine.start()

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.text = result.bestTranscription.formattedString
                    self.send(["text": self.text, "final": result.isFinal])
                    self.restartQuietTimer()
                    if result.isFinal { self.finish() }
                } else if error != nil {
                    if self.text.isEmpty { self.send(["error": "Didn't catch that"]) } else { self.send(["text": self.text, "final": true]) }
                    self.finish()
                }
            }
        }
        restartQuietTimer()
    }

    func stop() {
        guard request != nil else { return }
        request?.endAudio()
    }

    private func restartQuietTimer() {
        quiet?.invalidate()
        quiet = Timer.scheduledTimer(withTimeInterval: text.isEmpty ? 5 : 1.5, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.request?.endAudio() }
        }
    }

    private func finish() {
        quiet?.invalidate()
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        task = nil
        request = nil
        // Back to playback, so the spoken answer comes out of the speaker at full volume.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
    }

    private static func authorize() async -> Bool {
        let speech = await withCheckedContinuation { done in
            SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0 == .authorized) }
        }
        let microphone = await AVAudioApplication.requestRecordPermission()
        return speech && microphone
    }
}

enum ListenerError: LocalizedError {
    case notAllowed, unavailable
    var errorDescription: String? {
        switch self {
        case .notAllowed: "Allow the microphone and speech recognition for Brainy in Settings"
        case .unavailable: "Speech recognition isn't available right now"
        }
    }
}
