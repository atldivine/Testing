import Foundation
import SwiftUI
import UIKit

@MainActor
final class PiStore: ObservableObject {
    @Published var stats: Stats?
    @Published var sites: [Site] = []
    @Published var sitesRoot = ""
    @Published var error: String?
    @Published var lastUpdate: Date?
    @Published var cpuHistory: [Sample] = []
    @Published var tempHistory: [Sample] = []
    @Published var toast: String?
    @Published var busy: Set<String> = []
    @Published var analytics: Analytics?
    @Published var range = "24h" {
        didSet { if !PiStore.isDemo { Task { await loadAnalytics() } } }
    }

    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }
    @Published var token: String {
        didSet { Keychain.set("token", token) }
    }

    private var pollTask: Task<Void, Never>?

    init() {
        serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? "http://192.168.1.5:8088"
        token = Keychain.get("token") ?? ""
    }

    var api: API { API(baseURL: serverURL, token: token) }
    var isOnline: Bool { error == nil && stats != nil }

    // MARK: polling

    /// Launch with `-demo` to show bundled sample data (used for screenshots).
    static let isDemo = ProcessInfo.processInfo.arguments.contains("-demo")

    func loadDemo() {
        struct Demo: Decodable { let stats: Stats; let analytics: Analytics; let sites: SitesResponse }
        guard let url = Bundle.main.url(forResource: "demo", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { error = "demo.json missing"; return }
        do {
            let d = try API.decoder.decode(Demo.self, from: data)
            stats = d.stats
            analytics = d.analytics
            sites = d.sites.sites
            sitesRoot = d.sites.sitesRoot
            lastUpdate = Date()
        } catch {
            self.error = "Demo data didn't decode: \(error)"
        }
    }

    func start() {
        if PiStore.isDemo { if stats == nil { loadDemo() }; return }
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            var n = 0
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh(includeSites: n % 5 == 0)
                n += 1
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func refresh(includeSites: Bool = true) async {
        do {
            let s = try await api.get("/api/stats", as: Stats.self)
            stats = s
            error = nil
            lastUpdate = Date()
            let now = Date()
            if let c = s.cpu { push(&cpuHistory, Sample(t: now, v: c)) }
            if let t = s.temp { push(&tempHistory, Sample(t: now, v: t)) }
            if includeSites {
                let r = try await api.get("/api/sites", as: SitesResponse.self)
                sites = r.sites
                sitesRoot = r.sitesRoot
                await loadAnalytics()
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func loadAnalytics() async {
        // older pi_dashboard.py versions don't have /api/analytics — just skip.
        if let a = try? await api.get("/api/analytics?range=\(range)", as: Analytics.self) {
            analytics = a
        }
    }

    var greeting: String {
        let h = Calendar.current.component(.hour, from: Date())
        return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
    }

    private func push(_ arr: inout [Sample], _ s: Sample) {
        arr.append(s)
        if arr.count > 60 { arr.removeFirst(arr.count - 60) }
    }

    // MARK: actions

    /// Runs an action, shows the result as a toast, then refreshes.
    func run(_ label: String, _ op: () async throws -> APIResult) async {
        busy.insert(label)
        defer { busy.remove(label) }
        do {
            let r = try await op()
            var msg = r.message ?? "Done"
            if let site = r.site, r.files != nil { msg = "Deployed \(site) (\(r.files ?? 0) files)" }
            if let restored = r.restored { msg = "Rolled back to \(restored)" }
            if let w = r.warning { msg += " — \(w)" }
            toast = "✓ " + msg
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            await refresh(includeSites: true)
        } catch {
            toast = "⚠️ " + error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    func service(_ action: String, _ name: String) async {
        await run("svc:\(name)") { try await api.control(kind: "service", action: action, name: name) }
    }

    func container(_ action: String, _ name: String) async {
        await run("ctr:\(name)") { try await api.control(kind: "docker", action: action, name: name) }
    }

    func system(_ action: String) async {
        await run("sys") { try await api.control(kind: "system", action: action) }
    }

    /// Link to open a site from the phone.
    func link(for site: Site) -> URL? {
        let host = api.host
        switch site.source {
        case "folder":
            return URL(string: api.normalizedBase + (site.preview ?? "/sites/\(site.name)/"))
        default:
            let port = site.ports?.first ?? "80"
            return URL(string: "http://\(host)" + (port == "80" ? "" : ":\(port)"))
        }
    }
}
