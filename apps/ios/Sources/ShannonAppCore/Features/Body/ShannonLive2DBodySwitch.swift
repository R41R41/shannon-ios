import Foundation

/// Which body the page shows and which one the app is asking for: the switch between the character and her eyes
/// alone as a value, so that every sequence of the page's messages can be tested without a web view. The stage feeds
/// it what happens (`Event`) and carries out what it says (`Effect`).
///
/// - One switch at a time. The page chains to the latest choice itself, but two `setBody` calls in flight can make it
///   load two models (each holds a large texture), so nothing more is asked while a request is pending; a choice
///   made meanwhile is asked for when the page says which body it shows.
/// - The page of 10:43 answers every `setBody` with `body` and says the body in `contextRestored`. An earlier page
///   ignored a `setBody` for the body it showed and could bring back the body it had before a switch when it mended
///   a lost surface. So a request is never trusted for ever: one that is not answered within `deadlineSeconds` of
///   foreground time ends in a reload in the chosen body; and a `contextRestored` without a body is followed by
///   asking for the chosen body again (see `contextRestored`).
struct ShannonLive2DBodySwitch: Equatable, Sendable {
    /// Foreground seconds a switch may take. A switch builds a model from what the page has already read (the first
    /// load, which also reads the 27 MB of assets, took about a minute on a busy simulator), so this is generous;
    /// shorter than the 90 seconds of a load, so that a stuck choice does not hold her for a minute and a half.
    static let deadlineSeconds = 30

    enum Event: Equatable, Sendable {
        /// The owner's choice (the setting changed, or the page is started).
        case chose(ShannonLive2DBody)
        /// `ready`: the bodies the page has (none named: the character only) and the one it shows.
        case ready(bodies: [ShannonLive2DBody], shown: ShannonLive2DBody?)
        /// `body`: the page switched.
        case switched(ShannonLive2DBody)
        /// The drawing surface was lost; the page mends it by itself.
        case contextLost
        /// It is back. A page that says which body it shows settles the question; one that does not is asked again.
        case contextRestored(shown: ShannonLive2DBody?)
        /// The web view was let go (no screen showed her, an error, a reload). What the bundled page has stays known.
        case released(bundled: [ShannonLive2DBody])
        /// One second passed with the app in front.
        case foregroundSecond
    }

    enum Effect: Equatable, Sendable {
        /// Call `setBody` with this body.
        case request(ShannonLive2DBody)
        /// The page switched: close the character's mouth and say the layout and the calm again.
        case afterSwitch(ShannonLive2DBody)
        /// A request went unanswered: reload the page, which starts in the chosen body.
        case recover
    }

    var chosen: ShannonLive2DBody
    /// The bodies the page has: the bundled page's until `ready`, then the page's own.
    var offered: [ShannonLive2DBody]
    /// The body the page shows, as far as its messages tell.
    private(set) var shown: ShannonLive2DBody = .human
    /// The body asked for that the page has not yet said it shows.
    private(set) var pending: ShannonLive2DBody?
    /// The pending request only asks the page to confirm the body after its surface came back. The page does not
    /// answer for a body it already shows, so an unanswered confirmation means that body is shown.
    private(set) var confirming = false
    private(set) var waited = 0
    private(set) var pageReady = false
    /// While the drawing surface is lost, nothing is asked and no time is counted.
    private(set) var surfaceLost = false

    init(chosen: ShannonLive2DBody, offered: [ShannonLive2DBody]) {
        self.chosen = chosen
        self.offered = offered
    }

    /// The body her figure takes for the choice: the chosen one when the page has it, otherwise the character.
    var target: ShannonLive2DBody { ShannonLive2DBodyPolicy.effective(chosen, offered: offered) }

    mutating func reduce(_ event: Event) -> [Effect] {
        switch event {
        case let .chose(body):
            chosen = body
            return ask()
        case let .ready(bodies, shown):
            pageReady = true
            surfaceLost = false
            offered = ShannonLive2DBodyPolicy.offered(byReady: bodies)
            self.shown = shown ?? .human
            forget()
            return ask()
        case let .switched(body):
            shown = body
            forget()
            return [.afterSwitch(body)] + ask()
        case .contextLost:
            surfaceLost = true
            return []
        case let .contextRestored(shown):
            surfaceLost = false
            forget()
            guard pageReady else { return [] }
            if let shown {
                self.shown = shown
                return ask()
            }
            // The page may have brought back the body it had before a switch: ask for the chosen one again. If it is
            // shown, the page stays silent and the confirmation runs out; if not, the page switches and says so.
            pending = target
            confirming = true
            return [.request(target)]
        case let .released(bundled):
            self = ShannonLive2DBodySwitch(chosen: chosen, offered: bundled)
            return []
        case .foregroundSecond:
            guard let asked = pending, !surfaceLost else { return [] }
            waited += 1
            guard waited >= Self.deadlineSeconds else { return [] }
            if confirming {
                shown = asked
                forget()
                return ask()
            }
            forget()
            return [.recover]
        }
    }

    private mutating func forget() {
        pending = nil
        confirming = false
        waited = 0
    }

    private mutating func ask() -> [Effect] {
        guard pageReady, !surfaceLost, pending == nil, target != shown else { return [] }
        pending = target
        return [.request(target)]
    }
}
