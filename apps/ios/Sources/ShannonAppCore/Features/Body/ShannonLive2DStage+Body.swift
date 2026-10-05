import SwiftUI

/// The decisions about her body that need no web view, so they can be tested.
enum ShannonLive2DBodyPolicy {
    /// The body that can be shown for a choice: the chosen one when the page has it, otherwise the character.
    static func effective(_ chosen: ShannonLive2DBody, offered: [ShannonLive2DBody]) -> ShannonLive2DBody {
        offered.contains(chosen) ? chosen : .human
    }

    /// The bodies a `ready` names; a page that names none has only the character.
    static func offered(byReady bodies: [ShannonLive2DBody]) -> [ShannonLive2DBody] {
        bodies.isEmpty ? [.human] : bodies
    }

    /// The bodies of the bundled page, from its `version.json` file list (her eyes are `model-eyes/…`).
    static func bundled(files: [String]) -> [ShannonLive2DBody] {
        files.contains { $0.hasPrefix("model-eyes/") } ? [.human, .eyes] : [.human]
    }

    /// The page's own calm (`setIdle`) reaches only the character: the eyes blink and sway as part of their motion,
    /// so with her eyes alone an idle figure is paused to rest as a page without that calm would be.
    static func pageCalms(calmsInPage: Bool, body: ShannonLive2DBody) -> Bool {
        calmsInPage && body.hasCharacterRig
    }

    /// What the app says again after the page switched: the character's mouth closed (her eyes have none), where the
    /// screen in front wants her, and the calm when the page has it.
    static func commandsAfterSwitch(
        to body: ShannonLive2DBody, host: (layout: ShannonLive2DLayout, touchEnabled: Bool)?,
        calm: (reduceMotion: Bool, lowPower: Bool)?
    ) -> [ShannonLive2DCommand] {
        var commands: [ShannonLive2DCommand] = body.hasCharacterRig ? [.setMouthLevel(0)] : []
        if let host { commands += ShannonLive2DStagePolicy.hostCommands(layout: host.layout, touchEnabled: host.touchEnabled) }
        if let calm { commands += ShannonLive2DStagePolicy.calmCommands(reduceMotion: calm.reduceMotion, lowPower: calm.lowPower) }
        return commands
    }
}

/// Her body in the Live2D form: the character or her eyes alone (設定 › すがた › 体, owner decision 2026-10-05).
/// The page is started in the chosen body (`ShannonLive2DStagePolicy.pageURL`); the stage follows a later choice
/// of the setting by itself, wherever it is made, through `ShannonLive2DBodySwitch`.
extension ShannonLive2DStage {
    /// What the bundled page has, before it is loaded.
    static let bundledBodies: [ShannonLive2DBody] = {
        guard let folder = embedFolder,
              let data = try? Data(contentsOf: folder.appendingPathComponent("version.json")),
              let version = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [.human] }
        return ShannonLive2DBodyPolicy.bundled(files: version["files"] as? [String] ?? [])
    }()

    /// The body the page shows (the character or her eyes alone), as far as its messages tell.
    public var body: ShannonLive2DBody { bodySwitch.shown }
    /// The bodies the page has: the bundled page's until it says `ready`, then its own (`[.human]` for an older page).
    public var bodies: [ShannonLive2DBody] { bodySwitch.offered }

    /// Whether 目だけ can be chosen with this page.
    public var offersEyes: Bool { bodies.contains(.eyes) }

    /// The body her figure takes for the owner's choice: the character when the page does not have the chosen one.
    public func displayedBody(for chosen: ShannonLive2DBody) -> ShannonLive2DBody {
        ShannonLive2DBodyPolicy.effective(chosen, offered: bodies)
    }

    /// A body the page has not shown yet is loaded first; until the page says `body`, the other one stays.
    public func setBody(_ value: ShannonLive2DBody) {
        dispatch(.chose(value))
    }

    var pageCalms: Bool { ShannonLive2DBodyPolicy.pageCalms(calmsInPage: calmsInPage, body: body) }

    /// Feeds what happened to the switch and carries out what it says.
    func dispatch(_ event: ShannonLive2DBodySwitch.Event) {
        for effect in bodySwitch.reduce(event) {
            switch effect {
            case let .request(body):
                noteActivity()
                send(.setBody(body))
                watchBodyRequest()
            case let .afterSwitch(body):
                lastMouthLevel = 0
                ShannonLive2DBodyPolicy.commandsAfterSwitch(
                    to: body, host: frontHost, calm: calmsInPage ? (reduceMotion, lowPower) : nil
                ).forEach(send)
                noteActivity()
            case .recover:
                NSLog("[ShannonBody] the page did not answer a switch of body; reloading it in the chosen body")
                recover(generation: generation)
            }
        }
    }

    /// Counts the foreground seconds of a pending request, so that an unanswered one ends (`deadlineSeconds`).
    private func watchBodyRequest() {
        bodyRequestWatch?.cancel()
        let watched = generation
        bodyRequestWatch = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self, self.generation == watched, self.bodySwitch.pending != nil else { return }
                if self.appActive { self.dispatch(.foregroundSecond) }
            }
        }
    }

    /// The setting (設定 › すがた › 体, Talk's display options, the Mac's settings and body sheet) is followed once,
    /// here, at the moment it changes: also a page kept alive while no screen shows her switches before she is seen.
    func observeChosenBody() {
        _ = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ShannonLive2DStage.shared.setBody(.current()) }
        }
    }
}

extension ShannonLive2DBody {
    /// The owner's choice as her figure takes it: the character when the page does not have the chosen body.
    @MainActor static func displayed(rawValue: String) -> ShannonLive2DBody {
        ShannonLive2DStage.shared.displayedBody(for: ShannonLive2DBody(rawValue: rawValue) ?? .human)
    }

    /// A picker's selection over the stored choice that shows what her figure takes.
    @MainActor static func selection(_ stored: Binding<String>) -> Binding<String> {
        Binding(get: { displayed(rawValue: stored.wrappedValue).rawValue }, set: { stored.wrappedValue = $0 })
    }
}
