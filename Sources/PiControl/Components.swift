import SwiftUI

// MARK: - Colors

enum Palette {
    static let cpu = Color(red: 0.36, green: 0.82, blue: 1.0)      // sky
    static let mem = Color(red: 0.74, green: 0.55, blue: 1.0)      // lilac
    static let down = Color(red: 0.32, green: 0.92, blue: 0.75)    // mint
    static let up = Color(red: 1.0, green: 0.72, blue: 0.38)       // amber
    static let storage: [Color] = [
        Color(red: 0.36, green: 0.82, blue: 1.0), Color(red: 0.74, green: 0.55, blue: 1.0),
        Color(red: 0.32, green: 0.92, blue: 0.75), Color(red: 1.0, green: 0.72, blue: 0.38),
        Color(red: 1.0, green: 0.48, blue: 0.62), Color(white: 0.75),
    ]
}

func levelColor(_ v: Double, warn: Double, bad: Double) -> Color {
    v >= bad ? Color(red: 1, green: 0.42, blue: 0.42) : v >= warn ? Palette.up : Palette.down
}

// MARK: - Background (static mesh = cheap to render, gives the glass something to refract)

struct AppBackground: View {
    var body: some View {
        Group {
            if #available(iOS 18.0, *) {
                MeshGradient(
                    width: 3, height: 3,
                    points: [
                        [0, 0], [0.5, 0], [1, 0],
                        [0, 0.5], [0.62, 0.42], [1, 0.5],
                        [0, 1], [0.5, 1], [1, 1],
                    ],
                    colors: [
                        Color(red: 0.06, green: 0.07, blue: 0.18), Color(red: 0.20, green: 0.15, blue: 0.46), Color(red: 0.05, green: 0.26, blue: 0.40),
                        Color(red: 0.10, green: 0.09, blue: 0.26), Color(red: 0.13, green: 0.30, blue: 0.48), Color(red: 0.30, green: 0.14, blue: 0.42),
                        Color(red: 0.03, green: 0.05, blue: 0.12), Color(red: 0.07, green: 0.16, blue: 0.28), Color(red: 0.05, green: 0.05, blue: 0.13),
                    ]
                )
            } else {
                LinearGradient(colors: [Color(red: 0.08, green: 0.08, blue: 0.22), Color(red: 0.05, green: 0.2, blue: 0.32), Color(red: 0.03, green: 0.04, blue: 0.1)],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
            }
        }
        .ignoresSafeArea()
    }
}

// MARK: - Glass

#if compiler(>=6.2)
extension View {
    /// Clear Liquid Glass on iOS 26+, frosted material on older iOS.
    @ViewBuilder
    func glassCard(_ radius: CGFloat = 26) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        if #available(iOS 26.0, *) {
            self
                .background(Color.black.opacity(0.14), in: shape)   // dim layer keeps text readable on clear glass
                .glassEffect(.clear, in: shape)
        } else {
            self.background(.ultraThinMaterial, in: shape)
                .overlay(shape.strokeBorder(Color.white.opacity(0.14), lineWidth: 0.6))
        }
    }

    @ViewBuilder
    func glassPill() -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.clear.interactive(), in: Capsule())
        } else {
            self.background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 0.6))
        }
    }
}
#else
extension View {
    func glassCard(_ radius: CGFloat = 26) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return self.background(.ultraThinMaterial, in: shape)
            .overlay(shape.strokeBorder(Color.white.opacity(0.14), lineWidth: 0.6))
    }

    func glassPill() -> some View {
        self.background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 0.6))
    }
}
#endif

extension View {
    /// Shared styling for List-based screens on the glass background.
    func glassList() -> some View {
        self.scrollContentBackground(.hidden)
            .background(AppBackground())
    }
}

// MARK: - Building blocks

struct Card<Content: View>: View {
    let title: String
    var trailing: AnyView? = nil
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.headline)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 8)
                if let trailing { trailing }
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .glassCard()
    }
}

struct KPICard: View {
    let title: String
    let icon: String
    let value: String
    var unit: String = ""
    var caption: String = ""
    var badge: (String, Color)? = nil
    var progress: Double? = nil      // 0...1
    var tint: Color = Palette.cpu

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(tint)
                Text(title)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 4)
                if let badge {
                    Text(badge.0)
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .foregroundStyle(badge.1)
                        .background(badge.1.opacity(0.16), in: Capsule())
                        .fixedSize()
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(.system(.title, design: .rounded).weight(.semibold).monospacedDigit())
                    .contentTransition(.numericText())
                if !unit.isEmpty {
                    Text(unit).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            if let p = progress {
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.12))
                        Capsule().fill(tint).frame(width: max(4, g.size.width * min(max(p, 0), 1)))
                    }
                }
                .frame(height: 5)
            }
            if !caption.isEmpty {
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, minHeight: 118, alignment: .topLeading)
        .padding(14)
        .glassCard(22)
    }
}

struct StatePill: View {
    let text: String

    var color: Color {
        let t = text.lowercased()
        if ["running", "active", "up", "ok"].contains(where: { t.hasPrefix($0) }) { return Palette.down }
        if ["fail", "exited", "dead", "down", "missing", "error"].contains(where: { t.contains($0) }) { return Color(red: 1, green: 0.42, blue: 0.42) }
        if ["restart", "activat", "paused", "created"].contains(where: { t.contains($0) }) { return Palette.up }
        return .gray
    }

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .foregroundStyle(color)
            .background(color.opacity(0.16), in: Capsule())
            .fixedSize()
    }
}

struct LegendDot: View {
    let color: Color
    let label: String
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

struct OfflineBanner: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "wifi.exclamationmark").foregroundStyle(Palette.up)
            VStack(alignment: .leading, spacing: 3) {
                Text("Can't reach the Pi").font(.subheadline.weight(.semibold))
                Text(message).font(.caption).foregroundStyle(.secondary)
                Text("Away from home? Turn on Tailscale and use the Pi's Tailscale address in Settings.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(14)
        .glassCard(20)
    }
}
