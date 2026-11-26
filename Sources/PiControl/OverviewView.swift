import SwiftUI
import Charts

struct OverviewView: View {
    @EnvironmentObject var store: PiStore
    @State private var confirmReboot = false
    @State private var confirmShutdown = false
    @State private var showDeploy = false
    @State private var selectedDate: Date?

    private let kpiCols = [GridItem(.adaptive(minimum: 158), spacing: 12, alignment: .top)]

    var body: some View {
        NavigationStack {
          ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 14) {
                    header
                    if let e = store.error { OfflineBanner(message: e) }
                    if let s = store.stats {
                        quickActions
                        LazyVGrid(columns: kpiCols, spacing: 12) { kpis(s) }
                        utilization.id("util")
                        if let a = store.analytics {
                            storage(a.storage).id("storage")
                            traffic(a).id("traffic")
                            power(a.power).id("power")
                        }
                        health(s).id("health")
                        activity.id("activity")
                        processes(s.procs)
                    } else if store.error == nil {
                        ProgressView("Connecting…")
                            .padding(.top, 60)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .background(AppBackground())
            .overlay(alignment: .top) {
                // soft fade under the status bar so scrolled cards never collide with the clock
                LinearGradient(colors: [Color(red: 0.05, green: 0.06, blue: 0.15), Color(red: 0.05, green: 0.06, blue: 0.15).opacity(0)],
                               startPoint: .top, endPoint: .bottom)
                    .frame(height: 24)
                    .ignoresSafeArea(edges: .top)
                    .allowsHitTesting(false)
            }
            .onAppear {
                // `-section util` launch arg scrolls to a card (used for screenshots)
                if let id = UserDefaults.standard.string(forKey: "section") {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { proxy.scrollTo(id, anchor: .top) }
                }
            }
            .refreshable { await store.refresh() }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showDeploy) { DeploySheet().environmentObject(store) }
            .confirmationDialog("Reboot the Pi?", isPresented: $confirmReboot, titleVisibility: .visible) {
                Button("Reboot", role: .destructive) { Task { await store.system("reboot") } }
            } message: {
                Text("Your sites and services will be offline for about a minute.")
            }
            .confirmationDialog("Shut down the Pi?", isPresented: $confirmShutdown, titleVisibility: .visible) {
                Button("Shut down", role: .destructive) { Task { await store.system("shutdown") } }
            } message: {
                Text("You'll need to unplug and replug it to turn it back on.")
            }
          }
        }
    }

    // MARK: header

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(store.greeting)
                    .font(.system(.largeTitle, design: .rounded).weight(.bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                HStack(spacing: 6) {
                    Circle()
                        .fill(store.isOnline ? Palette.down : Color.red)
                        .frame(width: 7, height: 7)
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
            }
            Spacer(minLength: 8)
            Menu {
                Button(role: .destructive) { confirmReboot = true } label: {
                    Label("Reboot Pi", systemImage: "arrow.clockwise")
                }
                Button(role: .destructive) { confirmShutdown = true } label: {
                    Label("Shut down Pi", systemImage: "power")
                }
            } label: {
                Image(systemName: "power")
                    .font(.headline)
                    .frame(width: 44, height: 44)
                    .glassPill()
            }
            .accessibilityLabel("Power")
        }
        .padding(.top, 8)
    }

    private var subtitle: String {
        let host = store.stats?.info.hostname ?? "Raspberry Pi"
        if let d = store.lastUpdate {
            return "\(host) · \(store.isOnline ? "online" : "offline") · \(d.formatted(date: .omitted, time: .shortened))"
        }
        return host
    }

    private var quickActions: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 10) {
                actionButton("Upload site", "arrow.up.circle") { showDeploy = true }
                actionButton("Refresh", "arrow.triangle.2.circlepath") {
                    Task { await store.refresh() }
                }
                if let ip = store.stats?.info.ips.first {
                    Label(ip, systemImage: "network")
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .glassPill()
                }
            }
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
    }

    private func actionButton(_ title: String, _ icon: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .glassPill()
        }
        .buttonStyle(.plain)
    }

    // MARK: KPIs

    @ViewBuilder
    private func kpis(_ s: Stats) -> some View {
        let a = store.analytics
        if let bw = a?.bandwidth {
            KPICard(title: "Bandwidth", icon: "arrow.up.arrow.down",
                    value: Fmt.bytes(bw.total),
                    caption: "↓ \(Fmt.bytes(bw.monthRx)) · ↑ \(Fmt.bytes(bw.monthTx))",
                    badge: ("Month", Palette.cpu),
                    progress: bw.quota.map { bw.total / $0 },
                    tint: Palette.down)
        }
        let cpuNow = s.cpu ?? 0
        KPICard(title: "CPU load", icon: "cpu",
                value: String(format: "%.1f", a?.cpuAvg ?? cpuNow), unit: "%",
                caption: "now \(Int(cpuNow))% · peak \(Int(a?.cpuPeak ?? cpuNow))%",
                badge: cpuNow < 60 ? ("OK", Palette.down) : cpuNow < 85 ? ("Busy", Palette.up) : ("High", Color.red),
                progress: (a?.cpuAvg ?? cpuNow) / 100, tint: Palette.cpu)
        if let inst = a?.instances {
            KPICard(title: "Active services", icon: "server.rack",
                    value: "\(inst.running)", unit: "/\(inst.total)",
                    caption: inst.failed > 0 ? "\(inst.failed) failed · \(inst.containers) containers" : "\(inst.containers) containers",
                    badge: inst.failed > 0 ? ("Check", Color.red) : ("OK", Palette.down),
                    tint: Palette.mem)
        }
        let memPct = s.mem.total > 0 ? s.mem.used / s.mem.total * 100 : 0
        KPICard(title: "Memory", icon: "memorychip",
                value: "\(Int(memPct))", unit: "%",
                caption: "\(Fmt.bytes(s.mem.used)) of \(Fmt.bytes(s.mem.total))",
                progress: memPct / 100, tint: Palette.mem)
        let temp = s.temp ?? 0
        KPICard(title: "Temperature", icon: "thermometer.medium",
                value: s.temp.map { String(format: "%.1f", $0) } ?? "–", unit: "°C",
                caption: s.cpuMhz.map { "\($0) MHz" } ?? "",
                badge: temp < 70 ? ("Cool", Palette.down) : temp < 80 ? ("Warm", Palette.up) : ("Hot", Color.red),
                progress: temp / 85, tint: levelColor(temp, warn: 70, bad: 80))
        KPICard(title: "Uptime", icon: "clock.arrow.circlepath",
                value: Fmt.uptime(s.uptime),
                caption: a?.uptime.percentWeek.map { String(format: "%.2f%% last 7 days", $0) } ?? "since last boot",
                tint: Palette.down)
    }

    // MARK: resource utilization

    private var utilization: some View {
        let points = store.analytics?.series ?? []
        let selected = selectedDate.flatMap { d in points.min(by: { abs($0.date.timeIntervalSince(d)) < abs($1.date.timeIntervalSince(d)) }) }
        return Card(title: "Resource utilization") {
            Picker("Range", selection: $store.range) {
                Text("1H").tag("1h")
                Text("24H").tag("24h")
                Text("7D").tag("7d")
            }
            .pickerStyle(.segmented)

            HStack(spacing: 14) {
                LegendDot(color: Palette.cpu, label: "CPU")
                LegendDot(color: Palette.mem, label: "Memory")
                Spacer(minLength: 0)
                if let p = selected {
                    Text("\(p.date.formatted(date: .omitted, time: .shortened)) · CPU \(Int(p.cpu))% · Mem \(Int(p.mem ?? 0))%")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
            }

            if points.count < 2 {
                Text("Collecting history… charts fill in as the Pi records samples every 30 seconds.")
                    .font(.footnote).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 160, alignment: .center)
                    .multilineTextAlignment(.center)
            } else {
                Chart {
                    ForEach(points) { p in
                        AreaMark(x: .value("Time", p.date), y: .value("CPU", p.cpu))
                            .foregroundStyle(LinearGradient(colors: [Palette.cpu.opacity(0.35), Palette.cpu.opacity(0)],
                                                            startPoint: .top, endPoint: .bottom))
                            .interpolationMethod(.monotone)
                        LineMark(x: .value("Time", p.date), y: .value("CPU", p.cpu), series: .value("S", "CPU"))
                            .foregroundStyle(Palette.cpu)
                            .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round))
                            .interpolationMethod(.monotone)
                        if let m = p.mem {
                            LineMark(x: .value("Time", p.date), y: .value("Mem", m), series: .value("S", "Memory"))
                                .foregroundStyle(Palette.mem)
                                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, dash: [5, 4]))
                                .interpolationMethod(.monotone)
                        }
                    }
                    if let p = selected {
                        RuleMark(x: .value("Selected", p.date))
                            .foregroundStyle(Color.white.opacity(0.35))
                            .lineStyle(StrokeStyle(lineWidth: 1))
                    }
                }
                .chartYScale(domain: 0...100)
                .chartYAxis {
                    AxisMarks(position: .leading, values: [0, 25, 50, 75, 100]) { v in
                        AxisGridLine().foregroundStyle(Color.white.opacity(0.08))
                        AxisValueLabel { Text("\(v.as(Int.self) ?? 0)%").font(.caption2) }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                        AxisValueLabel(format: store.range == "7d" ? .dateTime.weekday(.abbreviated) : .dateTime.hour())
                            .font(.caption2)
                    }
                }
                .chartXSelection(value: $selectedDate)
                .frame(height: 190)
                .transaction { $0.animation = nil }   // smooth: no re-animating every refresh
            }
        }
    }

    // MARK: storage

    private func storage(_ st: Analytics.Storage) -> some View {
        let items = st.items ?? []
        let maxB = items.map(\.bytes).max() ?? 1
        return Card(title: "Storage distribution") {
            if let used = st.used, let total = st.total {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Fmt.bytes(total)).font(.title3.weight(.semibold)).lineLimit(1)
                        Text("Total").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(Fmt.bytes(used)).font(.title3.weight(.semibold)).lineLimit(1)
                        Text("Used").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if items.isEmpty {
                Text("Measuring folders… this updates every 15 minutes.")
                    .font(.footnote).foregroundStyle(.secondary)
            } else {
                VStack(spacing: 10) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { i, it in
                        let c = Palette.storage[i % Palette.storage.count]
                        HStack(spacing: 10) {
                            Circle().fill(c).frame(width: 8, height: 8)
                            Text(it.label)
                                .font(.subheadline)
                                .lineLimit(1)
                                .frame(width: 70, alignment: .leading)
                            GeometryReader { g in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(Color.white.opacity(0.08))
                                    Capsule().fill(c.gradient)
                                        .frame(width: max(6, g.size.width * it.bytes / maxB))
                                }
                            }
                            .frame(height: 10)
                            Text(Fmt.bytes(it.bytes))
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .frame(width: 72, alignment: .trailing)
                        }
                    }
                }
            }
        }
    }

    // MARK: traffic

    private func traffic(_ a: Analytics) -> some View {
        Card(title: "Network traffic") {
            HStack(spacing: 14) {
                LegendDot(color: Palette.down, label: "Download")
                LegendDot(color: Palette.up, label: "Upload")
                Spacer(minLength: 0)
                Text("Last 14 days").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Chart(a.trafficDays) { d in
                BarMark(x: .value("Day", d.date, unit: .day), y: .value("GB", d.rx / 1_073_741_824))
                    .foregroundStyle(Palette.down.gradient)
                    .cornerRadius(4)
                BarMark(x: .value("Day", d.date, unit: .day), y: .value("GB", d.tx / 1_073_741_824))
                    .foregroundStyle(Palette.up.gradient)
                    .cornerRadius(4)
            }
            .chartYAxis {
                AxisMarks(position: .leading) { v in
                    AxisGridLine().foregroundStyle(Color.white.opacity(0.08))
                    AxisValueLabel {
                        Text(String(format: "%.1f GB", v.as(Double.self) ?? 0)).font(.caption2)
                    }
                }
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: .day, count: 3)) { _ in
                    AxisValueLabel(format: .dateTime.day().month(.abbreviated)).font(.caption2)
                }
            }
            .frame(height: 170)
            .transaction { $0.animation = nil }
        }
    }

    // MARK: power

    private func power(_ p: Analytics.Power) -> some View {
        Card(title: "Electricity estimate") {
            VStack(alignment: .leading, spacing: 4) {
                Text(p.projectedCost.map { String(format: "$%.2f", $0) } ?? String(format: "$%.2f", p.costMonth))
                    .font(.system(size: 40, weight: .bold, design: .rounded).monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                Text(p.projectedCost != nil ? "Projected for this month" : "So far this month")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 10)
            .glassCard(18)

            HStack {
                statColumn(String(format: "$%.2f", p.costMonth), "Month to date")
                Divider().frame(height: 30).overlay(Color.white.opacity(0.15))
                statColumn(String(format: "%.2f kWh", p.kwhMonth), "Used")
                Divider().frame(height: 30).overlay(Color.white.opacity(0.15))
                statColumn(String(format: "%.1f W", p.wattsNow), "Drawing now")
            }
            Text(String(format: "Estimated from CPU load at $%.2f/kWh. Change PRICE_PER_KWH in pi_dashboard.py.", p.pricePerKwh))
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func statColumn(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.subheadline.weight(.semibold).monospacedDigit()).lineLimit(1).minimumScaleFactor(0.7)
            Text(label).font(.caption2).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: health

    private func health(_ s: Stats) -> some View {
        Card(title: "Uptime & health") {
            if let t = s.throttle {
                if t.flags.isEmpty {
                    Label("Power supply OK — no throttling", systemImage: "bolt.badge.checkmark")
                        .font(.subheadline).foregroundStyle(Palette.down)
                } else {
                    ForEach(t.flags, id: \.self) { f in
                        Label(f, systemImage: "bolt.trianglebadge.exclamationmark")
                            .font(.subheadline)
                            .foregroundStyle(f.contains("now") ? Color.red : Palette.up)
                    }
                }
            }
            if s.slow.checks.isEmpty {
                Text("Add your sites' URLs to HTTP_CHECKS in pi_dashboard.py to monitor them here.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(s.slow.checks) { ch in
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ch.label).font(.subheadline).lineLimit(1)
                        Text(ch.url).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                    Spacer(minLength: 8)
                    Text("\(Int(ch.ms ?? 0)) ms").font(.caption.monospacedDigit()).foregroundStyle(.secondary).fixedSize()
                    StatePill(text: ch.ok ? "up" : "down")
                }
            }
        }
    }

    // MARK: activity

    private var activity: some View {
        let events = store.analytics?.events ?? []
        return Card(title: "Activity", trailing: events.count > 5 ? AnyView(
            NavigationLink("See all") { ActivityView() }.font(.subheadline)
        ) : nil) {
            if events.isEmpty {
                Text("Deploys, restarts and failures will show up here.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(events.prefix(5)) { e in EventRow(event: e) }
        }
    }

    private func processes(_ p: [Proc]) -> some View {
        Card(title: "Top processes") {
            ForEach(p) { pr in
                HStack(spacing: 8) {
                    Text(pr.name).font(.subheadline.monospaced()).lineLimit(1)
                    Spacer(minLength: 8)
                    Text("\(pr.cpu)%").font(.caption.monospacedDigit()).foregroundStyle(Palette.cpu)
                        .frame(width: 48, alignment: .trailing)
                    Text("\(pr.mem)%").font(.caption.monospacedDigit()).foregroundStyle(Palette.mem)
                        .frame(width: 48, alignment: .trailing)
                }
            }
        }
    }
}

struct EventRow: View {
    let event: Analytics.Event

    private var icon: (String, Color) {
        switch event.kind {
        case "deploy": return ("arrow.up.circle.fill", Palette.cpu)
        case "rollback": return ("clock.arrow.circlepath", Palette.up)
        case "failure": return ("xmark.octagon.fill", Color.red)
        case "recovered": return ("checkmark.circle.fill", Palette.down)
        case "health": return (event.level == "error" ? "heart.slash.fill" : "heart.fill",
                               event.level == "error" ? Color.red : Palette.down)
        case "power": return ("power.circle.fill", Palette.up)
        case "boot", "start": return ("bolt.circle.fill", Palette.mem)
        default: return (event.level == "error" ? "exclamationmark.circle.fill" : "gearshape.circle.fill",
                         event.level == "error" ? Color.red : Palette.mem)
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon.0)
                .font(.title3)
                .foregroundStyle(icon.1)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.text).font(.subheadline).lineLimit(2)
                Text(event.date, format: .relative(presentation: .named))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }
}

struct ActivityView: View {
    @EnvironmentObject var store: PiStore

    var body: some View {
        List {
            ForEach(store.analytics?.events ?? []) { e in
                EventRow(event: e)
                    .listRowBackground(Color.white.opacity(0.06))
            }
        }
        .glassList()
        .navigationTitle("Activity")
    }
}
