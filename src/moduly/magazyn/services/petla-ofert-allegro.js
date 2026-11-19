// Pętla wysyłki ofert Allegro: do_wyslania → wyslana → sprawdzana → aktywna | nieaktywna.
// Zasady wspólne z ERLI (bramka, znak instalacji, skrót treści, przerwy) w `oferty-wspolne.js`.
//
// Kolejność przy wystawieniu jest NIEZMIENNIKIEM: najpierw zapis wiersza (`wyslana` + `ext:<externalId>`),
// dopiero potem POST. Proces przerwany po POST zostawia wiersz `wyslana` — następny przebieg szuka oferty po
// sygnaturze zamiast wystawiać drugi raz. Bariera rejestru kanałów (operacje niejednoznaczne) i tak odmówi
// drugiego POST z tym samym `external.id`, dopóki pętla jej nie zwolni — a zwalnia ją wyłącznie po odczycie.
//
// Oferty już wystawione: jeden odczyt listy ofert konta na przebieg, potem ilość i cena komendami
// (różnica względem ODCZYTU, nie wysłanej wartości), treść PATCH-em z kompletem tablic, aktywacja szkicu na
// żądanie (`aktywuj`), zdjęcie (`zdejmij` albo karta wycofana) PATCH-em ENDED bez przywracania ilości.
import { createHash, randomUUID } from 'node:crypto';
import {
  znakInstalacji,
  przerwaPonowienia,
  skrotTresci,
  bramkaZapisu,
  cenaWymagaPotwierdzenia,
} from './oferty-wspolne.js';
import { ofertaAllegroKarty } from './tresc-oferty-allegro.js';
import { powodCzekaniaOferty } from '../../../domena/czekanie-oferty.js';
import {
  podstawWgraneZdjecia,
  PROBLEMY_ALLEGRO,
  PARAMETR_STAN,
  STAN_NOWY,
  ZNACZNIK_WGRANIA,
} from '../../../domena/allegro-oferta-z-karty.js';
import { dekodujEncje } from '../../../domena/slowniki-kart.js';
import { groszeZKwoty } from '../../../domena/kwota.js';
import { kwotaDziesietna } from '../../../domena/cena-kanalu.js';
import { zmianyPonowienia } from '../oferty.js';
import { migawkaStanow, wyjasnieniaOfert } from '../../../oms/db/stany-magazynowe.js';
import {
  iloscDlaKanalu,
  skokIlosci,
  ocenRozjazdu,
  wolnoPodniesc,
  zeroMasowe,
  kluczKomendyIlosci,
  PROBLEMY_ILOSCI,
  liczySieDoZeraMasowego,
  potwierdzenieZerZuzyte,
  bezPotwierdzeniaZer,
  potwierdzenieZerWazne,
} from '../../../domena/ilosc-kanalu.js';
import {
  ofertaPoId,
  ofertaPoIdZewnetrznym,
  zmienOferte,
  przypiszIdZewnetrzne,
  ustawieniaOfertKonta,
  zapiszWgraneZdjecie,
  wgraneZdjeciaAllegro,
} from '../../../oms/db/oferty-kanalow.ts';

/** Najwyżej tyle nowych ofert na konto w jednym przebiegu. */
export const LIMIT_WYSYLEK = 25;
/** Dwa odczyty po sygnaturze bez wyniku, co najmniej tyle ms od pierwszego, zanim wolno ponowić POST. */
export const ODZYSK_MS = 15 * 60_000;
/**
 * `GET /sale/offers` pokazuje świeżo wystawioną (albo zmienioną) ofertę z opóźnieniem. Przez
 * tyle ms od wysłania, póki lista jej jeszcze nie pokazała, brak na liście nie jest problemem `brak-w-allegro`.
 */
export const SWIEZA_OFERTA_MS = 15 * 60_000;
/** Bez wyniku operacji po tylu ms → problem „bez potwierdzenia”. */
export const BEZ_POTWIERDZENIA_MS = 3 * 3_600_000;
const ODCZYT_PO_SYGNATURZE_CO_MS = 5 * 60_000;
const MIN_CZEKANIE_S = 5;
const MAKS_CZEKANIE_S = 300;
/** Stany, w których oferta z naszą sygnaturą może być naszą zgubioną. Zakończona — nie. */
const STATUSY_NASZE = new Set(['INACTIVE', 'ACTIVATING', 'ACTIVE']);
const ETAPY = ['do_wyslania', 'wyslana', 'sprawdzana'];
/**
 * Oferta zakończona przy 0 sztukach
 * (wyprzedana) na niewycofanej karcie wraca sama jednym PATCH-em ilości + ACTIVE — bez `offer-fee-preview`.
 * Zakończona ręcznie (> 0 sztuk) albo odmowa pętli (problem z powodem) → `problem` do decyzji człowieka; przycisk
 * „Wznów” stawia znacznik `wyslanePola.wznow` i pętla wznawia ją raz, z tymi samymi limitami.
 * ⚠️ Cykl ACTIVE → ENDED → ACTIVE NIE był zmierzony (konto sandbox bez warunków) — PATCH wznowienia i jego
 * operacja czytane tak samo jak aktywacja szkicu (202/303/4xx), bez zgadywania innych pól odpowiedzi.
 */
export const WZNAWIAJ_WYPRZEDANE = true;
export const ZERO_ALLEGRO = 'zakoncz';
/** Najwyżej tyle ofert w jednej komendzie ilości albo ceny (limit Allegro). */
const MAKS_OFERT_KOMENDY = 1000;
/**
 * Okno wyjaśnień sięga najwyżej 7 dni wstecz — znacznik sprzed wyłączenia stanów nie każe czytać całej
 * historii zamówień. Horyzont ogranicza TYLKO okno zapytania: oferta ze starszym T zostaje
 * z prawdziwą bazą (W, stan karty), a jej wyjaśnienia są zerowe — daje to alarm wstrzymujący (skok, rozjazd), nigdy
 * cichy zapis.
 */
const HORYZONT_WYJASNIEN_MS = 7 * 24 * 60 * 60 * 1000;
/** Tyle odrzuconych prób komendy ilości albo ceny, potem problem `komenda` i koniec ponowień. */
const MAKS_PROB_KOMENDY = 5;
/** Tyle nieudanych prób zakończenia oferty (ENDED), potem problem `zdejmowanie` i cisza do decyzji człowieka. */
const MAKS_PROB_ZDJECIA = 5;
/**
 * Najwyżej tyle zapisów na konto w jednym przebiegu — PATCH (status, treść) i komendy ilości/ceny (paczka do
 * 1000 ofert = 1 zapis). Reszta czeka na następny przebieg bez zmiany stanu. Nowe oferty (POST) liczy LIMIT_WYSYLEK.
 */
export const LIMIT_ZAPISOW_PRZEBIEGU = 50;
/** Część limitu, której PATCH-e nie zajmą — zmiana ilości i ceny wychodzi w tym samym przebiegu. */
export const REZERWA_KOMEND_PRZEBIEGU = 10;
const AKTYWNE = new Set(['ACTIVATING', 'ACTIVE']);
export const STANY_SYNCHRONIZACJI_ALLEGRO = Object.freeze(['aktywna', 'nieaktywna', 'problem']);
/** Problemy, które sama synchronizacja wystawia i sama zdejmuje — wiersz z innym problemem czeka na człowieka. */
const PROBLEMY_SYNCHRONIZACJI = new Set(['zakonczona', 'brak-w-allegro', 'karta', 'cena', 'zdejmowanie', 'odczyt']);
const PROBLEM_CENY = () => ({
  kod: 'cena',
  tekst: 'Zmiana ceny przekracza próg — czeka na potwierdzenie, do Allegro nic nie poszło.',
});

/**
 * Treść oferty do PATCH: komplet tablic, „Stan” zawsze w `parameters`, GPSR z karty albo — gdy karta
 * go nie daje (produkt z katalogu bez przypisania marki) — zapamiętany z produktu Allegro (`gpsrZProduktu`).
 * Bez ceny, ilości, statusu i kategorii: ilość i cena idą komendami, status osobnym PATCH-em.
 */
export function trescAllegro(zadanie, gpsrZProduktu = null) {
  const parametry = Array.isArray(zadanie.parameters) ? zadanie.parameters : [];
  const stan = parametry.find((p) => String(p?.id) === PARAMETR_STAN) ?? { id: PARAMETR_STAN, valuesIds: [STAN_NOWY] };
  const productSet = (Array.isArray(zadanie.productSet) ? zadanie.productSet : []).map((pozycja) => {
    const p = { ...pozycja };
    if (gpsrZProduktu?.responsibleProducer && !p.responsibleProducer)
      p.responsibleProducer = gpsrZProduktu.responsibleProducer;
    if (gpsrZProduktu?.responsiblePerson && !p.responsiblePerson) p.responsiblePerson = gpsrZProduktu.responsiblePerson;
    return p;
  });
  return {
    name: zadanie.name,
    delivery: zadanie.delivery,
    parameters: [stan, ...parametry.filter((p) => String(p?.id) !== PARAMETR_STAN)],
    images: Array.isArray(zadanie.images) ? [...zadanie.images] : [],
    ...(zadanie.description ? { description: zadanie.description } : {}),
    productSet,
  };
}

// Ten sam zasób, który liczy `zasobZapisu` w rejestrze kanałów (src/moduly/kanaly/services/rejestr-kanalow.ts).
// Celowo powtórzony zamiast importu: moduł magazynu nie importuje z modułu kanałów. Rozjazd łapie test pętli,
// który chodzi przez prawdziwy rejestr (bez zwolnienia ponowny POST dostałby odmowę bariery).
const zasobPost = (externalId) =>
  '/sale/product-offers#' + createHash('sha256').update(JSON.stringify(externalId)).digest('hex');
const zasobPatch = (ofertaId) => `/sale/product-offers/${ofertaId}`;

const kodHttp = (e) => (Number.isInteger(e?.status) ? e.status : 0);
/** 4xx poza 429 = Allegro odrzuciło treść; reszta (5xx, sieć, limit czasu, bariera) = spróbuj później. */
const odrzucone = (e) => kodHttp(e) >= 400 && kodHttp(e) < 500 && kodHttp(e) !== 429;
/** 401/403 = brak dostępu (np. wygasły token), nie błąd treści — nie liczy się do limitu treści. */
const bezDostepu = (e) => kodHttp(e) === 401 || kodHttp(e) === 403;
const niezgodnyParametr = (e) =>
  kodHttp(e) === 422 && Array.isArray(e?.bledy) ? (e.bledy.find((b) => b?.kod === 'PARAMETER_MISMATCH') ?? null) : null;
const komunikat = (e) => String(e?.message ?? e).slice(0, 500);

/** `wyslanePola` bez znacznika ręcznego „Wznów” (zdejmowany po decyzji pętli). */
function bezWznow(p) {
  const { wznow: _w, ...bez } = p;
  return bez;
}

/**
 * @param {{db: import('node:sqlite').DatabaseSync,
 *   konta: () => Array<{klucz: string, nazwa?: string, srodowisko?: 'produkcja'|'sandbox', zgoda: boolean,
 *     tylkoOdczyt?: () => boolean, katalog: any, allegro: any, klient?: any}>,
 *   zwolnijOperacje: (klucz: string, metoda: string, zasob: string) => unknown,
 *   czytajZdjecie: (z: object) => Promise<Uint8Array>,
 *   teraz?: () => Date, log?: (tekst: string) => void, pollerMs?: number}} o
 */
export function createPetlaOfertAllegro({
  db,
  konta,
  zwolnijOperacje,
  czytajZdjecie,
  teraz = () => new Date(),
  log = () => {},
  pollerMs = 120_000,
}) {
  if (typeof zwolnijOperacje !== 'function') throw new Error('Pętla ofert Allegro wymaga zwolnijOperacje (D31).');
  if (typeof czytajZdjecie !== 'function') throw new Error('Pętla ofert Allegro wymaga czytajZdjecie.');
  let wToku = false;
  let migawka = null;
  // Chwila tuż przed migawką stanów — T (`iloscWyslanaAt`) każdego zapisu stanKartyWyslany z tej migawki.
  let chwilaMigawki = null;
  let przyspieszony = false;
  let ostatniStart = -Infinity;
  let zegar = null;
  const czas = () => teraz().getTime();
  const iso = (ms = czas()) => new Date(ms).toISOString();
  const opcje = () => ({ teraz: iso() });
  // Przy zapisie po await pierwszeństwo mają aktualne decyzje człowieka w bazie.
  const zmien = (o, zmiany, usunZnaczniki = []) => {
    if (zmiany.wyslanePola) {
      const aktualne = pola(ofertaPoId(db, o.id));
      const nowe = { ...zmiany.wyslanePola };
      for (const klucz of [
        'zdejmij',
        'wznow',
        'aktywuj',
        'cenaPotwierdzonaGr',
        'wznowionaAt',
        'wznowienia',
        'zeraPotwierdzone',
      ]) {
        if (usunZnaczniki.includes(klucz)) delete nowe[klucz];
        else if ((klucz === 'wznowionaAt' || klucz === 'wznowienia') && Object.hasOwn(nowe, klucz)) continue;
        else if (Object.hasOwn(aktualne, klucz)) nowe[klucz] = aktualne[klucz];
        else delete nowe[klucz];
      }
      zmiany = { ...zmiany, wyslanePola: nowe };
    }
    return zmienOferte(db, o.id, zmiany, opcje());
  };
  const pola = (o) => (o.wyslanePola && typeof o.wyslanePola === 'object' ? o.wyslanePola : {});
  const kartaWycofana = (o) =>
    Boolean(db.prepare('SELECT wycofana FROM karty_produktow WHERE id = ?').get(o.kartaId)?.wycofana);
  const czekanieS = (retryAfterS) => Math.min(MAKS_CZEKANIE_S, Math.max(MIN_CZEKANIE_S, Number(retryAfterS) || 0));
  const pozniej = (o, ms, zmiany = {}) => zmien(o, { ...zmiany, nastepnaProbaAt: iso(czas() + ms) });
  const problem = (o, p) => zmien(o, { stan: 'problem', problemy: [p], nastepnaProbaAt: null });
  const blad = (o, tekst) => zmien(o, { stan: 'blad', blad: tekst, nastepnaProbaAt: null });
  let zapisy = 0;
  const potwierdzoneIlosci = new Set();
  /**
   * Wznowienie po END z `zakonczonaPrzezOms` najwyżej 3 razy na dobę na ofertę,
   * jedna reguła dla obu trybów (przy włączonych stanach). Czwarte → problem „częste wznawianie”, decyzja człowieka.
   */
  const wznowieniaDoby = (p) =>
    (Array.isArray(p.wznowienia) ? p.wznowienia : []).filter((t) => czas() - Date.parse(t) < 24 * 3_600_000);
  const czesteWznawianie = (p) => wznowieniaDoby(p).length >= 3;
  const CZESTE_WZNAWIANIE = 'Częste wznawianie: OMS wznowił tę ofertę 3 razy w ciągu doby — dalej decyduje człowiek.';
  /** Przy włączonych stanach komendy ilości i publikacji mają własną przerwę — backoff ceny i treści ich nie wstrzymuje. */
  const bezPrzerwyIlosci = (p) => {
    const { przerwaIlosci: _p, ...bez } = p;
    return bez;
  };
  /** PATCH (status, treść) kończą się REZERWA_KOMEND_PRZEBIEGU przed limitem — reszta tylko dla komend ilości/ceny. */
  const wolnyZapis = (komenda = false) => zapisy < LIMIT_ZAPISOW_PRZEBIEGU - (komenda ? 0 : REZERWA_KOMEND_PRZEBIEGU);
  /** Liczy zapis do limitu przebiegu konta; false = limit wyczerpany, zapis czeka na następny przebieg. */
  const zapis = (komenda = false) => (wolnyZapis(komenda) ? (zapisy++, true) : false);

  /**
   * Odrzucona próba zakończenia oferty (4xx, operacja FAIL, „nadal ACTIVE”) — kolejna po `przerwa(n)`, po
   * MAKS_PROB_ZDJECIA problem bez prób. Licznik `wyslanePola.probyZdjecia` jest osobny od `liczbaProb` komend.
   */
  function nieudaneZdjecie(o, tekst, przerwa, zmiany = {}) {
    const p = zmiany.wyslanePola ?? pola(o);
    const n = (pola(o).probyZdjecia ?? 0) + 1;
    const wyslanePola = { ...p, probyZdjecia: n };
    if (n >= MAKS_PROB_ZDJECIA) {
      // Z flagą „zdejmij” ekran nie ma już ani „Ponów”, ani „Zdejmij” — zostaje zakończenie w Allegro.
      const co = pola(o).zdejmij
        ? 'zakończ ją ręcznie w Allegro — OMS zauważy to przy następnym odczycie'
        : 'zakończ ją w Allegro albo spróbuj jeszcze raz przyciskiem „Zdejmij ofertę” lub „Wyślij ponownie”';
      zmien(o, {
        ...zmiany,
        wyslanePola,
        stan: 'problem',
        blad: tekst,
        nastepnaProbaAt: null,
        problemy: [PROBLEMY_ALLEGRO.zdejmowanie(`Allegro nie zakończyło oferty po ${n} próbach (${tekst}) — ${co}.`)],
      });
    } else zmien(o, { ...zmiany, wyslanePola, blad: tekst, nastepnaProbaAt: iso(czas() + przerwa(n)) });
  }

  /**
   * Skrót treści niezależny od adresów zdjęć: adres wgrany na Allegro i znacznik „do wgrania” tego samego zdjęcia
   * dają ten sam skrót — wygasły adres albo ponowne wgranie nie jest zmianą treści.
   */
  function skrotAllegro(kartaId, kontoKlucz, zadanie, dawny = false) {
    const poAdresie = new Map(
      wgraneZdjeciaAllegro(db, { kartaId, konto: kontoKlucz }).map((z) => [z.adres, String(z.zdjecieId)]),
    );
    const normuj = (v) => {
      if (typeof v === 'string') {
        if (v.startsWith(ZNACZNIK_WGRANIA)) return `zdj:${v.slice(ZNACZNIK_WGRANIA.length)}`;
        return poAdresie.has(v) ? `zdj:${poAdresie.get(v)}` : v;
      }
      if (Array.isArray(v)) return v.map(normuj);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normuj(x)]));
      return v;
    };
    const tresc = trescAllegro(zadanie, null);
    if (dawny) delete tresc.delivery;
    return skrotTresci(normuj(tresc));
  }

  function bramka(konto, o, zakres = null) {
    const klucze = konta().map((k) => k.klucz);
    return bramkaZapisu({
      konto,
      ustawienia: ustawieniaOfertKonta(db, konto.klucz),
      oferta: { ...o, ilosc_z_oms: o.iloscZOms ? 1 : 0 },
      klucze,
      kanal: 'Allegro',
      zakres,
    });
  }

  function zwolnijPost(konto, externalId) {
    zwolnijOperacje(konto.klucz, 'POST', zasobPost(externalId));
  }

  /** EAN szukany w katalogu Allegro; jeden produkt → katalog-id, zero → nowy, kilka → problem. */
  async function trescKarty(konto, o, { tworzenie = false } = {}) {
    const opisKonta = { klucz: konto.klucz, nazwa: konto.nazwa, srodowisko: konto.srodowisko };
    let w = ofertaAllegroKarty(db, o.kartaId, opisKonta, { teraz: iso(), tworzenie, migawka });
    if (w.droga !== 'ean') return { w };
    const ean = String(w.karta?.ean ?? '').trim();
    const produkty = await konto.allegro.szukajProduktow(ean);
    if (produkty.length > 1) {
      // Szukanie trybem GTIN: każdy znaleziony produkt ma EAN karty.
      return {
        problem: PROBLEMY_ALLEGRO['wiele-produktow'](
          produkty.map((p) => ({ id: String(p.id), nazwa: p.name ?? null, ean })),
        ),
      };
    }
    const katalog = produkty.length === 1 ? { produktId: String(produkty[0].id) } : { brak: true };
    w = ofertaAllegroKarty(db, o.kartaId, opisKonta, { teraz: iso(), katalog, tworzenie, migawka });
    return { w };
  }

  /** Istniejący numer wraca do synchronizacji jak po Ponów, nigdy do POST. */
  function przywrocSynchronizacje(o) {
    const zmiany = zmianyPonowienia(o, true);
    if (zmiany.stan === 'do_wyslania') return false;
    zmien(o, zmiany);
    return true;
  }

  /** Krok 1: wyłącznie nowa oferta — zdjęcia, zapis wiersza, POST. */
  async function wyslij(konto, o) {
    if (przywrocSynchronizacje(o)) return true;
    if (!migawka) return false;
    if (kartaWycofana(o)) {
      blad(o, 'Karta jest wycofana — oferta nie zostanie wystawiona.');
      return true;
    }
    if (!bramka(konto, o).wolno) return false;
    const externalId = `${znakInstalacji(db)}-K${o.kartaId}`;
    let zadanie;
    let droga;
    try {
      // POST nowej oferty odmawia wyjątku cennika spoza listy konta jak podgląd (błąd z tekstem, bez POST).
      const t = await trescKarty(konto, o, { tworzenie: true });
      if (t.problem) {
        problem(o, t.problem);
        return true;
      }
      if (t.w.bledy.length) {
        blad(o, t.w.bledy.map((b) => b.tekst ?? b.kod).join('; '));
        return true;
      }
      if (migawka?.wlaczone && !(t.w.zadanie.stock?.available > 0)) return false;
      droga = t.w.droga;
      const adresy = await wgrajZdjecia(konto, o, t.w.doWgrania);
      if (!adresy) return true;
      zadanie = { ...podstawWgraneZdjecia(t.w.zadanie, adresy), external: { id: externalId } };
    } catch (e) {
      if (odrzucone(e)) blad(o, komunikat(e));
      else pozniej(o, przerwaPonowienia(o.liczbaProb + 1), { liczbaProb: o.liczbaProb + 1, blad: komunikat(e) });
      return true;
    }
    if (!bramka(konto, o).wolno) return true;
    const zapiszWyslanie = () => {
      if (o.idZewnetrzne !== `ext:${externalId}`) {
        // Pierwsze wystawienie bez numeru: POST dostaje tymczasowe `ext:…`.
        db.prepare('UPDATE oferty_kanalow SET id_zewnetrzne = ? WHERE id = ?').run(`ext:${externalId}`, o.id);
      }
      zmien(o, {
        stan: 'wyslana',
        liczbaProb: o.liczbaProb + 1,
        nastepnaProbaAt: iso(czas() + przerwaPonowienia(o.liczbaProb + 1)),
        wyslanySkrot: skrotAllegro(o.kartaId, konto.klucz, zadanie),
        wyslanoAt: iso(),
        blad: null,
        problemy: null,
        wyslanaIlosc: zadanie.stock?.available ?? null,
        wyslanaCenaGr: groszeZKwoty(zadanie.sellingMode?.price?.amount, 'cena oferty Allegro'),
        wyslanePola: {
          externalId,
          nazwa: zadanie.name,
          dostawa: zadanie.delivery,
          droga,
          etap: 'wystawienie',
          odzyskOd: null,
          operacja: null,
          operacjaOd: null,
          ...(droga === 'katalog-id' && zadanie.productSet?.[0]?.product?.id
            ? { produktId: String(zadanie.productSet[0].product.id) }
            : {}),
        },
      });
    };
    const wystaw = () => konto.katalog.wystawOferte(externalId, zadanie);
    let wynik;
    try {
      zapiszWyslanie();
      wynik = await wystaw();
    } catch (e) {
      const teraz2 = ofertaPoId(db, o.id);
      if (kodHttp(e) === 429) {
        // 429 = nie przyjęte (rejestr usuwa wpis niejednoznaczny); wraca do kolejki z Retry-After.
        pozniej(teraz2, czekanieS(e.retryAfterS) * 1000, { stan: 'do_wyslania', blad: komunikat(e) });
      } else if (niezgodnyParametr(e)) {
        // Produkt z katalogu istnieje, ale wartość parametru karty się różni — wybór na karcie.
        const m = niezgodnyParametr(e).metadata ?? {};
        problem(teraz2, PROBLEMY_ALLEGRO['parameter-mismatch'](m.productId ?? null, m.parameterId ?? null));
      } else if (odrzucone(e)) {
        blad(teraz2, komunikat(e));
      } else {
        // 5xx, sieć, limit czasu albo odmowa bariery: wynik nieznany — zostaje `wyslana`, decyduje odzysk po sygnaturze.
        log(`Allegro ${konto.klucz}: oferta karty ${o.kartaId} bez potwierdzenia (${komunikat(e)})`);
        zmien(teraz2, { blad: komunikat(e) });
      }
      return true;
    }
    const w = ofertaPoId(db, o.id);
    if (!wynik.ok) {
      blad(w, wynik.powod);
      return true;
    }
    const d = wynik.dane ?? {};
    if (!d.ofertaId) return true; // bez numeru: zostaje `wyslana`, odzysk po sygnaturze
    przypiszIdZewnetrzne(db, o.id, String(d.ofertaId), opcje());
    zmien(w, {
      stan: 'sprawdzana',
      blad: null,
      nastepnaProbaAt: d.operacja ? iso(czas() + czekanieS(d.retryAfterS) * 1000) : iso(),
      wyslanePola: { ...pola(w), operacja: d.operacja ?? null, operacjaOd: d.operacja ? iso() : null },
    });
    return true;
  }

  /** Krok 2: wiersz `wyslana` bez numeru — szukamy własnej oferty po sygnaturze. */
  async function odzyskaj(konto, o) {
    const p = pola(o);
    if (!p.externalId) {
      blad(o, 'Brak sygnatury wysłanej oferty — nie da się sprawdzić, czy Allegro ją przyjęło.');
      return;
    }
    let lista;
    try {
      lista = await konto.allegro.ofertyPoSygnaturze(p.externalId);
    } catch (e) {
      pozniej(o, ODCZYT_PO_SYGNATURZE_CO_MS, { blad: komunikat(e) });
      return;
    }
    const zajeta = (id) => {
      const inna = ofertaPoIdZewnetrznym(db, konto.klucz, String(id));
      return Boolean(inna && inna.id !== o.id);
    };
    const nasze = lista.filter(
      (x) =>
        x?.external?.id === p.externalId &&
        STATUSY_NASZE.has(x?.publication?.status) &&
        !zajeta(x.id) &&
        // Lista ofert Allegro oddaje nazwę z encjami HTML („&amp;”) — porównujemy po ich zdjęciu.
        dekodujEncje(x?.name) === dekodujEncje(p.nazwa),
    );
    if (nasze.length > 1) {
      problem(o, PROBLEMY_ALLEGRO.duplikat(nasze.map((x) => ({ id: String(x.id), nazwa: x.name }))));
      return;
    }
    if (nasze.length === 1) {
      przypiszIdZewnetrzne(db, o.id, String(nasze[0].id), opcje());
      zwolnijPost(konto, p.externalId);
      zmien(o, {
        stan: 'sprawdzana',
        blad: null,
        nastepnaProbaAt: iso(),
        wyslanePola: { ...p, odzyskOd: null, operacja: null },
      });
      return;
    }
    const od = p.odzyskOd ? Date.parse(p.odzyskOd) : null;
    if (od !== null && czas() - od >= ODZYSK_MS) {
      // Dwa odczyty bez naszej oferty, ≥ 15 min od siebie: Allegro jej nie przyjęło — wolno wystawić ponownie.
      zwolnijPost(konto, p.externalId);
      zmien(o, { stan: 'do_wyslania', nastepnaProbaAt: iso(), wyslanePola: { ...p, odzyskOd: null } });
      return;
    }
    pozniej(o, ODCZYT_PO_SYGNATURZE_CO_MS, { wyslanePola: { ...p, odzyskOd: p.odzyskOd ?? iso() } });
  }

  /** Krok 3: operacja (202/303), stan oferty, aktywacja albo szkic. */
  async function sprawdz(konto, o, ustawienia) {
    let p = pola(o);
    const bladOdczytu = (e) => {
      if (odrzucone(e)) {
        if (p.etap === 'aktywacja') {
          problem(o, PROBLEMY_ALLEGRO.aktywacja(komunikat(e)));
          return;
        }
        if (o.idZewnetrzne && !o.idZewnetrzne.startsWith('ext:')) {
          // Licznik odczytu jest osobny od `liczbaProb` komend i wznowienia; po MAKS_PROB_KOMENDY odrzuconej treści
          // skrót zostaje, więc ta sama treść nie idzie ponownie, dopóki karta się nie zmieni.
          const n = (p.probyOdczytu ?? 0) + 1;
          // 401/403 = brak dostępu (np. wygasły token), nie odrzucona treść — nie kończy limitu treści.
          const dosc = p.etap === 'tresc' && n >= MAKS_PROB_KOMENDY && !bezDostepu(e);
          zmien(o, {
            stan: !dosc && o.odczytStatus ? (AKTYWNE.has(o.odczytStatus) ? 'aktywna' : 'nieaktywna') : 'problem',
            problemy: [
              {
                kod: 'odczyt',
                tekst: dosc
                  ? `Allegro ${n} razy odrzuciło zmianę treści (HTTP ${kodHttp(e)}): ${komunikat(e)}. Popraw kartę produktu.`
                  : `Nie udało się odczytać wyniku w Allegro (HTTP ${kodHttp(e)}): ${komunikat(e)}`,
              },
            ],
            blad: null,
            nastepnaProbaAt: null,
            ...(p.etap === 'tresc' && !dosc ? { wyslanySkrot: null } : {}),
            wyslanePola: {
              ...p,
              etap: null,
              operacja: null,
              probyOdczytu: n,
              odczytPo: dosc ? null : iso(czas() + przerwaPonowienia(n)),
            },
          });
        } else blad(o, komunikat(e));
      } else pozniej(o, czekanieS(e?.retryAfterS) * 1000, { blad: komunikat(e) });
    };
    let odrzucenie = null;
    if (p.operacja) {
      let r;
      try {
        r = await konto.allegro.stanOperacji(p.operacja);
      } catch (e) {
        // Operacja może skończyć się 422 zamiast 303 (np. ENDED na ofercie już nieaktywnej) — przy zdejmowaniu
        // rozstrzyga odczyt oferty niżej; odrzucone wznowienie czeka na człowieka.
        if (odrzucone(e) && p.etap === 'zdejmowanie') {
          r = { wToku: false };
          odrzucenie = komunikat(e);
        } else if (odrzucone(e) && p.etap === 'wznowienie') {
          zmien(o, {
            stan: 'problem',
            problemy: [
              PROBLEMY_ALLEGRO.zakonczona(
                Number(p.sztukPrzedWznowieniem) || 0,
                `Allegro odrzuciło wznowienie: ${komunikat(e)}`,
              ),
            ],
            nastepnaProbaAt: null,
            wyslanePola: { ...p, etap: null, operacja: null },
          });
          return;
        } else {
          bladOdczytu(e);
          return;
        }
      }
      if (r.wToku) {
        const od = Date.parse(p.operacjaOd ?? o.wyslanoAt ?? iso());
        if (czas() - od >= BEZ_POTWIERDZENIA_MS) problem(o, PROBLEMY_ALLEGRO['bez-potwierdzenia']());
        else pozniej(o, czekanieS(r.retryAfterS) * 1000);
        return;
      }
      p = { ...p, operacja: null };
      zmien(o, { wyslanePola: p });
    }
    let oferta;
    try {
      const s = await konto.katalog.stanOferty(o.idZewnetrzne);
      if (!s.ok) {
        blad(o, s.powod);
        return;
      }
      oferta = s.dane ?? {};
    } catch (e) {
      bladOdczytu(e);
      return;
    }
    if (p.probyOdczytu || p.odczytPo) {
      const { probyOdczytu: _n, odczytPo: _t, skrotOdrzuconej: _s, ...bezOdczytu } = p;
      p = bezOdczytu;
      zmien(o, { wyslanePola: p });
    }
    const status = oferta.publication?.status ?? null;
    const produkt = oferta.productSet?.[0];
    const gpsr =
      p.droga === 'katalog-id' && (produkt?.responsibleProducer || produkt?.responsiblePerson)
        ? {
            gpsrZProduktu: {
              responsibleProducer: produkt.responsibleProducer ?? null,
              responsiblePerson: produkt.responsiblePerson ?? null,
            },
          }
        : {};
    if (p.etap === 'zdejmowanie') {
      // PATCH ENDED potwierdzony odczytem. Nadal aktywna → synchronizacja spróbuje ponownie (bez wycofanoAt),
      // z przerwą rosnącą od 5 min i najwyżej MAKS_PROB_ZDJECIA razy.
      if (AKTYWNE.has(status)) {
        nieudaneZdjecie(
          o,
          odrzucenie ?? `oferta nadal ${status}`,
          (n) => Math.min(3_600_000, ODCZYT_PO_SYGNATURZE_CO_MS * 2 ** (n - 1)),
          { stan: 'aktywna', odczytStatus: status, wyslanePola: { ...p, etap: null } },
        );
      } else
        zmien(o, {
          stan: 'nieaktywna',
          problemy: null,
          blad: null,
          liczbaProb: 0,
          nastepnaProbaAt: null,
          odczytStatus: status,
          wyslanePola: { ...p, etap: null, wycofanoAt: iso() },
        });
      return;
    }
    if (AKTYWNE.has(status)) {
      const { szkic: _s, aktywuj: _a, ...reszta } = p;
      if (reszta.etap === 'wznowienie') {
        reszta.etap = null;
        if (migawka?.wlaczone) delete reszta.zakonczonaPrzezOms;
      }
      zmien(
        o,
        {
          stan: 'aktywna',
          problemy: null,
          blad: null,
          liczbaProb: 0,
          nastepnaProbaAt: null,
          odczytStatus: status,
          wyslanePola: { ...reszta, ...gpsr },
        },
        p.aktywuj ? ['aktywuj'] : [],
      );
      return;
    }
    if (p.etap === 'wznowienie') {
      // Operacja wznowienia skończona, a oferta nadal nieaktywna — bez kolejnej próby, decyzja człowieka.
      const powody = (Array.isArray(oferta.validation?.errors) ? oferta.validation.errors : [])
        .map((b) => b?.userMessage || b?.message || '')
        .filter(Boolean);
      const tekst = `Allegro nie wznowiło oferty (status ${status ?? 'nieznany'})${powody.length ? `: ${powody.join('; ')}` : ''}.`;
      zmien(o, {
        stan: 'problem',
        problemy: [PROBLEMY_ALLEGRO.zakonczona(Number(p.sztukPrzedWznowieniem) || 0, tekst)],
        nastepnaProbaAt: null,
        odczytStatus: status,
        wyslanePola: { ...p, etap: null },
      });
      return;
    }
    if (status === 'ENDED') {
      // Zakończona oferta nigdy nie wraca gołym PATCH ACTIVE — tylko przez Wznów (ilość z karty, hamulce Wznów).
      const { aktywuj: _a, ...reszta } = p;
      zmien(o, {
        stan: 'problem',
        problemy: [PROBLEMY_ALLEGRO.zakonczona(Number(oferta.stock?.available) || 0)],
        blad: null,
        nastepnaProbaAt: null,
        odczytStatus: status,
        wyslanePola: { ...reszta, ...gpsr, etap: null, operacja: null },
      });
      return;
    }
    const bledy = Array.isArray(oferta.validation?.errors) ? oferta.validation.errors : [];
    if (bledy.length) {
      const lista = bledy.map((b) => ({ kod: b?.code ?? null, tekst: b?.userMessage || b?.message || '' }));
      if (p.etap === 'aktywacja') {
        const { aktywuj: _a, ...reszta } = p;
        zmien(
          o,
          {
            stan: 'problem',
            problemy: [PROBLEMY_ALLEGRO.aktywacja(lista.map((b) => b.tekst).join('; '))],
            nastepnaProbaAt: null,
            wyslanePola: reszta,
          },
          p.aktywuj ? ['aktywuj'] : [],
        );
      } else problem(o, PROBLEMY_ALLEGRO.walidacja(lista));
      return;
    }
    if (p.etap === 'aktywacja') {
      const { aktywuj: _a, ...reszta } = p;
      zmien(
        o,
        {
          stan: 'problem',
          problemy: [PROBLEMY_ALLEGRO.aktywacja(`Allegro nie aktywowało oferty (status ${status ?? 'nieznany'}).`)],
          nastepnaProbaAt: null,
          wyslanePola: reszta,
        },
        p.aktywuj ? ['aktywuj'] : [],
      );
      return;
    }
    if (p.etap === 'tresc' || p.zdejmij) {
      // Zmiana treści nieaktywnej oferty albo oferta do zdjęcia: bez samoczynnej aktywacji.
      zmien(o, {
        stan: 'nieaktywna',
        blad: null,
        liczbaProb: 0,
        nastepnaProbaAt: null,
        odczytStatus: status,
        wyslanePola: { ...p, ...gpsr, etap: null },
      });
      return;
    }
    if (kartaWycofana(o) || !ustawienia.aktywujPoSprawdzeniu) {
      zmien(o, {
        stan: 'nieaktywna',
        blad: null,
        liczbaProb: 0,
        nastepnaProbaAt: null,
        odczytStatus: status,
        wyslanePola: { ...p, ...gpsr, szkic: true },
      });
      return;
    }
    if (!bramka(konto, o).wolno || !zapis()) return;
    // Aktywacja jest idempotentna (to samo ciało), więc zgubiony wcześniej PATCH wolno powtórzyć.
    zwolnijOperacje(konto.klucz, 'PATCH', zasobPatch(o.idZewnetrzne));
    let r;
    try {
      r = await konto.katalog.zmienOferte(o.idZewnetrzne, { publication: { status: 'ACTIVE' } });
    } catch (e) {
      if (odrzucone(e)) problem(o, PROBLEMY_ALLEGRO.aktywacja(komunikat(e)));
      else pozniej(o, czekanieS(e?.retryAfterS) * 1000, { blad: komunikat(e) });
      return;
    }
    if (!r.ok) {
      blad(o, r.powod);
      return;
    }
    const d = r.dane ?? {};
    zmien(o, {
      nastepnaProbaAt: iso(czas() + czekanieS(d.retryAfterS) * 1000),
      blad: null,
      wyslanePola: { ...p, ...gpsr, etap: 'aktywacja', operacja: d.operacja ?? null, operacjaOd: iso() },
    });
  }

  /** Zdjęcia do wgrania → mapa id zdjęcia → adres w Allegro; null = bramka zamknięta w trakcie. */
  async function wgrajZdjecia(konto, o, doWgrania) {
    const adresy = new Map();
    for (const z of doWgrania) {
      if (!bramka(konto, o).wolno) return null;
      const bajty = await czytajZdjecie(z);
      const wgrane = await konto.allegro.wgrajZdjecie(bajty, z.typ ?? 'image/jpeg', { ai: z.ai === 1 });
      // Od tej chwili znacznik AI zdjęcia jest zablokowany (wyslane_at) — Allegro zna już plik z tą flagą.
      zapiszWgraneZdjecie(
        db,
        {
          zdjecieId: z.id,
          konto: konto.klucz,
          adres: wgrane.location,
          ai: z.ai === 1 ? 1 : 0,
          wygasaAt: wgrane.expiresAt ?? null,
        },
        opcje(),
      );
      adresy.set(String(z.id), wgrane.location);
    }
    return adresy;
  }

  /** Aktywacja szkicu na żądanie (`aktywuj`). Oferta zdjęta, nie-szkic albo karta wycofana → tylko zdjęcie flagi. */
  async function aktywuj(konto, o) {
    const p = pola(o);
    const { aktywuj: _a, ...bezFlagi } = p;
    const karta = db.prepare('SELECT wycofana FROM karty_produktow WHERE id = ?').get(o.kartaId);
    if (o.odczytStatus === 'ENDED' || p.szkic !== true || p.zdejmij || karta?.wycofana) {
      zmien(o, { wyslanePola: bezFlagi }, ['aktywuj']);
      return;
    }
    if (!bramka(konto, o).wolno || !zapis()) return;
    zwolnijOperacje(konto.klucz, 'PATCH', zasobPatch(o.idZewnetrzne));
    let r;
    try {
      r = await konto.katalog.zmienOferte(o.idZewnetrzne, { publication: { status: 'ACTIVE' } });
    } catch (e) {
      if (odrzucone(e)) {
        zmien(
          o,
          {
            stan: 'problem',
            problemy: [PROBLEMY_ALLEGRO.aktywacja(komunikat(e))],
            nastepnaProbaAt: null,
            wyslanePola: bezFlagi,
          },
          ['aktywuj'],
        );
      } else pozniej(o, czekanieS(e?.retryAfterS) * 1000, { blad: komunikat(e) });
      return;
    }
    if (!r.ok) {
      zmien(o, { blad: r.powod, wyslanePola: bezFlagi }, ['aktywuj']);
      return;
    }
    const d = r.dane ?? {};
    zmien(o, {
      stan: 'sprawdzana',
      blad: null,
      nastepnaProbaAt: iso(czas() + czekanieS(d.retryAfterS) * 1000),
      wyslanePola: { ...p, etap: 'aktywacja', operacja: d.operacja ?? null, operacjaOd: iso() },
    });
  }

  /**
   * Oferty już wystawione. Jeden odczyt listy ofert konta, potem dla każdego wiersza: wynik zaległej komendy,
   * zdjęcie, zakończona, treść (PATCH), ilość i cena (komendy grupowane po wartości, po pętli).
   */
  async function synchronizuj(konto) {
    const wiersze = db
      .prepare(
        `SELECT id FROM oferty_kanalow WHERE kanal = ? AND tryb IN ('zarzadzana', 'obserwowana')
      AND stan IN (${STANY_SYNCHRONIZACJI_ALLEGRO.map(() => '?').join(', ')}) AND id_zewnetrzne NOT LIKE 'ext:%' ORDER BY id`,
      )
      .all(konto.klucz, ...STANY_SYNCHRONIZACJI_ALLEGRO)
      .map((w) => ofertaPoId(db, Number(w.id)));
    // Wycofana karta albo „Zdejmij” idą dalej przy każdym problemie — ENDED musi wyjść, inaczej oferta dalej sprzedaje.
    // Tak samo znacznik „Wznów” — inaczej po problemie karty zostałby na zawsze, bez PATCH i bez przycisku.
    const pelna = (o) =>
      o.stan !== 'problem' ||
      pola(o).zdejmij ||
      pola(o).wznow ||
      kartaWycofana(o) ||
      o.problemy.every((x) => PROBLEMY_SYNCHRONIZACJI.has(x?.kod));
    // Przy włączonych stanach każdy objęty wiersz dostaje odczyt i ilość niezależnie od problemu treści/ceny —
    // inaczej problem ceny przy celu 0 zostawiłby sprzedającą ofertę (nadsprzedaż).
    const samaIlosc = (o) => Boolean(migawka?.wlaczone && (o.tryb === 'zarzadzana' || o.iloscZOms));
    const kandydaci = wiersze.filter((o) => o && (pelna(o) || samaIlosc(o)));
    if (!kandydaci.length) {
      log(`oferty-allegro: konto ${konto.klucz}: komendy 0, stock 0, zapisy ${zapisy}`);
      return;
    }
    let lista;
    try {
      const r = await konto.katalog.odczytOfert({ offset: 0 });
      if (!r.ok) {
        log(`Allegro ${konto.klucz}: odczyt ofert: ${r.powod}`);
        return;
      }
      lista = r.dane?.oferty ?? [];
    } catch (e) {
      log(`Allegro ${konto.klucz}: odczyt ofert: ${komunikat(e)}`);
      return;
    }
    const poId = new Map(lista.map((x) => [String(x?.id), x]));
    // Cele, wyjaśnienia i bezpiecznik masowy tylko przy włączonych stanach — wyłączone nie robią nowych zapytań.
    // Awaria któregokolwiek z nich pomija ilość tego konta (`ilosci` = null); cena, treść i zdejmowanie idą dalej.
    let ilosci = null;
    if (migawka?.wlaczone) {
      try {
        const objete = wiersze.filter((o) => o.tryb === 'zarzadzana' || o.iloscZOms);
        const ustawienia = ustawieniaOfertKonta(db, konto.klucz);
        const cele = new Map(
          objete.map((o) => [
            o.id,
            iloscDlaKanalu({
              migawka,
              kartaId: o.kartaId,
              tryb: o.tryb,
              iloscZOms: o.iloscZOms,
              bufor: ustawienia.buforSzt,
              stalaIlosc: ustawienia.stalaIlosc,
            }),
          ]),
        );
        const granica = czas() - HORYZONT_WYJASNIEN_MS;
        const wyjasnienia = wyjasnieniaOfert(
          db,
          objete.map((o) => {
            const t = Date.parse(o.iloscWyslanaAt ?? '');
            return {
              id: o.id,
              kanal: o.kanal,
              ofertaId: o.idZewnetrzne,
              kartaId: o.kartaId,
              od: Number.isFinite(t) && t < granica ? null : o.iloscWyslanaAt,
              regula: 'zlozone',
            };
          }),
        );
        // Bezpiecznik masowy liczy tylko oferty, które sprzedają (zakończone przez OMS nie są „zerowane”).
        // Oferta z potwierdzonym „Wyślij zera” nie wchodzi do bezpiecznika masowego.
        const masowe = zeroMasowe(
          objete
            .filter(
              (o) =>
                AKTYWNE.has(poId.get(String(o.idZewnetrzne))?.publication?.status) &&
                liczySieDoZeraMasowego(o, migawka),
            )
            .map((o) => ({
              cel: cele.get(o.id)?.ilosc,
              odczyt: poId.get(String(o.idZewnetrzne))?.stock?.available,
            })),
        );
        ilosci = { cele, wyjasnienia, masowe };
      } catch (e) {
        log(`Allegro ${konto.klucz}: pominięto ilość — błąd wyjaśnień (${komunikat(e)})`);
      }
    }
    /** @type {Map<string, Array<{o: any, wartosc: any}>>} */
    const komendy = new Map();
    const dodajKomende = (rodzaj, wartosc, o) => {
      const klucz =
        migawka?.wlaczone && rodzaj === 'ilosc'
          ? kluczKomendyIlosci({ cel: wartosc, odczyt: o.odczytIlosc })
          : `${rodzaj}:${wartosc}`;
      if (!komendy.has(klucz)) komendy.set(klucz, []);
      komendy.get(klucz).push({ o, wartosc });
    };
    for (const o0 of kandydaci) {
      try {
        await synchronizujWiersz(
          konto,
          o0,
          poId.get(String(o0.idZewnetrzne)),
          dodajKomende,
          ilosci && {
            cel: ilosci.cele.get(o0.id),
            wyjasnienie: ilosci.wyjasnienia.get(o0.id) ?? {},
            masowe: ilosci.masowe,
          },
          !pelna(o0),
        );
      } catch (e) {
        log(`Allegro ${konto.klucz}: synchronizacja oferty ${o0.id}: ${komunikat(e)}`);
      }
    }
    const grupy = [...komendy];
    // Wznowienie (ACTIVATE) to podwyżka — po obniżkach i END.
    const priorytet = (klucz) =>
      klucz.startsWith('cena:') ? 2 : klucz.endsWith(':podwyzka') || klucz === 'publikacja:ACTIVATE' ? 1 : 0;
    if (migawka?.wlaczone) grupy.sort(([a], [b]) => priorytet(a) - priorytet(b));
    let stock = 0;
    for (const [klucz, pozycje] of grupy) {
      const rodzaj = klucz.startsWith('publikacja:') ? 'publikacja' : klucz.startsWith('ilosc:') ? 'ilosc' : 'cena';
      for (let i = 0; i < pozycje.length; i += MAKS_OFERT_KOMENDY) {
        if (!zapis(true)) break;
        await wyslijKomende(konto, rodzaj, pozycje.slice(i, i + MAKS_OFERT_KOMENDY));
        if (rodzaj !== 'cena') stock += pozycje.slice(i, i + MAKS_OFERT_KOMENDY).length;
      }
    }
    log(`oferty-allegro: konto ${konto.klucz}: komendy ${grupy.length}, stock ${stock}, zapisy ${zapisy}`);
  }

  const POLE_KOMENDY = { ilosc: 'komendaIlosci', cena: 'komendaCeny', publikacja: 'komendaPublikacji' };

  /** Komenda odrzucona (FAIL albo 4xx na PUT): kolejna próba po przerwie, po MAKS_PROB_KOMENDY problem bez ponowień. */
  function nieudanaKomenda(rodzaj, w, tekst, p) {
    if (migawka?.wlaczone && rodzaj !== 'cena') {
      // Własny licznik i przerwa ilości/publikacji; problem dopisany obok problemów treści i ceny.
      const n = (p.przerwaIlosci?.proby ?? 0) + 1;
      if (n >= MAKS_PROB_KOMENDY) {
        zmien(w, {
          stan: 'problem',
          wyslanePola: bezPrzerwyIlosci(p),
          problemy: [
            ...(w.problemy ?? []).filter((x) => !(x?.kod === 'komenda' && x.rodzaj === rodzaj)),
            PROBLEMY_ALLEGRO.komenda(rodzaj, tekst),
          ],
        });
      } else zmien(w, { wyslanePola: { ...p, przerwaIlosci: { do: iso(czas() + przerwaPonowienia(n)), proby: n } } });
      return;
    }
    const n = w.liczbaProb + 1;
    if (n >= MAKS_PROB_KOMENDY) {
      zmien(w, {
        stan: 'problem',
        problemy: [PROBLEMY_ALLEGRO.komenda(rodzaj, tekst)],
        blad: tekst,
        liczbaProb: n,
        nastepnaProbaAt: null,
        wyslanePola: p,
      });
    } else
      zmien(w, { blad: tekst, liczbaProb: n, nastepnaProbaAt: iso(czas() + przerwaPonowienia(n)), wyslanePola: p });
  }

  /** Wynik komendy zapisany w wierszu: true = sukces (wartość przyjęta), false = porażka, null = jeszcze nie wiadomo. */
  function zapiszWynikKomendy(rodzaj, o, wartosc, zadanie) {
    const w = ofertaPoId(db, o.id);
    const { [POLE_KOMENDY[rodzaj]]: _k, ...p } = pola(w);
    if (zadanie?.status === 'SUCCESS') {
      if (rodzaj === 'ilosc') potwierdzoneIlosci.add(o.id);
      // T = chwila migawki, z której pochodzi zapisany stan karty (komenda zaległa — chwila z jej przebiegu).
      const chwila = _k?.stanKartyAt ?? chwilaMigawki ?? iso();
      if (rodzaj === 'publikacja') {
        // Sukces publikacji nie zeruje licznika ani błędu treści/ceny; wznowienie pętli liczone do limitu doby.
        zmien(
          w,
          {
            ...(wartosc === 'END' ? { iloscWyslanaAt: chwila, stanKartyWyslany: _k?.stanKarty ?? null } : {}),
            wyslanePola: {
              ...bezPrzerwyIlosci(p),
              publikacjaWToku: { status: wartosc === 'ACTIVATE' ? 'ACTIVE' : 'ENDED', at: iso() },
              ...(wartosc === 'ACTIVATE'
                ? {
                    wznowienieIlosc: null,
                    wznowionaAt: iso(),
                    wznowienia: p.wznow ? wznowieniaDoby(p) : [...wznowieniaDoby(p), iso()],
                  }
                : {}),
            },
          },
          wartosc === 'ACTIVATE' ? ['wznow'] : [],
        );
      } else if (rodzaj === 'ilosc')
        zmien(w, {
          wyslanaIlosc: wartosc,
          ...(!migawka?.wlaczone ? { odczytIlosc: wartosc, blad: null, liczbaProb: 0 } : {}),
          ...(migawka?.wlaczone
            ? { iloscWyslanaAt: chwila, stanKartyWyslany: _k?.stanKarty ?? migawka.stany.get(w.kartaId)?.stan ?? null }
            : {}),
          wyslanePola: p.wznowienieIlosc
            ? { ...bezPrzerwyIlosci(p), wznowienieIlosc: { ...p.wznowienieIlosc, gotowe: true } }
            : bezPrzerwyIlosci(p),
        });
      else {
        const { cenaPotwierdzonaGr: _c, ...bezPotw } = p;
        zmien(
          w,
          {
            wyslanaCenaGr: wartosc,
            odczytCenaGr: wartosc,
            cenaDoPotwierdzeniaGr: null,
            blad: null,
            liczbaProb: 0,
            wyslanePola: bezPotw,
          },
          ['cenaPotwierdzonaGr'],
        );
      }
      return true;
    }
    if (zadanie?.status === 'FAIL') {
      // Tylko przy włączonych stanach — wyłączone liczą ten FAIL jak każdy inny (5 prób, potem problem).
      if (
        migawka?.wlaczone &&
        rodzaj === 'ilosc' &&
        JSON.stringify(zadanie).includes('AvailableStockCannotBeChanged')
      ) {
        zmien(w, {
          iloscProblem: { ...PROBLEMY_ILOSCI['ilosc-niezmienialna'], od: iso(), cel: wartosc, odczyt: w.odczytIlosc },
          wyslanePola: bezPrzerwyIlosci(p),
        });
        return false;
      }
      nieudanaKomenda(rodzaj, w, String(zadanie.message ?? 'Allegro odrzuciło komendę.').slice(0, 500), p);
      return false;
    }
    return null;
  }

  /** Komenda ilości albo ceny: UUID zapisany w wierszach PRZED wysłaniem — po zgubionej odpowiedzi czytamy jej wynik. */
  async function wyslijKomende(konto, rodzaj, pozycje) {
    pozycje = pozycje.filter(({ o }) => {
      const w = ofertaPoId(db, o.id);
      return bramka(konto, w, rodzaj === 'cena' ? null : 'ilosc').wolno;
    });
    if (!pozycje.length) return;
    const id = randomUUID();
    const pole = POLE_KOMENDY[rodzaj];
    for (const { o, wartosc } of pozycje) {
      const w = ofertaPoId(db, o.id);
      zmien(w, {
        wyslanePola: {
          ...pola(w),
          [pole]: {
            id,
            wartosc,
            at: iso(),
            ...(migawka?.wlaczone && rodzaj !== 'cena'
              ? { stanKarty: migawka.stany.get(w.kartaId)?.stan ?? null, stanKartyAt: chwilaMigawki }
              : {}),
          },
          ...(rodzaj === 'publikacja' && wartosc === 'END' ? { zakonczonaPrzezOms: { at: iso() } } : {}),
        },
      });
    }
    try {
      if (rodzaj === 'ilosc')
        await konto.allegro.komendaIlosci(
          id,
          pozycje.map(({ o, wartosc }) => ({ ofertaId: String(o.idZewnetrzne), ilosc: wartosc })),
        );
      else if (rodzaj === 'publikacja') {
        // Metodę klienta udostępnia nowszy adapter; starszy adapter wezlyAllegro jeszcze jej nie przepuszcza.
        const klient = typeof konto.allegro.komendaPublikacji === 'function' ? konto.allegro : konto.klient;
        await klient.komendaPublikacji(
          id,
          pozycje.map(({ o }) => String(o.idZewnetrzne)),
          pozycje[0].wartosc,
        );
      } else
        await konto.allegro.komendaCeny(
          id,
          pozycje.map(({ o, wartosc }) => ({ ofertaId: String(o.idZewnetrzne), cena: kwotaDziesietna(wartosc) })),
        );
    } catch (e) {
      if (odrzucone(e)) {
        for (const { o } of pozycje) {
          const w = ofertaPoId(db, o.id);
          const { [pole]: _k, ...p } = pola(w);
          nieudanaKomenda(rodzaj, w, komunikat(e), p);
        }
      } else {
        // 5xx/429 albo brak odpowiedzi — UUID zostaje w wierszach (wynik czyta zalegleKomendy), nowa komenda
        // dopiero po Retry-After albo po przerwie rosnącej z liczbą prób.
        for (const { o } of pozycje) {
          const w = ofertaPoId(db, o.id);
          if (migawka?.wlaczone && rodzaj !== 'cena') {
            const p = pola(w);
            const n = (p.przerwaIlosci?.proby ?? 0) + 1;
            const ms = e?.retryAfterS ? czekanieS(e.retryAfterS) * 1000 : przerwaPonowienia(n);
            zmien(w, { wyslanePola: { ...p, przerwaIlosci: { do: iso(czas() + ms), proby: n } } });
            continue;
          }
          const n = w.liczbaProb + 1;
          pozniej(w, e?.retryAfterS ? czekanieS(e.retryAfterS) * 1000 : przerwaPonowienia(n), { liczbaProb: n });
        }
        log(`Allegro ${konto.klucz}: komenda ${rodzaj} ${id} bez potwierdzenia (${komunikat(e)})`);
      }
      return;
    }
    let zadania;
    try {
      zadania = await konto.allegro.wynikKomendy(rodzaj, id);
    } catch (e) {
      log(`Allegro ${konto.klucz}: wynik komendy ${rodzaj} ${id}: ${komunikat(e)}`);
      return;
    }
    const poOfercie = new Map((Array.isArray(zadania) ? zadania : []).map((t) => [String(t?.offer?.id), t]));
    for (const { o, wartosc } of pozycje) zapiszWynikKomendy(rodzaj, o, wartosc, poOfercie.get(String(o.idZewnetrzne)));
  }

  /** Zaległa komenda wiersza: true = wolno liczyć dalej, false = czekamy na jej wynik. */
  async function zalegleKomendy(konto, o, zCena = true) {
    for (const rodzaj of ['ilosc', ...(zCena ? ['cena'] : []), ...(migawka?.wlaczone ? ['publikacja'] : [])]) {
      const k = pola(ofertaPoId(db, o.id))[POLE_KOMENDY[rodzaj]];
      if (!k?.id) continue;
      let zadania;
      try {
        zadania = await konto.allegro.wynikKomendy(rodzaj, k.id);
      } catch (e) {
        if (kodHttp(e) !== 404) return false;
        zadania = null; // Allegro nie zna komendy — nie dotarła, wolno wysłać nową z nowym UUID.
      }
      const t = Array.isArray(zadania) ? zadania.find((x) => String(x?.offer?.id) === String(o.idZewnetrzne)) : null;
      if (t && t.status !== 'SUCCESS' && t.status !== 'FAIL') return false;
      if (t) {
        if (!zapiszWynikKomendy(rodzaj, o, k.wartosc, t)) return false;
      } else {
        const w = ofertaPoId(db, o.id);
        const { [POLE_KOMENDY[rodzaj]]: _k, ...p } = pola(w);
        zmien(w, { wyslanePola: p });
      }
    }
    return true;
  }

  async function synchronizujWiersz(konto, o0, x, dodajKomende, stany, tylkoIlosc = false) {
    if (!x) {
      if (tylkoIlosc) return;
      const wyslano = Date.parse(o0.wyslanoAt ?? '');
      const nieWidzianaPoWyslaniu = !o0.odczytanoAt || Date.parse(o0.odczytanoAt) < wyslano;
      if (nieWidzianaPoWyslaniu && czas() - wyslano < SWIEZA_OFERTA_MS) return;
      problem(o0, PROBLEMY_ALLEGRO['brak-w-allegro']());
      return;
    }
    const status = x.publication?.status ?? null;
    const odczyt = {
      odczytIlosc:
        Number.isSafeInteger(x.stock?.available) && (!migawka?.wlaczone || x.stock.available >= 0)
          ? x.stock.available
          : null,
      ...(migawka?.wlaczone
        ? { odczytIloscKanalu: Number.isSafeInteger(x.stock?.available) ? x.stock.available : null }
        : {}),
      odczytCenaGr: groszeZKwoty(x.sellingMode?.price?.amount, 'cena oferty z odczytu Allegro'),
      odczytStatus: status,
      odczytanoAt: iso(),
    };
    zmien(o0, odczyt);
    // Odczyt ACTIVE kasuje znacznik zakończenia przez OMS (oba tryby) — chyba że END dopiero czeka na potwierdzenie.
    // Kasuje też wznowienieIlosc — oferta aktywowana bez naszej komendy, a jej późniejszy ręczny koniec
    // u sprzedawcy nigdy nie budzi ACTIVATE.
    const p0 = pola(ofertaPoId(db, o0.id));
    if (
      AKTYWNE.has(status) &&
      (p0.zakonczonaPrzezOms || p0.wznowienieIlosc) &&
      !p0.komendaPublikacji &&
      !p0.publikacjaWToku
    ) {
      const { zakonczonaPrzezOms: _z, wznowienieIlosc: _w, ...bez } = p0;
      zmien(o0, { wyslanePola: bez });
    }
    // Bez migawki albo bez wyjaśnień ilość nie jest oceniana ani wysyłana (żadnej sztucznej migawki).
    const bezIlosci = !migawka || (migawka.wlaczone && !stany);
    if (o0.tryb !== 'zarzadzana' && !(migawka?.wlaczone && o0.iloscZOms)) return;
    // Wiersz z problemem treści/ceny — tylko odczyt, zaległe komendy ilości/publikacji i ilość; problemy zostają.
    if (tylkoIlosc) {
      if (bezIlosci || o0.problemy.some((x) => x?.kod === 'komenda' && x.rodzaj !== 'cena')) return;
      if (!(await zalegleKomendy(konto, o0, false))) return;
      await synchronizujIlosc(konto, ofertaPoId(db, o0.id), o0, x, stany, dodajKomende, true);
      return;
    }
    if (migawka?.wlaczone && o0.tryb === 'obserwowana') {
      if (!(await zalegleKomendy(konto, o0)) || bezIlosci) return;
      await synchronizujIlosc(konto, ofertaPoId(db, o0.id), o0, x, stany, dodajKomende);
      return;
    }
    let o = ofertaPoId(db, o0.id);
    let p = pola(o);
    const karta = db.prepare('SELECT wycofana FROM karty_produktow WHERE id = ?').get(o.kartaId);
    // „Wznów” dotyczy tylko oferty zakończonej na karcie w sprzedaży — w innym razie znacznik znika bez zapisu.
    if (p.wznow && (status !== 'ENDED' || p.zdejmij || karta?.wycofana)) {
      zmien(o, { wyslanePola: bezWznow(p) }, ['wznow']);
      o = ofertaPoId(db, o.id);
      p = pola(o);
    }
    if (p.zdejmij || karta?.wycofana) {
      if (!AKTYWNE.has(status) || p.wycofanoAt) {
        if (o.stan !== 'nieaktywna') zmien(o, { stan: 'nieaktywna', problemy: null });
        return;
      }
      // Po MAKS_PROB_ZDJECIA próbach czekamy na człowieka (Ponów i Zdejmij zerują licznik).
      if (
        o.stan === 'problem' &&
        (p.probyZdjecia ?? 0) >= MAKS_PROB_ZDJECIA &&
        o.problemy.some((x) => x?.kod === 'zdejmowanie')
      )
        return;
      if (o.nastepnaProbaAt && Date.parse(o.nastepnaProbaAt) > czas()) return;
      if (!bramka(konto, o).wolno || !zapis()) return;
      zwolnijOperacje(konto.klucz, 'PATCH', zasobPatch(o.idZewnetrzne));
      try {
        const r = await konto.katalog.zmienOferte(o.idZewnetrzne, { publication: { status: 'ENDED' } });
        if (!r.ok) {
          nieudaneZdjecie(o, r.powod, przerwaPonowienia);
          return;
        }
        const d = r.dane ?? {};
        const { bledyZdjecia: _b, ...bez } = p;
        zmien(o, {
          stan: 'sprawdzana',
          blad: null,
          nastepnaProbaAt: iso(czas() + czekanieS(d.retryAfterS) * 1000),
          wyslanePola: { ...bez, etap: 'zdejmowanie', operacja: d.operacja ?? null, operacjaOd: iso() },
        });
      } catch (e) {
        // Do limitu prób tylko odrzucenie (4xx). 5xx, 429 i sieć to awaria Allegro — przerwa wg Retry-After
        // albo rosnąca (osobny licznik), bez zbliżania do problemu.
        if (odrzucone(e)) {
          nieudaneZdjecie(o, komunikat(e), przerwaPonowienia);
          return;
        }
        const b = (p.bledyZdjecia ?? 0) + 1;
        pozniej(
          o,
          e?.retryAfterS
            ? czekanieS(e.retryAfterS) * 1000
            : Math.min(3_600_000, ODCZYT_PO_SYGNATURZE_CO_MS * 2 ** (b - 1)),
          { blad: komunikat(e), wyslanePola: { ...p, bledyZdjecia: b } },
        );
      }
      return;
    }
    if (!(await zalegleKomendy(konto, o))) return;
    o = ofertaPoId(db, o.id);
    p = pola(o);
    if (migawka?.wlaczone && !bezIlosci && !p.zdejmij && !karta?.wycofana) {
      const wolno = await synchronizujIlosc(konto, o, o0, x, stany, dodajKomende);
      if (status === 'ENDED' && !wolno) return;
      o = ofertaPoId(db, o.id);
      p = pola(o);
    }
    // Karta znów w sprzedaży: liczniki zdejmowania nie przechodzą na następne wycofanie.
    if (p.probyZdjecia != null || p.bledyZdjecia != null) {
      const { probyZdjecia: _z, bledyZdjecia: _b, ...bez } = p;
      zmien(o, { wyslanePola: bez });
      o = ofertaPoId(db, o.id);
    }
    if (status === 'ENDED') {
      if (bezIlosci) return;
      // Bez „Wznów” pętla decyduje sama tylko o wyprzedanej; ręczne „Wznów” omija oba warunki niżej.
      if (!p.wznow) {
        // Pętla już raz zdecydowała „nie wznawiam” (powód w `tekst`) — czeka na człowieka
        // (także gdy nieudane wznowienie zostawiło w Allegro nową ilość przy statusie ENDED).
        if (o.stan === 'problem' && o.problemy.some((x) => x?.kod === 'zakonczona' && x.tekst && !x.limitDobowy))
          return;
        // Zakończona ręcznie (zostały sztuki) albo ilość nieznana → zawsze decyzja człowieka.
        if (!WZNAWIAJ_WYPRZEDANE || (odczyt.odczytIlosc !== 0 && !(migawka?.wlaczone && p.zakonczonaPrzezOms))) {
          problem(o, PROBLEMY_ALLEGRO.zakonczona(odczyt.odczytIlosc ?? 0));
          return;
        }
      }
      await wznowWyprzedana(konto, o, odczyt.odczytIlosc ?? 0);
      return;
    }
    // Przerwa odczytu wstrzymuje tylko treść; przerwa po zapisie wstrzymuje całą synchronizację.
    if (o.nastepnaProbaAt && Date.parse(o.nastepnaProbaAt) > czas()) return;
    const czekaTresc = Boolean(p.odczytPo && Date.parse(p.odczytPo) > czas());
    const problemOdczytu = o.problemy.find((x) => x.kod === 'odczyt');
    if (!bramka(konto, o).wolno) return;
    const opisKonta = { klucz: konto.klucz, nazwa: konto.nazwa, srodowisko: konto.srodowisko };
    let w;
    if (p.produktId)
      w = ofertaAllegroKarty(db, o.kartaId, opisKonta, {
        teraz: iso(),
        katalog: { produktId: String(p.produktId) },
        migawka,
      });
    else if (p.droga === 'nowy')
      w = ofertaAllegroKarty(db, o.kartaId, opisKonta, { teraz: iso(), katalog: { brak: true }, migawka });
    else {
      const t = await trescKarty(konto, o);
      if (t.problem) {
        problem(o, t.problem);
        return;
      }
      w = t.w;
    }
    // Po MAKS_PROB_KOMENDY odrzuconej treści problem zostaje, dopóki nowa treść karty nie przejdzie odczytu.
    const odrzuconaTresc = Boolean(problemOdczytu && (p.probyOdczytu ?? 0) >= MAKS_PROB_KOMENDY);
    const problemy = (czekaTresc || odrzuconaTresc) && problemOdczytu ? [problemOdczytu] : [];
    if (w.bledy.length) {
      problemy.push({ kod: 'karta', tekst: w.bledy.map((b) => b.tekst ?? b.kod).join('; ') });
    } else {
      const zadanie = w.zadanie;
      const ilosc = zadanie.stock?.available;
      if (migawka && !migawka.wlaczone && Number.isSafeInteger(ilosc) && ilosc !== odczyt.odczytIlosc)
        dodajKomende('ilosc', ilosc, o);
      const cel = groszeZKwoty(zadanie.sellingMode?.price?.amount, 'cena oferty Allegro');
      let doPotwierdzenia = null;
      if (cel !== null && cel !== odczyt.odczytCenaGr) {
        const prog = ustawieniaOfertKonta(db, konto.klucz).progPotwierdzeniaBp;
        if (cenaWymagaPotwierdzenia(odczyt.odczytCenaGr, cel, prog) && p.cenaPotwierdzonaGr !== cel) {
          doPotwierdzenia = cel;
          problemy.push(PROBLEM_CENY());
        } else dodajKomende('cena', cel, o);
      }
      zmien(o, { cenaDoPotwierdzeniaGr: doPotwierdzenia });
      o = ofertaPoId(db, o.id);
      // Przejście dawnego skrótu bez zapisu do kanału tylko przy niezmienionej treści.
      // Stara kolumna konta opisuje wysłany cennik, nowe reguły mogą już wybierać inny.
      // Bez `delivery` w zadaniu nie ma czego przenosić — inaczej co przebieg PATCH `{}` (zeruje liczbaProb komend).
      if (
        zadanie.delivery &&
        !pola(o).dostawa &&
        !czekaTresc &&
        skrotAllegro(o.kartaId, konto.klucz, zadanie, true) === o.wyslanySkrot
      ) {
        const dostawa = {
          ...zadanie.delivery,
          shippingRates: { id: ustawieniaOfertKonta(db, konto.klucz).cennikDostaw },
        };
        zmien(o, {
          wyslanePola: { ...pola(o), dostawa },
          wyslanySkrot: skrotAllegro(o.kartaId, konto.klucz, { ...zadanie, delivery: dostawa }),
        });
        o = ofertaPoId(db, o.id);
      }
      const skrot = skrotAllegro(o.kartaId, konto.klucz, zadanie);
      if (skrot !== o.wyslanySkrot && !czekaTresc) {
        const tylkoDostawa =
          Boolean(pola(o).dostawa) &&
          skrotAllegro(o.kartaId, konto.klucz, { ...zadanie, delivery: pola(o).dostawa }) === o.wyslanySkrot;
        if (!(await zmienTresc(konto, o, w, tylkoDostawa))) return;
        o = ofertaPoId(db, o.id);
        if (o.stan === 'sprawdzana') {
          if (problemy.length) zmien(o, { problemy });
          return;
        }
        // Nowa treść przyjęta od razu zdejmuje problem odrzuconej treści.
        if (problemOdczytu && !pola(o).probyOdczytu && problemy.includes(problemOdczytu))
          problemy.splice(problemy.indexOf(problemOdczytu), 1);
      }
    }
    zmien(o, {
      stan:
        odrzuconaTresc && problemy.includes(problemOdczytu)
          ? 'problem'
          : AKTYWNE.has(status)
            ? 'aktywna'
            : 'nieaktywna',
      problemy: problemy.length ? problemy : null,
    });
  }

  /** Ilość z OMS jest niezależna od poprawności treści i mapy kategorii. */
  async function synchronizujIlosc(
    konto,
    o,
    poprzednia,
    x,
    { cel: wynik, wyjasnienie, masowe },
    dodajKomende,
    tylkoIlosc = false,
  ) {
    const cel = wynik?.ilosc ?? null;
    const odczyt = Number.isSafeInteger(x.stock?.available) ? x.stock.available : null;
    const status = x.publication?.status;
    let p = pola(o);
    // Potwierdzenie zer zużyte — zapis 0 widać w odczycie (0 albo END), albo cel wzrósł ponad 0.
    // Potwierdzenie z innego przełączenia stanów jest nieważne — też zdjęte.
    if (
      p.zeraPotwierdzone &&
      (status === 'ENDED' || !potwierdzenieZerWazne(o, migawka) || potwierdzenieZerZuzyte({ cel, odczyt }))
    ) {
      p = bezPotwierdzeniaZer(p);
      zmien(o, { wyslanePola: p }, ['zeraPotwierdzone']);
    }
    // W wierszu z problemem treści/ceny nowy problem dochodzi obok tamtych, nie zamiast nich.
    const zglos = (pr) =>
      tylkoIlosc
        ? zmien(o, {
            stan: 'problem',
            problemy: [...(ofertaPoId(db, o.id).problemy ?? []).filter((y) => y?.kod !== pr.kod), pr],
          })
        : problem(o, pr);
    if (p.publikacjaWToku) {
      if (status === p.publikacjaWToku.status || (p.publikacjaWToku.status === 'ACTIVE' && status === 'ACTIVATING')) {
        // Potwierdzone ACTIVATE zdejmuje od razu znacznik END przez OMS i wznowienie — ręczny koniec
        // sprzedawcy przed następnym odczytem nie może obudzić drugiego wznowienia.
        const { publikacjaWToku: _p, ...reszta } = p;
        const { zakonczonaPrzezOms: _z, wznowienieIlosc: _w, ...poAktywacji } = reszta;
        const bez = p.publikacjaWToku.status === 'ACTIVE' ? poAktywacji : reszta;
        zmien(
          o,
          tylkoIlosc
            ? { wyslanePola: bez }
            : { wyslanePola: bez, stan: AKTYWNE.has(status) ? 'aktywna' : 'nieaktywna', problemy: null },
        );
        p = bez;
      } else {
        if (czas() - Date.parse(p.publikacjaWToku.at) >= BEZ_POTWIERDZENIA_MS)
          zglos(PROBLEMY_ALLEGRO['bez-potwierdzenia']());
        return false;
      }
    }
    // Ręczne „Wznów” przy celu 0 — decyzja z powodem i zdjęcie znacznika (inaczej „Wznów” wisiałby bez końca).
    if (status === 'ENDED' && p.wznow && !(cel > 0)) {
      zmien(
        o,
        {
          stan: 'problem',
          nastepnaProbaAt: null,
          wyslanePola: bezWznow(p),
          problemy: [PROBLEMY_ALLEGRO.zakonczona(odczyt ?? 0, 'Nie wznowiono: karta nie ma sztuk do wystawienia.')],
        },
        ['wznow'],
      );
      return false;
    }
    if (o.iloscProblem?.wstrzymuje && o.iloscProblem.kod !== 'rozjazd-gora') return false;
    // Alarm wstrzymujący (tu: rozjazd w górę) zdejmuje człowiek — problem niewstrzymujący go nie nadpisuje.
    const trwaly = (nowy) => (o.iloscProblem?.wstrzymuje && !nowy?.wstrzymuje ? o.iloscProblem : nowy);
    const ustaw = (kod) => zmien(o, { iloscProblem: trwaly({ ...PROBLEMY_ILOSCI[kod], od: iso(), cel, odczyt }) });
    if (cel == null) {
      if (wynik?.powod) ustaw(wynik.powod);
      return false;
    }
    if (!bramka(konto, o, 'ilosc').wolno) return false;
    // Własna przerwa komend ilości/publikacji — przerwa ceny i treści (nastepnaProbaAt) jej nie wstrzymuje.
    if (p.przerwaIlosci?.do && Date.parse(p.przerwaIlosci.do) > czas()) return false;
    if (!Number.isFinite(odczyt)) {
      ustaw('karencja');
      return false;
    }
    if (o.iloscProblem?.kod === 'rozjazd-gora' && cel > odczyt) return false;
    if (x.isFulfillment || x.stock?.isFulfillment) {
      ustaw('ilosc-niezmienialna');
      return false;
    }
    if (status === 'ENDED' && !p.zakonczonaPrzezOms && odczyt !== 0 && !p.wznowienieIlosc && !p.wznow) {
      zglos(PROBLEMY_ALLEGRO.zakonczona(odczyt));
      return false;
    }
    const ustawienia = ustawieniaOfertKonta(db, konto.klucz);
    const stan = migawka.stany.get(o.kartaId)?.stan;
    const skok = skokIlosci({
      stan,
      stanKartyWyslany: o.stanKartyWyslany,
      wyjasnioneKarty: wyjasnienie.wyjasnioneKarty,
      prog: ustawienia.progSkokuSzt,
      od: iso(),
      cel,
      odczyt,
    });
    if (skok) {
      zmien(o, { iloscProblem: skok });
      return false;
    }
    if (masowe && liczySieDoZeraMasowego(o, migawka) && status !== 'ENDED' && cel === 0 && odczyt > 0) {
      ustaw('zero-masowe');
      return false;
    }
    // Najwyżej 3 wznowienia po END na dobę — czwarte czeka na człowieka.
    if (
      status === 'ENDED' &&
      cel > 0 &&
      !p.wznow &&
      (czesteWznawianie(p) || o.problemy?.some((y) => y?.kod === 'zakonczona' && y.czeste))
    ) {
      if (!o.problemy?.some((y) => y?.czeste))
        zglos({ ...PROBLEMY_ALLEGRO.zakonczona(odczyt ?? 0, CZESTE_WZNAWIANIE), czeste: true });
      return false;
    }
    // ACTIVATE tylko przy odczycie równym celowi wznowienia — inaczej najpierw FIXED.
    if (
      status === 'ENDED' &&
      o.tryb === 'obserwowana' &&
      p.wznowienieIlosc?.gotowe &&
      p.wznowienieIlosc.cel === cel &&
      cel > 0 &&
      odczyt === cel
    ) {
      dodajKomende('publikacja', 'ACTIVATE', o);
      return false;
    }
    if (status !== 'ENDED' && potwierdzoneIlosci.has(o.id) && cel !== odczyt) return false;
    // Zakończona oferta nie sprzedaje — jej odczyt to resztka, nie rozjazd.
    const rozjazd =
      status === 'ENDED'
        ? { problem: null, baza: null, wolnoWyslac: true }
        : ocenRozjazdu({
            wyslanaIlosc: o.wyslanaIlosc,
            odczyt,
            cel,
            wyjasnienie,
            wToku: pola(poprzednia).komendaIlosci,
            odczytanoAt: iso(),
            alarmOd: o.iloscProblem?.od,
            poller: wyjasnienie.poller,
            policzonoAt: migawka.policzonoAt,
            pollerMs,
          });
    // Zgodny odczyt przesuwa bazę (T) — razem z nią stan karty, inaczej skok liczyłby sprzedaż sprzed T bez wyjaśnień.
    zmien(o, {
      iloscProblem: trwaly(rozjazd.problem),
      ...(rozjazd.baza ? { ...rozjazd.baza, iloscWyslanaAt: chwilaMigawki } : {}),
      ...(rozjazd.baza && o.stanKartyWyslany != null ? { stanKartyWyslany: stan } : {}),
    });
    if (!rozjazd.wolnoWyslac) return false;
    const podwyzka = wolnoPodniesc({
      cel,
      odczyt,
      poprzedniOdczyt: { ilosc: poprzednia.odczytIlosc, odczytanoAt: poprzednia.odczytanoAt },
      poller: wyjasnienie.poller,
      policzonoAt: migawka.policzonoAt,
      pollerMs,
    });
    if (!podwyzka.wolno) {
      ustaw(podwyzka.powod);
      return false;
    }
    if (cel === 0 && ZERO_ALLEGRO === 'zakoncz') {
      // END tylko ofercie, która sprzedaje (INACTIVE i ENDED zostają bez komendy).
      if (AKTYWNE.has(status)) dodajKomende('publikacja', 'END', o);
      return false;
    }
    if (status === 'ENDED') {
      if (o.tryb === 'zarzadzana') return true;
      // Przejęta nie korzysta z karty: najpierw FIXED, dopiero jego SUCCESS pozwala ACTIVATE.
      if (p.wznowienieIlosc?.gotowe && p.wznowienieIlosc.cel === cel && odczyt === cel) {
        dodajKomende('publikacja', 'ACTIVATE', o);
      } else {
        zmien(o, { wyslanePola: { ...p, wznowienieIlosc: { cel, gotowe: false } } });
        dodajKomende('ilosc', cel, o);
      }
      return false;
    }
    if (cel !== odczyt) dodajKomende('ilosc', cel, o);
    return true;
  }

  /**
   * Oferta zakończona przy 0 sztukach → jeden PATCH ilości + ACTIVE (dalej jak aktywacja: operacja, odczyt), bez
   * prognozy opłat. To samo po ręcznym „Wznów” (znacznik `wyslanePola.wznow`, także przy
   * `sztuk` > 0) — z tymi samymi hamulcami (bramka, limit zapisów, MAKS_PROB_KOMENDY); znacznik znika po decyzji
   * pętli, a przy przerwie, zamkniętej bramce i błędzie 5xx czeka na następny przebieg.
   * ⚠️ Odpowiedzi PATCH/operacji wznowienia NIE zmierzone — czytamy je jak aktywację.
   */
  async function wznowWyprzedana(konto, o, sztuk = 0) {
    const p = pola(o);
    const reczne = Boolean(p.wznow);
    // Przy włączonych stanach limit 3 wznowienia na dobę (synchronizujIlosc); 24 h zostaje dla wyłączonych.
    if (!reczne && migawka?.wlaczone && czesteWznawianie(p)) {
      zmien(o, {
        stan: 'problem',
        nastepnaProbaAt: null,
        problemy: [{ ...PROBLEMY_ALLEGRO.zakonczona(sztuk, CZESTE_WZNAWIANIE), czeste: true }],
      });
      return;
    }
    if (!reczne && !migawka?.wlaczone && p.wznowionaAt && czas() - Date.parse(p.wznowionaAt) < 24 * 3_600_000) {
      zmien(o, {
        stan: 'problem',
        nastepnaProbaAt: null,
        problemy: [
          {
            ...PROBLEMY_ALLEGRO.zakonczona(sztuk, 'Oferta była już wznawiana w ciągu 24 godzin — użyj Wznów.'),
            limitDobowy: true,
          },
        ],
      });
      return;
    }
    const zakonczona = (tekst) =>
      zmien(
        o,
        {
          stan: 'problem',
          problemy: [PROBLEMY_ALLEGRO.zakonczona(sztuk, tekst)],
          nastepnaProbaAt: null,
          wyslanePola: bezWznow(p),
        },
        ['wznow'],
      );
    /** Karta nie daje treści oferty: problem karty obok „zakończona”; po „Wznów” z powodem, żeby nie zniknął. */
    const bezTresci = (problemKarty) =>
      zmien(
        o,
        {
          stan: 'problem',
          nastepnaProbaAt: null,
          wyslanePola: bezWznow(p),
          problemy: [
            PROBLEMY_ALLEGRO.zakonczona(
              sztuk,
              reczne ? 'Nie wznowiono: popraw kartę, potem wciśnij Wznów.' : undefined,
            ),
            problemKarty,
          ],
        },
        ['wznow'],
      );
    // Czekanie (przerwa, bramka, limit zapisów) nie nadpisuje bieżącego „zakończona” — sztuki zapisane
    // po 5xx zostają, więc Wznów nie znika do końca przerwy.
    const czeka = () =>
      zmien(o, {
        stan: 'problem',
        problemy: [o.problemy.find((x) => x?.kod === 'zakonczona') ?? PROBLEMY_ALLEGRO.zakonczona(0)],
      });
    // Przerwa po błędzie sieci albo zamknięta bariera: zostaje problem „zakończona”, bez zapytań do Allegro.
    // Wyczerpany limit zapisów przebiegu — wznowienie w następnym przebiegu. Ręczne „Wznów” czeka bez zmian.
    if ((o.nastepnaProbaAt && Date.parse(o.nastepnaProbaAt) > czas()) || !bramka(konto, o).wolno || !wolnyZapis()) {
      if (!reczne) czeka();
      return;
    }
    const opisKonta = { klucz: konto.klucz, nazwa: konto.nazwa, srodowisko: konto.srodowisko };
    let w;
    if (p.produktId)
      w = ofertaAllegroKarty(db, o.kartaId, opisKonta, {
        teraz: iso(),
        katalog: { produktId: String(p.produktId) },
        migawka,
      });
    else if (p.droga === 'nowy')
      w = ofertaAllegroKarty(db, o.kartaId, opisKonta, { teraz: iso(), katalog: { brak: true }, migawka });
    else {
      const t = await trescKarty(konto, o);
      if (t.problem) {
        bezTresci(t.problem);
        return;
      }
      w = t.w;
    }
    if (w.bledy.length) {
      bezTresci({ kod: 'karta', tekst: w.bledy.map((b) => b.tekst ?? b.kod).join('; ') });
      return;
    }
    const n = w.zadanie.stock?.available;
    // Karta bez sztuk (albo bez stałej ilości) → nic do wznowienia; bez „Wznów” zwykły problem, pętla patrzy dalej.
    if (!Number.isSafeInteger(n) || n <= 0) {
      if (reczne) zakonczona('Nie wznowiono: karta nie ma sztuk do wystawienia.');
      else problem(o, PROBLEMY_ALLEGRO.zakonczona(0));
      return;
    }
    if (!bramka(konto, o).wolno || !zapis()) {
      if (!reczne) czeka();
      return;
    }
    zwolnijOperacje(konto.klucz, 'PATCH', zasobPatch(o.idZewnetrzne));
    let r;
    try {
      r = await konto.katalog.zmienOferte(o.idZewnetrzne, {
        stock: { available: n },
        publication: { status: 'ACTIVE' },
      });
    } catch (e) {
      if (odrzucone(e)) {
        zakonczona(`Allegro odrzuciło wznowienie: ${komunikat(e)}`);
        return;
      }
      const k = o.liczbaProb + 1;
      // Jak przy komendach: po MAKS_PROB_KOMENDY nieudanych próbach decyzja człowieka (tekst = bez ponowień).
      if (k >= MAKS_PROB_KOMENDY) {
        zmien(
          o,
          {
            stan: 'problem',
            liczbaProb: k,
            blad: komunikat(e),
            nastepnaProbaAt: null,
            wyslanePola: bezWznow(p),
            problemy: [
              PROBLEMY_ALLEGRO.zakonczona(
                sztuk,
                `Wznowienie nie powiodło się ${k} razy (${komunikat(e)}) — wznów ręcznie.`,
              ),
            ],
          },
          ['wznow'],
        );
        return;
      }
      zmien(o, {
        stan: 'problem',
        problemy: [PROBLEMY_ALLEGRO.zakonczona(sztuk)],
        liczbaProb: k,
        blad: komunikat(e),
        nastepnaProbaAt: iso(czas() + przerwaPonowienia(k)),
      });
      return;
    }
    if (!r.ok) {
      zakonczona(`Allegro odrzuciło wznowienie: ${r.powod}`);
      return;
    }
    const d = r.dane ?? {};
    zmien(
      o,
      {
        stan: 'sprawdzana',
        problemy: null,
        blad: null,
        liczbaProb: 0,
        wyslanaIlosc: n,
        ...(migawka?.wlaczone
          ? { iloscWyslanaAt: chwilaMigawki, stanKartyWyslany: migawka.stany.get(o.kartaId)?.stan ?? null }
          : {}),
        nastepnaProbaAt: iso(czas() + czekanieS(d.retryAfterS) * 1000),
        // Sztuki sprzed wznowienia — gdy Allegro je odrzuci, problem „zakonczona” pokazuje je dalej (nie 0).
        wyslanePola: {
          ...bezWznow(p),
          wznowionaAt: iso(),
          etap: 'wznowienie',
          sztukPrzedWznowieniem: sztuk,
          operacja: d.operacja ?? null,
          operacjaOd: iso(),
          ...(migawka?.wlaczone ? { wznowienia: reczne ? wznowieniaDoby(p) : [...wznowieniaDoby(p), iso()] } : {}),
        },
      },
      ['wznow'],
    );
  }

  /** PATCH treści z kompletem tablic (zdjęcia wgrane najpierw). false = błąd zapisany w wierszu. */
  async function zmienTresc(konto, o, w, tylkoDostawa = false) {
    let zadanie;
    // Limit zapisów sprawdzony przed wgrywaniem zdjęć — treść czeka na następny przebieg bez zmiany stanu.
    if (!wolnyZapis()) return false;
    try {
      const adresy = tylkoDostawa ? new Map() : await wgrajZdjecia(konto, o, w.doWgrania);
      if (!adresy) return false;
      zadanie = tylkoDostawa ? w.zadanie : podstawWgraneZdjecia(w.zadanie, adresy);
      if (!bramka(konto, o).wolno || !zapis()) return false;
      zwolnijOperacje(konto.klucz, 'PATCH', zasobPatch(o.idZewnetrzne));
      const r = await konto.katalog.zmienOferte(
        o.idZewnetrzne,
        tylkoDostawa ? { delivery: zadanie.delivery } : trescAllegro(zadanie, pola(o).gpsrZProduktu ?? null),
      );
      if (!r.ok) {
        zmien(o, { blad: r.powod });
        return false;
      }
      const d = r.dane ?? {};
      // Treść przyjęta od razu (bez operacji) kończy licznik odrzuceń treści.
      const { probyOdczytu: _n, odczytPo: _t, skrotOdrzuconej: _s, ...bezOdczytu } = pola(o);
      zmien(o, {
        wyslanySkrot: skrotAllegro(o.kartaId, konto.klucz, zadanie),
        wyslanoAt: iso(),
        blad: null,
        liczbaProb: d.operacja ? o.liczbaProb : 0,
        wyslanePola: { ...bezOdczytu, dostawa: zadanie.delivery },
        ...(d.operacja
          ? {
              stan: 'sprawdzana',
              nastepnaProbaAt: iso(czas() + czekanieS(d.retryAfterS) * 1000),
              // Nowa treść po limicie odrzuceń dostaje pełne MAKS_PROB_KOMENDY.
              wyslanePola: {
                ...pola(o),
                dostawa: zadanie.delivery,
                etap: 'tresc',
                operacja: d.operacja,
                operacjaOd: iso(),
                ...((pola(o).probyOdczytu ?? 0) >= MAKS_PROB_KOMENDY ? { probyOdczytu: 0 } : {}),
              },
            }
          : {}),
      });
      return true;
    } catch (e) {
      // 401/403 idą zwykłą ścieżką błędu połączenia (przerwa, `liczbaProb`), nie do limitu treści.
      if (odrzucone(e) && !bezDostepu(e)) {
        // E4.25 (N2): odrzucona treść ma własny licznik i przerwę tylko dla treści (`odczytPo`), jak odrzucenie
        // w operacji — ilość i cena idą dalej. Po MAKS_PROB_KOMENDY problem; skrót zostaje, więc ta sama treść
        // nie idzie ponownie, dopóki karta się nie zmieni albo ktoś nie kliknie Ponów (wtedy licznik od nowa).
        // Inna treść niż ostatnio odrzucona → licznik od nowa, stary problem „odczyt” znika.
        const p0 = pola(o);
        const skrotOdrzuconej = skrotAllegro(o.kartaId, konto.klucz, w.zadanie);
        const innaTresc = p0.skrotOdrzuconej != null && p0.skrotOdrzuconej !== skrotOdrzuconej;
        const prob = innaTresc ? 0 : (p0.probyOdczytu ?? 0);
        const n = (prob >= MAKS_PROB_KOMENDY ? 0 : prob) + 1;
        const dosc = n >= MAKS_PROB_KOMENDY;
        const { odczytPo: _t, ...bezPrzerwy } = pola(o);
        if (dosc) {
          zmien(o, {
            stan: 'problem',
            blad: null,
            wyslanySkrot: skrotAllegro(o.kartaId, konto.klucz, w.zadanie),
            problemy: [
              {
                kod: 'odczyt',
                tekst: `Allegro ${n} razy odrzuciło zmianę treści (HTTP ${kodHttp(e)}): ${komunikat(e)}. Popraw kartę produktu.`,
              },
            ],
            wyslanePola: { ...bezPrzerwy, probyOdczytu: n, skrotOdrzuconej },
          });
        } else {
          const bezStaregoProblemu =
            n === 1 && o.problemy.some((x) => x?.kod === 'odczyt')
              ? { problemy: o.problemy.filter((x) => x?.kod !== 'odczyt') }
              : {};
          zmien(o, {
            blad: komunikat(e),
            wyslanePola: {
              ...bezPrzerwy,
              probyOdczytu: n,
              skrotOdrzuconej,
              odczytPo: iso(czas() + przerwaPonowienia(n)),
            },
            ...bezStaregoProblemu,
          });
        }
      } else {
        const n = o.liczbaProb + 1;
        pozniej(o, przerwaPonowienia(n), { liczbaProb: n, blad: komunikat(e) });
      }
      return false;
    }
  }

  async function konto1(konto) {
    const ustawienia = ustawieniaOfertKonta(db, konto.klucz);
    // Ten sam warunek karta produktu pokazuje jako powód, na który czeka oferta.
    if (powodCzekaniaOferty(konto, ustawienia)) return;
    zapisy = 0;
    potwierdzoneIlosci.clear();
    const doAktywacji = db
      .prepare(
        `SELECT id FROM oferty_kanalow WHERE kanal = ? AND tryb = 'zarzadzana'
      AND stan IN ('aktywna', 'nieaktywna', 'problem') ORDER BY id`,
      )
      .all(konto.klucz)
      .map((w) => ofertaPoId(db, Number(w.id)))
      .filter((o) => o && pola(o).aktywuj === true && !(o.nastepnaProbaAt && Date.parse(o.nastepnaProbaAt) > czas()));
    for (const o of doAktywacji) {
      try {
        await aktywuj(konto, o);
      } catch (e) {
        log(`Allegro ${konto.klucz}: aktywacja oferty ${o.id}: ${komunikat(e)}`);
      }
    }
    const ids = db
      .prepare(
        `SELECT id FROM oferty_kanalow WHERE kanal = ? AND tryb = 'zarzadzana'
      AND stan IN ('do_wyslania', 'wyslana', 'sprawdzana') ORDER BY id`,
      )
      .all(konto.klucz)
      .map((w) => Number(w.id));
    let wyslane = 0;
    for (const id of ids) {
      // Jeden wiersz może przejść kilka kroków w tym samym przebiegu (POST → odczyt → PATCH).
      for (let krok = 0; krok < 4; krok++) {
        const o = ofertaPoId(db, id);
        if (!o || !ETAPY.includes(o.stan)) break;
        if (o.nastepnaProbaAt && Date.parse(o.nastepnaProbaAt) > czas()) break;
        try {
          if (o.stan === 'do_wyslania') {
            if (przywrocSynchronizacje(o)) break;
            if (wyslane >= LIMIT_WYSYLEK) break;
            if (await wyslij(konto, o)) wyslane++;
            else break;
          } else if (o.stan === 'wyslana') await odzyskaj(konto, o);
          else await sprawdz(konto, o, ustawienia);
        } catch (e) {
          log(`Allegro ${konto.klucz}: oferta ${id}: ${komunikat(e)}`);
          break;
        }
        const po = ofertaPoId(db, id);
        if (po.stan === o.stan && po.nastepnaProbaAt === o.nastepnaProbaAt) break;
      }
    }
    await synchronizuj(konto);
  }

  async function przebieg() {
    if (wToku) return { pominiety: true };
    if (zegar) {
      clearTimeout(zegar);
      zegar = null;
    }
    wToku = true;
    ostatniStart = czas();
    przyspieszony = false;
    try {
      try {
        chwilaMigawki = iso();
        migawka = migawkaStanow(db);
      } catch (e) {
        migawka = null;
        log(`oferty-allegro: pominięto ilość — błąd migawki (${komunikat(e)})`);
      }
      const listaKont = [...konta()];
      if (migawka?.wlaczone) listaKont.sort((a, b) => a.klucz.localeCompare(b.klucz));
      for (const konto of listaKont) await konto1(konto);
      return { pominiety: false };
    } finally {
      wToku = false;
      if (przyspieszony) przyspiesz();
    }
  }

  function przyspiesz() {
    if (wToku) {
      przyspieszony = true;
      return;
    }
    if (zegar) return;
    zegar = setTimeout(
      () => {
        zegar = null;
        void przebieg().catch((e) => log(`oferty-allegro: ${komunikat(e)}`));
      },
      Math.max(0, 60_000 - (czas() - ostatniStart)),
    );
    zegar.unref?.();
  }

  return { przebieg, przyspiesz };
}
