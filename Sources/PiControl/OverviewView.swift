import SwiftUI
import Charts

struct OverviewView: View {
    @EnvironmentObject var store: PiStore
    @State private var confirmReboot = false
    @State private var confirmShutdown = false

    private let cols = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if let e = store.error { OfflineBanner(message: e) }
                    if let s = store.stats {
                        header(s)
                        LazyVGrid(columns: cols, spacing: 12) { tiles(s) }
                        cpuChart
                        if let t = s.throttle { power(t) }
                        if !s.slow.checks.isEmpty { checks(s.slow.checks) }
                        processes(s.procs)
                    } else if store.error == nil {
                        ProgressView("Connecting…").padding(.top, 80)
                    }
                }
                .padding()
            }
            .refreshable { await store.refresh() }
            .navigationTitle(store.stats?.info.hostname ?? "Pi Control")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(role: .destructive) { confirmReboot = true } label: {
                            Label("Reboot Pi", systemImage: "arrow.clockwise.circle")
                        }
                        Button(role: .destructive) { confirmShutdown = true } label: {
                            Label("Shut down Pi", systemImage: "power")
                        }
                    } label: {
                        Image(systemName: "power.circle")
                    }
                }
            }
            .confirmationDialog("Reboot the Pi?", isPresented: $confirmReboot, titleVisibility: .visible) {
                Button("Reboot", role: .destructive) { Task { await store.system("reboot") } }
            } message: {
                Text("Your sites and services will be offline for about a minute.")
            }
            .confirmationDialog("Shut down the Pi?", isPresented: $confirmShutdown, titleVisibility: .visible) {
                Button("Shut down", role: .destructive) { Task { await store.system("shutdown") } }
            } message: {
                Text("You'll need to unplug and replug it to turn it back on — the app can't start it remotely.")
            }
        }
    }

    private func header(_ s: Stats) -> some View {
        HStack {
            Circle().fill(store.isOnline ? Color.green : Color.red).frame(width: 8, height: 8)
            Text("\(s.info.model) · \(s.info.ips.first ?? "")")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            Spacer()
            if let d = store.lastUpdate {
                Text(d, style: .time).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func tiles(_ s: Stats) -> some View {
        let cpu = s.cpu ?? 0
        StatTile(label: "CPU", value: s.cpu.map { "\(Int($0))%" } ?? "–",
                 detail: "load \(s.load.joined(separator: " · "))",
                 progress: cpu, color: levelColor(cpu, warn: 60, bad: 85), icon: "cpu")
        let temp = s.temp ?? 0
        StatTile(label: "Temp", value: s.temp.map { String(format: "%.1f°C", $0) } ?? "–",
                 detail: s.cpuMhz.map { "\($0) MHz" } ?? "",
                 progress: temp / 85 * 100, color: levelColor(temp, warn: 70, bad: 80), icon: "thermometer.medium")
        let memPct = s.mem.total > 0 ? s.mem.used / s.mem.total * 100 : 0
        StatTile(label: "Memory", value: "\(Int(memPct))%",
                 detail: "\(Fmt.bytes(s.mem.used)) of \(Fmt.bytes(s.mem.total))",
                 progress: memPct, color: levelColor(memPct, warn: 75, bad: 90), icon: "memorychip")
        if let d = s.disks.first {
            StatTile(label: "Disk \(d.mount)", value: "\(Int(d.pct))%",
                     detail: "\(Fmt.bytes(d.used)) of \(Fmt.bytes(d.total))",
                     progress: d.pct, color: levelColor(d.pct, warn: 80, bad: 92), icon: "internaldrive")
        }
        StatTile(label: "Network", value: "↓ \(Fmt.rate(s.net.rxRate))",
                 detail: "↑ \(Fmt.rate(s.net.txRate))", icon: "arrow.up.arrow.down")
        StatTile(label: "Uptime", value: Fmt.uptime(s.uptime),
                 detail: "\(s.info.cores ?? 0) cores", icon: "clock")
        ForEach(s.disks.dropFirst()) { d in
            StatTile(label: "Disk \(d.mount)", value: "\(Int(d.pct))%",
                     detail: "\(Fmt.bytes(d.used)) of \(Fmt.bytes(d.total))",
                     progress: d.pct, color: levelColor(d.pct, warn: 80, bad: 92), icon: "externaldrive")
        }
    }

    private var cpuChart: some View {
        Card(title: "CPU % · last 3 min") {
            Chart(store.cpuHistory) { p in
                AreaMark(x: .value("Time", p.t), y: .value("CPU", p.v))
                    .foregroundStyle(.cyan.opacity(0.18))
                LineMark(x: .value("Time", p.t), y: .value("CPU", p.v))
                    .foregroundStyle(.cyan)
            }
            .chartYScale(domain: 0...100)
            .chartXAxis(.hidden)
            .frame(height: 110)
        }
    }

    private func power(_ t: Throttle) -> some View {
        Card(title: "Power & throttling") {
            if t.flags.isEmpty {
                Label("No under-voltage or throttling", systemImage: "checkmark.seal.fill")
                    .foregroundStyle(.green).font(.subheadline)
            } else {
                ForEach(t.flags, id: \.self) { f in
                    Label(f, systemImage: "bolt.trianglebadge.exclamationmark")
                        .foregroundStyle(f.contains("now") ? Color.red : Color.orange).font(.subheadline)
                }
            }
        }
    }

    private func checks(_ c: [Check]) -> some View {
        Card(title: "Health checks") {
            ForEach(c) { ch in
                HStack {
                    VStack(alignment: .leading) {
                        Text(ch.label).font(.subheadline)
                        Text(ch.url).font(.caption2.monospaced()).foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatePill(text: ch.ok ? "up" : "down")
                    Text("\(Int(ch.ms ?? 0)) ms").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func processes(_ p: [Proc]) -> some View {
        Card(title: "Top processes") {
            ForEach(p) { pr in
                HStack {
                    Text(pr.name).font(.subheadline.monospaced())
                    Spacer()
                    Text("\(pr.cpu)% cpu").font(.caption).foregroundStyle(.secondary)
                    Text("\(pr.mem)% mem").font(.caption).foregroundStyle(.secondary)
                        .frame(width: 70, alignment: .trailing)
                }
            }
        }
    }
}
