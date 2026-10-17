import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { grupujPominiete } from '../../../src/domena/magazyn-pominiete.js';

// EKRAN „POMINIĘTE".
//
// ⚠️⚠️ POWOD GRUPOWANIA (mina z Zadania 8): pominietych jest ~473, z czego 447 to OFERTY
// ALLEGRO, ktore kart nie zakladaja CELOWO — a realnej roboty jest ~26. Lista plaska
// utopilaby te 26 w tamtych 447 i pierwszym odruchem czlowieka byloby „to blad, napraw".
// Dlatego: grupy, liczby przy grupach, robota NA GORZE, a rzeczy celowe na dole i z wprost
// napisanym „tak ma byc".

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const magazyn = () => ({
  start: vi.fn(() => ({ wystartowal: true })),
  stan: () => ({ trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null }),
});

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

const zapisz = (p) => zapiszProduktSklepowy(db, {
  wariant_id: '', odczytane_at: '2026-08-11T06:00:00.000Z', ...p,
});
const ileKart = () => db.prepare('SELECT COUNT(*) AS ile FROM karty_produktow').get().ile;

// Trzy oferty Allegro (celowo bez karty), jeden zepsuty wariant (realna robota),
// jeden zdrowy produkt sklepowy (karta powstanie).
function lustro() {
  zapisz({ kanal: 'allegro_szkicownia', produkt_id: 'a1', nazwa: 'Trójnóg podłogowy DUZY' });
  zapisz({ kanal: 'allegro_szkicownia', produkt_id: 'a2', nazwa: 'Kandelabr ozdobny wysoki' });
  zapisz({ kanal: 'allegro_amarka', produkt_id: 'b1', nazwa: 'Lampion ozdobny' });
  zapisz({ kanal: 'szkicownia', produkt_id: '77', wariant_id: '78', nazwa: 'Motyw bez rozmiaru' });
  zapisz({ kanal: 'pro', produkt_id: '944', nazwa: 'Kandelabr 70x100 cm' });
}

describe('grupujPominiete', () => {
  it('grupuje po POWODZIE i liczy pozycje w grupie', () => {
    const grupy = grupujPominiete([
      { id: 1, kanal: 'allegro_szkicownia', nazwa: 'A', powod: 'kanał „allegro_szkicownia" nie zakłada kart' },
      { id: 2, kanal: 'allegro_szkicownia', nazwa: 'B', powod: 'kanał „allegro_szkicownia" nie zakłada kart' },
      { id: 3, kanal: 'szkicownia', nazwa: 'C', powod: 'wariant bez rozmiaru' },
    ], ['pro', 'szkicownia']);

    expect(grupy).toHaveLength(2);
    expect(grupy.map((g) => g.ile)).toEqual([1, 2]);
    expect(grupy[0].produkty.map((p) => p.id)).toEqual([3]);
  });

  it('ROBOTA idzie na gore, rzeczy celowe na dol — nawet gdy celowych jest wielokrotnie wiecej', () => {
    const oferty = Array.from({ length: 447 }, (_, i) => ({
      id: i, kanal: 'allegro_szkicownia', nazwa: `oferta ${i}`, powod: 'kanał „allegro_szkicownia" nie zakłada kart',
    }));
    const robota = [{ id: 900, kanal: 'szkicownia', nazwa: 'X', powod: 'wariant bez rozmiaru' }];

    const grupy = grupujPominiete([...oferty, ...robota], ['pro', 'szkicownia']);

    expect(grupy[0].celowo).toBe(false);
    expect(grupy[0].ile).toBe(1);
    expect(grupy[1].celowo).toBe(true);
    expect(grupy[1].ile).toBe(447);
  });

  it('grupa jest CELOWA tylko wtedy, gdy ZADNA jej pozycja nie pochodzi z kanalu sklepowego', () => {
    const [tylkoAllegro] = grupujPominiete([{ id: 1, kanal: 'allegro_szkicownia', powod: 'p' }], ['pro', 'szkicownia']);
    const [mieszana] = grupujPominiete([
      { id: 1, kanal: 'allegro_szkicownia', powod: 'p' },
      { id: 2, kanal: 'szkicownia', powod: 'p' },
    ], ['pro', 'szkicownia']);
    const [sklepowa] = grupujPominiete([{ id: 3, kanal: 'pro', powod: 'p' }], ['pro', 'szkicownia']);

    expect(tylkoAllegro.celowo).toBe(true);
    // Produkt ze sklepu pominiety z tego samego powodu jest ROBOTA — grupa przestaje
    // byc „tak ma byc", bo przestala mowic wylacznie o ofertach.
    expect(mieszana.celowo).toBe(false);
    expect(sklepowa.celowo).toBe(false);
  });

  it('pusta lista daje pusty wynik, a nie grupe o zerowej liczbie', () => {
    expect(grupujPominiete([], ['pro', 'szkicownia'])).toEqual([]);
    expect(grupujPominiete(undefined, ['pro', 'szkicownia'])).toEqual([]);
  });

  it('kolejnosc grup jest POWTARZALNA przy remisie liczb', () => {
    const dane = [
      { id: 1, kanal: 'szkicownia', powod: 'bez nazwy' },
      { id: 2, kanal: 'szkicownia', powod: 'wariant bez rozmiaru' },
    ];
    const a = grupujPominiete(dane, ['pro', 'szkicownia']).map((g) => g.powod);
    const b = grupujPominiete([...dane].reverse(), ['pro', 'szkicownia']).map((g) => g.powod);
    expect(a).toEqual(b);
  });
});

describe('POST /magazyn/utworz-karty', () => {
  it('tworzy karty i pokazuje, CZEGO nie tknal, pogrupowane po powodzie', async () => {
    lustro();
    const app = buildOmsServer({ db, config, magazyn: magazyn() });
    const r = await app.inject({ method: 'POST', url: '/magazyn/utworz-karty', headers: auth, payload: {} });

    expect(r.statusCode).toBe(200);
    expect(ileKart()).toBe(1);
    expect(r.body).toContain('Motyw bez rozmiaru');
    // ⚠️ LICZBA RAZEM Z NAGLOWKIEM SWOJEJ GRUPY. Wczesniej stalo tu `toContain('3')` —
    // cyfra 3 wystepuje w ukladzie strony 143 razy, wiec ta asercja nie mowila nic.
    // Bez liczby przy grupie 447 wierszy wyglada na 447 usterek.
    expect(r.body).toContain('Do zrobienia — 1 poz.');
    expect(r.body).toContain('Tak ma być — 2 poz.');
  });

  it('bez naglowka Origin ochrona CSRF odmawia i NIC nie powstaje', async () => {
    lustro();
    const app = buildOmsServer({ db, config, magazyn: magazyn() });
    const r = await app.inject({
      method: 'POST', url: '/magazyn/utworz-karty',
      headers: { authorization: auth.authorization }, payload: {},
    });

    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(ileKart()).toBe(0);
  });

  it('grupa ofert Allegro stoi PO grupie z robota', async () => {
    lustro();
    const app = buildOmsServer({ db, config, magazyn: magazyn() });
    const r = await app.inject({ method: 'POST', url: '/magazyn/utworz-karty', headers: auth, payload: {} });

    expect(r.body.indexOf('Motyw bez rozmiaru')).toBeLessThan(r.body.indexOf('Trójnóg podłogowy'));
  });
});

describe('GET /magazyn/pominiete', () => {
  it('pokazuje ten sam zbior, ale NICZEGO nie zaklada', async () => {
    lustro();
    const app = buildOmsServer({ db, config, magazyn: magazyn() });
    const r = await app.inject({ method: 'GET', url: '/magazyn/pominiete', headers: auth });

    expect(r.statusCode).toBe(200);
    // ⚠️ Zwykle wejscie na ekran NIE MA prawa zalozyc ~980 kart — a to jest ta sama
    // funkcja co pod przyciskiem.
    expect(ileKart()).toBe(0);
    expect(r.body).toContain('Motyw bez rozmiaru');
    expect(r.body).toContain('Trójnóg podłogowy');
    // ⚠️ TEN SAM KANAL MA SIE NAZYWAC TAK SAMO, CO NA LISCIE. Ekran pokazywal surowy klucz
    // z lustra, a lista obok — etykiete z `domain/kanaly.js`; czlowiek porownujacy oba
    // ekrany musial sam zgadnac, czy patrzy na to samo konto.
    expect(r.body).toContain('<td>Allegro AmarkaPL</td>');
    expect(r.body).toContain('<td>szkicownia.pl</td>');
    expect(r.body).not.toContain('<td>allegro_amarka</td>');
  });

  it('nic do pominiecia MOWI, ze nic nie ma', async () => {
    const app = buildOmsServer({ db, config, magazyn: magazyn() });
    const r = await app.inject({ method: 'GET', url: '/magazyn/pominiete', headers: auth });

    expect(r.statusCode).toBe(200);
    // ⚠️ CALE ZDANIE: `/nic|pusto/i` trafialo w uklad strony SZESNASCIE razy (nazwy klas
    // `.pusto`, `.pusto-sekcja` i slowa w komentarzach arkusza), wiec bylo spelnione zawsze.
    expect(r.body).toContain('Nic nie zostało pominięte');
  });
});

// ---------------------------------------------------------------------------------
// POWROT NA ZAWEZONY MAGAZYN (4.13d, trzecia partia z 2026-09-10).
//
// Ten ekran otwiera sie odnosnikiem Z LISTY MAGAZYNU, na ktorej stoi komplet filtrow,
// sortowanie i tryb kolumn — a wracal na goly `/magazyn`. Sasiednie ekrany tej zakladki
// (karta produktu, hurt, SKU, przejecie) adres powrotu maja od Zadania 6.
// ---------------------------------------------------------------------------------
describe('powrót na zawężony magazyn z ekranu „pominięte"', () => {
  const ZAWEZENIE = '/magazyn?fraza=kandelabr&brak=sku';
    // Adres, ktory lista SKLADA jako swoj wlasny (adresPowrotuListy) — z kolejnoscia,
    // bo powrot ma odtworzyc ekran, a nie samo zawezenie.
    const ZAWEZENIE_Z_LISTY = ZAWEZENIE + '&sort=nazwa&kier=asc';
  const ESC = ZAWEZENIE.replace(/&/g, '&amp;');
  // Asercja na FRAGMENCIE: adres magazynu stoi na tym ekranie takze w pasie zakladek layoutu.
  const odnosnikPowrotu = (body) => {
    const m = body.match(/<p class="wroc">[\s\S]*?<\/p>/);
    expect(m).not.toBeNull();
    return m[0];
  };

  it('odnośnik z listy magazynu niesie zawężenie, na którym stoi operator', async () => {
    lustro();
    const app = buildOmsServer({ db, config, magazyn: magazyn() });
    const r = await app.inject({ method: 'GET', url: ZAWEZENIE, headers: auth });
    expect(r.body).toContain(`href="/magazyn/pominiete?wroc=${encodeURIComponent(ZAWEZENIE_Z_LISTY)}"`);
  });

  it('ekran pominiętych odsyła tam, skąd kliknięto', async () => {
    lustro();
    const app = buildOmsServer({ db, config, magazyn: magazyn() });
    const r = await app.inject({
      method: 'GET', url: `/magazyn/pominiete?wroc=${encodeURIComponent(ZAWEZENIE)}`, headers: auth,
    });
    expect(odnosnikPowrotu(r.body)).toContain(`href="${ESC}"`);
  });

  // ⚠️ DRUGI RENDER TEGO SAMEGO WIDOKU: „Utwórz karty z niepowiązanych" zakłada ~980 kart
  // i pokazuje wynik na tym ekranie. Formularz stoi na zawężonej liście obok odnośnika,
  // więc gubienie adresu tutaj bolałoby dokładnie po najdłuższej operacji tej zakładki.
  it('ekran wyniku po utworzeniu kart też odsyła na zawężony magazyn', async () => {
    lustro();
    const app = buildOmsServer({ db, config, magazyn: magazyn() });
    const lista = await app.inject({ method: 'GET', url: ZAWEZENIE, headers: auth });
    expect(lista.body).toContain(
      `<input type="hidden" name="wroc" value="${ZAWEZENIE_Z_LISTY.replace(/&/g, '&amp;')}">`,
    );
    const r = await app.inject({
      method: 'POST', url: '/magazyn/utworz-karty', headers: auth, payload: { wroc: ZAWEZENIE },
    });
    expect(r.statusCode).toBe(200);
    expect(odnosnikPowrotu(r.body)).toContain(`href="${ESC}"`);
  });

  it('adres spoza magazynu jest odrzucany — zostaje goły magazyn', async () => {
    lustro();
    const app = buildOmsServer({ db, config, magazyn: magazyn() });
    for (const zly of ['//obcy.example.com/', '/?status=nowe', '/magazyn//obcy']) {
      const r = await app.inject({
        method: 'GET', url: `/magazyn/pominiete?wroc=${encodeURIComponent(zly)}`, headers: auth,
      });
      expect(odnosnikPowrotu(r.body)).toContain('href="/magazyn"');
    }
  });
});
