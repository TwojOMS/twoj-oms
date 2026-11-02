// PRZ-123 C06 — atrapa KSeF v2 przyjmujaca WYSYLKE faktur (sesja interaktywna), w ksztalcie `fetchImpl`.
// Ta sama atrapa sluzy piaskownicy i testom (tests/pomoc/atrapa-ksef-wysylki.js tylko ja opakowuje).
// Zero sieci: adres `https://ksef.atrapa.invalid/v2`, wszystko w pamieci procesu.
//
// Odwzorowuje to, co zaklada klient src/oms/ksef/wysylka.js (docs/ksef/README.md):
//   GET  /security/public-key-certificates          → lista certyfikatow `{ certificate, usage, validFrom, validTo }`
//   POST /sessions/online                           → `{ referenceNumber, validUntil }` (klucz AES szyfrowany RSA-OAEP)
//   POST /sessions/online/{ref}/invoices            → 202 `{ referenceNumber }`
//   POST /sessions/online/{ref}/close               → 204
//   GET  /sessions/{ref}                            → status sesji `{ status: { code, description } }`: otwarta 100;
//                                                     po close pierwszy odczyt 170 (w przetwarzaniu), kolejne 200
//   GET  /sessions/{ref}/invoices/{invRef}          → stan faktury (`status.code`, `ksefNumber`, …)
//   GET  /sessions/{ref}/invoices?pageSize=N        → `{ invoices, continuationToken? }` (+ naglowek x-continuation-token)
//   GET  /sessions/{ref}/invoices/{invRef}/upo      → UPO v4-3 (application/xml)
//   GET  /invoices/ksef/{numerKsef}                 → bajty XML przyjetej faktury (application/xml), nieznany → 404
//
// Tryby sterowane danymi (bez plikow i zmiennych env):
//   - NIP nabywcy (Podmiot2) `0000000000` → stan 450 (blad semantyki);
//   - ponowny numer faktury tego samego sprzedawcy (NIP + RodzajFaktury + P_2) → 440 z `originalKsefNumber`;
//     pobranie oryginalu oddaje bajty PIERWSZEJ faktury, wiec ten sam plik wyslany drugi raz ma zgodny skrot,
//     a inny dokument z tym samym numerem (np. cudzy przy wspolnym NIP testowym) — niezgodny (K440);
//   - zly skrot pliku (jawnego albo zaszyfrowanego) albo rozmiar → 430; pliku nie da sie odszyfrowac → 435;
//   - `zwolnijNumer(referenceNumber)` — test podmienil stan przyjetej faktury na odmowe (np. 450): numer faktury
//     wraca do puli jak po prawdziwym odrzuceniu, a ponowne wyslanie nie dostaje 440;
//   - `awaria('zerwanie')` — zadne zadanie nie dochodzi (wyjatek jak przy zerwanym polaczeniu);
//     `awaria('po-przyjeciu')` — wyslanie faktury PRZETWORZONE, ale odpowiedz zerwana; `awaria(null)` wylacza.
// Pierwsze `krokiPrzetwarzania` odczytow stanu faktury pokazuje 100 (przyjeta), potem stan koncowy.
import {
  createDecipheriv, createHash, generateKeyPairSync, privateDecrypt, constants, randomBytes, sign,
} from 'node:crypto';
import { wymagajTrybuProby } from './tryb.mjs';

export const ADRES_ATRAPY_KSEF_WYSYLKI = 'https://ksef.atrapa.invalid/v2';
export const NIP_ODMOWY_SEMANTYKI = '0000000000';
export const TRYBY_AWARII = Object.freeze(['zerwanie', 'po-przyjeciu']);

const WAZNOSC_SESJI_MS = 12 * 60 * 60 * 1000;
const DOMYSLNA_STRONA = 10;
const OPISY = Object.freeze({
  100: 'Faktura przyjęta do dalszego przetwarzania',
  200: 'Sukces',
  430: 'Błąd weryfikacji pliku faktury',
  435: 'Błąd odszyfrowania pliku',
  440: 'Duplikat faktury',
  450: 'Błąd weryfikacji semantyki dokumentu faktury',
});
const OPISY_SESJI = Object.freeze({
  100: 'Sesja interaktywna otwarta',
  170: 'Sesja zamknięta, trwa przetwarzanie',
  200: 'Sesja przetworzona',
});

// ── Certyfikat X.509 (samopodpisany, DER skladany recznie — bez zaleznosci) ─────────────────────────────
function dlugosc(n) {
  if (n < 128) return Buffer.from([n]);
  const b = [];
  for (let x = n; x > 0; x >>= 8) b.unshift(x & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
}
const der = (tag, ...czesci) => {
  const tresc = Buffer.concat(czesci);
  return Buffer.concat([Buffer.from([tag]), dlugosc(tresc.length), tresc]);
};
const seq = (...c) => der(0x30, ...c);
const oid = (hex) => der(0x06, Buffer.from(hex, 'hex'));
const czasUtc = (n) => der(0x17, Buffer.from(n));
const SHA256_RSA = seq(oid('2a864886f70d01010b'), der(0x05));
const nazwa = (cn) => seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from(cn)))));

function paraZCertyfikatem(cn) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const tbs = seq(
    der(0x02, Buffer.from([1])), SHA256_RSA, nazwa(cn),
    seq(czasUtc('200101000000Z'), czasUtc('491231235959Z')), nazwa(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const cert = seq(tbs, SHA256_RSA, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return { privateKey, certyfikat: cert.toString('base64') };
}

// ── Numery ──────────────────────────────────────────────────────────────────────────────────────────────
/** CRC-8 numeru KSeF: wielomian 0x07, start 0x00, z 32 pierwszych znakow (z myslnikami), 2 znaki hex. */
export function crc8Ksef(napis) {
  let crc = 0;
  for (const b of Buffer.from(napis, 'utf8')) {
    crc ^= b;
    for (let i = 0; i < 8; i += 1) crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc.toString(16).toUpperCase().padStart(2, '0');
}

const hex = (n) => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n).toUpperCase();

/** Data RRRRMMDD w strefie Europe/Warsaw. */
function dzien(data) {
  const czesci = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(data);
  const p = (t) => czesci.find((c) => c.type === t).value;
  return `${p('year')}${p('month')}${p('day')}`;
}

function numerReferencyjny(data, rodzaj) {
  const rdzen = `${dzien(data)}-${rodzaj}-${hex(10)}-${hex(10)}`;
  return `${rdzen}-${crc8Ksef(rdzen)}`;
}

function numerKsef(nip, data) {
  const rdzen = `${nip}-${dzien(data)}-${hex(12)}`;
  return `${rdzen}-${crc8Ksef(rdzen)}`;
}

// ── XML faktury (tylko pola, ktorych atrapa potrzebuje) ─────────────────────────────────────────────────
const pole = (xml, sciezka) => {
  let tresc = xml;
  for (const znacznik of sciezka) {
    const m = new RegExp(`<(?:[\\w.-]+:)?${znacznik}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${znacznik}>`).exec(tresc);
    if (!m) return null;
    tresc = m[1];
  }
  return tresc.trim();
};

function daneFaktury(xml) {
  return {
    nipSprzedawcy: pole(xml, ['Podmiot1', 'NIP']),
    nipNabywcy: pole(xml, ['Podmiot2', 'NIP']),
    numer: pole(xml, ['Fa', 'P_2']),
    dataWystawienia: pole(xml, ['Fa', 'P_1']),
    rodzaj: pole(xml, ['Fa', 'RodzajFaktury']) ?? '',
  };
}

const xmlTekst = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function upoXml({ sesja, faktura }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Potwierdzenie xmlns="http://upo.schematy.mf.gov.pl/KSeF/v4-3">
\t<NazwaPodmiotuPrzyjmujacego>Ministerstwo Finansów</NazwaPodmiotuPrzyjmujacego>
\t<NumerReferencyjnySesji>${sesja.referenceNumber}</NumerReferencyjnySesji>
\t<Uwierzytelnienie>
\t\t<IdKontekstu>
\t\t\t<Nip>${faktura.dane.nipSprzedawcy}</Nip>
\t\t</IdKontekstu>
\t\t<SkrotDokumentuUwierzytelniajacego>${createHash('sha256').update(sesja.referenceNumber).digest('base64')}</SkrotDokumentuUwierzytelniajacego>
\t</Uwierzytelnienie>
\t<NazwaStrukturyLogicznej>Schemat_FA(3)_v1-0E.xsd</NazwaStrukturyLogicznej>
\t<KodFormularza>FA (3)</KodFormularza>
\t<Dokument>
\t\t<NipSprzedawcy>${faktura.dane.nipSprzedawcy}</NipSprzedawcy>
\t\t<NumerKSeFDokumentu>${faktura.ksefNumber}</NumerKSeFDokumentu>
\t\t<NumerFaktury>${xmlTekst(faktura.dane.numer)}</NumerFaktury>
\t\t<DataWystawieniaFaktury>${faktura.dane.dataWystawienia}</DataWystawieniaFaktury>
\t\t<DataPrzeslaniaDokumentu>${faktura.przyjeta}</DataPrzeslaniaDokumentu>
\t\t<DataNadaniaNumeruKSeF>${faktura.przyjeta}</DataNadaniaNumeruKSeF>
\t\t<SkrotDokumentu>${faktura.invoiceHash}</SkrotDokumentu>
\t\t<TrybWysylki>Online</TrybWysylki>
\t</Dokument>
</Potwierdzenie>
`;
}

// ── Odpowiedzi ──────────────────────────────────────────────────────────────────────────────────────────
const json = (status, dane, naglowki = {}) => new Response(dane === undefined ? null : JSON.stringify(dane), {
  status, headers: { 'Content-Type': 'application/json', ...naglowki },
});
const odmowa = (status, title, detail) => json(status, {
  title, status, detail, traceId: `atrapa-${hex(8).toLowerCase()}`,
}, { 'Content-Type': 'application/problem+json' });

function zerwanie() {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error('socket hang up (atrapa KSeF: awaria)'), { code: 'ECONNRESET' });
  return e;
}

function naglowek(init, nazwaNaglowka) {
  const h = init?.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(nazwaNaglowka);
  const klucz = Object.keys(h).find((k) => k.toLowerCase() === nazwaNaglowka.toLowerCase());
  return klucz ? String(h[klucz]) : null;
}

/**
 * @param {{ env?: Record<string, string|undefined>, teraz?: () => Date, krokiPrzetwarzania?: number }} [opcje]
 */
export function createAtrapaKsefWysylki({ env = process.env, teraz = () => new Date(), krokiPrzetwarzania = 1 } = {}) {
  wymagajTrybuProby(env, 'atrapa KSeF (wysyłka faktur)');
  const tokenowy = paraZCertyfikatem('Atrapa KSeF — KsefTokenEncryption');
  const symetryczny = paraZCertyfikatem('Atrapa KSeF — SymmetricKeyEncryption');
  const certy = Object.freeze([
    { certificate: tokenowy.certyfikat, usage: ['KsefTokenEncryption'], validFrom: '2020-01-01T00:00:00Z', validTo: '2049-12-31T23:59:59Z' },
    { certificate: symetryczny.certyfikat, usage: ['SymmetricKeyEncryption'], validFrom: '2020-01-01T00:00:00Z', validTo: '2049-12-31T23:59:59Z' },
  ]);

  /** @type {Map<string, any>} */
  const sesje = new Map();
  /** @type {Map<string, string>} klucz duplikatu → numer KSeF pierwszej przyjetej faktury */
  const przyjete = new Map();
  /** @type {Map<string, Buffer>} numer KSeF → bajty XML przyjetej faktury (GET /invoices/ksef/{numer}) */
  const xmlPrzyjetych = new Map();
  let trybAwarii = null;

  function awaria(tryb) {
    if (tryb !== null && tryb !== undefined && !TRYBY_AWARII.includes(tryb)) {
      throw new Error(`atrapa KSeF: nieznany tryb awarii „${tryb}” (znane: ${TRYBY_AWARII.join(', ')}).`);
    }
    const poprzedni = trybAwarii;
    trybAwarii = tryb ?? null;
    return poprzedni;
  }

  function zwolnijNumer(referencjaFaktury) {
    for (const sesja of sesje.values()) {
      for (const f of sesja.faktury) {
        if (f.referenceNumber !== referencjaFaktury || !f.ksefNumber) continue;
        for (const [klucz, p] of przyjete) if (p.ksefNumber === f.ksefNumber) przyjete.delete(klucz);
        xmlPrzyjetych.delete(f.ksefNumber);
      }
    }
  }

  function otworz(cialo) {
    const szyfr = cialo?.encryption;
    if (cialo?.formCode?.systemCode !== 'FA (3)' || !szyfr?.encryptedSymmetricKey || !szyfr?.initializationVector) {
      return odmowa(400, 'Bad Request', 'Brak formCode FA (3) albo danych szyfrowania sesji.');
    }
    let klucz;
    try {
      klucz = privateDecrypt(
        { key: symetryczny.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(szyfr.encryptedSymmetricKey, 'base64'),
      );
    } catch {
      return odmowa(400, 'Bad Request', 'Nie udało się odszyfrować klucza symetrycznego sesji.');
    }
    const iv = Buffer.from(szyfr.initializationVector, 'base64');
    if (klucz.length !== 32 || iv.length !== 16) {
      return odmowa(400, 'Bad Request', 'Klucz sesji musi mieć 32 bajty, a wektor IV 16 bajtów.');
    }
    const teraz0 = teraz();
    const sesja = {
      referenceNumber: numerReferencyjny(teraz0, 'SO'),
      validUntil: new Date(teraz0.getTime() + WAZNOSC_SESJI_MS).toISOString(),
      klucz, iv, zamknieta: false, odczytyPoZamknieciu: 0, faktury: [],
    };
    sesje.set(sesja.referenceNumber, sesja);
    return json(201, { referenceNumber: sesja.referenceNumber, validUntil: sesja.validUntil });
  }

  /** Stan koncowy faktury liczony od razu przy przyjeciu (odczyty tylko go odslaniaja). */
  function przetworz(sesja, cialo) {
    const zaszyfrowany = Buffer.from(String(cialo.encryptedInvoiceContent), 'base64');
    const skrot = (b) => createHash('sha256').update(b).digest('base64');
    const faktura = {
      referenceNumber: numerReferencyjny(teraz(), 'EE'),
      invoiceHash: cialo.invoiceHash,
      przyjeta: teraz().toISOString(),
      odczyty: 0,
      dane: null,
      ksefNumber: null,
      kod: 200,
      szczegoly: [],
      extensions: null,
    };
    const odrzuc = (kod, szczegol) => Object.assign(faktura, { kod, szczegoly: szczegol ? [szczegol] : [] });
    if (skrot(zaszyfrowany) !== cialo.encryptedInvoiceHash || zaszyfrowany.length !== cialo.encryptedInvoiceSize) {
      return odrzuc(430, 'Skrót albo rozmiar zaszyfrowanego pliku nie zgadza się z deklaracją.');
    }
    let xml;
    try {
      const d = createDecipheriv('aes-256-cbc', sesja.klucz, sesja.iv);
      xml = Buffer.concat([d.update(zaszyfrowany), d.final()]);
    } catch {
      return odrzuc(435, 'Pliku nie da się odszyfrować kluczem sesji.');
    }
    if (skrot(xml) !== cialo.invoiceHash || xml.length !== cialo.invoiceSize) {
      return odrzuc(430, 'Skrót albo rozmiar pliku faktury nie zgadza się z deklaracją.');
    }
    faktura.dane = daneFaktury(xml.toString('utf8'));
    const { nipSprzedawcy, nipNabywcy, numer, rodzaj } = faktura.dane;
    if (!nipSprzedawcy || !numer || !faktura.dane.dataWystawienia) {
      return odrzuc(450, 'Brak NIP sprzedawcy, numeru albo daty wystawienia faktury.');
    }
    if (nipNabywcy === NIP_ODMOWY_SEMANTYKI) {
      return odrzuc(450, `Nieprawidłowy NIP nabywcy ${NIP_ODMOWY_SEMANTYKI} (tryb odmowy atrapy).`);
    }
    const kluczDuplikatu = `${nipSprzedawcy}|${rodzaj}|${numer}`;
    const pierwsza = przyjete.get(kluczDuplikatu);
    if (pierwsza) {
      odrzuc(440, `Faktura o numerze ${numer} została już przyjęta.`);
      faktura.extensions = { originalKsefNumber: pierwsza.ksefNumber, originalSessionReferenceNumber: pierwsza.sesja };
      return faktura;
    }
    faktura.ksefNumber = numerKsef(nipSprzedawcy, teraz());
    przyjete.set(kluczDuplikatu, { ksefNumber: faktura.ksefNumber, sesja: sesja.referenceNumber });
    xmlPrzyjetych.set(faktura.ksefNumber, xml);
    return faktura;
  }

  function wyslij(sesja, cialo) {
    if (sesja.zamknieta) return odmowa(400, 'Bad Request', 'Sesja jest zamknięta.');
    if (teraz().getTime() > Date.parse(sesja.validUntil)) return odmowa(400, 'Bad Request', 'Sesja wygasła.');
    const wymagane = ['invoiceHash', 'invoiceSize', 'encryptedInvoiceHash', 'encryptedInvoiceSize', 'encryptedInvoiceContent'];
    const brak = wymagane.filter((k) => cialo?.[k] === undefined || cialo?.[k] === null || cialo?.[k] === '');
    if (brak.length) return odmowa(400, 'Bad Request', `Brak pól: ${brak.join(', ')}.`);
    const faktura = przetworz(sesja, cialo);
    sesja.faktury.push(faktura);
    if (trybAwarii === 'po-przyjeciu') throw zerwanie();
    return json(202, { referenceNumber: faktura.referenceNumber });
  }

  function stan(sesja, faktura) {
    const kod = faktura.odczyty < krokiPrzetwarzania ? 100 : faktura.kod;
    faktura.odczyty += 1;
    const koncowy = kod !== 100;
    return {
      referenceNumber: faktura.referenceNumber,
      invoiceHash: faktura.invoiceHash,
      invoiceNumber: faktura.dane?.numer ?? null,
      ...(koncowy && faktura.ksefNumber ? { ksefNumber: faktura.ksefNumber } : {}),
      acquisitionDate: faktura.przyjeta,
      status: {
        code: kod,
        description: OPISY[kod],
        ...(koncowy && faktura.szczegoly.length ? { details: faktura.szczegoly } : {}),
        ...(koncowy && faktura.extensions ? { extensions: faktura.extensions } : {}),
      },
      ...(koncowy && kod === 200 ? { upoDownloadUrl: `${ADRES_ATRAPY_KSEF_WYSYLKI}/sessions/${sesja.referenceNumber}/invoices/${faktura.referenceNumber}/upo` } : {}),
    };
  }

  /** Status sesji: otwarta 100; po zamknieciu pierwszy odczyt 170 (w przetwarzaniu), kazdy kolejny 200. */
  function stanSesji(sesja) {
    if (!sesja.zamknieta) return { code: 100, description: OPISY_SESJI[100] };
    const kod = sesja.odczytyPoZamknieciu < 1 ? 170 : 200;
    sesja.odczytyPoZamknieciu += 1;
    return { code: kod, description: OPISY_SESJI[kod] };
  }

  function lista(sesja, url, init) {
    const rozmiar = Math.max(1, Math.min(1000, Number(url.searchParams.get('pageSize')) || DOMYSLNA_STRONA));
    const od = Number(naglowek(init, 'x-continuation-token') ?? 0) || 0;
    const strona = sesja.faktury.slice(od, od + rozmiar).map((f) => stan(sesja, f));
    const dalej = od + rozmiar < sesja.faktury.length ? String(od + rozmiar) : null;
    return json(200, { invoices: strona, ...(dalej ? { continuationToken: dalej } : {}) },
      dalej ? { 'x-continuation-token': dalej } : {});
  }

  async function obsluz(url, init) {
    const metoda = String(init?.method ?? 'GET').toUpperCase();
    const sciezka = url.pathname.slice(new URL(ADRES_ATRAPY_KSEF_WYSYLKI).pathname.length);
    if (metoda === 'GET' && sciezka === '/security/public-key-certificates') return json(200, certy);

    const autoryzacja = naglowek(init, 'authorization');
    if (!autoryzacja || !/^Bearer \S+/.test(autoryzacja)) return odmowa(401, 'Unauthorized', 'Brak tokenu dostępu.');
    let cialo = null;
    if (init?.body) {
      try { cialo = JSON.parse(String(init.body)); } catch { return odmowa(400, 'Bad Request', 'Treść nie jest JSON-em.'); }
    }

    if (metoda === 'POST' && sciezka === '/sessions/online') return otworz(cialo);
    let m = /^\/sessions\/online\/([^/]+)\/(invoices|close)$/.exec(sciezka);
    if (metoda === 'POST' && m) {
      const sesja = sesje.get(decodeURIComponent(m[1]));
      if (!sesja) return odmowa(400, 'Bad Request', 'Nieznana sesja.');
      if (m[2] === 'close') {
        sesja.zamknieta = true;
        return new Response(null, { status: 204 });
      }
      return wyslij(sesja, cialo);
    }
    m = /^\/sessions\/([^/]+)$/.exec(sciezka);
    if (metoda === 'GET' && m && m[1] !== 'online') {
      const sesja = sesje.get(decodeURIComponent(m[1]));
      if (!sesja) return odmowa(404, 'Not Found', 'Nieznana sesja.');
      return json(200, { status: stanSesji(sesja) });
    }
    m = /^\/sessions\/([^/]+)\/invoices(?:\/([^/]+)(\/upo)?)?$/.exec(sciezka);
    if (metoda === 'GET' && m) {
      const sesja = sesje.get(decodeURIComponent(m[1]));
      if (!sesja) return odmowa(404, 'Not Found', 'Nieznana sesja.');
      if (!m[2]) return lista(sesja, url, init);
      const faktura = sesja.faktury.find((f) => f.referenceNumber === decodeURIComponent(m[2]));
      if (!faktura) return odmowa(404, 'Not Found', 'Nieznana faktura w sesji.');
      if (!m[3]) return json(200, stan(sesja, faktura));
      if (faktura.kod !== 200 || faktura.odczyty < krokiPrzetwarzania) {
        return odmowa(404, 'Not Found', 'UPO tej faktury nie jest dostępne.');
      }
      return new Response(upoXml({ sesja, faktura }), { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
    }
    m = /^\/invoices\/ksef\/([^/]+)$/.exec(sciezka);
    if (metoda === 'GET' && m) {
      const bajty = xmlPrzyjetych.get(decodeURIComponent(m[1]));
      if (!bajty) return odmowa(404, 'Not Found', 'Nieznany numer KSeF.');
      return new Response(Buffer.from(bajty), { status: 200, headers: { 'Content-Type': 'application/xml' } });
    }
    return odmowa(404, 'Not Found', `Atrapa KSeF nie zna ${metoda} ${sciezka}.`);
  }

  /** `fetch` atrapy: tylko adresy pod ADRES_ATRAPY_KSEF_WYSYLKI, wszystko inne to blad programisty. */
  async function fetchImpl(cel, init = {}) {
    const adres = String(cel instanceof URL ? cel.href : (cel?.url ?? cel));
    if (adres !== ADRES_ATRAPY_KSEF_WYSYLKI && !adres.startsWith(`${ADRES_ATRAPY_KSEF_WYSYLKI}/`)) {
      throw new Error(`atrapa KSeF: adres spoza atrapy (${adres}) — atrapa nie łączy się z siecią.`);
    }
    if (trybAwarii === 'zerwanie') throw zerwanie();
    return obsluz(new URL(adres), init);
  }

  return Object.freeze({ baseUrl: ADRES_ATRAPY_KSEF_WYSYLKI, fetchImpl, certy, awaria, zwolnijNumer });
}
