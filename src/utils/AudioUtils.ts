function pad2(n: number): string {
    return n < 10 ? "0" + n : String(n);
}

function pad3(n: number): string {
    return n < 10 ? "00" + n : n < 100 ? "0" + n : String(n);
}

export function formatAudioTimestamp(time: number): string {
    const totalSeconds = Math.floor(time);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const hoursPrefix = hours > 0 ? pad2(hours) + ":" : "";
    return `${hoursPrefix}${pad2(minutes)}:${pad2(seconds)}`;
}

export function formatSrtTimestamp(time: number): string {
    const totalSeconds = Math.floor(time);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const milliseconds = Math.floor((time - totalSeconds) * 1000);

    return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${pad3(milliseconds)}`;
}

export function formatSrtTimeRange(start: number, end: number): string {
    return `${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`;
}

export function parseAudioTimestamp(timestamp: string): number | null {
    const trimmed = timestamp.trim();
    if (!trimmed) return null;

    const parts = trimmed.split(":");
    if (parts.length === 0 || parts.length > 3) return null;

    let seconds = 0;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i].trim();
        if (!part) return null;
        const value = parseFloat(part);
        if (isNaN(value) || !isFinite(value) || value < 0) return null;
        seconds = seconds * 60 + value;
    }
    return isFinite(seconds) && seconds >= 0 ? seconds : null;
}

const BLOCKED_HOSTNAMES = new Set([
    "localhost",
    "localtest.me",
    "vcap.me",
    "lvh.me",
    "router.asus.com",
    "tplinkwifi.net",
    "my.router",
]);

function isPrivateIPv4(ip: string): boolean {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
        return false;
    }
    const [a, b] = parts;

    // 0.0.0.0/8 (Current network / default route)
    if (a === 0) return true;
    // 10.0.0.0/8 (Private-use networks RFC 1918)
    if (a === 10) return true;
    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;
    // 100.64.0.0/10 (Carrier-grade NAT RFC 6598)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 169.254.0.0/16 (Link-local / cloud metadata RFC 3927)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12 (Private-use networks RFC 1918)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 (Private-use networks RFC 1918)
    if (a === 192 && b === 168) return true;
    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved / Future use)
    if (a >= 224) return true;

    return false;
}

function isPrivateIPv6(cleanHost: string): boolean {
    // Loopback (::1) and unspecified (::)
    if (
        cleanHost === "::1" ||
        cleanHost === "::" ||
        cleanHost === "0:0:0:0:0:0:0:1" ||
        cleanHost === "0:0:0:0:0:0:0:0"
    ) {
        return true;
    }
    // IPv4-mapped IPv6 (::ffff:x.x.x.x)
    const mappedMatch = cleanHost.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mappedMatch) {
        return isPrivateIPv4(mappedMatch[1]);
    }
    // Unique Local Address (ULA) fc00::/7 (fc00... or fd00...)
    if (/^f[cd][0-9a-f]{2}:/i.test(cleanHost)) {
        return true;
    }
    // Link-Local fe80::/10 (fe80... to febf...)
    if (/^fe[89ab][0-9a-f]:/i.test(cleanHost)) {
        return true;
    }
    return false;
}

/**
 * Checks if a hostname or IP address refers to a local, private, or internal network endpoint.
 * Detects IPv4 private ranges, link-local, loopback, IPv6 equivalents, and common local TLDs/aliases.
 */
export function isPrivateOrLocalHost(rawHostname: string): boolean {
    const hostname = rawHostname.toLowerCase().trim();
    const cleanHost = hostname.replace(/^\[|\]$/g, "");

    if (BLOCKED_HOSTNAMES.has(cleanHost) || BLOCKED_HOSTNAMES.has(hostname)) {
        return true;
    }

    // Common local, test, and private TLDs / wildcard DNS rebinding domains
    if (
        hostname.endsWith(".local") ||
        hostname.endsWith(".internal") ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".test") ||
        hostname.endsWith(".example") ||
        hostname.endsWith(".invalid") ||
        hostname.endsWith(".lan") ||
        hostname.endsWith(".home") ||
        hostname.endsWith(".corp") ||
        hostname.endsWith(".nip.io") ||
        hostname.endsWith(".sslip.io") ||
        hostname.endsWith(".localtest.me")
    ) {
        return true;
    }

    // Canonical dotted-decimal IPv4
    if (/^\d+\.\d+\.\d+\.\d+$/.test(cleanHost)) {
        return isPrivateIPv4(cleanHost);
    }

    // Integer or hexadecimal IP representation (e.g. 2130706433 or 0x7f000001)
    if (/^(0x[0-9a-f]+|\d+)$/i.test(cleanHost)) {
        return true;
    }

    // IPv6 address
    if (cleanHost.includes(":")) {
        return isPrivateIPv6(cleanHost);
    }

    return false;
}
