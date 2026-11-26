#!/usr/bin/env python3
"""
Pi Dashboard — a zero-dependency health & activity dashboard for a Raspberry Pi.

Run:   python3 pi_dashboard.py            (then open http://<pi-ip>:8088)
Needs: Python 3.7+ only. Docker / systemd / vcgencmd are used if present.

Edit the CONFIG section below to pin the services you care about and add
HTTP health checks for your web servers.
"""
import json, os, re, socket, subprocess, threading, time, shutil
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ============================ CONFIG ============================
PORT = int(os.environ.get("DASH_PORT", 8088))
BIND = os.environ.get("DASH_BIND", "0.0.0.0")

# systemd services to always show (even when stopped). Others that are
# running or failed are listed automatically.
WATCH_SERVICES = [
    # "nginx", "pihole-FTL", "ssh", "docker", "homebridge",
]

# HTTP health checks: (label, url). A 2xx/3xx response = healthy.
HTTP_CHECKS = [
    # ("Pi-hole", "http://localhost/admin/"),
    # ("Home Assistant", "http://localhost:8123"),
]

DISKS = ["/"]            # mount points to show; external drives e.g. "/mnt/usb"
SLOW_REFRESH_SEC = 10    # how often services/docker/ports/checks are polled

# Sites: static sites live in SITES_ROOT/<name>/ and can be deployed by uploading
# a .zip to POST /api/sites/<name>/deploy (needs the deploy token).
SITES_ROOT = os.environ.get("DASH_SITES_ROOT", "/var/www")
MAX_UPLOAD_MB = 200
KEEP_BACKUPS = 5         # previous versions kept per site for rollback

# Analytics estimates (edit to match your setup)
PRICE_PER_KWH = float(os.environ.get("DASH_PRICE_PER_KWH", 0.25))  # $/kWh
POWER_IDLE_W = 3.0       # approx. Pi 5 idle watts
POWER_MAX_W = 9.0        # approx. Pi 5 at 100% CPU
BANDWIDTH_QUOTA_GB = 0   # monthly cap to show progress against; 0 = none
# ================================================================


def sh(cmd, timeout=8):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip()
    except Exception as e:
        return 1, str(e)


def read(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip()
    except Exception:
        return default


# ---------------- fast metrics (computed per request) ----------------
_prev = {"cpu": None, "net": None, "t": None}
_lock = threading.Lock()


def cpu_times():
    out = []
    for line in read("/proc/stat").splitlines():
        if line.startswith("cpu"):
            p = line.split()
            vals = list(map(int, p[1:]))
            idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
            out.append((sum(vals), idle))
    return out  # [total, cpu0, cpu1, ...]


def net_bytes():
    rx = tx = 0
    per = {}
    for line in read("/proc/net/dev").splitlines()[2:]:
        name, data = line.split(":", 1)
        name = name.strip()
        if name == "lo" or name.startswith(("veth", "br-", "docker")):
            continue
        f = data.split()
        per[name] = (int(f[0]), int(f[8]))
        rx += int(f[0]); tx += int(f[8])
    return rx, tx, per


def temperature():
    t = read("/sys/class/thermal/thermal_zone0/temp")
    if t.isdigit():
        return round(int(t) / 1000, 1)
    code, out = sh("vcgencmd measure_temp")
    m = re.search(r"([\d.]+)", out) if code == 0 else None
    return float(m.group(1)) if m else None


THROTTLE_BITS = {
    0: "Under-voltage now", 1: "CPU freq capped now", 2: "Throttled now",
    3: "Soft temp limit now", 16: "Under-voltage since boot",
    17: "Freq capped since boot", 18: "Throttled since boot",
    19: "Soft temp limit since boot",
}


def throttling():
    if not shutil.which("vcgencmd"):
        return None
    code, out = sh("vcgencmd get_throttled")
    m = re.search(r"0x([0-9a-fA-F]+)", out)
    if code != 0 or not m:
        return None
    v = int(m.group(1), 16)
    return {"raw": hex(v), "flags": [msg for b, msg in THROTTLE_BITS.items() if v & (1 << b)]}


def memory():
    info = {}
    for line in read("/proc/meminfo").splitlines():
        k, v = line.split(":", 1)
        info[k] = int(v.split()[0]) * 1024
    total = info.get("MemTotal", 0)
    avail = info.get("MemAvailable", info.get("MemFree", 0))
    st, sf = info.get("SwapTotal", 0), info.get("SwapFree", 0)
    return {"total": total, "used": total - avail,
            "swap_total": st, "swap_used": st - sf}


def disks():
    res = []
    for m in DISKS:
        try:
            u = shutil.disk_usage(m)
            res.append({"mount": m, "total": u.total, "used": u.used})
        except Exception:
            pass
    return res


def top_processes(n=6):
    code, out = sh(f"ps -eo pid,comm,%cpu,%mem --sort=-%cpu --no-headers | head -n {n}")
    procs = []
    if code == 0:
        for line in out.splitlines():
            p = line.split(None, 3)
            if len(p) == 4:
                procs.append({"pid": p[0], "name": p[1], "cpu": p[2], "mem": p[3]})
    return procs


def fast_stats():
    now = time.time()
    cpu = cpu_times()
    rx, tx, per = net_bytes()
    with _lock:
        pc, pn, pt = _prev["cpu"], _prev["net"], _prev["t"]
        _prev.update(cpu=cpu, net=(rx, tx), t=now)
    usage, cores = None, []
    if pc and len(pc) == len(cpu):
        def pct(a, b):
            dt, di = a[0] - b[0], a[1] - b[1]
            return round(100 * (dt - di) / dt, 1) if dt > 0 else 0.0
        usage = pct(cpu[0], pc[0])
        cores = [pct(a, b) for a, b in zip(cpu[1:], pc[1:])]
    rx_rate = tx_rate = None
    if pn and pt and now > pt:
        rx_rate = max(0, (rx - pn[0]) / (now - pt))
        tx_rate = max(0, (tx - pn[1]) / (now - pt))
    load = read("/proc/loadavg").split()[:3]
    uptime = float(read("/proc/uptime", "0").split()[0])
    freq = read("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq")
    return {
        "time": now, "cpu": usage, "cores": cores, "load": load,
        "cpu_mhz": int(freq) // 1000 if freq.isdigit() else None,
        "temp": temperature(), "throttle": throttling(),
        "mem": memory(), "disks": disks(),
        "net": {"rx_rate": rx_rate, "tx_rate": tx_rate,
                "rx_total": rx, "tx_total": tx, "ifaces": list(per)},
        "uptime": uptime, "procs": top_processes(),
    }


# ---------------- slow metrics (background thread) ----------------
slow = {"services": [], "docker": None, "ports": [], "checks": [], "updated": 0}


def services():
    rows, seen = [], set()
    code, out = sh("systemctl list-units --type=service --all --no-legend --plain --no-pager")
    if code == 0:
        for line in out.splitlines():
            p = line.split(None, 4)
            if len(p) < 4:
                continue
            name = p[0].removesuffix(".service") if hasattr(str, "removesuffix") else p[0].replace(".service", "")
            active, sub = p[2], p[3]
            if sub == "running" or active == "failed" or name in WATCH_SERVICES:
                rows.append({"name": name, "active": active, "sub": sub,
                             "desc": p[4] if len(p) > 4 else "",
                             "pinned": name in WATCH_SERVICES})
                seen.add(name)
    for name in WATCH_SERVICES:
        if name not in seen:
            rows.append({"name": name, "active": "not-found", "sub": "missing",
                         "desc": "", "pinned": True})
    rows.sort(key=lambda r: (not r["pinned"], r["active"] != "failed", r["name"]))
    return rows


def docker_containers():
    if not shutil.which("docker"):
        return None
    code, out = sh("docker ps -a --format '{{json .}}'")
    if code != 0:
        return {"error": out[:200] or "docker not accessible (add user to docker group?)"}
    stats = {}
    c2, o2 = sh("docker stats --no-stream --format '{{json .}}'", timeout=15)
    if c2 == 0:
        for line in o2.splitlines():
            try:
                s = json.loads(line); stats[s.get("Name")] = s
            except Exception:
                pass
    rows = []
    for line in out.splitlines():
        try:
            c = json.loads(line)
        except Exception:
            continue
        s = stats.get(c.get("Names"), {})
        rows.append({"name": c.get("Names"), "image": c.get("Image"),
                     "state": c.get("State"), "status": c.get("Status"),
                     "ports": c.get("Ports"), "cpu": s.get("CPUPerc"),
                     "mem": s.get("MemUsage")})
    rows.sort(key=lambda r: (r["state"] != "running", r["name"] or ""))
    return {"containers": rows}


def listening_ports():
    code, out = sh("ss -tlnpH 2>/dev/null || ss -tlnp | tail -n +2")
    rows, seen = [], set()
    if code == 0:
        for line in out.splitlines():
            p = line.split()
            if len(p) < 4:
                continue
            addr = p[3]
            port = addr.rsplit(":", 1)[-1]
            host = addr.rsplit(":", 1)[0]
            m = re.search(r'\(\("([^"]+)"', line)
            proc = m.group(1) if m else ""
            key = (port, proc)
            if key in seen:
                continue
            seen.add(key)
            rows.append({"port": int(port) if port.isdigit() else port,
                         "addr": host, "proc": proc,
                         "local_only": host in ("127.0.0.1", "[::1]", "127.0.0.53%lo")})
    rows.sort(key=lambda r: r["port"] if isinstance(r["port"], int) else 99999)
    return rows


def http_checks():
    res = []
    for label, url in HTTP_CHECKS:
        t0 = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pi-dashboard"})
            with urllib.request.urlopen(req, timeout=4) as r:
                code = r.status
            ok = 200 <= code < 400
        except urllib.error.HTTPError as e:
            code, ok = e.code, e.code < 400
        except Exception as e:
            code, ok = str(e.__class__.__name__), False
        res.append({"label": label, "url": url, "ok": ok, "code": code,
                    "ms": round((time.time() - t0) * 1000)})
    return res


def slow_loop():
    while True:
        try:
            slow.update(services=services(), docker=docker_containers(),
                        ports=listening_ports(), checks=http_checks(),
                        updated=time.time())
        except Exception as e:
            slow["error"] = str(e)
        time.sleep(SLOW_REFRESH_SEC)


def static_info():
    model = read("/proc/device-tree/model").replace("\x00", "") or "Linux host"
    os_name = "Linux"
    for line in read("/etc/os-release").splitlines():
        if line.startswith("PRETTY_NAME="):
            os_name = line.split("=", 1)[1].strip('"')
    ips = []
    code, out = sh("hostname -I")
    if code == 0:
        ips = out.split()[:3]
    return {"hostname": socket.gethostname(), "model": model, "os": os_name,
            "kernel": os.uname().release, "ips": ips,
            "cores": os.cpu_count()}


# ---------------- analytics: history, traffic, storage, power, events ----------------
import collections, gzip

DATA_DIR = os.environ.get("DASH_DATA_DIR") or os.path.dirname(os.path.abspath(__file__))
SAMPLE_SEC = int(os.environ.get("DASH_SAMPLE_SEC", 30))
HISTORY_DAYS = 7
_hist = collections.deque(maxlen=HISTORY_DAYS * 86400 // SAMPLE_SEC)   # (t, cpu, mem%, temp, watts)
_daily = {}          # "YYYY-MM-DD" -> {"rx": bytes, "tx": bytes, "kwh": float, "up": seconds}
_events = collections.deque(maxlen=300)
_storage = {"items": [], "updated": 0}
_alock = threading.Lock()


def _data_path(name):
    return os.path.join(DATA_DIR, name)


def log_event(kind, text, level="info"):
    with _alock:
        _events.appendleft({"t": time.time(), "kind": kind, "text": text, "level": level})


def watts_for(cpu_pct):
    return POWER_IDLE_W + (POWER_MAX_W - POWER_IDLE_W) * max(0.0, min(100.0, cpu_pct or 0)) / 100


def _load_analytics():
    try:
        with gzip.open(_data_path("analytics.json.gz"), "rt") as f:
            d = json.load(f)
        _hist.extend(tuple(x) for x in d.get("hist", []))
        _daily.update(d.get("daily", {}))
        _events.extend(d.get("events", []))
    except FileNotFoundError:
        pass
    except Exception as e:
        print("analytics load failed:", e)


def _save_analytics():
    with _alock:
        d = {"hist": list(_hist), "daily": _daily, "events": list(_events)}
    tmp = _data_path("analytics.json.gz.tmp")
    try:
        with gzip.open(tmp, "wt") as f:
            json.dump(d, f, separators=(",", ":"))
        os.replace(tmp, _data_path("analytics.json.gz"))
    except Exception as e:
        print("analytics save failed:", e)


def _storage_breakdown():
    """Disk split by category (du is slow, so this runs rarely)."""
    try:
        u = shutil.disk_usage("/")
    except Exception:
        return
    cats = [("Sites", SITES_ROOT), ("Docker", "/var/lib/docker"), ("Logs", "/var/log"),
            ("Home", "/home"), ("Apps", "/opt")]
    items, counted = [], 0
    for label, path in cats:
        if not os.path.isdir(path):
            continue
        code, out = sh(f"du -sxb '{path}' 2>/dev/null | tail -n1", timeout=180)
        try:
            size = int(out.split()[0])
        except Exception:
            continue
        items.append({"label": label, "bytes": size})
        counted += size
    items.append({"label": "System", "bytes": max(0, u.used - counted)})
    items.sort(key=lambda x: -x["bytes"])
    _storage.update(items=items, total=u.total, used=u.used, free=u.free, updated=time.time())


def analytics_loop():
    _load_analytics()
    up = float(read("/proc/uptime", "0").split()[0])
    log_event("boot" if up < 600 else "start",
              "Pi booted" if up < 600 else "Dashboard service started")
    prev_cpu, prev_net, prev_t = cpu_times(), net_bytes()[:2], time.time()
    last_save = last_storage = 0
    failed_before = set()
    while True:
        time.sleep(SAMPLE_SEC)
        try:
            now = time.time()
            cpu = cpu_times()
            dt_all, di = cpu[0][0] - prev_cpu[0][0], cpu[0][1] - prev_cpu[0][1]
            cpu_pct = round(100 * (dt_all - di) / dt_all, 1) if dt_all > 0 else 0.0
            m = memory()
            mem_pct = round(100 * m["used"] / m["total"], 1) if m["total"] else 0.0
            rx, tx = net_bytes()[:2]
            drx = rx - prev_net[0] if rx >= prev_net[0] else rx   # counter reset after reboot
            dtx = tx - prev_net[1] if tx >= prev_net[1] else tx
            elapsed = min(now - prev_t, SAMPLE_SEC * 3)
            w = watts_for(cpu_pct)
            day = time.strftime("%Y-%m-%d", time.localtime(now))
            with _alock:
                _hist.append((round(now), cpu_pct, mem_pct, temperature(), round(w, 2)))
                dd = _daily.setdefault(day, {"rx": 0, "tx": 0, "kwh": 0.0, "up": 0})
                dd["rx"] += drx; dd["tx"] += dtx
                dd["kwh"] = round(dd["kwh"] + w * elapsed / 3600 / 1000, 6)
                dd["up"] += elapsed
                for k in sorted(_daily)[:-120]:
                    del _daily[k]
            prev_cpu, prev_net, prev_t = cpu, (rx, tx), now
            # service failures → events
            failed = {s["name"] for s in slow.get("services", []) if s.get("active") == "failed"}
            for n in failed - failed_before:
                log_event("failure", f"{n} failed", "error")
            for n in failed_before - failed:
                log_event("recovered", f"{n} recovered")
            failed_before = failed
            for c in slow.get("checks", []):
                key = "chk:" + c["url"]
                was = _check_state.get(key)
                if was is not None and was != c["ok"]:
                    log_event("health", f"{c['label']} is {'up' if c['ok'] else 'down'}",
                              "info" if c["ok"] else "error")
                _check_state[key] = c["ok"]
            if now - last_storage > 900:
                last_storage = now
                threading.Thread(target=_storage_breakdown, daemon=True).start()
            if now - last_save > 300:
                last_save = now
                _save_analytics()
        except Exception as e:
            print("analytics sample failed:", e)


_check_state = {}


def _bucket(series, start, step, idx):
    """Average column idx of samples into buckets of `step` seconds from `start`."""
    out = {}
    for row in series:
        if row[0] < start or row[idx] is None:
            continue
        b = int((row[0] - start) // step)
        s = out.setdefault(b, [0.0, 0])
        s[0] += row[idx]; s[1] += 1
    return out


def analytics(range_key="24h"):
    spans = {"1h": (3600, 60), "24h": (86400, 900), "7d": (7 * 86400, 5400)}
    span, step = spans.get(range_key, spans["24h"])
    now = time.time()
    start = now - span
    with _alock:
        hist = [r for r in _hist if r[0] >= start]
        daily = dict(_daily)
        events = list(_events)[:60]
    cpu_b, mem_b, tmp_b = (_bucket(hist, start, step, i) for i in (1, 2, 3))
    series = []
    for b in range(int(span // step)):
        if b in cpu_b:
            series.append({"t": round(start + (b + 0.5) * step),
                           "cpu": round(cpu_b[b][0] / cpu_b[b][1], 1),
                           "mem": round(mem_b[b][0] / mem_b[b][1], 1) if b in mem_b else None,
                           "temp": round(tmp_b[b][0] / tmp_b[b][1], 1) if b in tmp_b else None})
    cpus = [r[1] for r in hist]
    # traffic: last 14 days + month to date
    today = time.localtime(now)
    days = []
    for i in range(13, -1, -1):
        d = time.strftime("%Y-%m-%d", time.localtime(now - i * 86400))
        v = daily.get(d, {})
        days.append({"day": d, "rx": v.get("rx", 0), "tx": v.get("tx", 0)})
    month = time.strftime("%Y-%m", today)
    mtd = [v for k, v in daily.items() if k.startswith(month)]
    month_rx = sum(v["rx"] for v in mtd); month_tx = sum(v["tx"] for v in mtd)
    kwh = sum(v["kwh"] for v in mtd)
    import calendar
    dim = calendar.monthrange(today.tm_year, today.tm_mon)[1]
    frac = (today.tm_mday - 1 + (today.tm_hour * 3600 + today.tm_min * 60) / 86400) / dim
    tracked = sum(v["up"] for v in mtd) / 86400
    # projection: avg kWh per tracked day * days in month
    proj_kwh = kwh / tracked * dim if tracked > 0.02 else None
    # uptime over 7 days: time covered by samples (gaps > 3 samples = down)
    win = 7 * 86400
    covered, last = 0.0, None
    with _alock:
        ts = [r[0] for r in _hist if r[0] >= now - win]
    for t in ts:
        if last is not None and t - last <= SAMPLE_SEC * 3:
            covered += t - last
        last = t
    first = ts[0] if ts else now
    observed = max(now - first, 1)
    svc = slow.get("services", [])
    dk = (slow.get("docker") or {}).get("containers") or []
    running = sum(1 for s in svc if s.get("sub") == "running") + sum(1 for c in dk if c.get("state") == "running")
    total = len(svc) + len(dk)
    return {
        "range": range_key, "now": now, "series": series,
        "cpu_avg": round(sum(cpus) / len(cpus), 1) if cpus else None,
        "cpu_peak": max(cpus) if cpus else None,
        "instances": {"running": running, "total": total,
                      "failed": sum(1 for s in svc if s.get("active") == "failed"),
                      "containers": len(dk)},
        "bandwidth": {"month_rx": month_rx, "month_tx": month_tx, "month": month,
                      "quota": BANDWIDTH_QUOTA_GB * 1024 ** 3 if BANDWIDTH_QUOTA_GB else None},
        "traffic_days": days,
        "storage": _storage,
        "power": {"watts_now": round(watts_for(cpus[-1] if cpus else 0), 2),
                  "kwh_month": round(kwh, 3), "cost_month": round(kwh * PRICE_PER_KWH, 2),
                  "projected_cost": round(proj_kwh * PRICE_PER_KWH, 2) if proj_kwh else None,
                  "price_per_kwh": PRICE_PER_KWH, "month_fraction": round(frac, 3),
                  "estimate": True},
        "uptime": {"percent_week": round(min(100.0, 100 * covered / observed), 2) if len(ts) > 2 else None,
                   "tracked_since": first if ts else None},
        "events": events,
    }


# ---------------- sites: discovery + deploy API ----------------
import io, zipfile, tarfile, secrets, mimetypes, hmac
from urllib.parse import unquote, urlparse

SITE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")
_deploy_lock = threading.Lock()


def load_token():
    """Upload token: $DASH_TOKEN, else a random one saved next to the script."""
    if os.environ.get("DASH_TOKEN"):
        return os.environ["DASH_TOKEN"]
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deploy-token.txt")
    try:
        with open(path) as f:
            t = f.read().strip()
            if t:
                return t
    except FileNotFoundError:
        pass
    t = secrets.token_urlsafe(24)
    try:
        with open(path, "w") as f:
            f.write(t + "\n")
        os.chmod(path, 0o600)
    except Exception:
        pass
    print(f"Deploy token saved to {path}")
    return t


def dir_size(path):
    total = files = 0
    for root, dirs, fs in os.walk(path):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in fs:
            try:
                total += os.path.getsize(os.path.join(root, f)); files += 1
            except OSError:
                pass
    return total, files


def _parse_conf(path, kind):
    """Pull server names / ports / roots from an nginx or apache site file."""
    txt = read(path)
    txt = re.sub(r"#.*", "", txt)
    if kind == "nginx":
        names = re.findall(r"server_name\s+([^;]+);", txt)
        ports = re.findall(r"listen\s+(?:\[::\]:)?(?:[\d.]+:)?(\d+)", txt)
        roots = re.findall(r"\broot\s+([^;]+);", txt)
        proxies = re.findall(r"proxy_pass\s+([^;]+);", txt)
    else:
        names = re.findall(r"Server(?:Name|Alias)\s+(\S+)", txt, re.I)
        ports = re.findall(r"<VirtualHost[^>]*:(\d+)>", txt, re.I)
        roots = re.findall(r"DocumentRoot\s+\"?([^\"\n]+)\"?", txt, re.I)
        proxies = re.findall(r"ProxyPass\s+\S+\s+(\S+)", txt, re.I)
    names = sorted({n for line in names for n in line.split() if n not in ("_", "localhost")})
    return {"names": names, "ports": sorted(set(ports), key=int),
            "roots": sorted({r.strip() for r in roots}),
            "proxies": sorted({p.strip() for p in proxies})}


def list_sites():
    sites = []
    for kind, base in (("nginx", "/etc/nginx/sites-enabled"), ("nginx", "/etc/nginx/conf.d"),
                       ("apache", "/etc/apache2/sites-enabled")):
        if not os.path.isdir(base):
            continue
        for fn in sorted(os.listdir(base)):
            p = os.path.join(base, fn)
            if not os.path.isfile(p) or (base.endswith("conf.d") and not fn.endswith(".conf")):
                continue
            c = _parse_conf(p, kind)
            sites.append({"name": fn.rsplit(".conf", 1)[0], "source": kind, "config": p,
                          "domains": c["names"], "ports": c["ports"], "root": ", ".join(c["roots"]),
                          "proxy": ", ".join(c["proxies"]), "managed": False})
    # static folders under SITES_ROOT (managed = deployable through the API)
    if os.path.isdir(SITES_ROOT):
        for fn in sorted(os.listdir(SITES_ROOT)):
            p = os.path.join(SITES_ROOT, fn)
            if fn.startswith(".") or not os.path.isdir(p):
                continue
            size, files = dir_size(p)
            hist = site_history(fn)
            sites.append({"name": fn, "source": "folder", "root": p, "size": size, "files": files,
                          "managed": bool(SITE_NAME_RE.match(fn)),
                          "preview": f"/sites/{fn}/", "modified": os.path.getmtime(p),
                          "last_deploy": hist[0] if hist else None, "backups": len(hist)})
    # docker containers publishing ports
    dk = slow.get("docker") or {}
    for c in (dk.get("containers") or []):
        if c.get("ports"):
            sites.append({"name": c["name"], "source": "docker", "ports": sorted(set(
                re.findall(r":(\d+)->", c["ports"]))), "state": c["state"], "image": c["image"],
                "managed": False})
    return sites


def backups_dir(name):
    return os.path.join(SITES_ROOT, ".backups", name)


def site_history(name):
    d = backups_dir(name)
    if not os.path.isdir(d):
        return []
    out = []
    for fn in sorted(os.listdir(d), reverse=True):
        if fn.endswith(".tar.gz"):
            out.append({"id": fn[:-7], "size": os.path.getsize(os.path.join(d, fn))})
    return out


def _backup_current(name):
    """Snapshot the live site into .backups/<name>/<timestamp>.tar.gz; keep KEEP_BACKUPS."""
    live = os.path.join(SITES_ROOT, name)
    if not os.path.isdir(live) or not os.listdir(live):
        return None
    d = backups_dir(name)
    os.makedirs(d, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(d, stamp + ".tar.gz")
    with tarfile.open(path, "w:gz") as tf:
        tf.add(live, arcname=".")
    for old in site_history(name)[KEEP_BACKUPS:]:
        os.remove(os.path.join(d, old["id"] + ".tar.gz"))
    return stamp


def _swap_in(name, new_dir):
    live = os.path.join(SITES_ROOT, name)
    old = live + ".old-" + secrets.token_hex(4)
    if os.path.exists(live):
        os.rename(live, old)
    os.rename(new_dir, live)
    if os.path.exists(old):
        shutil.rmtree(old, ignore_errors=True)
    for root, dirs, files in os.walk(live):
        os.chmod(root, 0o755)
        for f in files:
            os.chmod(os.path.join(root, f), 0o644)
    if shutil.which("chown"):
        sh(f"id www-data >/dev/null 2>&1 && chown -R www-data:www-data '{live}'")


def deploy_zip(name, data):
    if not SITE_NAME_RE.match(name):
        raise ValueError("site name must be lowercase letters, numbers, - or _")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ValueError("upload must be a .zip file")
    members = [m for m in zf.infolist() if not m.filename.startswith("__MACOSX/")
               and not m.filename.endswith(".DS_Store")]
    if not members:
        raise ValueError("zip is empty")
    if sum(m.file_size for m in members) > MAX_UPLOAD_MB * 1024 * 1024 * 4:
        raise ValueError("unzipped size too large")
    # if everything sits in one top folder (zipping a folder), strip it
    tops = {m.filename.split("/", 1)[0] for m in members}
    strip = len(tops) == 1 and all("/" in m.filename for m in members)
    os.makedirs(SITES_ROOT, exist_ok=True)
    tmp = os.path.join(SITES_ROOT, f".incoming-{name}-{secrets.token_hex(4)}")
    os.makedirs(tmp)
    try:
        base = os.path.realpath(tmp)
        for m in members:
            rel = m.filename.split("/", 1)[1] if strip else m.filename
            if not rel or rel.endswith("/"):
                continue
            dest = os.path.realpath(os.path.join(tmp, rel))
            if not dest.startswith(base + os.sep):
                raise ValueError(f"unsafe path in zip: {m.filename}")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with zf.open(m) as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out)
        if not any(os.path.exists(os.path.join(tmp, f)) for f in ("index.html", "index.htm")):
            warn = "no index.html at the top level"
        else:
            warn = None
        with _deploy_lock:
            backup = _backup_current(name)
            _swap_in(name, tmp)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    size, files = dir_size(os.path.join(SITES_ROOT, name))
    log_event("deploy", f"Deployed {name} ({files} files)")
    return {"ok": True, "site": name, "files": files, "size": size, "backup": backup,
            "warning": warn, "url": f"/sites/{name}/"}


def rollback(name, backup_id=None):
    if not SITE_NAME_RE.match(name):
        raise ValueError("bad site name")
    hist = site_history(name)
    if not hist:
        raise ValueError("no backups for this site")
    bid = backup_id or hist[0]["id"]
    path = os.path.join(backups_dir(name), bid + ".tar.gz")
    if not re.match(r"^[\d-]+$", bid) or not os.path.isfile(path):
        raise ValueError("backup not found")
    tmp = os.path.join(SITES_ROOT, f".incoming-{name}-{secrets.token_hex(4)}")
    os.makedirs(tmp)
    with tarfile.open(path) as tf:
        base = os.path.realpath(tmp)
        for m in tf.getmembers():
            if not os.path.realpath(os.path.join(tmp, m.name)).startswith(base) or m.issym() or m.islnk():
                raise ValueError("unsafe backup")
        try:
            tf.extractall(tmp, filter="data")
        except TypeError:
            tf.extractall(tmp)
    with _deploy_lock:
        _backup_current(name)
        _swap_in(name, tmp)
    log_event("rollback", f"Rolled back {name} to {bid}")
    return {"ok": True, "site": name, "restored": bid}


# ---------------- remote control (token required) ----------------
UNIT_RE = re.compile(r"^[A-Za-z0-9@._:-]{1,100}$")


def control(req):
    """{"kind":"service"|"docker"|"system", "action":..., "name":...}"""
    kind, action, name = req.get("kind"), req.get("action"), str(req.get("name") or "")
    if kind == "service":
        if action not in ("start", "stop", "restart") or not UNIT_RE.match(name):
            raise ValueError("bad service action or name")
        if name.removesuffix(".service") in ("pi-dashboard",) and action == "stop":
            raise ValueError("refusing to stop the dashboard itself")
        code, out = sh(f"systemctl {action} {name}", timeout=30)
    elif kind == "docker":
        if action not in ("start", "stop", "restart") or not UNIT_RE.match(name):
            raise ValueError("bad docker action or name")
        code, out = sh(f"docker {action} {name}", timeout=60)
    elif kind == "system":
        if action in ("reboot", "shutdown"):
            log_event("power", f"{action.capitalize()} requested from app", "warn")
            _save_analytics()
        if action == "reboot":
            threading.Timer(2, lambda: sh("systemctl reboot")).start()
            return {"ok": True, "message": "rebooting in 2 seconds"}
        if action == "shutdown":
            threading.Timer(2, lambda: sh("systemctl poweroff")).start()
            return {"ok": True, "message": "shutting down in 2 seconds"}
        raise ValueError("bad system action")
    else:
        raise ValueError("kind must be service, docker or system")
    threading.Thread(target=lambda: slow.update(services=services(),
                     docker=docker_containers()), daemon=True).start()
    if code != 0:
        log_event("control", f"{action} {name} failed", "error")
        raise ValueError(out[:300] or f"{action} failed")
    log_event("control", f"{action.capitalize()}ed {name}" if action != "stop" else f"Stopped {name}")
    return {"ok": True, "message": f"{action} {name}: done"}


# ---------------- web server ----------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def authed(self):
        h = self.headers.get("Authorization", "")
        tok = h[7:] if h.startswith("Bearer ") else self.headers.get("X-Deploy-Token", "")
        return bool(tok) and hmac.compare_digest(tok, TOKEN)

    def send_json(self, obj, code=200):
        self.send(json.dumps(obj), code=code)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/control":
            if not self.authed():
                return self.send_json({"error": "missing or wrong deploy token"}, 401)
            length = int(self.headers.get("Content-Length") or 0)
            try:
                return self.send_json(control(json.loads(self.rfile.read(min(length, 4096)) or b"{}")))
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            except Exception as e:
                return self.send_json({"error": f"server error: {e}"}, 500)
        m = re.match(r"^/api/sites/([^/]+)/(deploy|rollback)$", path)
        if not m:
            return self.send_json({"error": "not found"}, 404)
        if not self.authed():
            return self.send_json({"error": "missing or wrong deploy token"}, 401)
        name, action = unquote(m.group(1)), m.group(2)
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD_MB * 1024 * 1024:
            return self.send_json({"error": f"upload over {MAX_UPLOAD_MB} MB"}, 413)
        body = self.rfile.read(length) if length else b""
        try:
            if action == "deploy":
                self.send_json(deploy_zip(name, body))
            else:
                bid = None
                if body:
                    try:
                        bid = json.loads(body).get("backup")
                    except Exception:
                        pass
                self.send_json(rollback(name, bid))
        except ValueError as e:
            self.send_json({"error": str(e)}, 400)
        except Exception as e:
            self.send_json({"error": f"server error: {e}"}, 500)

    def serve_site(self, path):
        m = re.match(r"^/sites/([^/]+)(/.*)?$", path)
        name, rest = unquote(m.group(1)), unquote(m.group(2) or "")
        if not SITE_NAME_RE.match(name):
            return self.send("not found", "text/plain", 404)
        if not rest:
            self.send_response(301); self.send_header("Location", f"/sites/{name}/")
            self.end_headers(); return
        root = os.path.realpath(os.path.join(SITES_ROOT, name))
        target = os.path.realpath(os.path.join(root, rest.lstrip("/")))
        if not (target == root or target.startswith(root + os.sep)):
            return self.send("forbidden", "text/plain", 403)
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            return self.send("not found", "text/plain", 404)
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        with open(target, "rb") as f:
            self.send(f.read(), ctype)

    def send(self, body, ctype="application/json", code=200):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/stats"):
            payload = fast_stats()
            payload.update(slow=slow, info=INFO)
            self.send(json.dumps(payload))
        elif self.path.startswith("/api/sites"):
            m = re.match(r"^/api/sites/([^/]+)/history$", urlparse(self.path).path)
            if m:
                self.send_json({"site": m.group(1), "backups": site_history(unquote(m.group(1)))})
            else:
                self.send_json({"sites": list_sites(), "sites_root": SITES_ROOT})
        elif self.path.startswith("/api/analytics"):
            from urllib.parse import parse_qs
            q = parse_qs(urlparse(self.path).query)
            self.send_json(analytics((q.get("range") or ["24h"])[0]))
        elif self.path.startswith("/api/auth-check"):
            self.send_json({"ok": self.authed()}, 200 if self.authed() else 401)
        elif self.path.startswith("/sites/"):
            self.serve_site(urlparse(self.path).path)
        elif self.path == "/manifest.json":
            self.send(json.dumps({"name": "Pi Control", "short_name": "Pi Control", "start_url": "/",
                                  "display": "standalone", "background_color": "#0d1117",
                                  "theme_color": "#0d1117",
                                  "icons": [{"src": "/icon.png", "sizes": "180x180", "type": "image/png"}]}),
                      "application/manifest+json")
        elif self.path == "/icon.png":
            import base64
            self.send(base64.b64decode(ICON_PNG), "image/png")
        elif self.path in ("/", "/index.html"):
            self.send(PAGE, "text/html; charset=utf-8")
        else:
            self.send("not found", "text/plain", 404)


PAGE = r"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pi Dashboard</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Pi Control">
<meta name="theme-color" content="#0d1117">
<link rel="apple-touch-icon" href="/icon.png"><link rel="icon" href="/icon.png">
<link rel="manifest" href="/manifest.json">
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--mute:#8b949e;
--ok:#3fb950;--warn:#d29922;--bad:#f85149;--acc:#58a6ff;--acc2:#bc8cff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;
flex-wrap:wrap;gap:8px 20px;align-items:baseline}
h1{font-size:18px;margin:0}.sub{color:var(--mute);font-size:12px}
#status{margin-left:auto;font-size:12px;color:var(--mute)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
main{padding:16px;display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:0 0 10px;
display:flex;justify-content:space-between}
.wide{grid-column:1/-1}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:14px}
.tile .v{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}
.tile .l{color:var(--mute);font-size:12px}
.bar{height:6px;background:#21262d;border-radius:3px;overflow:hidden;margin-top:6px}
.bar i{display:block;height:100%;background:var(--acc);border-radius:3px;transition:width .5s}
canvas{width:100%;height:90px;display:block}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:6px 4px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--mute);font-weight:500;font-size:12px}
tr:last-child td{border-bottom:none}
.pill{font-size:11px;padding:2px 8px;border-radius:10px;white-space:nowrap}
.p-ok{background:#12351d;color:var(--ok)}.p-bad{background:#3d1416;color:var(--bad)}
.p-warn{background:#3a2c0b;color:var(--warn)}.p-mute{background:#21262d;color:var(--mute)}
.mute{color:var(--mute)}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.cores{display:flex;gap:4px;margin-top:8px}.cores div{flex:1;height:28px;background:#21262d;
border-radius:3px;position:relative;overflow:hidden}.cores i{position:absolute;bottom:0;left:0;right:0;background:var(--acc)}
input{background:#0d1117;border:1px solid var(--line);color:var(--text);border-radius:6px;padding:4px 8px;font-size:12px;width:140px}
.legend{font-size:11px;color:var(--mute)}.legend b{font-weight:500}
.scroll{max-height:340px;overflow:auto}
.up{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-top:10px;align-items:end}
.up label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--mute)}
.up input{width:100%;font-size:13px;padding:7px 8px}
button{background:var(--acc);color:#0d1117;border:0;border-radius:6px;padding:8px 14px;font-weight:600;cursor:pointer}
button.ghost{background:#21262d;color:var(--text);padding:3px 10px;font-weight:500;font-size:12px}
button:disabled{opacity:.5}
.src{font-size:11px;padding:2px 7px;border-radius:10px;background:#1f2a3a;color:var(--acc)}
a{color:var(--acc);text-decoration:none}
header{padding-top:max(16px,env(safe-area-inset-top))}
.hdrbtns{display:flex;gap:6px;flex-wrap:wrap;width:100%}
.acts{white-space:nowrap}.acts button{margin:1px;padding:3px 8px}
#toast{position:fixed;left:50%;top:max(14px,env(safe-area-inset-top));transform:translateX(-50%);background:#21262d;border:1px solid var(--line);padding:9px 16px;border-radius:20px;font-size:13px;z-index:9;display:none;max-width:90vw}
</style></head><body>
<header><h1 id="host">Pi Dashboard</h1><span class="sub" id="meta"></span>
<span id="status"><span class="dot" id="dot"></span><span id="stxt">connecting…</span></span>
<span class="hdrbtns"><button class="ghost" id="lockbtn" data-act="token">🔒 Unlock controls</button>
<button class="ghost" data-act="sys" data-a="reboot">⟳ Reboot</button>
<button class="ghost" data-act="sys" data-a="shutdown">⏻ Shut down</button></span></header>
<div id="toast"></div>
<main>
<section class="card wide"><div class="tiles">
 <div class="tile"><div class="l">CPU</div><div class="v" id="cpu">–</div><div class="bar"><i id="cpub"></i></div><div class="cores" id="cores"></div></div>
 <div class="tile"><div class="l">Temperature</div><div class="v" id="temp">–</div><div class="bar"><i id="tempb"></i></div><div class="l" id="freq" style="margin-top:6px"></div></div>
 <div class="tile"><div class="l">Memory</div><div class="v" id="mem">–</div><div class="bar"><i id="memb"></i></div><div class="l" id="memd" style="margin-top:6px"></div></div>
 <div class="tile"><div class="l">Load avg (1/5/15)</div><div class="v" id="load" style="font-size:20px">–</div><div class="l" id="uptime" style="margin-top:8px"></div></div>
 <div class="tile"><div class="l">Network ↓ / ↑</div><div class="v" id="net" style="font-size:20px">–</div><div class="l" id="nett" style="margin-top:8px"></div></div>
 <div class="tile"><div class="l">Power / throttling</div><div class="v" id="thr" style="font-size:16px">–</div><div class="l" id="thrd" style="margin-top:6px"></div></div>
</div></section>

<section class="card"><h2>CPU & temperature <span class="legend"><b style="color:var(--acc)">■</b> CPU % <b style="color:var(--warn)">■</b> °C</span></h2><canvas id="c1"></canvas></section>
<section class="card"><h2>Network <span class="legend"><b style="color:var(--ok)">■</b> down <b style="color:var(--acc2)">■</b> up</span></h2><canvas id="c2"></canvas></section>

<section class="card"><h2>Storage</h2><div id="disks"></div></section>
<section class="card"><h2>Health checks</h2><div id="checks"></div></section>

<section class="card wide"><h2>Sites hosted on this Pi <span class="legend" id="siteroot"></span></h2>
<div class="scroll" id="sites"><span class="mute">loading…</span></div>
<details style="margin-top:12px"><summary style="cursor:pointer;color:var(--acc)">⬆ Upload / update a site</summary>
<div class="up">
 <label>Site name<input id="upname" placeholder="e.g. jevs-auto" autocapitalize="off"></label>
 <label>Site .zip<input id="upfile" type="file" accept=".zip,application/zip"></label>
 <label>Deploy token<input id="uptoken" type="password" placeholder="from deploy-token.txt"></label>
 <button id="upbtn">Deploy</button>
</div><div id="upmsg" class="mute" style="margin-top:8px;font-size:12px">Zip the folder that contains index.html. The current version is backed up first, so you can roll back.</div>
</details></section>

<section class="card wide"><h2>Services <span><input id="filter" placeholder="filter…"></span></h2><div class="scroll" id="svcs"></div></section>
<section class="card wide" id="dockcard"><h2>Docker containers</h2><div class="scroll" id="docker"></div></section>
<section class="card"><h2>Listening ports</h2><div class="scroll" id="ports"></div></section>
<section class="card"><h2>Top processes</h2><div id="procs"></div></section>
</main>
<script>
const $=id=>document.getElementById(id);
const H=120, hist={cpu:[],temp:[],rx:[],tx:[]};
const fmtB=b=>{if(b==null)return'–';const u=['B','KB','MB','GB','TB'];let i=0;while(b>=1024&&i<4){b/=1024;i++}return b.toFixed(b<10&&i?1:0)+' '+u[i]};
const fmtUp=s=>{const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return(d?d+'d ':'')+h+'h '+m+'m'};
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const col=(v,w,b)=>v>=b?'var(--bad)':v>=w?'var(--warn)':'var(--ok)';
function bar(id,pct,w,b){const e=$(id);e.style.width=Math.min(100,pct)+'%';e.style.background=col(pct,w,b)}
function push(a,v){a.push(v);if(a.length>H)a.shift()}
function draw(cv,series,maxFn){const dpr=devicePixelRatio||1,W=cv.clientWidth,Ht=cv.clientHeight;
 cv.width=W*dpr;cv.height=Ht*dpr;const g=cv.getContext('2d');g.scale(dpr,dpr);
 g.strokeStyle='#21262d';g.lineWidth=1;for(let i=1;i<4;i++){g.beginPath();g.moveTo(0,Ht*i/4);g.lineTo(W,Ht*i/4);g.stroke()}
 series.forEach(s=>{const d=s.data,mx=s.max||maxFn()||1;if(d.length<2)return;g.beginPath();
  d.forEach((v,i)=>{const x=W*(i+H-d.length)/(H-1),y=Ht-2-(Ht-4)*Math.min(1,(v||0)/mx);i?g.lineTo(x,y):g.moveTo(x,y)});
  g.strokeStyle=s.c;g.lineWidth=1.6;g.stroke()})}
function pill(state){const s=String(state);
 const cls=/^(running|active|up|ok)/i.test(s)?'p-ok':/fail|exited|dead|missing|not-found|error|down/i.test(s)?'p-bad':/restart|activat|paused|created/i.test(s)?'p-warn':'p-mute';
 return `<span class="pill ${cls}">${esc(s)}</span>`}
let last=null;
const getTok=()=>{try{return localStorage.getItem('deployToken')||''}catch(e){return ''}};
const setTok=t=>{try{localStorage.setItem('deployToken',t)}catch(e){};const u=$('uptoken');if(u)u.value=t;lockUI()};
function lockUI(){const b=$('lockbtn');if(b)b.textContent=getTok()?'🔓 Controls on':'🔒 Unlock controls'}
function toast(m){const t=$('toast');t.innerHTML=m;t.style.display='block';clearTimeout(toast.h);toast.h=setTimeout(()=>t.style.display='none',3500)}
function acts(kind,name,running){const n=esc(name);
 return (running?`<button class="ghost" data-act="${kind}" data-a="stop" data-n="${n}">■</button>`:`<button class="ghost" data-act="${kind}" data-a="start" data-n="${n}">▶</button>`)+`<button class="ghost" data-act="${kind}" data-a="restart" data-n="${n}">⟳</button>`}
async function control(kind,action,name){let t=getTok();
 if(!t){t=prompt('Paste your deploy token (sudo cat /opt/pi-dashboard/deploy-token.txt):');if(!t)return;setTok(t.trim());t=t.trim()}
 if(kind==='system'&&!confirm(action==='reboot'?'Reboot the Pi? Sites go offline for ~1 minute.':'Shut down the Pi? You will need to replug it to turn it back on.'))return;
 if(kind!=='system'&&action==='stop'&&!confirm('Stop '+name+'?'))return;
 toast('⏳ '+action+' '+esc(name||'Pi')+'…');
 try{const r=await fetch('/api/control',{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify({kind,action,name})});
  const d=await r.json();if(r.status===401){setTok('');toast('⚠️ Token rejected — tap Unlock controls');return}
  toast(r.ok?'✓ '+esc(d.message):'⚠️ '+esc(d.error));setTimeout(tick,1500);setTimeout(tick,4000)}
 catch(e){toast('⚠️ '+esc(String(e)))}}
document.addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(!b)return;const a=b.dataset.act;
 if(a==='token'){const t=prompt('Deploy token (leave empty to lock):',getTok());if(t!==null)setTok(t.trim());return}
 if(a==='sys')return control('system',b.dataset.a,'');
 control(a,b.dataset.a,b.dataset.n)});
lockUI();
function render(d){
 const i=d.info;$('host').textContent=i.hostname;document.title=i.hostname+' · Pi Dashboard';
 $('meta').textContent=`${i.model} · ${i.os} · ${i.ips.join(', ')}`;
 if(d.cpu!=null){$('cpu').textContent=d.cpu.toFixed(0)+'%';bar('cpub',d.cpu,60,85);push(hist.cpu,d.cpu)}
 $('cores').innerHTML=d.cores.map(c=>`<div title="${c}%"><i style="height:${c}%;background:${col(c,60,85)}"></i></div>`).join('');
 if(d.temp!=null){$('temp').textContent=d.temp+'°C';bar('tempb',d.temp/85*100,70,88);push(hist.temp,d.temp)}
 $('freq').textContent=d.cpu_mhz?d.cpu_mhz+' MHz':'';
 const m=d.mem,mp=m.used/m.total*100;$('mem').textContent=mp.toFixed(0)+'%';bar('memb',mp,75,90);
 $('memd').textContent=`${fmtB(m.used)} / ${fmtB(m.total)}`+(m.swap_total?` · swap ${fmtB(m.swap_used)}`:'');
 $('load').textContent=d.load.join(' · ');$('uptime').textContent='up '+fmtUp(d.uptime)+` · ${i.cores} cores`;
 const n=d.net;if(n.rx_rate!=null){$('net').textContent=fmtB(n.rx_rate)+'/s · '+fmtB(n.tx_rate)+'/s';push(hist.rx,n.rx_rate);push(hist.tx,n.tx_rate)}
 $('nett').textContent=`total ↓${fmtB(n.rx_total)} ↑${fmtB(n.tx_total)} · ${n.ifaces.join(', ')}`;
 const t=d.throttle;if(!t){$('thr').innerHTML='<span class="mute">n/a</span>';$('thrd').textContent='vcgencmd not found'}
 else if(!t.flags.length){$('thr').innerHTML=pill('ok');$('thrd').textContent='No under-voltage or throttling'}
 else{const now=t.flags.some(f=>f.includes('now'));$('thr').innerHTML=`<span class="pill ${now?'p-bad':'p-warn'}">${now?'issue now':'past issue'}</span>`;$('thrd').textContent=t.flags.join(', ')}
 draw($('c1'),[{data:hist.cpu,c:'#58a6ff',max:100},{data:hist.temp,c:'#d29922',max:90}]);
 draw($('c2'),[{data:hist.rx,c:'#3fb950'},{data:hist.tx,c:'#bc8cff'}],()=>Math.max(...hist.rx,...hist.tx,1024));
 $('disks').innerHTML=d.disks.map(k=>{const p=k.used/k.total*100;return `<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between"><span class="mono">${esc(k.mount)}</span><span class="mute">${fmtB(k.used)} / ${fmtB(k.total)} · ${p.toFixed(0)}%</span></div><div class="bar"><i style="width:${p}%;background:${col(p,80,92)}"></i></div></div>`}).join('');
 const s=d.slow;
 $('checks').innerHTML=s.checks.length?'<table>'+s.checks.map(c=>`<tr><td>${esc(c.label)}<div class="mute mono">${esc(c.url)}</div></td><td>${pill(c.ok?'up':'down')}</td><td class="mute">${esc(c.code)} · ${c.ms} ms</td></tr>`).join('')+'</table>':'<span class="mute">None configured — add URLs to HTTP_CHECKS in pi_dashboard.py</span>';
 const f=$('filter').value.toLowerCase();
 const sv=s.services.filter(x=>!f||(x.name+x.desc).toLowerCase().includes(f));
 const failed=s.services.filter(x=>x.active==='failed').length;
 $('svcs').innerHTML=`<div class="mute" style="margin-bottom:6px">${s.services.length} shown · ${failed?`<b style="color:var(--bad)">${failed} failed</b>`:'none failed'}</div><table><tr><th>Service</th><th>State</th><th>Description</th><th></th></tr>`+
  sv.map(x=>`<tr><td class="mono">${x.pinned?'★ ':''}${esc(x.name)}</td><td>${pill(x.active==='active'?x.sub:x.active)}</td><td class="mute">${esc(x.desc)}</td><td class="acts">${acts('service',x.name,x.sub==='running')}</td></tr>`).join('')+'</table>';
 const dk=s.docker;
 if(dk==null){$('dockcard').style.display='none'}
 else if(dk.error){$('docker').innerHTML=`<span class="mute">${esc(dk.error)}</span>`}
 else $('docker').innerHTML=dk.containers.length?'<table><tr><th>Name</th><th>State</th><th>CPU</th><th>Memory</th><th>Ports</th><th></th></tr>'+dk.containers.map(c=>`<tr><td><b>${esc(c.name)}</b><div class="mute mono">${esc(c.image)}</div></td><td>${pill(c.state)}<div class="mute" style="font-size:11px;margin-top:3px">${esc(c.status)}</div></td><td>${esc(c.cpu||'–')}</td><td class="mono">${esc(c.mem||'–')}</td><td class="mono mute">${esc(c.ports)}</td><td class="acts">${acts('docker',c.name,c.state==='running')}</td></tr>`).join('')+'</table>':'<span class="mute">No containers</span>';
 $('ports').innerHTML='<table><tr><th>Port</th><th>Process</th><th>Bound to</th></tr>'+s.ports.map(p=>`<tr><td class="mono"><b>${esc(p.port)}</b></td><td>${esc(p.proc)||'<span class="mute">(run as root to see)</span>'}</td><td class="mono mute">${esc(p.addr)}${p.local_only?' (local)':''}</td></tr>`).join('')+'</table>';
 $('procs').innerHTML='<table><tr><th>Process</th><th>CPU%</th><th>Mem%</th></tr>'+d.procs.map(p=>`<tr><td class="mono">${esc(p.name)} <span class="mute">${p.pid}</span></td><td>${p.cpu}</td><td>${p.mem}</td></tr>`).join('')+'</table>';
}
async function tick(){
 try{const r=await fetch('/api/stats');const d=await r.json();last=d;render(d);
  $('dot').style.background='var(--ok)';$('stxt').textContent='live · '+new Date().toLocaleTimeString()}
 catch(e){$('dot').style.background='var(--bad)';$('stxt').textContent='offline — retrying'}
}
$('filter').oninput=()=>last&&render(last);
const ago=t=>{const s=Date.now()/1000-t;return s<90?'just now':s<5400?Math.round(s/60)+' min ago':s<129600?Math.round(s/3600)+' h ago':Math.round(s/86400)+' d ago'};
function stampAgo(id){const m=id.match(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/);if(!m)return id;return ago(new Date(+m[1],m[2]-1,+m[3],+m[4],+m[5],+m[6]).getTime()/1000)}
async function loadSites(){
 try{const r=await fetch('/api/sites');const d=await r.json();$('siteroot').textContent='uploads go to '+d.sites_root;
  const host=location.hostname;
  $('sites').innerHTML=d.sites.length?'<table><tr><th>Site</th><th>Type</th><th>Where</th><th></th></tr>'+d.sites.map(x=>{
   let where='',link='';
   if(x.source==='folder'){where=`<span class="mono mute">${esc(x.root)}</span><div class="mute" style="font-size:11px">${x.files} files · ${fmtB(x.size)} · updated ${ago(x.modified)}${x.backups?` · ${x.backups} backup${x.backups>1?'s':''}`:''}</div>`;link=`<a href="${x.preview}" target="_blank">open ↗</a>`}
   else if(x.source==='docker'){where=`<span class="mono mute">${esc(x.image)}</span>`;link=x.ports.map(p=>`<a href="http://${host}:${p}" target="_blank">:${p} ↗</a>`).join(' ')}
   else{where=`${x.domains.length?esc(x.domains.join(', ')):'<span class="mute">any host</span>'}<div class="mute mono" style="font-size:11px">${esc(x.root||x.proxy||'')}</div>`;link=(x.ports.length?x.ports:['80']).map(p=>`<a href="http://${host}${p==='80'?'':':'+p}" target="_blank">:${p} ↗</a>`).join(' ')}
   const rb=x.managed&&x.backups?` <button class="ghost" onclick="doRollback('${x.name}')">rollback</button>`:'';
   return `<tr><td><b>${esc(x.name)}</b></td><td><span class="src">${x.source}</span>${x.state?' '+pill(x.state):''}</td><td>${where}</td><td style="white-space:nowrap">${link}${rb}</td></tr>`}).join('')+'</table>'
   :'<span class="mute">No sites found yet — upload one below.</span>'}
 catch(e){$('sites').innerHTML='<span class="mute">could not load sites</span>'}}
try{$('uptoken').value=localStorage.getItem('deployToken')||''}catch(e){}
$('uptoken').onchange=()=>{try{localStorage.setItem('deployToken',$('uptoken').value)}catch(e){}};
$('upbtn').onclick=async()=>{const n=$('upname').value.trim().toLowerCase(),f=$('upfile').files[0],t=$('uptoken').value.trim();
 if(!n||!f||!t){$('upmsg').textContent='Fill in the name, pick a .zip and paste the token.';return}
 $('upbtn').disabled=true;$('upmsg').textContent='Uploading '+f.name+'…';
 try{const r=await fetch('/api/sites/'+encodeURIComponent(n)+'/deploy',{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/zip'},body:f});
  const d=await r.json();$('upmsg').innerHTML=r.ok?`<span style="color:var(--ok)">✓ Deployed ${esc(d.site)}</span> — ${d.files} files${d.warning?' · ⚠ '+esc(d.warning):''} · <a href="${d.url}" target="_blank">open ↗</a>`:`<span style="color:var(--bad)">✗ ${esc(d.error)}</span>`;loadSites()}
 catch(e){$('upmsg').textContent='Upload failed: '+e}
 $('upbtn').disabled=false};
async function doRollback(n){const t=$('uptoken').value.trim();if(!t){$('upmsg').textContent='Paste the deploy token in the upload form first.';document.querySelector('details').open=true;return}
 if(!confirm('Roll '+n+' back to its previous version?'))return;
 const r=await fetch('/api/sites/'+n+'/rollback',{method:'POST',headers:{'Authorization':'Bearer '+t}});const d=await r.json();
 $('upmsg').innerHTML=r.ok?`<span style="color:var(--ok)">✓ ${esc(n)} restored to version from ${stampAgo(d.restored)}</span>`:`<span style="color:var(--bad)">✗ ${esc(d.error)}</span>`;loadSites()}
loadSites();setInterval(loadSites,15000);
tick();setInterval(tick,2000);
</script></body></html>"""

ICON_PNG = "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAAG2UlEQVR4Xu2dvY5dNRSFPRHNzIiCJki5EkUoEM0kFWUKxJPwDrQUtDR5Ah4jNIgHoII0hIIG6c4bzEyLgkeHk/Pn7W17e9leX33OnXuvP6217TOTXHz8yaeuPJdX1+V/yEA83N8ZfNqPyv0MClGO+XdbTpT8ctAJY6YvPLsl2eSgE9XJbkkGOagFGn5F0oMkSQ5qgUy6Ik/UH49mNEHKMmmSI+XnEXvUERKdHDSjURQLFyeH4gcQHGKXT1orsa9LMImqGFFy0IzOEC5oWA7hC5G2kCxrQA7JS5BGCS5uODnIsBzJETSLtM7xEu/KQTMG4WCht+WgGUOxt9ycOcguG3IwNgZkc9GXctCMYVkvPWuFyGqFsTE4CwGYHESQHIwN4twHGjA5iCA5CFnwmBzsFDIxycBaIawVEs/75GCnkAVeCdYKYa2QeJgcZD85OHCQTS6vrqV/1NQfX//4t/xD/frd5/KLu+Hi6el5Nx/mgCgVJIygS89yZBdij15F6VAOMyfWdGZJV3JU1GJON4r0IAeIE/0FSdtywGrRR5C0KkcTWrSuSJMnpM2Z4VyT77mxQ7AWtfC8e/3q2enknLs9nyXnKAi0lBztmjHHK9IEbSRH61q8e/1q7Qd+hDSQHJ2ZMYEfIehytG7GMeB+4NZKH1osCmUN8pQKmhx9mCEHM0IQk8PMDOFDEPX7CcbGYkpFG1HhTkjVKyFBaMMx8ncYJYcHyg8sOeTfexRZnFhz/G4VZqD5ASRHdjMKOSGxRG0GlB8ocuQ1w0yLOfOPkCgHSL9AyJHRjCpaLBRJNwMkPxB3Kzqqa+HxbwNzaxpL/XOOLLEBYsZElk1HdcMq10q6GWhaLEhf4Cye6aiZHN2b4Zx78/Mb3cJMpOulpqYciYBnhnPu97d/ZPGjFtVqJSU28LWYzJh4efMiJQOqlEud5BjNDO9KygKniKWmjhxqWsyMiUQ/7Kkghzo2mjbDk+KHfXhYy6E2ow9e3rxI+SDGfljLoaaD2JjMSBk+LDGVQx0bPZnhUfthGR6mcujoz4xEP8ywk0MdG/j4w649EueMNWbhYSeHDvzYODbjGHW52AAtRwdmBGMD2Q8jObrslGBmBM1QY9MsRnIoAI+NjGbAhoeFHP3FRkYz1BiEh4UcCpBjo4QZmOEBKke7lJsz7Ckuh6JT2o2NFDMU4VG6WYrL0RPGh13VoRxSRjMD8X9qwuwUGzMUzVKUssmhGDgACW5PKlJ07CgrRwcEzUgZQsHBkgOtU+zNgGqWfv5WNoWgBJt0nBme0eXQaeFc/2Yg7lYsoRnHFJw5wLcq3ZhRbsNSUI5YLKdRZDNwZlIgOcxANgOKEeUgQoaTQx0b6z+c757h5CByKAfZhXIQykHiYXIQJgeJZ7jkSHmUmnJviwwnB5Ezohy6ANDd1TRAclg+xY1d6djrUyj3lDWWgnJYPmVVIF9v+ZVVKPcUt6Ac+EhWXXJNr4z+a4J+7Tefxo2shWd0OTz0YBOsWrGcSTHBmUZH/wVjckzZ5ADfsHRAua0KYnKM3CxQnYIoB8GhbK2Qpikuh2LsGLNZFJ1SdOBgrZAjiieHjtHCQxEbBljIoWgWEqR0p0DXyjjhgRkbdnIowkNxS6MoMkBxiwLEB2/jaDFxez4D5geWHANqMffDOayKsRhIPcGFD14wArfnc7AyghfkAiI5qMUCv/zVi+bi6el5LtEkLPYg1OKYtR9msWG3W9mEZgSRtEw5rJPDuffhQS0UPDudLGPDuRpykFaw262Q5oDYrQT58qeb4DUTf377VnLxL99Lrnrkmx9EF//z1Rei6/7js9/+kl9chQozRxRRWsw5UCRKizkHikRpMQdZEdYK2QVaDnVsOLd7rzo2nNu9Vx0bziXdWxpoOUhdKAdps1ZIXZgchMlB4mFykDaTQ3jWucnevcKzzk327k05yEq5tzRMDrIL+vG5J+o0TJg3UadhwryJOg1DzgxPG3KQKrBWSJsDKakLk4MwOUg8Tx7u7+LvIv3zcH/HWiGsFRIPk4McJgfHDrLAK8HkIJw5SDyPycFmIROTDKwVwloh8fyfHGwW4twHGrBWiKxWGB6DsxCAyUFkybGoHDIU697YSA6Wy4BsLjprhYhrxcPwGIq95d5NDvoxCAcLfVQr9KN7jpeYMweJnDkmGB4dE1zccHIEX4K0iGRZw3Jw89IfEjOcE/8Lxv7lLq+u+/umhkKohUeUHBxB+iDKjGg5WDHtEmtGRK3MYcW0hUILTa2sFSHgqM1QJsdiBOGUikmKFp4M/98KWwaNdC2yyeGZ3hCDpBa5nJjIkBwLaIkx2Z0oKMdiIvEwTvJSTog5/wKfjWCYI1bFNAAAAABJRU5ErkJggg=="

INFO = static_info()
TOKEN = load_token()

def install():
    """sudo python3 pi_dashboard.py --install  → runs on boot as a service."""
    import sys
    if os.geteuid() != 0:
        sys.exit("Run with sudo:  sudo python3 pi_dashboard.py --install")
    os.makedirs("/opt/pi-dashboard", exist_ok=True)
    dest = "/opt/pi-dashboard/pi_dashboard.py"
    shutil.copy(os.path.abspath(__file__), dest)
    with open("/etc/systemd/system/pi-dashboard.service", "w") as f:
        f.write("[Unit]\nDescription=Pi Dashboard\nAfter=network-online.target\n\n"
                f"[Service]\nExecStart=/usr/bin/python3 {dest}\nRestart=always\n\n"
                "[Install]\nWantedBy=multi-user.target\n")
    os.system("systemctl daemon-reload && systemctl enable pi-dashboard >/dev/null 2>&1 "
              "&& systemctl restart pi-dashboard")
    time.sleep(2)
    ok = os.system("systemctl is-active --quiet pi-dashboard") == 0
    print("\n" + ("✅ Pi Dashboard is running and will start on boot." if ok
                  else "⚠️  Service didn't start — check: journalctl -u pi-dashboard"))
    for ip in INFO["ips"]:
        print(f"   Open:  http://{ip}:{PORT}")
    print(f"   Or:    http://{INFO['hostname']}.local:{PORT}")
    print(f"   Deploy token:  sudo cat /opt/pi-dashboard/deploy-token.txt  (created on first start)")
    print(f"   Edit settings: sudo nano {dest}  then  sudo systemctl restart pi-dashboard\n")


if __name__ == "__main__":
    import sys
    if "--install" in sys.argv:
        install(); sys.exit()
    fast_stats()  # prime CPU/net deltas
    threading.Thread(target=slow_loop, daemon=True).start()
    threading.Thread(target=analytics_loop, daemon=True).start()
    import atexit, signal
    atexit.register(_save_analytics)
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    print(f"Pi Dashboard on http://{INFO['ips'][0] if INFO['ips'] else 'localhost'}:{PORT}")
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
