// blackhole-auth: Touch ID (or the Mac password) before a secret is shown or copied.
// Usage: blackhole-auth "<reason>"  → exit 0 when the owner confirmed, 1 otherwise.
import Foundation
import LocalAuthentication

let reason = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "블랙홀 비밀 정보 보기"
let context = LAContext()
var error: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
    FileHandle.standardError.write("UNAVAILABLE: \(error?.localizedDescription ?? "")\n".data(using: .utf8)!)
    exit(2)
}
let done = DispatchSemaphore(value: 0)
var ok = false
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
    ok = success
    done.signal()
}
_ = done.wait(timeout: .now() + 120)
exit(ok ? 0 : 1)
