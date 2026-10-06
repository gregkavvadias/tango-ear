// Minimal, dependency-free audio tag reader for ID3 (MP3), FLAC, MP4/M4A and Ogg (Vorbis/Opus).
// Reads only the bytes it needs via File.slice(). Returns a flat object of strings:
// { title, artist, albumartist, album, conductor, grouping, comment, date, extra }

async function bytes(file, start, len) {
  if (start >= file.size) return new Uint8Array(0);
  return new Uint8Array(await file.slice(start, Math.min(file.size, start + len)).arrayBuffer());
}

const ascii = (b, s, n) => String.fromCharCode(...b.subarray(s, s + n));
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u32le = (b, i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0);
const syncsafe = (b, i) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('iso-8859-1');
const clean = s => s.replace(/\u0000+$/g, '').replace(/\u0000/g, ', ').trim();

export async function readTags(file) {
  const head = await bytes(file, 0, 12);
  const out = {};
  try {
    if (ascii(head, 0, 3) === 'ID3') await readID3v2(file, out);
    else if (ascii(head, 0, 4) === 'fLaC') await readFlac(file, out);
    else if (ascii(head, 4, 4) === 'ftyp') await readMp4(file, out);
    else if (ascii(head, 0, 4) === 'OggS') await readOgg(file, out);
    if (!out.artist && !out.title && file.size > 128) await readID3v1(file, out);
  } catch (e) {
    console.warn('Tag read failed for', file.name, e);
  }
  return out;
}

/* ---------------- ID3v2 ---------------- */

function decodeText(enc, b) {
  if (enc === 0) return latin1.decode(b);
  if (enc === 3) return utf8.decode(b);
  if (enc === 1) {
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
    return new TextDecoder('utf-16le').decode(b);
  }
  if (enc === 2) return new TextDecoder('utf-16be').decode(b);
  return latin1.decode(b);
}

// Find the end of a null-terminated string in the given encoding; returns [stringEnd, nextStart].
function findNull(enc, b, from) {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return [i, i + 2];
  } else {
    for (let i = from; i < b.length; i++) if (b[i] === 0) return [i, i + 1];
  }
  return [b.length, b.length];
}

const ID3_MAP = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TPE2: 'albumartist', TP2: 'albumartist',
  TPE3: 'conductor', TP3: 'conductor',
  TALB: 'album', TAL: 'album',
  TIT1: 'grouping', TT1: 'grouping',
  TDRC: 'date', TYER: 'date', TYE: 'date', TDOR: 'origdate', TORY: 'origdate', TOR: 'origdate',
};

async function readID3v2(file, out) {
  const h = await bytes(file, 0, 10);
  const ver = h[3], flags = h[5];
  const size = syncsafe(h, 6);
  let b = await bytes(file, 10, Math.min(size, 16 * 1024 * 1024));
  if (flags & 0x80 && ver < 4) b = unsync(b);
  let p = 0;
  if (flags & 0x40) p = ver === 4 ? syncsafe(b, 0) : u32be(b, 0) + 4;
  const idLen = ver === 2 ? 3 : 4, hdrLen = ver === 2 ? 6 : 10;
  const extras = [];

  while (p + hdrLen <= b.length) {
    const id = ascii(b, p, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let fsize;
    if (ver === 2) fsize = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5];
    else if (ver === 4) fsize = syncsafe(b, p + 4);
    else fsize = u32be(b, p + 4);
    const fflags = ver === 4 ? b[p + 9] : 0;
    let data = b.subarray(p + hdrLen, p + hdrLen + fsize);
    p += hdrLen + fsize;
    if (!data.length) continue;
    if (ver === 4 && fflags & 0x02) data = unsync(data);
    if (ver === 4 && fflags & 0x01) data = data.subarray(4); // data length indicator

    const enc = data[0];
    if (ID3_MAP[id]) {
      const key = ID3_MAP[id];
      if (!out[key]) out[key] = clean(decodeText(enc, data.subarray(1)));
    } else if (id === 'COMM' || id === 'COM') {
      const [, start] = findNull(enc, data, 4);
      const txt = clean(decodeText(enc, data.subarray(start)));
      if (txt) out.comment = out.comment ? out.comment + ' | ' + txt : txt;
    } else if (id === 'TXXX' || id === 'TXX') {
      const [end, start] = findNull(enc, data, 1);
      const desc = clean(decodeText(enc, data.subarray(1, end)));
      const val = clean(decodeText(enc, data.subarray(start)));
      if (val) extras.push(`${desc}: ${val}`);
    }
  }
  if (extras.length) out.extra = extras.join(' | ');
  if (!out.date && out.origdate) out.date = out.origdate;
}

function unsync(b) {
  const r = new Uint8Array(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) {
    r[j++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return r.subarray(0, j);
}

async function readID3v1(file, out) {
  const b = await bytes(file, file.size - 128, 128);
  if (ascii(b, 0, 3) !== 'TAG') return;
  const s = (i, n) => clean(latin1.decode(b.subarray(i, i + n)));
  out.title ||= s(3, 30);
  out.artist ||= s(33, 30);
  out.album ||= s(63, 30);
  out.date ||= s(93, 4);
  out.comment ||= s(97, 28);
}

/* ---------------- Vorbis comments (FLAC / Ogg) ---------------- */

const VORBIS_MAP = {
  TITLE: 'title', ARTIST: 'artist', ALBUMARTIST: 'albumartist', 'ALBUM ARTIST': 'albumartist',
  ALBUM: 'album', CONDUCTOR: 'conductor', GROUPING: 'grouping', CONTENTGROUP: 'grouping',
  COMMENT: 'comment', DESCRIPTION: 'comment', DATE: 'date', YEAR: 'date',
  ORIGINALDATE: 'origdate', ORIGINALYEAR: 'origdate',
};

function parseVorbisComment(b, p, out) {
  const vlen = u32le(b, p); p += 4 + vlen;
  const count = u32le(b, p); p += 4;
  const extras = [];
  for (let i = 0; i < count && p + 4 <= b.length; i++) {
    const len = u32le(b, p); p += 4;
    if (p + len > b.length) break;
    const kv = utf8.decode(b.subarray(p, p + len)); p += len;
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    const k = kv.slice(0, eq).toUpperCase(), v = kv.slice(eq + 1).trim();
    const key = VORBIS_MAP[k];
    if (key) out[key] = out[key] ? `${out[key]}, ${v}` : v;
    else if (['PERFORMER', 'VOCALIST', 'SINGER', 'ENSEMBLE', 'ORCHESTRA', 'RECORDINGDATE'].includes(k)) extras.push(`${k}: ${v}`);
  }
  if (extras.length) out.extra = extras.join(' | ');
  if (out.origdate && !/\d{4}/.test(out.date || '')) out.date = out.origdate;
}

async function readFlac(file, out) {
  let p = 4;
  for (let n = 0; n < 64; n++) {
    const h = await bytes(file, p, 4);
    if (h.length < 4) return;
    const last = h[0] & 0x80, type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4) {
      parseVorbisComment(await bytes(file, p + 4, len), 0, out);
      return;
    }
    if (last) return;
    p += 4 + len;
  }
}

async function readOgg(file, out) {
  const b = await bytes(file, 0, 256 * 1024);
  const find = sig => {
    outer: for (let i = 0; i < b.length - sig.length; i++) {
      for (let j = 0; j < sig.length; j++) if (b[i + j] !== sig[j]) continue outer;
      return i;
    }
    return -1;
  };
  let i = find([3, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]); // \x03vorbis
  if (i >= 0) return parseVorbisComment(b, i + 7, out);
  i = find([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // OpusTags
  if (i >= 0) return parseVorbisComment(b, i + 8, out);
}

/* ---------------- MP4 / M4A ---------------- */

const MP4_MAP = {
  '©nam': 'title', '©ART': 'artist', aART: 'albumartist', '©alb': 'album',
  '©day': 'date', '©cmt': 'comment', '©grp': 'grouping', '©con': 'conductor',
};

async function readMp4(file, out) {
  // Walk top-level boxes to find moov (may be at the end of the file).
  let p = 0;
  while (p + 8 <= file.size) {
    const h = await bytes(file, p, 16);
    let size = u32be(h, 0);
    const type = ascii(h, 4, 4);
    if (size === 1) size = u32be(h, 8) * 2 ** 32 + u32be(h, 12);
    else if (size === 0) size = file.size - p;
    if (size < 8) return;
    if (type === 'moov') {
      const moov = await bytes(file, p, Math.min(size, 64 * 1024 * 1024));
      walkMp4(moov, 8, moov.length, out);
      return;
    }
    p += size;
  }
}

function walkMp4(b, start, end, out, inIlst = false) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32be(b, p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (size === 0) size = end - p;
    if (size < 8 || p + size > end) return;
    const body = p + 8;
    if (inIlst) {
      readIlstItem(b, type, body, p + size, out);
    } else if (type === 'udta' || type === 'trak') {
      walkMp4(b, body, p + size, out);
    } else if (type === 'meta') {
      // 'meta' is a full box (4 bytes version/flags) in MP4, but not in some QuickTime files.
      const skip = String.fromCharCode(b[body + 4], b[body + 5], b[body + 6], b[body + 7]) === 'hdlr' ? 0 : 4;
      walkMp4(b, body + skip, p + size, out);
    } else if (type === 'ilst') {
      walkMp4(b, body, p + size, out, true);
    }
    p += size;
  }
}

function readIlstItem(b, type, start, end, out) {
  let p = start, name = null, value = null;
  while (p + 8 <= end) {
    const size = u32be(b, p);
    const t = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (size < 8) return;
    if (t === 'data') value = utf8.decode(b.subarray(p + 16, p + size));
    else if (t === 'name') name = utf8.decode(b.subarray(p + 12, p + size));
    p += size;
  }
  if (value == null) return;
  const key = MP4_MAP[type];
  if (key) out[key] ||= value.trim();
  else if (type === '----' && name) out.extra = (out.extra ? out.extra + ' | ' : '') + `${name}: ${value.trim()}`;
}
