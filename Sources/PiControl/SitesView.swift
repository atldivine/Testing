import SwiftUI
import UniformTypeIdentifiers

struct SitesView: View {
    @EnvironmentObject var store: PiStore
    @Environment(\.openURL) private var openURL
    @State private var showDeploy = false
    @State private var rollbackSite: Site?

    var body: some View {
        NavigationStack {
            List {
                if let e = store.error {
                    Section { OfflineBanner(message: e) }
                }
                Section {
                    if store.sites.isEmpty {
                        Text("No sites yet. Tap + to upload one.").foregroundStyle(.secondary)
                    }
                    ForEach(store.sites) { site in row(site) }
                } footer: {
                    if !store.sitesRoot.isEmpty {
                        Text("Uploaded sites are stored in \(store.sitesRoot). Swipe a site to roll it back.")
                    }
                }
            }
            .refreshable { await store.refresh(includeSites: true) }
            .navigationTitle("Sites")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showDeploy = true } label: { Image(systemName: "plus.circle.fill") }
                }
            }
            .sheet(isPresented: $showDeploy) { DeploySheet().environmentObject(store) }
            .confirmationDialog("Roll back \(rollbackSite?.name ?? "")?",
                                isPresented: Binding(get: { rollbackSite != nil }, set: { if !$0 { rollbackSite = nil } }),
                                titleVisibility: .visible) {
                Button("Restore previous version", role: .destructive) {
                    if let s = rollbackSite {
                        Task { await store.run("site:\(s.name)") { try await store.api.rollback(site: s.name) } }
                    }
                }
            } message: {
                Text("The current version is saved first, so you can undo this.")
            }
        }
    }

    private func row(_ s: Site) -> some View {
        Button {
            if let u = store.link(for: s) { openURL(u) }
        } label: {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(s.name).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                        Text(s.source).font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Color.cyan.opacity(0.15), in: Capsule())
                            .foregroundStyle(.cyan)
                        if let st = s.state { StatePill(text: st) }
                    }
                    Text(detail(s)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer()
                if store.busy.contains("site:\(s.name)") { ProgressView() }
                else { Image(systemName: "arrow.up.right.square").foregroundStyle(.cyan) }
            }
        }
        .swipeActions(edge: .trailing) {
            if s.managed == true, (s.backups ?? 0) > 0 {
                Button { rollbackSite = s } label: { Label("Rollback", systemImage: "clock.arrow.circlepath") }
                    .tint(.orange)
            }
        }
    }

    private func detail(_ s: Site) -> String {
        switch s.source {
        case "folder":
            var parts = ["\(s.files ?? 0) files", Fmt.bytes(s.size)]
            if let m = s.modified { parts.append("updated \(Fmt.ago(m))") }
            if let b = s.backups, b > 0 { parts.append("\(b) backup\(b == 1 ? "" : "s")") }
            return parts.joined(separator: " · ")
        case "docker":
            return (s.image ?? "") + " · port " + (s.ports ?? []).joined(separator: ", ")
        default:
            let domains = (s.domains ?? []).joined(separator: ", ")
            let target = (s.root?.isEmpty == false ? s.root : s.proxy) ?? ""
            return [domains.isEmpty ? "any host" : domains, target].filter { !$0.isEmpty }.joined(separator: " · ")
        }
    }
}

struct DeploySheet: View {
    @EnvironmentObject var store: PiStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var fileURL: URL?
    @State private var picking = false
    @State private var error: String?

    private var existing: [String] {
        store.sites.filter { $0.source == "folder" && $0.managed == true }.map(\.name)
    }

    private var validName: Bool {
        name.range(of: "^[a-z0-9][a-z0-9_-]{0,40}$", options: .regularExpression) != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("site-name", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: name) { _, v in name = v.lowercased() }
                    if !existing.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack {
                                ForEach(existing, id: \.self) { n in
                                    Button(n) { name = n }.buttonStyle(.bordered).font(.caption)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Site name")
                } footer: {
                    Text("Lowercase letters, numbers, - or _. Pick an existing site to update it.")
                }

                Section("Site files") {
                    Button {
                        picking = true
                    } label: {
                        Label(fileURL?.lastPathComponent ?? "Choose .zip from Files", systemImage: "doc.zipper")
                    }
                    Text("Zip the folder that contains index.html (in Files: long-press the folder → Compress).")
                        .font(.caption).foregroundStyle(.secondary)
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.callout) }
                }

                Section {
                    Button {
                        Task { await deploy() }
                    } label: {
                        HStack {
                            Spacer()
                            if store.busy.contains("deploy") { ProgressView() } else { Text("Deploy").bold() }
                            Spacer()
                        }
                    }
                    .disabled(!validName || fileURL == nil || store.busy.contains("deploy"))
                }
            }
            .navigationTitle("Upload site")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.zip]) { result in
                switch result {
                case .success(let url): fileURL = url; error = nil
                case .failure(let e): error = e.localizedDescription
                }
            }
        }
    }

    private func deploy() async {
        guard let url = fileURL else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            self.error = "Couldn't read the file: \(error.localizedDescription)"
            return
        }
        let site = name
        await store.run("deploy") { try await store.api.deploy(site: site, zip: data) }
        if store.toast?.hasPrefix("✓") == true { dismiss() }
    }
}
