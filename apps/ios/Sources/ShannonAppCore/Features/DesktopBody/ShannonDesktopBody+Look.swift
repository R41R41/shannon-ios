#if os(macOS)
import CoreGraphics
import Foundation

/// One look at the room through the Mac's camera (`look.room-look`, `docs/body-contract.md`, "Looking at the room";
/// Syzygy ADR-0002, 部屋をひと目見る). Only while her window is up, the owner allowed the camera for her body (off by
/// default), and he is alone. One frame, at most 960 wide and 400,000 bytes, sent once and kept nowhere: the frame
/// exists only as memory between the camera and the request, and is never written to disk.
extension ShannonDesktopBody {
    func takeLook(_ look: ShannonDesktopBodyPresenceDTO.Look) async {
        guard let client, let conversation, mayBeHeard else { return }
        if let expires = ShannonBodySignals.date(look.expiresAt), expires <= Date() { return }
        let now = Date()
        looksTaken = looksTaken.filter { now.timeIntervalSince($0) < 3_600 }
        cameraPermission = ShannonMediaPermission.currentVideoCapture()
        let camera = ShannonAppLookCameraCapture()
        hasCamera = !camera.cameras().isEmpty
        let refusal = ShannonDesktopBodyLookRules.refusal(
            cameraAllowed: cameraAllowed, windowShown: isShown, othersPresent: audience == .others, hasCamera: hasCamera,
            permission: cameraPermission, takenInLastHour: looksTaken.count)
        let answer: ShannonBodyLookAnswerDTO
        if let refusal {
            answer = .refused(scopeKey: conversation.scopeKey, code: refusal)
        } else {
            answer = await takeFrame(with: camera, scopeKey: conversation.scopeKey, until: ShannonBodySignals.date(look.expiresAt))
        }
        // An answer after the look expired is answered `410` by the server; it is not sent at all.
        if let expires = ShannonBodySignals.date(look.expiresAt), expires <= Date() { return }
        guard let response = try? await client.answerBodyLook(id: look.id, answer: answer), let message = response.message else { return }
        // Her words about the room (or her one honest line for a look he asked for). A look of her own time has none.
        // Asked again when it is said: what she saw of his room is for him alone, so with someone else around by then it
        // is neither shown nor said here (it is in the Talk).
        enqueue {
            guard self.audience == .owner else { return }
            await self.say(
                message.text, id: message.id, expression: "curious", speak: self.speaks && !self.soundTaken && !self.away.isAway, ownerOnly: true)
        }
    }

    private func takeFrame(with camera: ShannonAppLookCameraCapture, scopeKey: String, until expiry: Date?) async -> ShannonBodyLookAnswerDTO {
        isCapturing = true
        conversation?.appLook.bodyIsCapturing = true
        defer {
            isCapturing = false
            conversation?.appLook.bodyIsCapturing = false
        }
        let image: CGImage
        do {
            image = try await camera.capture(.front)
        } catch ShannonAppLookCaptureError.noCamera {
            return .refused(scopeKey: scopeKey, code: "no_camera")
        } catch ShannonAppLookCaptureError.busy {
            return .refused(scopeKey: scopeKey, code: "busy")
        } catch {
            return .refused(scopeKey: scopeKey, code: "failed")
        }
        // The conditions are asked again: the window hidden, the camera switched off or a friend joined meanwhile.
        if let refusal = ShannonDesktopBodyLookRules.refusal(
            cameraAllowed: cameraAllowed, windowShown: isShown, othersPresent: audience == .others, hasCamera: true,
            permission: .granted, takenInLastHour: 0) {
            return .refused(scopeKey: scopeKey, code: refusal)
        }
        if let expiry, expiry <= Date() { return .refused(scopeKey: scopeKey, code: "timeout") }
        guard let frame = ShannonAppLookEncoder.frame(from: image) else { return .refused(scopeKey: scopeKey, code: "failed") }
        looksTaken.append(Date())
        return .seen(scopeKey: scopeKey, frame: frame)
    }
}
#endif
