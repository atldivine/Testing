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
    @State private var tab = UserDefaults.standard.integer(forKey: "tab")   // `-tab N` launch arg

    var body: some View {
        TabView(selection: $tab) {
            OverviewView()
                .tag(0)
                .tabItem { Label("Overview", systemImage: "gauge.with.dots.needle.67percent") }
            ServicesView()
                .tag(1)
                .tabItem { Label("Services", systemImage: "server.rack") }
            SitesView()
                .tag(2)
                .tabItem { Label("Sites", systemImage: "globe") }
            SettingsView()
                .tag(3)
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .tint(.cyan)
        .overlay(alignment: .top) {
            if let t = store.toast {
                Text(t)
                    .font(.subheadline.weight(.medium))
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .glassPill()
                    .padding(.horizontal, 20)
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
