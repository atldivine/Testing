import Foundation
import Security

enum APIError: LocalizedError {
    case badURL
    case noToken
    case server(String)

    var errorDescription: String? {
        switch self {
        case .badURL: return "The server address looks wrong. Check it in Settings."
        case .noToken: return "Add your deploy token in Settings first."
        case .server(let m): return m
        }
    }
}

/// Talks to pi_dashboard.py running on the Raspberry Pi.
struct API {
    var baseURL: String
    var token: String

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    var normalizedBase: String {
        var b = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if !b.lowercased().hasPrefix("http") { b = "http://" + b }
        while b.hasSuffix("/") { b.removeLast() }
        return b
    }

    var host: String { URL(string: normalizedBase)?.host ?? "" }

    func url(_ path: String) throws -> URL {
        guard let u = URL(string: normalizedBase + path) else { throw APIError.badURL }
        return u
    }

    func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        var req = URLRequest(url: try url(path))
        req.timeoutInterval = 8
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(data, resp)
        return try API.decoder.decode(T.self, from: data)
    }

    func post(_ path: String, body: Data?, contentType: String) async throws -> APIResult {
        guard !token.isEmpty else { throw APIError.noToken }
        var req = URLRequest(url: try url(path))
        req.httpMethod = "POST"
        req.timeoutInterval = 180
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(data, resp)
        return try API.decoder.decode(APIResult.self, from: data)
    }

    private func check(_ data: Data, _ resp: URLResponse) throws {
        guard let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) else { return }
        let msg = (try? API.decoder.decode(APIResult.self, from: data))?.error ?? "Server returned \(http.statusCode)"
        throw APIError.server(msg)
    }

    // MARK: actions

    func control(kind: String, action: String, name: String = "") async throws -> APIResult {
        let body = try JSONSerialization.data(withJSONObject: ["kind": kind, "action": action, "name": name])
        return try await post("/api/control", body: body, contentType: "application/json")
    }

    func deploy(site: String, zip: Data) async throws -> APIResult {
        try await post("/api/sites/\(site)/deploy", body: zip, contentType: "application/zip")
    }

    func rollback(site: String) async throws -> APIResult {
        try await post("/api/sites/\(site)/rollback", body: nil, contentType: "application/json")
    }

    /// true = server reachable and token accepted
    func authCheck() async throws -> Bool {
        var req = URLRequest(url: try url("/api/auth-check"))
        req.timeoutInterval = 8
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (_, resp) = try await URLSession.shared.data(for: req)
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }
}

/// Stores the deploy token in the iOS Keychain instead of plain settings.
enum Keychain {
    private static let service = "PiControl"

    static func get(_ key: String) -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ key: String, _ value: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}

enum Fmt {
    static func bytes(_ b: Double?) -> String {
        guard let b else { return "–" }
        return ByteCountFormatter.string(fromByteCount: Int64(b), countStyle: .binary)
    }
    static func rate(_ b: Double?) -> String { b == nil ? "–" : bytes(b) + "/s" }
    static func uptime(_ s: Double) -> String {
        let d = Int(s) / 86400, h = Int(s) % 86400 / 3600, m = Int(s) % 3600 / 60
        return (d > 0 ? "\(d)d " : "") + "\(h)h \(m)m"
    }
    static func ago(_ t: Double?) -> String {
        guard let t else { return "" }
        return RelativeDateTimeFormatter().localizedString(for: Date(timeIntervalSince1970: t), relativeTo: Date())
    }
}
