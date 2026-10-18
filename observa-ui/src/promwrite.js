// Agent metrics intake helpers: parse the Prometheus text format strictly, and write samples to
// Prometheus with the remote-write protocol (protobuf + snappy), with no extra dependencies.
// Pure functions except writeToPrometheus; unit-tested in tests/promwrite.test.js.

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Parse "name{a="b",...} value [timestamp_ms]" lines. Comments are skipped.
// Returns { series: [{ name, labels: {..}, value, ts }], errors: [line numbers] }.
// Values that are not finite numbers are refused (never stored as 0).
export function parseExposition(text, { maxSeries = 20000, maxLabels = 30, maxValueLen = 256 } = {}) {
  const series = [];
  const errors = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line[0] === '#') continue;
    if (series.length >= maxSeries) { errors.push({ line: i + 1, reason: 'too many series' }); break; }
    const r = parseLine(line, maxLabels, maxValueLen);
    if (r.err) errors.push({ line: i + 1, reason: r.err });
    else series.push(r);
  }
  return { series, errors };
}

function parseLine(line, maxLabels, maxValueLen) {
  let i = 0;
  while (i < line.length && /[a-zA-Z0-9_:]/.test(line[i])) i++;
  const name = line.slice(0, i);
  if (!NAME_RE.test(name)) return { err: 'bad metric name' };
  const labels = {};
  if (line[i] === '{') {
    i++;
    let n = 0;
    for (;;) {
      while (line[i] === ' ' || line[i] === ',') i++;
      if (line[i] === '}') { i++; break; }
      const s = i;
      while (i < line.length && /[a-zA-Z0-9_]/.test(line[i])) i++;
      const key = line.slice(s, i);
      if (!LABEL_RE.test(key) || line[i] !== '=' || line[i + 1] !== '"') return { err: 'bad label' };
      i += 2;
      let val = '';
      for (;;) {
        if (i >= line.length) return { err: 'unterminated label value' };
        const c = line[i];
        if (c === '\\') {
          const nx = line[i + 1];
          val += nx === 'n' ? '\n' : nx;
          i += 2;
        } else if (c === '"') { i++; break; } else { val += c; i++; }
      }
      if (val.length > maxValueLen) return { err: 'label value too long' };
      if (key in labels) return { err: 'duplicate label' };
      labels[key] = val;
      if (++n > maxLabels) return { err: 'too many labels' };
    }
  }
  const rest = line.slice(i).trim().split(/\s+/);
  if (rest.length < 1 || rest.length > 2) return { err: 'bad value' };
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(rest[0])) return { err: 'value is not a finite number' };
  const value = Number(rest[0]);
  if (!Number.isFinite(value)) return { err: 'value is not a finite number' };
  let ts = null;
  if (rest[1] !== undefined) {
    if (!/^\d{1,15}$/.test(rest[1])) return { err: 'bad timestamp' };
    ts = Number(rest[1]);
  }
  return { name, labels, value, ts };
}

// ---------------- protobuf (just what prompb.WriteRequest needs) ----------------
function varint(n, out) {
  // n is a non-negative integer that fits in 2^53
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
}
function lenDelim(field, bytes, out) {
  out.push((field << 3) | 2);
  varint(bytes.length, out);
  for (const b of bytes) out.push(b);
}
const utf8 = (s) => Buffer.from(s, 'utf8');

function encodeLabel(name, value) {
  const out = [];
  lenDelim(1, utf8(name), out);
  lenDelim(2, utf8(value), out);
  return out;
}
function encodeSample(value, ts) {
  const out = [];
  out.push((1 << 3) | 1); // double, fixed64
  const b = Buffer.alloc(8);
  b.writeDoubleLE(value);
  for (const x of b) out.push(x);
  out.push((2 << 3) | 0); // int64 timestamp (ms)
  varint(ts, out);
  return out;
}

// series: [{ labels: {__name__, ...} (any order), value, ts }] -> WriteRequest bytes
export function encodeWriteRequest(series) {
  const out = [];
  for (const s of series) {
    const ts = [];
    for (const k of Object.keys(s.labels).sort()) lenDelim(1, encodeLabel(k, s.labels[k]), ts); // labels sorted by name
    lenDelim(2, encodeSample(s.value, s.ts), ts);
    lenDelim(1, ts, out);
  }
  return Buffer.from(out);
}

// ---------------- snappy block format, literal-only (valid snappy; Prometheus decodes it) ----------------
export function snappyEncode(buf) {
  const out = [];
  varint(buf.length, out);
  const head = Buffer.from(out);
  const parts = [head];
  for (let off = 0; off < buf.length; off += 65536) {
    const chunk = buf.subarray(off, Math.min(off + 65536, buf.length));
    const n = chunk.length - 1;
    let tag;
    if (n < 60) tag = Buffer.from([n << 2]);
    else if (n < 0x100) tag = Buffer.from([60 << 2, n]);
    else tag = Buffer.from([61 << 2, n & 0xff, (n >> 8) & 0xff]);
    parts.push(tag, chunk);
  }
  return Buffer.concat(parts);
}

// Simple decoder for literal + copy elements (used by tests to check the round trip).
export function snappyDecode(buf) {
  let i = 0, len = 0, shift = 0;
  for (;;) { const b = buf[i++]; len |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
  const out = Buffer.alloc(len);
  let o = 0;
  while (i < buf.length) {
    const tag = buf[i++];
    if ((tag & 3) !== 0) throw new Error('copy elements not supported in this test decoder');
    let n = tag >> 2;
    if (n === 60) n = buf[i++];
    else if (n === 61) { n = buf[i] | (buf[i + 1] << 8); i += 2; }
    n += 1;
    buf.copy(out, o, i, i + n);
    o += n; i += n;
  }
  return out;
}

export async function writeToPrometheus(url, series, { timeoutMs = 10000 } = {}) {
  const body = snappyEncode(encodeWriteRequest(series));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST', body, signal: ctl.signal,
      headers: { 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'snappy', 'X-Prometheus-Remote-Write-Version': '0.1.0' },
    });
    const text = r.ok ? '' : (await r.text()).slice(0, 300);
    return { status: r.status, text };
  } finally {
    clearTimeout(t);
  }
}
