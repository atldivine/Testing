import SwiftUI

func levelColor(_ v: Double, warn: Double, bad: Double) -> Color {
    v >= bad ? .red : v >= warn ? .orange : .green
}

struct Card<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(white: 0.11), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(white: 0.2), lineWidth: 1))
    }
}

struct StatTile: View {
    let label: String
    let value: String
    var detail: String = ""
    var progress: Double? = nil   // 0...100
    var color: Color = .cyan
    var icon: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(label, systemImage: icon)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title2.weight(.semibold).monospacedDigit())
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if let p = progress {
                ProgressView(value: min(max(p, 0), 100), total: 100).tint(color)
            }
            if !detail.isEmpty {
                Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(white: 0.11), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(white: 0.2), lineWidth: 1))
    }
}

struct StatePill: View {
    let text: String

    var color: Color {
        let t = text.lowercased()
        if ["running", "active", "up", "ok"].contains(where: { t.hasPrefix($0) }) { return .green }
        if ["fail", "exited", "dead", "down", "missing", "error"].contains(where: { t.contains($0) }) { return .red }
        if ["restart", "activat", "paused", "created"].contains(where: { t.contains($0) }) { return .orange }
        return .gray
    }

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .foregroundStyle(color)
            .background(color.opacity(0.15), in: Capsule())
    }
}

struct OfflineBanner: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "wifi.exclamationmark").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Can't reach the Pi").font(.subheadline.weight(.semibold))
                Text(message).font(.caption).foregroundStyle(.secondary)
                Text("Away from home? Turn on Tailscale and use the Pi's Tailscale address in Settings.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }
}
