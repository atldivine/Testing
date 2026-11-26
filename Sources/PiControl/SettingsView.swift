import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var store: PiStore
    @State private var url = ""
    @State private var token = ""
    @State private var testResult: String?
    @State private var testing = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.1.5:8088", text: $url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Pi address")
                } footer: {
                    Text("At home: http://192.168.1.5:8088. Anywhere else: turn on Tailscale and use the Pi's Tailscale name or 100.x address, e.g. http://jevspi:8088.")
                }

                Section {
                    SecureField("Deploy token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Deploy token")
                } footer: {
                    Text("Needed to start/stop services, reboot, and upload sites. Get it on the Pi with: sudo cat /opt/pi-dashboard/deploy-token.txt. Stored in your iPhone's Keychain.")
                }

                Section {
                    Button {
                        Task { await saveAndTest() }
                    } label: {
                        HStack {
                            Text("Save & test connection")
                            Spacer()
                            if testing { ProgressView() }
                        }
                    }
                    if let r = testResult {
                        Text(r).font(.callout)
                    }
                }

                if let s = store.stats {
                    Section("This Pi") {
                        LabeledContent("Host", value: s.info.hostname)
                        LabeledContent("Model", value: s.info.model)
                        LabeledContent("OS", value: s.info.os)
                        LabeledContent("Kernel", value: s.info.kernel)
                        LabeledContent("IP", value: s.info.ips.joined(separator: ", "))
                    }
                }
            }
            .glassList()
            .navigationTitle("Settings")
            .onAppear {
                url = store.serverURL
                token = store.token
            }
        }
    }

    private func saveAndTest() async {
        testing = true
        defer { testing = false }
        store.serverURL = url
        store.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try await store.api.get("/api/stats", as: Stats.self)
            if store.token.isEmpty {
                testResult = "✓ Connected. Add the token to unlock controls."
            } else {
                testResult = try await store.api.authCheck()
                    ? "✓ Connected and token accepted."
                    : "⚠️ Connected, but the token was rejected."
            }
            await store.refresh()
        } catch {
            testResult = "⚠️ Can't connect: \(error.localizedDescription)"
        }
    }
}
