// PRZ-160 E2.05 — pętla ofert ERLI (D9). Prawdziwy klient ERLI na atrapie `fetch` (serwer w pamięci),
// żadnego połączenia z ERLI. Dane zmyślone („Pracownia Półcień”, SKU LMP-*).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { migracjaKanalowSprzedazy } from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import { migracjaDiagnostykiAllegro } from '../../../src/moduly/kanaly/migracje/0002-diagnostyka-allegro.ts';
import { migracjaTypuKanaluISklepow } from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import { migracjaOfertKanalow } from '../../../src/moduly/magazyn/migracje/0001-oferty-kanalow.ts';
import { wstawOferte, zmienOferte, ofertaPoId, zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { katalogErli } from '../../../src/integracje/kanal-modul.ts';
import { createErliClient } from '../../../src/oms/erli/client.js';
import {
  createPetlaOfert, bramkaZapisu, znakInstalacji, idProduktuErli, tlumaczProblemyErli, przerwaPonowienia,
  CZAS_POBRANIA_ZDJEC_MS,
} from '../../../src/moduly/magazyn/services/petla-ofert.js';

const KONTO = 'erli-polcien';
const START = Date.parse('2026-11-13T10:00:00.000Z');
const ID1 = 'pc7k2q-K1';
const ID2 = 'pc7k2q-K2';

/** Serwer ERLI w pamięci z rejestrem żądań; `wymus` podmienia kolejną odpowiedź na (metoda, ścieżka). */
function serwerErli() {
  const produkty = new Map();
  const zadania = [];
  const wymuszone = [];
  const odp = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  async function fetchImpl(url, init) {
    const sciezka = new URL(url).pathname.replace(/^\/api/, '');
    const metoda = init.method;
    const surowe = typeof init.body === 'string' ? init.body : '';
    const cialo = surowe ? JSON.parse(surowe) : undefined;
    zadania.push({ metoda, sciezka, cialo, surowe });
    const i = wymuszone.findIndex(w => w.metoda === metoda && w.sciezka === sciezka);
    if (i >= 0) {
      const [w] = wymuszone.splice(i, 1);
      if (w.zawies) { w.zawies(); return new Promise(() => {}); }
      if (w.siec) throw new TypeError('fetch failed');
      return odp(w.status, w.body);
    }
    if (sciezka === '/products/_search' && metoda === 'POST') {
      const { limit = 100, after } = cialo?.pagination ?? {};
      const lista = [...produkty.values()].sort((a, b) => a.externalId.localeCompare(b.externalId))
        .filter(p => after === undefined || p.externalId > after);
      return odp(200, lista.slice(0, limit));
    }
    if (sciezka === '/products/batch-update' && metoda === 'PATCH') {
      return odp(200, cialo.map(z => {
        const p = produkty.get(z.externalId);
        if (!p) return { externalId: z.externalId, status: 400, polishMessage: 'Produkt nie istnieje' };
        produkty.set(z.externalId, { ...p, ...z });
        return { externalId: z.externalId, status: 202, updatedFields: Object.keys(z).filter(k => k !== 'externalId') };
      }).reverse());
    }
    const id = decodeURIComponent(sciezka.replace(/^\/products\//, ''));
    if (metoda === 'GET') return produkty.has(id) ? odp(200, produkty.get(id)) : odp(404, { message: 'Not found' });
    if (metoda === 'POST') {
      if (produkty.has(id)) return odp(409, [{ errorCode: '409', errorMessage: 'Product already exists' }]);
      produkty.set(id, { ...cialo, externalId: id, images: [], buyableProblems: ['shop-activity'] });
      return odp(202, { externalId: id, updatedFields: Object.keys(cialo) });
    }
    if (metoda === 'PATCH') {
      if (!produkty.has(id)) return odp(404, { message: 'Not found' });
      produkty.set(id, { ...produkty.get(id), ...cialo });
      return odp(202, { externalId: id, updatedFields: Object.keys(cialo) });
    }
    return odp(500, { message: 'nieobsłużone' });
  }
  const zapisy = () => zadania.filter(z => z.metoda !== 'GET' && z.sciezka !== '/products/_search');
  const wymus = w => wymuszone.push(w);
  return { produkty, zadania, zapisy, wymus, fetchImpl };
}

let db;
let erli;
let zegar;
let tylkoOdczyt;
const wszystkieZadania = [];

function karta(id, sku, { cena = 10000, wycofana = 0 } = {}) {
  db.prepare(`INSERT INTO karty_produktow (id, sku, nazwa, utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, sku, `Lampa Półcień ${sku}`, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
  db.prepare('UPDATE karty_produktow SET cena_gr = ?, stawka_vat = ?, wycofana = ? WHERE id = ?').run(cena, '23', wycofana, id);
  db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (?, 0, 'woo', ?, ?)`)
    .run(id, `https://polcien.example/z/${sku}.png`, '2026-11-01T00:00:00.000Z');
}

function ustawienia(zmiany = {}) {
  zapiszUstawieniaOfertKonta(db, KONTO, {
    czynne: true, narzutProcent: 0, progPotwierdzeniaProcent: 20, stalaIlosc: 5, czasWysylkiDni: 2,
    cennikDostaw: 'Cennik Półcień', stawkaVat: '23', ...zmiany,
  });
}

function petla(opcje = {}) {
  const klient = createErliClient({ adresApi: 'https://polcien.example/api', kluczApi: 'fikcyjny-klucz', wersja: 'test',
    fetchImpl: erli.fetchImpl, czekaj: vi.fn(async () => {}) });
  return createPetlaOfert({
    db, teraz: () => new Date(zegar.ms), log: () => {},
    konta: () => [{ klucz: KONTO, katalog: katalogErli(klient), tylkoOdczyt: () => tylkoOdczyt }],
    ...opcje,
  });
}

const oferta = id => ofertaPoId(db, id);
const nowa = (kartaId, idZewnetrzne, zmiany = {}) => wstawOferte(db, { kartaId, kanal: KONTO, idZewnetrzne, stan: 'do_wyslania', ...zmiany });
const zapisyNa = (metoda, sciezka) => erli.zapisy().filter(z => z.metoda === metoda && z.sciezka === sciezka);

beforeEach(() => {
  db = openOmsDb(':memory:', { moduly: [modulRdzen,
    { nazwa: 'kanaly', migracje: [migracjaKanalowSprzedazy, migracjaDiagnostykiAllegro, migracjaTypuKanaluISklepow] },
    { nazwa: 'magazyn', migracje: [migracjaOfertKanalow] }] });
  erli = serwerErli();
  zegar = { ms: START };
  tylkoOdczyt = false;
  karta(1, 'LMP-01');
  karta(2, 'LMP-02');
  ustawienia();
});
afterEach(() => { wszystkieZadania.push(...erli.zadania); db.close(); });

describe('wystawienie i restart (D9, decyzja 5)', () => {
  it('udany POST blokuje ręcznie wgrane zdjęcie po publicznym adresie sha256', async () => {
    const sha = 'a'.repeat(64);
    db.prepare("UPDATE zdjecia_kart SET zrodlo = 'reczne', adres_zrodlowy = NULL, plik = 'test.jpg', rozmiar = 1, sha256 = ?, typ = 'image/jpeg' WHERE karta_id = 1").run(sha);
    nowa(1, ID1);
    await petla({ adresPublicznyZdjec: 'https://polcien.example/zdjecia/' }).przebieg();
    expect(zapisyNa('POST', `/products/${ID1}`)[0].cialo.images).toEqual([{ url: `https://polcien.example/zdjecia/z/${sha}.jpg` }]);
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE karta_id = 1').get().wyslane_at).toBe(new Date(START).toISOString());
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE karta_id = 2').get().wyslane_at).toBeNull();
  });

  it.each(['lista', 'GET', '409'])('potwierdzenie niepewnego POST przez %s blokuje tylko zdjęcia wysłane i nadal na karcie', async droga => {
    const o = nowa(1, ID1);
    const sha = 'b'.repeat(64);
    db.prepare("INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, plik, rozmiar, sha256, typ, utworzono_at) VALUES (1, 1, 'reczne', 'test.jpg', 1, ?, 'image/jpeg', ?)").run(sha, new Date(START).toISOString());
    const opcje = { adresPublicznyZdjec: 'https://polcien.example/zdjecia' };
    let dotarlo;
    const wywolane = new Promise(r => { dotarlo = r; });
    erli.wymus({ metoda: 'POST', sciezka: `/products/${ID1}`, zawies: dotarlo });
    void petla(opcje).przebieg();
    await wywolane;
    const wyslane = zapisyNa('POST', `/products/${ID1}`)[0].cialo;
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE karta_id = 1').all().every(z => z.wyslane_at === null)).toBe(true);
    // Zmiana galerii przed restartem: nowego zdjęcia nie było w wysłanym ciele.
    db.prepare("INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (1, 2, 'woo', 'https://polcien.example/pozniej.jpg', ?)").run(new Date(START).toISOString());
    db.prepare('DELETE FROM zdjecia_kart WHERE karta_id = 1 AND kolejnosc = 0').run();
    const produkt = { ...wyslane, externalId: ID1, images: [], buyableProblems: [] };
    if (droga === 'lista') erli.produkty.set(ID1, produkt);
    else {
      erli.wymus({ metoda: 'GET', sciezka: `/products/${ID1}`, status: droga === 'GET' ? 200 : 404, body: droga === 'GET' ? produkt : {} });
      if (droga === '409') {
        erli.wymus({ metoda: 'POST', sciezka: `/products/${ID1}`, status: 409, body: {} });
        erli.wymus({ metoda: 'GET', sciezka: `/products/${ID1}`, status: 200, body: produkt });
      }
    }
    zegar.ms += 2 * 3600_000;
    await petla(opcje).przebieg();
    expect(oferta(o.id).stan).toBe('sprawdzana');
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE sha256 = ?').get(sha).wyslane_at).toBe(new Date(zegar.ms).toISOString());
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE karta_id = 1 AND kolejnosc = 2').get().wyslane_at).toBeNull();
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE karta_id = 2').get().wyslane_at).toBeNull();
    expect(zapisyNa('POST', `/products/${ID1}`)).toHaveLength(droga === '409' ? 2 : 1);
    // Następny przebieg dosyła zmienioną galerię — także po 409, gdzie ERLI ma ciało z pierwszej próby.
    erli.produkty.set(ID1, { ...produkt });
    zegar.ms += 90000;
    await petla(opcje).przebieg();
    zegar.ms += 90000;
    await petla(opcje).przebieg();
    expect(zapisyNa('PATCH', `/products/${ID1}`).at(-1)?.cialo.images.map(z => z.url)).toContain('https://polcien.example/pozniej.jpg');
  });

  it('udany POST blokuje tylko zdjęcia z ciała i zachowuje chwilę pierwszej wysyłki', async () => {
    nowa(1, ID1);
    await petla().przebieg();
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE karta_id = 1').get().wyslane_at).toBe(new Date(START).toISOString());
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE karta_id = 2').get().wyslane_at).toBeNull();
    zegar.ms += 90000;
    await petla().przebieg();
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE karta_id = 1').get().wyslane_at).toBe(new Date(START).toISOString());
  });
  it('błąd 400 POST nie blokuje zdjęć', async () => {
    nowa(1, ID1);
    erli.wymus({ metoda: 'POST', sciezka: `/products/${ID1}`, status: 400, body: { message: 'Błędny produkt' } });
    await petla().przebieg();
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE karta_id = 1').get().wyslane_at).toBeNull();
  });
  it.each([202, 400])('PATCH treści (%i) blokuje nowe zdjęcie wyłącznie po sukcesie', async status => {
    const o = nowa(1, ID1);
    await petla().przebieg();
    db.prepare("INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (1, 1, 'woo', 'https://polcien.example/nowe.jpg', ?)").run(new Date(START).toISOString());
    erli.produkty.get(ID1).images = [{ url: 'https://polcien.example/z/LMP-01.png', internalUrl: 'https://polcien.example/erli.jpg' }];
    erli.wymus({ metoda: 'PATCH', sciezka: `/products/${ID1}`, status, body: status === 202 ? { updatedFields: ['images'] } : { message: 'Błędna treść' } });
    zegar.ms += 90000;
    await petla().przebieg();
    expect(zapisyNa('PATCH', `/products/${ID1}`)).toHaveLength(1);
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE karta_id = 1 AND kolejnosc = 1').get().wyslane_at)
      .toBe(status === 202 ? new Date(zegar.ms).toISOString() : null);
    expect(oferta(o.id).wyslanePola.images).toEqual(status === 202
      ? zapisyNa('PATCH', `/products/${ID1}`)[0].cialo.images
      : zapisyNa('POST', `/products/${ID1}`)[0].cialo.images);
  });
  it('pierwszy przebieg wysyła POST z SKU i stałą ilością, wiersz przechodzi do „sprawdzana”', async () => {
    const o = nowa(1, ID1);
    await petla().przebieg();
    const post = zapisyNa('POST', `/products/${ID1}`);
    expect(post).toHaveLength(1);
    expect(post[0].cialo).toMatchObject({ name: 'Lampa Półcień LMP-01', sku: 'LMP-01', price: 10000, stock: 5, status: 'inactive' });
    expect(oferta(o.id)).toMatchObject({ stan: 'sprawdzana', liczbaProb: 0, nastepnaProbaAt: null, blad: null });
    expect(oferta(o.id).wyslanoAt).toBe(new Date(START).toISOString());
  });

  it('restart w połowie: wiersz zapisany przed wywołaniem, zero duplikatów, zero zgubionych', async () => {
    const o1 = nowa(1, ID1);
    const o2 = nowa(2, ID2);
    let wTrakcie;
    let wywolano;
    const dotarlo = new Promise(r => { wywolano = r; });
    erli.wymus({ metoda: 'POST', sciezka: `/products/${ID1}`, zawies: () => {
      wTrakcie = oferta(o1.id);
      // Żądanie dotarło do ERLI, ale odpowiedź nie wróciła (proces padł).
      erli.produkty.set(ID1, { externalId: ID1, name: 'Lampa Półcień LMP-01', sku: 'LMP-01', price: 10000, stock: 5, status: 'inactive', images: [], buyableProblems: [] });
      wywolano();
    } });
    void petla().przebieg();
    await dotarlo;
    expect(wTrakcie).toMatchObject({ stan: 'wyslana', liczbaProb: 1 });
    expect(wTrakcie.nastepnaProbaAt > new Date(START).toISOString()).toBe(true);

    // Nowy proces na tej samej bazie, po terminie ponowienia.
    zegar.ms = START + 2 * 3600_000;
    const druga = petla();
    await druga.przebieg();
    expect(oferta(o1.id).stan).toBe('sprawdzana');
    expect(oferta(o2.id).stan).toBe('sprawdzana');
    await druga.przebieg();
    expect(zapisyNa('POST', `/products/${ID1}`)).toHaveLength(1);
    expect(zapisyNa('POST', `/products/${ID2}`)).toHaveLength(1);
    expect(erli.zapisy().filter(z => z.metoda === 'PATCH')).toHaveLength(0);
    // Drugi przebieg czyta oba produkty z kanału — żaden wiersz nie zgubiony.
    expect(oferta(o1.id)).toMatchObject({ stan: 'nieaktywna', odczytIlosc: 5 });
    expect(oferta(o2.id)).toMatchObject({ stan: 'nieaktywna', odczytIlosc: 5 });
    expect([...erli.produkty.keys()].sort()).toEqual([ID1, ID2]);
  });

  it('restart, gdy żądanie nie dotarło: po terminie odczyt produktu, potem jeden POST', async () => {
    const o1 = nowa(1, ID1);
    let wywolano;
    const dotarlo = new Promise(r => { wywolano = r; });
    erli.wymus({ metoda: 'POST', sciezka: `/products/${ID1}`, zawies: () => wywolano() });
    void petla().przebieg();
    await dotarlo;
    const druga = petla();
    await druga.przebieg(); // termin jeszcze nie minął — bez wysyłki
    expect(zapisyNa('POST', `/products/${ID1}`)).toHaveLength(1);
    zegar.ms = START + 2 * 3600_000;
    await druga.przebieg();
    const poRestarcie = erli.zadania.filter(z => z.sciezka === `/products/${ID1}`).map(z => z.metoda);
    expect(poRestarcie).toEqual(['POST', 'GET', 'POST']);
    expect(oferta(o1.id).stan).toBe('sprawdzana');
    expect(erli.produkty.has(ID1)).toBe(true);
  });
});

describe('ponowienia i błędy (decyzja 10)', () => {
  it('5xx ponawia z narastającą przerwą, dopiero po terminie', async () => {
    const o = nowa(1, ID1);
    erli.wymus({ metoda: 'POST', sciezka: `/products/${ID1}`, status: 503, body: { message: 'Service Unavailable' } });
    erli.wymus({ metoda: 'POST', sciezka: `/products/${ID1}`, status: 502, body: { message: 'Bad Gateway' } });
    const p = petla();
    await p.przebieg();
    expect(oferta(o.id)).toMatchObject({ stan: 'wyslana', liczbaProb: 1 });
    expect(oferta(o.id).nastepnaProbaAt).toBe(new Date(START + przerwaPonowienia(1)).toISOString());
    await p.przebieg();
    expect(zapisyNa('POST', `/products/${ID1}`)).toHaveLength(1);
    zegar.ms = START + przerwaPonowienia(1);
    await p.przebieg();
    expect(oferta(o.id)).toMatchObject({ stan: 'wyslana', liczbaProb: 2 });
    expect(oferta(o.id).nastepnaProbaAt).toBe(new Date(zegar.ms + przerwaPonowienia(2)).toISOString());
    expect(przerwaPonowienia(2)).toBeGreaterThan(przerwaPonowienia(1));
    zegar.ms += przerwaPonowienia(2);
    await p.przebieg();
    expect(zapisyNa('POST', `/products/${ID1}`)).toHaveLength(3);
    expect(oferta(o.id)).toMatchObject({ stan: 'sprawdzana', liczbaProb: 0, blad: null });
  });

  it('błąd połączenia też ponawia', async () => {
    const o = nowa(1, ID1);
    erli.wymus({ metoda: 'POST', sciezka: `/products/${ID1}`, siec: true });
    await petla().przebieg();
    expect(oferta(o.id)).toMatchObject({ stan: 'wyslana', liczbaProb: 1 });
  });

  it('400 kończy w „blad” z komunikatem kanału i bez kolejnych prób', async () => {
    const o = nowa(1, ID1);
    erli.wymus({ metoda: 'POST', sciezka: `/products/${ID1}`, status: 400, body: [{ errorCode: '400', errorMessage: 'Niepoprawny format atrybutu' }] });
    const p = petla();
    await p.przebieg();
    expect(oferta(o.id).stan).toBe('blad');
    expect(oferta(o.id).blad).toContain('Niepoprawny format atrybutu');
    zegar.ms += 24 * 3600_000;
    await p.przebieg();
    expect(zapisyNa('POST', `/products/${ID1}`)).toHaveLength(1);
  });

  it('karta z błędem walidacji E2.04 nie idzie do kanału', async () => {
    db.prepare('UPDATE karty_produktow SET cena_gr = NULL WHERE id = 1').run();
    const o = nowa(1, ID1);
    await petla().przebieg();
    expect(erli.zapisy()).toHaveLength(0);
    expect(oferta(o.id).stan).toBe('blad');
    expect(oferta(o.id).blad).toMatch(/cenę/);
  });
});

describe('409 przy pierwszym POST (D10, decyzja 6)', () => {
  it('produkt o innej nazwie → „problem”, zero PATCH', async () => {
    erli.produkty.set(ID1, { externalId: ID1, name: 'Cudzy kinkiet', sku: 'LMP-01', price: 1, stock: 1, status: 'active', images: [], buyableProblems: [] });
    const o = nowa(1, ID1);
    const p = petla();
    await p.przebieg();
    await p.przebieg();
    expect(oferta(o.id).stan).toBe('problem');
    expect(oferta(o.id).problemy.map(x => x.tekst).join(' ')).toMatch(/produkt o tym identyfikatorze już istnieje w ERLI/i);
    expect(erli.zapisy().filter(z => z.metoda === 'PATCH')).toHaveLength(0);
    expect(erli.produkty.get(ID1).name).toBe('Cudzy kinkiet');
  });

  it('zarchiwizowany produkt o tej samej nazwie i SKU → „problem”', async () => {
    erli.produkty.set(ID1, { externalId: ID1, name: 'Lampa Półcień LMP-01', sku: 'LMP-01', price: 10000, stock: 5, status: 'inactive', archived: true, images: [], buyableProblems: [] });
    const o = nowa(1, ID1);
    await petla().przebieg();
    expect(oferta(o.id).stan).toBe('problem');
    expect(erli.zapisy().filter(z => z.metoda === 'PATCH')).toHaveLength(0);
  });

  it('własny produkt (ta sama nazwa i SKU) → „sprawdzana”', async () => {
    erli.produkty.set(ID1, { externalId: ID1, name: 'Lampa Półcień LMP-01', sku: 'LMP-01', price: 10000, stock: 5, status: 'inactive', images: [], buyableProblems: [] });
    const o = nowa(1, ID1);
    await petla().przebieg();
    expect(oferta(o.id).stan).toBe('sprawdzana');
    expect(zapisyNa('POST', `/products/${ID1}`)).toHaveLength(1);
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE karta_id = 1').get().wyslane_at).toBeNull();
  });
});

describe('synchronizacja z odczytem (D9, D13a, D14, D25)', () => {
  async function wystawione(...pary) {
    const wiersze = pary.map(([kartaId, id]) => nowa(kartaId, id));
    const p = petla();
    await p.przebieg();
    erli.zadania.length = 0;
    return { p, wiersze };
  }

  it('kanał zdjął 2 sztuki → pętla przywraca stałą ilość (porównanie z odczytem)', async () => {
    const { p, wiersze: [o] } = await wystawione([1, ID1]);
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), stock: 3 });
    await p.przebieg();
    const batch = zapisyNa('PATCH', '/products/batch-update');
    expect(batch).toHaveLength(1);
    expect(batch[0].cialo).toEqual([{ externalId: ID1, stock: 5 }]);
    expect(erli.produkty.get(ID1).stock).toBe(5);
    expect(oferta(o.id)).toMatchObject({ odczytIlosc: 3, wyslanaIlosc: 5 });
    erli.zadania.length = 0;
    await p.przebieg();
    expect(erli.zapisy()).toHaveLength(0);
  });

  it('odczyt zapisany przy wierszu, buyableProblems po polsku', async () => {
    const { p, wiersze: [o] } = await wystawione([1, ID1]);
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), buyableProblems: ['shop-activity', { code: 'nowy-kod' }] });
    await p.przebieg();
    const w = oferta(o.id);
    expect(w).toMatchObject({ stan: 'nieaktywna', odczytIlosc: 5, odczytCenaGr: 10000, odczytStatus: 'inactive' });
    expect(w.odczytanoAt).toBe(new Date(START).toISOString());
    const teksty = w.problemy.map(x => x.tekst);
    expect(teksty).toContain(tlumaczProblemyErli(['shop-activity'])[0].tekst);
    expect(teksty).toContain('ERLI zgłasza problem: nowy-kod');
  });

  it('zmiana ceny o 25% czeka na potwierdzenie, nic nie wychodzi', async () => {
    const { p, wiersze: [o] } = await wystawione([1, ID1]);
    db.prepare('UPDATE karty_produktow SET cena_gr = 12500 WHERE id = 1').run();
    await p.przebieg();
    expect(erli.zapisy()).toHaveLength(0);
    expect(oferta(o.id).cenaDoPotwierdzeniaGr).toBe(12500);
    expect(erli.produkty.get(ID1).price).toBe(10000);
  });

  it('zmiana ceny o 10% idzie sama (pod progiem)', async () => {
    const { p, wiersze: [o] } = await wystawione([1, ID1]);
    db.prepare('UPDATE karty_produktow SET cena_gr = 11000 WHERE id = 1').run();
    await p.przebieg();
    expect(zapisyNa('PATCH', '/products/batch-update')[0].cialo).toEqual([{ externalId: ID1, price: 11000 }]);
    expect(oferta(o.id).cenaDoPotwierdzeniaGr).toBe(null);
  });

  it('wycofana karta → status inactive raz, potem bez przywracania ilości', async () => {
    const { p, wiersze: [o] } = await wystawione([1, ID1]);
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), status: 'active', stock: 3 });
    db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = 1').run();
    await p.przebieg();
    const zapisy = erli.zapisy();
    expect(zapisy).toHaveLength(1);
    expect(zapisy[0]).toMatchObject({ metoda: 'PATCH', sciezka: `/products/${ID1}`, cialo: { status: 'inactive' } });
    erli.zadania.length = 0;
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), stock: 1 });
    await p.przebieg();
    await p.przebieg();
    expect(erli.zapisy()).toHaveLength(0);
    expect(oferta(o.id).stan).toBe('nieaktywna');
  });

  it('frozen → brak zapisu pola i problem widoczny', async () => {
    const { p, wiersze: [o] } = await wystawione([1, ID1]);
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), stock: 2, frozen: ['stock'] });
    await p.przebieg();
    await p.przebieg();
    expect(erli.zapisy()).toHaveLength(0);
    expect(oferta(o.id).stan).toBe('problem');
    expect(oferta(o.id).problemy.map(x => x.tekst).join(' ')).toMatch(/zablokowan/i);
  });

  it('zarchiwizowany w ERLI → brak zapisu i problem', async () => {
    const { p, wiersze: [o] } = await wystawione([1, ID1]);
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), stock: 2, archived: true });
    await p.przebieg();
    expect(erli.zapisy()).toHaveLength(0);
    expect(oferta(o.id).stan).toBe('problem');
  });

  it('zmiana treści karty → PATCH treści raz (skrót ostatnio wysłanej), bez ceny i ilości', async () => {
    const { p } = await wystawione([1, ID1]);
    db.prepare("UPDATE karty_produktow SET nazwa = 'Lampa Półcień LMP-01 mosiężna' WHERE id = 1").run();
    await p.przebieg();
    await p.przebieg();
    const patch = zapisyNa('PATCH', `/products/${ID1}`);
    expect(patch).toHaveLength(1);
    expect(patch[0].cialo.name).toBe('Lampa Półcień LMP-01 mosiężna');
    expect(patch[0].cialo).not.toHaveProperty('price');
    expect(patch[0].cialo).not.toHaveProperty('stock');
    expect(patch[0].cialo).not.toHaveProperty('status');
  });

  it('D24: czynne=false po wystawieniu → batch-update dwóch ofert nie wychodzi', async () => {
    const { p } = await wystawione([1, ID1], [2, ID2]);
    ustawienia({ czynne: false });
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), stock: 3 });
    erli.produkty.set(ID2, { ...erli.produkty.get(ID2), stock: 1 });
    await p.przebieg();
    expect(erli.zapisy()).toHaveLength(0);
    expect(erli.produkty.get(ID1).stock).toBe(3);
    expect(erli.produkty.get(ID2).stock).toBe(1);
  });

  it('D24: bramka batch-update sprawdza każdą ofertę paczki, nie tylko pierwszą', async () => {
    // Oferta 2 przestaje być zarządzana w trakcie przebiegu (w czasie PATCH jej treści), już po zebraniu paczki.
    const pierwotny = erli.fetchImpl;
    let o2Id = null;
    erli.fetchImpl = async (url, init) => {
      if (o2Id !== null && init.method === 'PATCH' && new URL(url).pathname.endsWith(`/products/${ID2}`)) zmienOferte(db, o2Id, { tryb: 'obserwowana' });
      return pierwotny(url, init);
    };
    const { p, wiersze: [, o2] } = await wystawione([1, ID1], [2, ID2]);
    o2Id = o2.id;
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), stock: 3 });
    erli.produkty.set(ID2, { ...erli.produkty.get(ID2), stock: 1 });
    db.prepare("UPDATE karty_produktow SET nazwa = 'Lampa Półcień LMP-02 mosiężna' WHERE id = 2").run();
    await p.przebieg();
    expect(zapisyNa('PATCH', `/products/${ID2}`)).toHaveLength(1);
    expect(zapisyNa('PATCH', '/products/batch-update')).toHaveLength(0);
    expect(erli.produkty.get(ID1).stock).toBe(3);
  });

  it('zamrożona treść (frozen: name) → zmiana nazwy na karcie nie wysyła PATCH treści', async () => {
    const { p } = await wystawione([1, ID1]);
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), frozen: ['name'] });
    db.prepare("UPDATE karty_produktow SET nazwa = 'Lampa Półcień LMP-01 mosiężna' WHERE id = 1").run();
    await p.przebieg();
    await p.przebieg();
    expect(zapisyNa('PATCH', `/products/${ID1}`)).toHaveLength(0);
    expect(erli.produkty.get(ID1).name).toBe('Lampa Półcień LMP-01');
  });

  it('D25: wycofana karta → inactive raz; ERLI znów „active” → OMS już nie zapisuje', async () => {
    const { p, wiersze: [o] } = await wystawione([1, ID1]);
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), status: 'active' });
    db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = 1').run();
    await p.przebieg();
    expect(erli.zapisy()).toHaveLength(1);
    expect(erli.zapisy()[0]).toMatchObject({ metoda: 'PATCH', sciezka: `/products/${ID1}`, cialo: { status: 'inactive' } });
    expect(oferta(o.id).wyslanePola.wycofanoAt).toBe(new Date(START).toISOString());
    erli.zadania.length = 0;
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), status: 'active' });
    await p.przebieg();
    expect(erli.zapisy()).toHaveLength(0);
  });

  it('zmiana ceny dokładnie o 20% (na progu) idzie sama', async () => {
    const { p, wiersze: [o] } = await wystawione([1, ID1]);
    db.prepare('UPDATE karty_produktow SET cena_gr = 12000 WHERE id = 1').run();
    await p.przebieg();
    expect(zapisyNa('PATCH', '/products/batch-update')).toHaveLength(1);
    expect(zapisyNa('PATCH', '/products/batch-update')[0].cialo).toEqual([{ externalId: ID1, price: 12000 }]);
    expect(oferta(o.id).cenaDoPotwierdzeniaGr).toBe(null);
  });

  it('5xx przy batch-update w synchronizacji → ponowienie z narastającą przerwą, dopiero po terminie', async () => {
    const { p, wiersze: [o] } = await wystawione([1, ID1]);
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), stock: 3 });
    erli.wymus({ metoda: 'PATCH', sciezka: '/products/batch-update', status: 503, body: { message: 'Service Unavailable' } });
    erli.wymus({ metoda: 'PATCH', sciezka: '/products/batch-update', status: 502, body: { message: 'Bad Gateway' } });
    await p.przebieg();
    expect(oferta(o.id).liczbaProb).toBe(1);
    expect(oferta(o.id).nastepnaProbaAt).toBe(new Date(START + przerwaPonowienia(1)).toISOString());
    await p.przebieg();
    expect(zapisyNa('PATCH', '/products/batch-update')).toHaveLength(1);
    zegar.ms = START + przerwaPonowienia(1);
    await p.przebieg();
    expect(oferta(o.id).liczbaProb).toBe(2);
    expect(oferta(o.id).nastepnaProbaAt).toBe(new Date(zegar.ms + przerwaPonowienia(2)).toISOString());
    await p.przebieg();
    expect(zapisyNa('PATCH', '/products/batch-update')).toHaveLength(2);
    zegar.ms += przerwaPonowienia(2);
    await p.przebieg();
    expect(zapisyNa('PATCH', '/products/batch-update')).toHaveLength(3);
    expect(erli.produkty.get(ID1).stock).toBe(5);
    expect(oferta(o.id)).toMatchObject({ liczbaProb: 0, nastepnaProbaAt: null });
  });

  it('batch-update z pozycją 400 w innej kolejności → właściwy wiersz w „blad”', async () => {
    const { p, wiersze: [o1, o2] } = await wystawione([1, ID1], [2, ID2]);
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), stock: 4 });
    erli.produkty.set(ID2, { ...erli.produkty.get(ID2), stock: 1 });
    erli.wymus({ metoda: 'PATCH', sciezka: '/products/batch-update', status: 200, body: [
      { externalId: ID2, status: 202, updatedFields: ['stock'] },
      { externalId: ID1, status: 400, polishMessage: 'Niepoprawna ilość' },
    ] });
    await p.przebieg();
    const batch = zapisyNa('PATCH', '/products/batch-update');
    expect(batch[0].cialo.map(z => z.externalId)).toEqual([ID1, ID2]);
    expect(oferta(o1.id).stan).toBe('blad');
    expect(oferta(o1.id).blad).toContain('Niepoprawna ilość');
    expect(oferta(o2.id).stan).not.toBe('blad');
    expect(oferta(o2.id).blad).toBe(null);
  });

  it('zdjęcie bez internalUrl po upływie czasu → problem „zdjęcie N nie zostało pobrane”', async () => {
    const { p, wiersze: [o] } = await wystawione([1, ID1]);
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), images: [{ url: 'https://polcien.example/z/LMP-01.png' }] });
    await p.przebieg();
    expect(oferta(o.id).problemy.map(x => x.tekst).join(' ')).not.toMatch(/Zdjęcie 1/);
    zegar.ms += CZAS_POBRANIA_ZDJEC_MS + 1;
    await p.przebieg();
    expect(oferta(o.id).problemy.map(x => x.tekst).join(' ')).toMatch(/Zdjęcie 1 nie zostało pobrane/);
    erli.produkty.set(ID1, { ...erli.produkty.get(ID1), images: [{ url: 'https://polcien.example/z/LMP-01.png', internalUrl: 'https://cdn.example/1.png' }] });
    await p.przebieg();
    expect(oferta(o.id).problemy.map(x => x.tekst).join(' ')).not.toMatch(/Zdjęcie 1/);
  });
});

describe('bramka zapisu (D23, D24, tylko odczyt, lista kont)', () => {
  it('oferta „obserwowana” → zero zapisów, odczyt wolno', async () => {
    erli.produkty.set(ID1, { externalId: ID1, name: 'Lampa Półcień LMP-01', sku: 'LMP-01', price: 9000, stock: 1, status: 'active', images: [], buyableProblems: [] });
    const o = wstawOferte(db, { kartaId: 1, kanal: KONTO, idZewnetrzne: ID1, pochodzenie: 'przejeta', stan: 'aktywna' });
    expect(o.tryb).toBe('obserwowana');
    await petla().przebieg();
    expect(erli.zapisy()).toHaveLength(0);
    expect(oferta(o.id).odczytIlosc).toBe(1);
  });

  it('czynne=false → zero zapisów (także nowa oferta), odczyt wolno', async () => {
    ustawienia({ czynne: false });
    erli.produkty.set(ID2, { externalId: ID2, name: 'Lampa Półcień LMP-02', sku: 'LMP-02', price: 10000, stock: 2, status: 'inactive', images: [], buyableProblems: [] });
    const o1 = nowa(1, ID1);
    const o2 = nowa(2, ID2, { stan: 'aktywna' });
    await petla().przebieg();
    expect(erli.zapisy()).toHaveLength(0);
    expect(oferta(o1.id)).toMatchObject({ stan: 'do_wyslania', liczbaProb: 0 });
    expect(oferta(o2.id).odczytIlosc).toBe(2);
  });

  it('tryb „tylko odczyt” → zero zapisów', async () => {
    tylkoOdczyt = true;
    const o = nowa(1, ID1);
    await petla().przebieg();
    expect(erli.zapisy()).toHaveLength(0);
    expect(oferta(o.id).stan).toBe('do_wyslania');
  });

  it('wiersze konta spoza bieżącej listy kont ERLI nie są ruszane', async () => {
    const obcy = wstawOferte(db, { kartaId: 1, kanal: 'erli-usuniete', idZewnetrzne: ID1, stan: 'do_wyslania' });
    await petla().przebieg();
    expect(erli.zadania).toHaveLength(0);
    expect(oferta(obcy.id).stan).toBe('do_wyslania');
  });

  it('bramkaZapisu: jedna decyzja dla każdego zapisu', () => {
    const konto = { klucz: KONTO, tylkoOdczyt: () => false };
    const zarzadzana = { kanal: KONTO, tryb: 'zarzadzana' };
    const czynne = { czynne: true };
    const klucze = [KONTO];
    expect(bramkaZapisu({ konto, ustawienia: czynne, oferta: zarzadzana, klucze }).wolno).toBe(true);
    expect(bramkaZapisu({ konto, ustawienia: { czynne: false }, oferta: zarzadzana, klucze }).wolno).toBe(false);
    expect(bramkaZapisu({ konto: { ...konto, tylkoOdczyt: () => true }, ustawienia: czynne, oferta: zarzadzana, klucze }).wolno).toBe(false);
    expect(bramkaZapisu({ konto, ustawienia: czynne, oferta: { ...zarzadzana, tryb: 'obserwowana' }, klucze }).wolno).toBe(false);
    expect(bramkaZapisu({ konto, ustawienia: czynne, oferta: { ...zarzadzana, kanal: 'erli-inne' }, klucze }).wolno).toBe(false);
    expect(bramkaZapisu({ konto, ustawienia: czynne, oferta: zarzadzana, klucze: [] }).wolno).toBe(false);
  });
});

describe('znak instalacji i identyfikator (D10, decyzja 1)', () => {
  it('6 znaków generowanych raz i trwale w tabeli ustawienia', () => {
    const losuj = vi.fn(() => 3);
    const znak = znakInstalacji(db, { losuj });
    expect(znak).toMatch(/^[a-z0-9]{6}$/);
    expect(znakInstalacji(db, { losuj: () => 0 })).toBe(znak);
    expect(db.prepare("SELECT wartosc FROM ustawienia WHERE klucz = 'oferty.znak_instalacji'").get().wartosc).toBe(znak);
    expect(idProduktuErli(db, 42)).toBe(`${znak}-K42`);
  });
});

describe('tłumaczenie buyableProblems', () => {
  it('znane kody po polsku, nieznane z kodem, napis i obiekt', () => {
    const wynik = tlumaczProblemyErli(['shopKyc', { code: 'shop-activity' }, 'cos-nowego']);
    expect(wynik.map(x => x.kod)).toEqual(['shopKyc', 'shop-activity', 'cos-nowego']);
    expect(wynik[0].tekst).not.toContain('shopKyc');
    expect(wynik[1].tekst).not.toContain('shop-activity');
    expect(wynik[2].tekst).toBe('ERLI zgłasza problem: cos-nowego');
    expect(tlumaczProblemyErli(undefined)).toEqual([]);
  });
});

describe('D11: archived nigdzie', () => {
  it('żadne żądanie w tym pliku nie zawiera „archived”', () => {
    expect(wszystkieZadania.length).toBeGreaterThan(30);
    for (const z of wszystkieZadania) expect(z.surowe, `${z.metoda} ${z.sciezka}`).not.toContain('archived');
  });
});
