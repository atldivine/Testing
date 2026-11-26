import Foundation

/// Decodes a JSON value that may be a string or a number into a String.
struct FlexString: Decodable, Hashable {
    let value: String
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { value = s }
        else if let i = try? c.decode(Int.self) { value = String(i) }
        else if let d = try? c.decode(Double.self) { value = String(d) }
        else if let b = try? c.decode(Bool.self) { value = String(b) }
        else { value = "" }
    }
}

// MARK: - /api/stats

struct Stats: Decodable {
    let cpu: Double?
    let cores: [Double]
    let load: [String]
    let cpuMhz: Int?
    let temp: Double?
    let throttle: Throttle?
    let mem: Mem
    let disks: [Disk]
    let net: Net
    let uptime: Double
    let procs: [Proc]
    let info: Info
    let slow: Slow
}

struct Throttle: Decodable { let raw: String; let flags: [String] }

struct Mem: Decodable {
    let total: Double
    let used: Double
    let swapTotal: Double
    let swapUsed: Double
}

struct Disk: Decodable, Identifiable {
    let mount: String
    let total: Double
    let used: Double
    var id: String { mount }
    var pct: Double { total > 0 ? used / total * 100 : 0 }
}

struct Net: Decodable {
    let rxRate: Double?
    let txRate: Double?
    let rxTotal: Double
    let txTotal: Double
    let ifaces: [String]
}

struct Proc: Decodable, Identifiable {
    let pid: String
    let name: String
    let cpu: String
    let mem: String
    var id: String { pid }
}

struct Info: Decodable {
    let hostname: String
    let model: String
    let os: String
    let kernel: String
    let ips: [String]
    let cores: Int?
}

struct Slow: Decodable {
    let services: [Service]
    let docker: Docker?
    let checks: [Check]
}

struct Service: Decodable, Identifiable {
    let name: String
    let active: String
    let sub: String
    let desc: String
    let pinned: Bool
    var id: String { name }
    var isRunning: Bool { sub == "running" }
    var isFailed: Bool { active == "failed" }
}

struct Docker: Decodable {
    let containers: [Container]?
    let error: String?
}

struct Container: Decodable, Identifiable {
    let name: String?
    let image: String?
    let state: String?
    let status: String?
    let ports: String?
    let cpu: String?
    let mem: String?
    var id: String { name ?? image ?? "?" }
    var isRunning: Bool { state == "running" }
}

struct Check: Decodable, Identifiable {
    let label: String
    let url: String
    let ok: Bool
    let code: FlexString
    let ms: Double?
    var id: String { url }
}

// MARK: - /api/sites

struct SitesResponse: Decodable {
    let sites: [Site]
    let sitesRoot: String
}

struct Site: Decodable, Identifiable {
    let name: String
    let source: String
    let root: String?
    let size: Double?
    let files: Int?
    let managed: Bool?
    let preview: String?
    let modified: Double?
    let backups: Int?
    let domains: [String]?
    let ports: [String]?
    let proxy: String?
    let state: String?
    let image: String?
    var id: String { source + ":" + name }
}

// MARK: - POST results

struct APIResult: Decodable {
    let ok: Bool?
    let error: String?
    let message: String?
    let site: String?
    let files: Int?
    let warning: String?
    let url: String?
    let restored: String?
}

struct Sample: Identifiable {
    let id = UUID()
    let t: Date
    let v: Double
}
