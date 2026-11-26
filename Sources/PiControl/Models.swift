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

// MARK: - /api/analytics

struct Analytics: Decodable {
    let range: String
    let series: [Point]
    let cpuAvg: Double?
    let cpuPeak: Double?
    let instances: Instances
    let bandwidth: Bandwidth
    let trafficDays: [TrafficDay]
    let storage: Storage
    let power: Power
    let uptime: Uptime
    let events: [Event]

    struct Point: Decodable, Identifiable {
        let t: Double
        let cpu: Double
        let mem: Double?
        let temp: Double?
        var id: Double { t }
        var date: Date { Date(timeIntervalSince1970: t) }
    }

    struct Instances: Decodable {
        let running: Int
        let total: Int
        let failed: Int
        let containers: Int
    }

    struct Bandwidth: Decodable {
        let monthRx: Double
        let monthTx: Double
        let month: String
        let quota: Double?
        var total: Double { monthRx + monthTx }
    }

    struct TrafficDay: Decodable, Identifiable {
        let day: String
        let rx: Double
        let tx: Double
        var id: String { day }
        var date: Date {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            return f.date(from: day) ?? Date()
        }
    }

    struct Storage: Decodable {
        let items: [Item]?
        let total: Double?
        let used: Double?
        let free: Double?
        struct Item: Decodable, Identifiable {
            let label: String
            let bytes: Double
            var id: String { label }
        }
    }

    struct Power: Decodable {
        let wattsNow: Double
        let kwhMonth: Double
        let costMonth: Double
        let projectedCost: Double?
        let pricePerKwh: Double
        let monthFraction: Double
    }

    struct Uptime: Decodable {
        let percent7d: Double?
        let trackedSince: Double?
    }

    struct Event: Decodable, Identifiable {
        let t: Double
        let kind: String
        let text: String
        let level: String
        var id: String { "\(t)-\(text)" }
        var date: Date { Date(timeIntervalSince1970: t) }
    }
}
