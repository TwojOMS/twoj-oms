import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { Readable } from 'node:stream';

export const LIMIT = 10 * 1024 * 1024;
const TYPY = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export function katalogZdjec(env) {
  return env.OMS_KATALOG_ZDJEC || join(dirname(env.OMS_DB_PATH || '/data-oms/oms.sqlite'), 'zdjecia');
}

/** Publiczny adres bazowy zdjęć (proxy `/z/<sha>.<ext>`); pusty = zdjęcia tylko w OMS-ie nie trafią do kanału. */
export function adresPublicznyZdjec(env) {
  return env.OMS_PUBLICZNY_ADRES_ZDJEC || '';
}

// Rozpoznanie nagłówków, bez dekodowania obrazu i bez zaufania do nazwy/MIME z sieci.
function naglowek(b) {
  if (b.length >= 33 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && b.readUInt32BE(8) === 13 && b.toString('ascii', 12, 16) === 'IHDR') {
    return ['png', b.readUInt32BE(16), b.readUInt32BE(20)];
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 3 < b.length) {
      if (b[p++] !== 0xff) break;
      while (b[p] === 0xff) p++;
      const marker = b[p++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p + 2 > b.length) break;
      const n = b.readUInt16BE(p);
      if (n < 2 || p + n > b.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && n >= 8) {
        return ['jpg', b.readUInt16BE(p + 5), b.readUInt16BE(p + 3)];
      }
      p += n;
    }
  }
  if (b.length >= 25 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
    && b.readUInt32LE(4) + 8 === b.length && b.readUInt32LE(16) + 20 <= b.length) {
    const rodzaj = b.toString('ascii', 12, 16);
    if (rodzaj === 'VP8X' && b.length >= 30) return ['webp', b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
    if (rodzaj === 'VP8 ' && b.length >= 30 && b.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))) {
      return ['webp', b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    }
    if (rodzaj === 'VP8L' && b[20] === 0x2f) {
      const n = b.readUInt32LE(21);
      return ['webp', (n & 0x3fff) + 1, ((n >>> 14) & 0x3fff) + 1];
    }
  }
  throw new Error('Niedozwolony lub uszkodzony typ zdjęcia (JPEG, PNG, WebP).');
}

export async function zapiszZdjecie(bufor, { katalog }) {
  if (!Buffer.isBuffer(bufor) || bufor.length > LIMIT) throw new Error('Limit zdjęcia: 10 MB.');
  const [ext, szerokosc, wysokosc] = naglowek(bufor);
  if (!szerokosc || !wysokosc || szerokosc > 10000 || wysokosc > 10000) throw new Error('Niedozwolone wymiary zdjęcia.');
  const sha256 = createHash('sha256').update(bufor).digest('hex');
  const plik = `${sha256}.${ext}`;
  const wynik = { sha256, plik, typ: TYPY[ext], rozmiar: bufor.length, szerokosc, wysokosc };
  await mkdir(katalog, { recursive: true });
  const cel = join(katalog, plik);
  try {
    const s = await lstat(cel);
    if (!s.isFile()) throw new Error('Cel zdjęcia nie jest plikiem.');
    if (s.size === bufor.length) return wynik;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const tymczasowy = join(katalog, `.zdjecie-${randomUUID()}.tmp`);
  try {
    const f = await open(tymczasowy, 'wx', 0o644);
    try { await f.writeFile(bufor); await f.sync(); } finally { await f.close(); }
    await rename(tymczasowy, cel);
  } finally { await unlink(tymczasowy).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  return wynik;
}

function publicznyIp(ip) {
  const rodzaj = isIP(ip);
  if (rodzaj === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (rodzaj === 6) {
    const normalny = new URL(`https://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
    // Tylko global unicast 2000::/3; wyklucza ULA, link-local, loopback,
    // multicast, IPv4-mapped, NAT64. Wykluczamy też specjalne 2001::/23 i 6to4.
    const czesci = normalny.split(':');
    const a = parseInt(czesci[0], 16), b = parseInt(czesci[1] || '0', 16);
    return a >= 0x2000 && a <= 0x3fff && a !== 0x2002
      && !(a === 0x2001 && (b <= 0x1ff || b === 0xdb8)) && a !== 0x3fff;
  }
  return false;
}

async function sprawdzAdres(adres, lookup) {
  const url = new URL(adres);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Zdjęcie wymaga HTTPS bez poświadczeń.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const adresy = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!Array.isArray(adresy) || !adresy.length || adresy.some(a => !publicznyIp(a.address))) throw new Error('Niedozwolony adres sieciowy zdjęcia.');
  return { url, ip: adresy[0].address, family: isIP(adresy[0].address) };
}

// Samo sprawdzenie DNS przed fetch zostawia okno DNS rebinding. Produkcyjny
// transport przypina sprawdzony IP przez lookup w node:https, bez drugiego DNS.
// URL zachowuje oryginalny host (SNI, Host i weryfikacja certyfikatu TLS).
// Wstrzyknięty fetch to zaufana atrapa/transport: musi sam gwarantować przypięcie.
function fetchPrzypiety(url, { signal, ip, family }) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET', signal, agent: false,
      lookup: (_host, opcje, callback) => callback(null, opcje.all ? [{ address: ip, family }] : ip, family),
    }, res => {
      const status = res.statusCode;
      const headers = new Headers();
      if (res.headers.location) headers.set('location', res.headers.location);
      if (res.headers['content-length']) headers.set('content-length', res.headers['content-length']);
      resolve({ status, ok: status >= 200 && status < 300, headers, body: Readable.toWeb(res) });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function pobierzZdjecie(adres, { limitCzasuMs = 15000, limitBajtow = LIMIT, fetch = fetchPrzypiety, lookup = dnsLookup } = {}) {
  if (!Number.isFinite(limitCzasuMs) || limitCzasuMs <= 0 || !Number.isSafeInteger(limitBajtow) || limitBajtow <= 0 || limitBajtow > LIMIT) throw new Error('Niepoprawne limity pobierania.');
  const controller = new AbortController();
  let reader, timer;
  const anulowanie = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      // `chwilowy` — przebieg treści ofert ponawia taki błąd (PRZ-160.06b).
      reject(Object.assign(new Error('Przekroczono czas pobierania zdjęcia.'), { chwilowy: true }));
    }, limitCzasuMs);
  });
  const praca = async () => {
    for (let przekierowania = 0; ; przekierowania++) {
      const { url, ip, family } = await sprawdzAdres(adres, lookup);
      controller.signal.throwIfAborted();
      const res = await fetch(url.href, { redirect: 'manual', credentials: 'omit', signal: controller.signal, ip, family });
      if (controller.signal.aborted) { void res.body?.cancel().catch(() => {}); controller.signal.throwIfAborted(); }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel();
        const location = res.headers.get('location');
        if (przekierowania >= 3 || !location) throw new Error('Niedozwolone przekierowanie zdjęcia.');
        adres = new URL(location, url).href;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        // `status` rozróżnia błąd chwilowy (429, 5xx) od trwałego (404, 410…) przy ponawianiu (PRZ-160.06b).
        throw Object.assign(new Error(`HTTP ${res.status} przy pobieraniu zdjęcia.`), { status: res.status });
      }
      if (Number(res.headers.get('content-length')) > limitBajtow) {
        await res.body?.cancel();
        throw new Error('Przekroczony limit zdjęcia.');
      }
      if (!res.body) throw new Error('Brak treści zdjęcia.');
      reader = res.body.getReader();
      const czesci = [];
      let rozmiar = 0;
      while (true) {
        const { done, value } = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        rozmiar += value.byteLength;
        if (rozmiar > limitBajtow) throw new Error('Przekroczony limit bajtów zdjęcia.');
        czesci.push(Buffer.from(value));
      }
      return Buffer.concat(czesci, rozmiar);
    }
  };
  try { return await Promise.race([praca(), anulowanie]); }
  finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

// Osłony logowania i uprawnień /magazyn zapewnia wspólny strażnik panelu.
export function registerZdjeciaMagazynu(app, { katalog }) {
  app.get('/magazyn/zdjecia/:plik', async (req, reply) => {
    const { plik } = req.params;
    if (!/^[0-9a-f]{64}\.(jpg|png|webp)$/.test(plik)) return reply.code(404).send();
    let f;
    try {
      f = await open(join(katalog, plik), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const s = await f.stat();
      if (!s.isFile() || s.size > LIMIT) return reply.code(404).send();
      const bufor = await f.readFile();
      return reply.type(TYPY[plik.split('.').pop()])
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, max-age=31536000, immutable').send(bufor);
    } catch (e) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(e.code)) return reply.code(404).send();
      req.log.error({ err: e }, 'Nie udało się odczytać zdjęcia magazynu.');
      return reply.code(500).send();
    } finally { await f?.close(); }
  });
}
