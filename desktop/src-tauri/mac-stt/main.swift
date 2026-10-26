// blackhole-stt: macOS speech recognition for one WAV file (Korean, on-device when available).
// Usage: blackhole-stt <file.wav>  → prints the transcript; exit 2 with a message on failure.
// The app runs it as a child process, so macOS asks once for 「음성 인식」 permission for 블랙홀.
import Foundation
import Speech

func fail(_ message: String, _ code: Int32 = 2) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

guard CommandLine.arguments.count == 2 else { fail("usage: blackhole-stt <file.wav>", 64) }
let url = URL(fileURLWithPath: CommandLine.arguments[1])

let auth = DispatchSemaphore(value: 0)
var status = SFSpeechRecognizer.authorizationStatus()
if status == .notDetermined {
    SFSpeechRecognizer.requestAuthorization { s in status = s; auth.signal() }
    _ = auth.wait(timeout: .now() + 120)
}
guard status == .authorized else { fail("NOT_AUTHORIZED: 시스템 설정 → 개인정보 보호 → 음성 인식에서 블랙홀을 허용해 주세요") }
guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "ko-KR")), recognizer.isAvailable else {
    fail("UNAVAILABLE: 한국어 음성 인식을 쓸 수 없습니다")
}
recognizer.queue = OperationQueue()
let request = SFSpeechURLRecognitionRequest(url: url)
request.shouldReportPartialResults = false
if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
request.addsPunctuation = true

let done = DispatchSemaphore(value: 0)
var text = ""
var failure: String?
let task = recognizer.recognitionTask(with: request) { result, error in
    if let result = result, result.isFinal {
        text = result.bestTranscription.formattedString
        done.signal()
    } else if let error = error {
        failure = error.localizedDescription
        done.signal()
    }
}
if done.wait(timeout: .now() + 300) == .timedOut {
    task.cancel()
    fail("TIMEOUT: 음성 인식이 끝나지 않았습니다")
}
if let failure = failure, text.isEmpty {
    // "No speech detected" ends with an error and an empty text: print nothing (empty audio).
    if failure.lowercased().contains("no speech") { exit(0) }
    fail("FAILED: \(failure)")
}
print(text)
