import SwiftUI

struct ServicesView: View {
    @EnvironmentObject var store: PiStore
    @State private var search = ""

    private var services: [Service] {
        let all = store.stats?.slow.services ?? []
        guard !search.isEmpty else { return all }
        return all.filter { ($0.name + $0.desc).localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        NavigationStack {
            List {
                if let e = store.error {
                    Section { OfflineBanner(message: e) }
                }
                if let docker = store.stats?.slow.docker {
                    Section("Docker containers") {
                        if let err = docker.error {
                            Text(err).font(.caption).foregroundStyle(.secondary)
                        }
                        ForEach(docker.containers ?? []) { c in containerRow(c) }
                    }
                }
                Section {
                    ForEach(services) { s in serviceRow(s) }
                } header: {
                    let failed = (store.stats?.slow.services ?? []).filter(\.isFailed).count
                    Text(failed > 0 ? "Services · \(failed) failed" : "Services")
                } footer: {
                    Text("Swipe a row or long-press for start / stop / restart. ★ = pinned in pi_dashboard.py.")
                }
            }
            .searchable(text: $search, prompt: "Filter services")
            .refreshable { await store.refresh() }
            .navigationTitle("Services")
        }
    }

    private func serviceRow(_ s: Service) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text((s.pinned ? "★ " : "") + s.name).font(.subheadline.monospaced())
                if !s.desc.isEmpty {
                    Text(s.desc).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            if store.busy.contains("svc:\(s.name)") { ProgressView() }
            else { StatePill(text: s.active == "active" ? s.sub : s.active) }
        }
        .swipeActions(edge: .trailing) {
            if s.isRunning {
                Button { Task { await store.service("stop", s.name) } } label: { Label("Stop", systemImage: "stop.fill") }
                    .tint(.red)
            } else {
                Button { Task { await store.service("start", s.name) } } label: { Label("Start", systemImage: "play.fill") }
                    .tint(.green)
            }
            Button { Task { await store.service("restart", s.name) } } label: { Label("Restart", systemImage: "arrow.clockwise") }
                .tint(.orange)
        }
        .contextMenu {
            Button { Task { await store.service("start", s.name) } } label: { Label("Start", systemImage: "play.fill") }
            Button { Task { await store.service("restart", s.name) } } label: { Label("Restart", systemImage: "arrow.clockwise") }
            Button(role: .destructive) { Task { await store.service("stop", s.name) } } label: { Label("Stop", systemImage: "stop.fill") }
        }
    }

    private func containerRow(_ c: Container) -> some View {
        let name = c.name ?? "?"
        return HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.subheadline.weight(.semibold))
                Text(c.image ?? "").font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                if c.isRunning, let cpu = c.cpu {
                    Text("\(cpu) cpu · \(c.mem ?? "")").font(.caption2).foregroundStyle(.secondary)
                } else if let st = c.status {
                    Text(st).font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if store.busy.contains("ctr:\(name)") { ProgressView() }
            else { StatePill(text: c.state ?? "?") }
        }
        .swipeActions(edge: .trailing) {
            if c.isRunning {
                Button { Task { await store.container("stop", name) } } label: { Label("Stop", systemImage: "stop.fill") }
                    .tint(.red)
            } else {
                Button { Task { await store.container("start", name) } } label: { Label("Start", systemImage: "play.fill") }
                    .tint(.green)
            }
            Button { Task { await store.container("restart", name) } } label: { Label("Restart", systemImage: "arrow.clockwise") }
                .tint(.orange)
        }
        .contextMenu {
            Button { Task { await store.container("start", name) } } label: { Label("Start", systemImage: "play.fill") }
            Button { Task { await store.container("restart", name) } } label: { Label("Restart", systemImage: "arrow.clockwise") }
            Button(role: .destructive) { Task { await store.container("stop", name) } } label: { Label("Stop", systemImage: "stop.fill") }
        }
    }
}
