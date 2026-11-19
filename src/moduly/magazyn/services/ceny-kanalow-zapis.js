import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { kwotaDziesietna } from '../../../domena/cena-kanalu.js';
import { MODUL_ALLEGRO } from '../../../domena/modul-allegro.ts';
import { MODUL_ERLI } from '../../../domena/modul-erli.ts';
import { MODUL_WOO } from '../../../domena/modul-woo.ts';
import { katalogErli } from '../../../integracje/kanal-modul.ts';
import { chronCeneKarty, zapiszZmianeWKanale } from '../../../oms/db/ceny-kanalow.js';
import { ofertaPoIdZewnetrznym, ustawieniaOfertKonta, zmienOferte } from '../../../oms/db/oferty-kanalow.ts';
import { podgladCen } from './ceny-kanalow-podglad.js';
import { bramkaZapisu } from './oferty-wspolne.js';
import { LIMIT_BATCH_ERLI } from './petla-ofert.js';

const CZAS_PODGLADU = 30 * 60_000;
const MAKS_PODGLADOW = 50;
const MAKS_OFERT_KOMENDY = 1000;
const ODPYTANIA_ALLEGRO = 15;
const PRZERWA_ALLEGRO_MS = 1000;

export const KOMUNIKAT_ZMIANY = 'Ceny na karcie albo narzut zmieniły się — otwórz podgląd ponownie';
const ZMIANA_W_KANALE = 'cena w kanale zmieniła się od podglądu';
const ZNIKNELA = 'cena w kanale jest już równa docelowej albo oferta zniknęła — otwórz podgląd ponownie';
const ALLEGRO_W_TOKU = 'Allegro jeszcze przetwarza — sprawdź za chwilę';
const NIEPOWIAZANA = 'oferta nie jest powiązana z tą kartą — pominięta';

/** Odmowa całego zatwierdzenia, zanim cokolwiek wyjdzie do kanału; `kod` rozróżnia powód dla trasy. */
export class OdmowaZapisuCen extends Error {
  constructor(kod, message) {
    super(message);
    this.name = 'OdmowaZapisuCen';
    this.kod = kod;
  }
}

const sha256 = (tekst) => createHash('sha256').update(tekst).digest('hex');
const kluczWiersza = (w) => `${w.kanal}|${w.cel}`;
const wartosc = (v) => (typeof v === 'function' ? v() : v);
const naChwile = (t) => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t));

// Skrót obejmuje to, co decyduje o zapisie: cel, kartę, cenę w kanale i cenę docelową.
const skrotWierszy = (wiersze) =>
  sha256(JSON.stringify(wiersze.map((w) => [w.klucz, w.kartaId, w.staraGr, w.nowaGr, w.zrodlo])));

// Ten sam podgląd, kanał, cena i zbiór ofert dają ten sam commandId, więc powtórka zatwierdzenia nie
// tworzy w Allegro drugiej komendy — Allegro rozpoznaje ją po kluczu idempotencji. Oferty są w skrócie,
// bo inny wybór z tego samego podglądu pod starym kluczem Allegro odrzuca (409 o innej treści).
function commandIdAllegro(podgladId, kanal, cenaGr, oferty) {
  const h = sha256(JSON.stringify([podgladId, kanal, cenaGr, oferty]));
  const wariant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${wariant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function celWoo(cel) {
  const produkt = /^produkt:(\d+)$/.exec(cel);
  if (produkt) return { rodzic: null, id: produkt[1] };
  const wariant = /^wariant:(\d+)\/(\d+)$/.exec(cel);
  if (wariant) return { rodzic: wariant[1], id: wariant[2] };
  return null;
}

const idOferty = (cel) => /^oferta:(.+)$/.exec(cel)?.[1] ?? null;

// Pozycja lustra, którą opisuje cel wiersza: oferta Allegro i produkt Woo nie mają wariantu.
function pozycjaLustra(cel) {
  const woo = celWoo(cel);
  if (woo) return woo.rodzic === null ? [woo.id, ''] : [woo.rodzic, woo.id];
  const oferta = idOferty(cel);
  return oferta === null ? null : [oferta, ''];
}

function paczki(lista, rozmiar) {
  const wynik = [];
  for (let i = 0; i < lista.length; i += rozmiar) wynik.push(lista.slice(i, i + rozmiar));
  return wynik;
}

async function zapiszWoo(klient, wiersze, oznacz) {
  const grupy = Map.groupBy(wiersze, (w) => celWoo(w.cel)?.rodzic ?? null);
  for (const [rodzic, grupa] of grupy) {
    const poId = new Map(grupa.map((w) => [celWoo(w.cel).id, w]));
    let wynik;
    try {
      if (!klient?.zapiszCenyHurtem) throw new Error('brak klienta sklepu');
      // Tylko cena regularna: promocję prowadzi sklep, OMS jej nie dotyka.
      wynik = await klient.zapiszCenyHurtem(
        rodzic,
        grupa.map((w) => ({ id: celWoo(w.cel).id, regular_price: kwotaDziesietna(w.nowaGr) })),
      );
    } catch (e) {
      for (const w of grupa) oznacz(w, 'blad', e.message);
      continue;
    }
    for (const r of wynik) {
      const w = poId.get(String(r.id));
      if (!w) continue;
      poId.delete(String(r.id));
      oznacz(w, r.ok ? 'ok' : 'blad', r.ok ? null : r.blad || 'sklep odrzucił cenę');
    }
    for (const w of poId.values()) oznacz(w, 'blad', 'Brak wyniku zapisu ceny Woo');
  }
}

async function zapiszAllegro(klient, kanal, wiersze, podgladId, czekaj, oznacz) {
  const czekajace = [];
  const poCenie = Map.groupBy(wiersze, (w) => w.nowaGr);
  for (const [cenaGr, grupa] of poCenie) {
    const poOfercie = grupa.toSorted((a, b) => idOferty(a.cel).localeCompare(idOferty(b.cel)));
    for (const paczka of paczki(poOfercie, MAKS_OFERT_KOMENDY)) {
      const oferty = paczka.map((w) => idOferty(w.cel));
      const commandId = commandIdAllegro(podgladId, kanal, cenaGr, oferty);
      try {
        if (!klient?.komendaCeny) throw new Error('brak klienta Allegro');
        await klient.komendaCeny(
          commandId,
          paczka.map((w) => ({ ofertaId: idOferty(w.cel), cena: kwotaDziesietna(cenaGr) })),
        );
      } catch (e) {
        for (const w of paczka) oznacz(w, 'blad', e.message);
        continue;
      }
      czekajace.push({ commandId, oferty: new Map(paczka.map((w) => [idOferty(w.cel), w])) });
    }
  }
  // Allegro przetwarza komendę asynchronicznie; po 15 s zostawiamy ją w toku zamiast blokować ekran.
  for (let i = 0; i < ODPYTANIA_ALLEGRO && czekajace.some((k) => k.oferty.size); i += 1) {
    await czekaj(PRZERWA_ALLEGRO_MS);
    for (const k of czekajace) {
      if (!k.oferty.size) continue;
      let zadania;
      try {
        zadania = await klient.wynikKomendy('cena', k.commandId);
      } catch {
        continue;
      }
      for (const t of zadania) {
        const id = String(t?.offer?.id);
        const w = k.oferty.get(id);
        if (!w || (t.status !== 'SUCCESS' && t.status !== 'FAIL')) continue;
        k.oferty.delete(id);
        oznacz(
          w,
          t.status === 'SUCCESS' ? 'ok' : 'blad',
          t.status === 'SUCCESS' ? null : t.message || 'Allegro odrzuciło cenę',
        );
      }
    }
  }
  for (const k of czekajace) for (const w of k.oferty.values()) oznacz(w, 'w_toku', null);
}

// ERLI dostaje cenę tą samą drogą co pętla ofert zarządzanych (batch-update) i przez tę samą bramkę zapisu:
// hamulec konta, klucz tylko do odczytu i tryb zarządzany sprawdzane są tuż przed wysłaniem.
async function zapiszErli(db, klient, kanal, wiersze, oznacz) {
  const konto = {
    klucz: kanal,
    tylkoOdczyt: () =>
      typeof klient?.tylkoOdczyt === 'function' ? klient.tylkoOdczyt() : klient?.tylkoOdczyt === true,
  };
  const ustawienia = ustawieniaOfertKonta(db, kanal);
  const doWyslania = [];
  for (const w of wiersze) {
    const oferta = ofertaPoIdZewnetrznym(db, kanal, idOferty(w.cel));
    const decyzja = bramkaZapisu({ konto, ustawienia, oferta, klucze: [kanal] });
    if (decyzja.wolno) doWyslania.push({ w, oferta });
    else oznacz(w, 'blad', decyzja.powod);
  }
  for (const paczka of paczki(doWyslania, LIMIT_BATCH_ERLI)) {
    let dane;
    try {
      if (!klient?.zmienProdukty) throw new Error('brak klienta ERLI');
      const r = await katalogErli(klient).zmienIloscCene(
        paczka.map(({ w }) => ({ externalId: idOferty(w.cel), price: w.nowaGr })),
      );
      if (!r.ok) throw new Error(r.powod ?? 'ERLI odmówiło zapisu');
      dane = r.dane;
    } catch (e) {
      for (const { w } of paczka) oznacz(w, 'blad', e.message);
      continue;
    }
    const poId = new Map((Array.isArray(dane) ? dane : []).map((p) => [p?.externalId, p]));
    for (const { w, oferta } of paczka) {
      const pozycja = poId.get(idOferty(w.cel));
      if (!pozycja) oznacz(w, 'blad', 'ERLI nie zwróciło wyniku tej pozycji');
      else if (pozycja.blad) oznacz(w, 'blad', pozycja.blad.message || 'ERLI odrzuciło cenę');
      else {
        oznacz(w, 'ok');
        // Pętla ofert porównuje cel z ceną ostatnio wysłaną — bez tego wysłałaby ją jeszcze raz.
        zmienOferte(db, oferta.id, { wyslanaCenaGr: w.nowaGr });
      }
    }
  }
}

/**
 * Podgląd i zatwierdzenie zmiany cen w kanałach. Podgląd zostaje w pamięci pod losowym id i wraca do
 * przeglądarki tylko jako podpis; zatwierdzenie przelicza ceny z bazy tą samą funkcją co podgląd i wysyła
 * wyłącznie wtedy, gdy wynik jest taki, jaki widział człowiek.
 */
export function createZapisCenKanalow({
  db,
  definicje,
  klienci,
  teraz = () => new Date(),
  sekret = randomBytes(32),
  czekaj = (ms) => new Promise((r) => setTimeout(r, ms)),
  maksPodgladow = MAKS_PODGLADOW,
  blokujPromocjeWoo = false,
}) {
  const podglady = new Map();
  const wTrakcie = new Set();
  const mac = (login, id, skrot, czas) =>
    createHmac('sha256', sekret)
      .update(JSON.stringify([login, id, skrot, czas]))
      .digest('hex');
  const chwila = () => naChwile(teraz());

  function zrobMiejsce(now) {
    for (const [id, p] of podglady) if (now - p.czas > CZAS_PODGLADU) podglady.delete(id);
    while (podglady.size >= maksPodgladow) podglady.delete(podglady.keys().next().value);
  }

  async function podglad(login, kartaIds) {
    const wynik = await podgladCen(db, kartaIds, {
      definicje: wartosc(definicje),
      klienci: wartosc(klienci),
      teraz,
      blokujPromocjeWoo,
    });
    const wiersze = wynik.wiersze.map((w) => ({ ...w, klucz: kluczWiersza(w) }));
    const czas = chwila();
    const id = randomBytes(16).toString('hex');
    const skrot = skrotWierszy(wiersze);
    zrobMiejsce(czas);
    podglady.set(id, { login, wiersze, skrot, czas });
    return { podpis: `${id}.${czas}.${mac(login, id, skrot, czas)}`, ...wynik, wiersze };
  }

  function sprawdzPodpis(login, podpis) {
    const [id, czasTekst, podany, ...reszta] = String(podpis ?? '').split('.');
    const zly = new OdmowaZapisuCen('podpis', 'Niepoprawny podpis podglądu — otwórz go ponownie');
    const p = podglady.get(id);
    if (reszta.length || !p || !/^\d+$/.test(czasTekst ?? '') || !/^[0-9a-f]{64}$/.test(podany ?? '')) throw zly;
    const czas = Number(czasTekst);
    const oczekiwany = mac(login, id, p.skrot, czas);
    if (p.login !== login || p.czas !== czas || !timingSafeEqual(Buffer.from(podany), Buffer.from(oczekiwany)))
      throw zly;
    const now = chwila();
    if (!(now >= czas && now - czas <= CZAS_PODGLADU))
      throw new OdmowaZapisuCen('wygasl', 'Podgląd wygasł — otwórz go ponownie');
    return { id, p };
  }

  async function zatwierdz(login, podpis, wybraneKlucze) {
    const { id, p } = sprawdzPodpis(login, podpis);
    const wybor = new Set(Array.isArray(wybraneKlucze) ? wybraneKlucze.map(String) : []);
    const wPodgladzie = new Map(p.wiersze.map((w) => [w.klucz, w]));
    const wybrane = [...wybor].map((k) => wPodgladzie.get(k));
    if (!wybrane.length || wybrane.some((w) => !w?.doWyboru))
      throw new OdmowaZapisuCen('wybor', 'Zaznacz wiersze z tego podglądu');
    if (wTrakcie.has(id)) throw new OdmowaZapisuCen('trwa', 'Ten podgląd jest już zatwierdzany — poczekaj na wynik');
    wTrakcie.add(id);
    try {
      return await wyslij(login, id, wybrane);
    } finally {
      wTrakcie.delete(id);
    }
  }

  async function wyslij(login, podgladId, wybrane) {
    const kanaly = new Set(wybrane.map((w) => w.kanal));
    const wszystkieKlienci = wartosc(klienci);
    // Drugi odczyt z bazy i z kanałów tą samą funkcją co podgląd: zmiana karty albo narzutu odrzuca
    // całość, zmiana ceny w samym kanale pomija tylko ten wiersz.
    const swiezy = await podgladCen(db, [...new Set(wybrane.map((w) => w.kartaId))], {
      definicje: wartosc(definicje).filter((d) => kanaly.has(d.klucz)),
      klienci: wszystkieKlienci,
      teraz,
      blokujPromocjeWoo,
    });
    const teraz_ = new Map(swiezy.wiersze.map((w) => [kluczWiersza(w), w]));
    const typy = new Map(wartosc(definicje).map((d) => [d.klucz, d.typ]));
    // Odpięcie oferty od karty zostawia w rejestrze kartę i flagę ceny z OMS-u, więc o tym, czy cena
    // karty może trafić do oferty, rozstrzyga dopiero bieżące powiązanie w lustrze. ERLI lustra nie ma —
    // powiązanie z kartą trzyma sam rejestr ofert.
    const powiazanie = db.prepare(
      `SELECT 1 FROM produkty_sklepowe
       WHERE kanal = ? AND produkt_id = ? AND wariant_id = ? AND karta_id = ? AND zniknal_at IS NULL`,
    );
    const powiazanieErli = db.prepare(
      'SELECT 1 FROM oferty_kanalow WHERE kanal = ? AND id_zewnetrzne = ? AND karta_id = ?',
    );
    const powiazana = (w) => {
      if (typy.get(w.kanal) === MODUL_ERLI.typ) {
        const oferta = idOferty(w.cel);
        return oferta !== null && Boolean(powiazanieErli.get(w.kanal, oferta, w.kartaId));
      }
      const pozycja = pozycjaLustra(w.cel);
      return Boolean(pozycja && powiazanie.get(w.kanal, ...pozycja, w.kartaId));
    };
    const niepowiazane = new Set(
      wybrane
        .filter((w) => {
          const s = teraz_.get(w.klucz);
          return !powiazana(w) || (s && s.kartaId !== w.kartaId);
        })
        .map((w) => w.klucz),
    );
    for (const w of wybrane) {
      const s = teraz_.get(w.klucz);
      if (s && !niepowiazane.has(w.klucz) && s.nowaGr !== w.nowaGr)
        throw new OdmowaZapisuCen('zmiana', KOMUNIKAT_ZMIANY);
    }

    const at = new Date(chwila()).toISOString();
    const opis = (w) => ({
      klucz: w.klucz,
      kanal: w.kanal,
      kartaId: w.kartaId,
      cel: w.cel,
      nazwa: w.nazwa,
      staraGr: w.staraGr,
      nowaGr: w.nowaGr,
    });
    const wynik = { zapisane: [], bledy: [], pominiete: [] };
    const doWyslania = [];
    for (const w of wybrane) {
      const s = teraz_.get(w.klucz);
      if (niepowiazane.has(w.klucz)) wynik.pominiete.push({ ...opis(w), powod: NIEPOWIAZANA });
      else if (!s) wynik.pominiete.push({ ...opis(w), powod: ZNIKNELA });
      else if (!s.doWyboru) wynik.pominiete.push({ ...opis(w), powod: s.uwagi.at(-1) ?? ZMIANA_W_KANALE });
      else if (s.staraGr !== w.staraGr) wynik.pominiete.push({ ...opis(w), powod: ZMIANA_W_KANALE });
      else doWyslania.push(w);
    }

    // Każdy wiersz zapisuje się osobno: błąd jednego kanału ani jednej oferty nie cofa reszty.
    const oznacz = (w, stan, blad) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        zapiszZmianeWKanale(db, {
          kanal: w.kanal,
          kartaId: w.kartaId,
          cel: w.cel,
          pole: 'cena',
          stara: w.staraGr,
          nowa: w.nowaGr,
          kto: login,
          at,
          wynik: stan,
          blad,
        });
        // Cena wysłana z narzutem wróci przy imporcie z kanału — karta musi ją wtedy zignorować.
        if (stan !== 'blad') chronCeneKarty(db, w.kartaId, at);
        db.exec('COMMIT');
      } catch (e) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw e;
      }
      if (stan === 'blad') wynik.bledy.push({ ...opis(w), wynik: stan, blad });
      else if (stan === 'w_toku') wynik.zapisane.push({ ...opis(w), wynik: stan, uwaga: ALLEGRO_W_TOKU });
      else wynik.zapisane.push({ ...opis(w), wynik: stan });
    };

    for (const [kanal, wiersze] of Map.groupBy(doWyslania, (w) => w.kanal)) {
      const klient = wszystkieKlienci?.[kanal];
      const typ = typy.get(kanal);
      if (typ === MODUL_WOO.typ) await zapiszWoo(klient, wiersze, oznacz);
      else if (typ === MODUL_ALLEGRO.typ) await zapiszAllegro(klient, kanal, wiersze, podgladId, czekaj, oznacz);
      else if (typ === MODUL_ERLI.typ) await zapiszErli(db, klient, kanal, wiersze, oznacz);
      else for (const w of wiersze) oznacz(w, 'blad', 'kanał nie obsługuje cen z OMS-u');
    }
    const kolejnosc = new Map(wybrane.map((w, i) => [w.klucz, i]));
    for (const lista of Object.values(wynik)) lista.sort((a, b) => kolejnosc.get(a.klucz) - kolejnosc.get(b.klucz));
    return wynik;
  }

  return { podglad, zatwierdz };
}
