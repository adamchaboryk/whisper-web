# Security Architecture & Features

This document outlines the security architecture, threat model mitigations, and privacy protections implemented in this application. This is a **100% client-side Web application**. All model downloads, audio decodings, neural network inferences, and text manipulations execute strictly within the user's browser.

---

## 1. Strictly Local Processing & Zero Server-Sided Footprint

### 100% In-Browser Execution
- **No Remote Backend**: There are zero application servers, backend databases, or cloud processing APIs handling user audio or transcripts. The site is delivered as a static Single Page Application (SPA).
- **On-Device Machine Learning**: Neural network inference is executed directly on the user's device using:
  - **WebGPU / WGSL** for high-performance hardware acceleration (e.g., NVIDIA Parakeet TDT 0.6B V2 via `parakeet.wgsl`).
  - **ONNX Runtime Web WebAssembly (WASM)** with SIMD multi-threading for OpenAI Whisper models (via Hugging Face Transformers.js).
- **Audio Privacy**: Audio tracks captured from files, microphone streams, or downloaded media never leave the user's device. Audio buffers are decoded directly into floating-point PCM memory using the Web Audio API (`OfflineAudioContext` / `AudioContext`) and passed to an isolated Web Worker via memory transfer.
- **Air-Gapped & Offline Capable**: Once application assets and model weights are retrieved and cached, the application functions without an internet connection.

### On-Device Summarization (Zero Cloud API)
- The transcript summarization engine integrates directly with the experimental **Chrome Built-in AI Summarizer API** (`window.Summarizer` powered by on-device Gemini Nano).
- Text is never transmitted to external LLM providers (e.g., OpenAI, Anthropic, or external Gemini endpoints). If the host browser does not feature native on-device summarization, the capability gracefully disables.

---

## 2. Cryptographic Model Verification & Supply Chain Integrity

To defend against upstream CDN compromises, DNS spoofing, or tampering with external weight repositories, external models undergo cryptographic pinning and validation:

### Immutable SHA-256 Manifest Pinning
In [`src/worker.js`](https://github.com/adamchaboryk/whisper-web/tree/main/src/worker.js#L4-L18), manifest URLs for Parakeet models are frozen with cryptographically verified SHA-256 content hashes:

```javascript
const PARAKEET_MODEL_URLS = Object.freeze({
  fp16: "https://parakeet-wgsl-models.narcotic.sh/v1/fp16/11a359db3d050fd82b002c745b24a5280f3ff13a76834b548df671c95c786c65/manifest.json",
  fp32: "https://parakeet-wgsl-models.narcotic.sh/v1/fp32/28dee836aefc2bfb01236fda6d10e1df7447724d2489040168549999ea267b1b/manifest.json",
});
```

### Runtime Integrity Assertion
Before worker initialization or model instantiation, the application performs an active assertion check comparing the package defaults against the hardcoded cryptographic hashes:

```javascript
if (
  DEFAULT_MODEL_URLS.fp16 !== PARAKEET_MODEL_URLS.fp16 ||
  DEFAULT_MODEL_URLS.fp32 !== PARAKEET_MODEL_URLS.fp32
) {
  throw new Error(
    "Parakeet model URL integrity check failed: manifest URLs do not match pinned SHA-256 hashes.",
  );
}
```
If an upstream dependency, CDN redirect, or dependency injection attempts to supply an unverified model manifest, the worker halts immediately.

---

## 3. Cross-Site Scripting (XSS) & DOM-Clobbering Protections

Transcripts can display user-supplied text, editable HTML blocks, and imported SRT/VTT files. Multiple layers of sanitization ensure malicious payloads cannot execute.

### Strict Subtitle Tag Allowlisting
In [`src/utils/SubtitleUtils.ts`](https://github.com/adamchaboryk/whisper-web/tree/main/src/utils/SubtitleUtils.ts#L20-L130), `sanitizeHTML` implements a strict parser that removes all executable tags, attributes, and handlers:
- **Allowed Tags**: Only standard typographic formatting tags essential to subtitles are permitted: `<b>`, `<strong>`, `<i>`, `<em>`, `<u>`, `<br>`, `<p>`, `<div>`.
- **Strict Attribute Stripping**: All inline event handlers (`onload`, `onerror`, `onclick`), scripting attributes, and dangerous link tags (`<a>`, `<script>`, `<iframe>`, `<object>`, `<embed>`, `<svg>`, `<img>`) are stripped.
- **Explicit Text Node Escaping**: Text nodes are escaped against HTML entities (`&amp;`, `&lt;`, `&gt;`).

### DOM-Clobbering Protection
Standard DOM parsers iterating over `element.childNodes` can be manipulated by malicious inputs containing form elements (e.g., `<input name="childNodes">` or `<form name="parentNode">`) that clobber DOM tree properties. `sanitizeHTML` explicitly utilizes linked-list pointer traversal to remain clobber-proof:

```typescript
// Use linked-list traversal rather than Array.from(el.childNodes)
// to prevent DOM-clobbered form controls (e.g. <input name="childNodes">)
// from breaking iteration or throwing uncaught exceptions.
let child = node.firstChild;
while (child) {
  inner += walk(child);
  child = child.nextSibling;
}
```

### Sanitized Subtitle & File Imports
When importing external SRT or VTT subtitle files in [`parseSubtitleFile`](https://github.com/adamchaboryk/whisper-web/tree/main/src/utils/SubtitleUtils.ts#L188-L200), each line is filtered through `sanitizeHTML` prior to state commitment:
```typescript
while (i < lines.length && lines[i].trim() !== "") {
  const cleanText = sanitizeHTML(lines[i]);
  textChunk += (textChunk ? "\n" : "") + cleanText;
  i++;
}
```

---

## 4. Client-Side SSRF & Intranet Scanning Prevention

When users load media from a remote URL, the browser issues a `fetch` request. If unconstrained, this could be abused as an intranet port scanner or metadata harvester (Server-Side Request Forgery executed in client context).

### Comprehensive Hostname & IP Filtering
In [`src/utils/AudioUtils.ts`](https://github.com/adamchaboryk/whisper-web/tree/main/src/utils/AudioUtils.ts#L51-L160), `isPrivateOrLocalHost` inspects the target URL before any network connection is initiated:

| Target Category | Blocked Ranges / Examples |
|---|---|
| **Private IPv4 (RFC 1918)** | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` |
| **Loopback Addresses** | `127.0.0.0/8`, `::1`, `localhost`, `0.0.0.0/8` |
| **Cloud Metadata Services (RFC 3927)** | `169.254.0.0/16` (e.g., AWS/GCP/Azure `169.254.169.254`) |
| **Carrier-Grade NAT (RFC 6598)** | `100.64.0.0/10` |
| **Multicast & Reserved** | `224.0.0.0/4`, `240.0.0.0/4` |
| **IPv6 Specials & Mapped** | IPv4-mapped IPv6 (`::ffff:x.x.x.x`), ULA (`fc00::/7`), Link-Local (`fe80::/10`) |
| **Alternative Formats** | Hexadecimal IP (`0x7f000001`), Decimal integer IP (`2130706433`) |
| **Internal & Private TLDs** | `.local`, `.internal`, `.localhost`, `.lan`, `.home`, `.corp` |
| **DNS Rebinding Resolvers** | `*.nip.io`, `*.sslip.io`, `*.localtest.me` |
| **Common Gateway Portals** | `router.asus.com`, `tplinkwifi.net`, `my.router` |

### Protocol Enforcement
The URL parser enforces that only `http:` and `https:` schemes are accepted, blocking dangerous URI schemes such as `file:`, `blob:`, `javascript:`, and `data:` from being evaluated as remote audio.

---

## 5. Denial of Service (DoS) & Resource Exhaustion Mitigations

Client-side machine learning and media processing can stress system memory and compute. Several explicit guardrails protect device stability:

### 1. Audio Duration & Memory Ceiling
In [`src/components/AudioManager.tsx`](https://github.com/adamchaboryk/whisper-web/tree/main/src/components/AudioManager.tsx#L40):
```typescript
const MAX_AUDIO_DURATION_SECONDS = 4 * 60 * 60; // 4 hours maximum
```
Files exceeding 4 hours are rejected before allocation to prevent Out-Of-Memory (OOM) browser tab crashes.

### 2. Decompression Bomb Detection
Compressed audio containers (e.g., high-compression AAC/Opus) can be crafted as "audio bombs" that decompress into tens of gigabytes of raw uncompressed floating-point audio data. In [`AudioManager.tsx`](https://github.com/adamchaboryk/whisper-web/tree/main/src/components/AudioManager.tsx#L41):
```typescript
const MIN_BYTES_PER_SECOND = 1000; // ~8 kbps minimum threshold for long audio (>30m)
```
If an audio file longer than 30 minutes exhibits an abnormally low byte-to-duration ratio, it is flagged as a suspected decompression bomb and rejected before full buffer expansion.

### 3. Bounded Sanitization Cache
To prevent memory exhaustion via unique HTML payloads, `sanitizeCache` in [`src/utils/SubtitleUtils.ts`](https://github.com/adamchaboryk/whisper-web/tree/main/src/utils/SubtitleUtils.ts#L1) is bounded to a maximum of 2,000 entries with FIFO eviction.

---

## 6. Memory Sandboxing & Complete Data Lifecycle Management

### Threaded Sandboxing (Web Workers)
- All neural network models and matrix math execute within an isolated Web Worker (`src/worker.js`).
- If an inference step experiences an unrecoverable WebGPU or WebAssembly exception, the main UI thread remains intact.

### Memory Lifecycle & Blob Revocation
- In-memory object URLs (`blob:...`) used for audio playback and subtitle downloads are revoked immediately upon component unmount or stream completion via `URL.revokeObjectURL(blobUrl)`.

### User-Controlled Storage Deletion
In [`src/components/modal/Modal.tsx`](https://github.com/adamchaboryk/whisper-web/tree/main/src/components/modal/Modal.tsx#L27-L62), users can completely wipe all local application data on demand:
- **Hugging Face Cache**: Clears `transformers-cache` from the browser `CacheStorage`.
- **Parakeet Model Cache**: Clears `parakeet.wgsl:models:*` entries.
- **Origin Private File System (OPFS)**: Removes the `parakeet-wgsl-audio-decoding` working directory.
- **Local Settings & Storage**: Wipes all stored application settings and caches.

---

## 7. Privacy & Permissions Management

- **Microphone Access**: Microphone audio is captured exclusively via `navigator.mediaDevices.getUserMedia` upon explicit user activation of the Record modal. When recording stops, all media tracks are explicitly terminated (`track.stop()`), extinguishing the hardware recording indicator immediately.
- **Clipboard Access**: Copying transcripts to the clipboard is only executed during explicit user-initiated click events via `navigator.clipboard.writeText`.
- **Zero Cookies & Third-Party Trackers**: The application uses no HTTP cookies, no third-party tracking scripts, and no marketing beacons.

---

## 8. Custom Text Replacement Dictionary Security

The custom text replacement dictionary is an auxiliary, non-critical feature that allows users to configure automated word and phrase replacements across transcripts. Because custom dictionaries may contain sensitive or proprietary terms (e.g., patient names, internal project code words, legal terminology, or confidential phrases), the following security controls are implemented:

### 1. AES-256-GCM Encrypted LocalStorage
In [`src/hooks/useEncryptedDictionary.ts`](https://github.com/adamchaboryk/whisper-web/tree/main/src/hooks/useEncryptedDictionary.ts#L46-L82), user-defined vocabulary entries are encrypted at rest using the **W3C Web Crypto API** (`crypto.subtle`):

- **Algorithm**: `AES-GCM` with a 256-bit key length (`{ name: "AES-GCM", length: 256 }`).
- **Cryptographic Key Isolation**: A dedicated cryptographic key is generated on the client via `crypto.subtle.generateKey` and stored in JWK format per browser profile.
- **Unique Initialization Vectors (IV)**: Every write operation generates a fresh, non-deterministic 96-bit (12-byte) initialization vector using a cryptographically secure pseudorandom number generator:
  ```typescript
  const iv = crypto.getRandomValues(new Uint8Array(12));
  ```
- **Authenticated Encryption**: AES-GCM provides both confidentiality and data integrity; any tampering or bit-flipping of ciphertext in `localStorage` fails decryption cleanly and reverts safely to defaults without leaking malformed data.
- **No Plaintext Leaks**: Sensitive dictionary terms are never stored in unencrypted browser storage.

### 2. ReDoS (Regular Expression Denial of Service) Prevention
When applying custom dictionary replacements across transcripts in [`src/worker.js`](https://github.com/adamchaboryk/whisper-web/tree/main/src/worker.js#L649-L651), user input strings are strictly sanitized before constructing dynamic regular expressions:
```javascript
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const replaceWord = (text, target, replacement) =>
  text.replace(new RegExp(`\\b${escapeRegExp(target)}\\b`, "gi"), replacement);
```
This prevents malicious or malformed regex character patterns from triggering catastrophic backtracking in the worker thread.

### 3. CSV Injection / Formula Injection Mitigation
When importing and exporting dictionary entries in [`src/hooks/useEncryptedDictionary.ts`](https://github.com/adamchaboryk/whisper-web/tree/main/src/hooks/useEncryptedDictionary.ts#L116-L125), values are parsed and escaped according to RFC 4180 (`"${value.replace(/"/g, '""')}"`):
- All fields are explicitly wrapped in quotes upon CSV export, preventing formula injection payloads (`=cmd|...`, `@SUM(...)`, `+`, `-`) from executing if the exported file is opened in external spreadsheet applications (e.g., Microsoft Excel, Google Sheets, LibreOffice Calc).
- The CSV parser strictly validates row values and generates cryptographically secure entry identifiers using `crypto.randomUUID()`.
