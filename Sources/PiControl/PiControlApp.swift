import SwiftUI

@main
struct PiControlApp: App {
    @StateObject private var store = PiStore()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
                .onAppear { store.start() }
                .onChange(of: phase) { _, newPhase in
                    if newPhase == .active { store.start() } else { store.stop() }
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var store: PiStore

    var body: some View {
        TabView {
            OverviewView()
                .tabItem { Label("Overview", systemImage: "gauge.with.dots.needle.67percent") }
            ServicesView()
                .tabItem { Label("Services", systemImage: "server.rack") }
            SitesView()
                .tabItem { Label("Sites", systemImage: "globe") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .tint(.cyan)
        .overlay(alignment: .top) {
            if let t = store.toast {
                Text(t)
                    .font(.subheadline.weight(.medium))
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .onTapGesture { store.toast = nil }
                    .task(id: t) {
                        try? await Task.sleep(nanoseconds: 3_500_000_000)
                        if store.toast == t { store.toast = nil }
                    }
            }
        }
        .animation(.spring(duration: 0.35), value: store.toast)
    }
}
