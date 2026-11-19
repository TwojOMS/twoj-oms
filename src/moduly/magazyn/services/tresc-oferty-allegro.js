// Wejście funkcji `ofertaAllegroZKarty` z bazy jednym odczytem — dla podglądu, karty i pętli,
// jak `tresc-oferty.js` dla ERLI. Bez sieci: opis kategorii tylko z pamięci podręcznej (`kanaly_kategorie`, wersja 2).
// Liczba zapytań na kartę jest stała (nie zależy od liczby zdjęć, parametrów ani ofert).
import { ofertaAllegroZKarty } from '../../../domena/allegro-oferta-z-karty.js';
import { WERSJA_OPISU_KATEGORII } from '../../../domena/tresc-oferty-allegro.js';
import { ustawieniaOfertKonta } from '../../../oms/db/oferty-kanalow.ts';
import { wyjatekCennika } from '../../../oms/db/cenniki-kart.ts';
import { cenyReczneKarty } from '../../../oms/db/ceny-kanalow.js';
import { znakInstalacji } from './petla-ofert.js';
import { iloscOferty } from './tresc-oferty.js';

const EPOKA = new Date(0).toISOString();
const SQLITE_BEZ_STREFY = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/** Kody błędów zależne od konta — bez konta nie są brakami karty. */
const BLEDY_KONTA = new Set(['ustawienia', 'narzut', 'ilosc', 'czas-wysylki', 'producent', 'znak-instalacji']);

/** Ustawienia zastępcze „bez konta”: komplet, żeby `ofertaAllegroZKarty` sprawdziła całą kartę (zadania i tak nie oddajemy). */
const USTAWIENIA_BEZ_KONTA = Object.freeze({
  narzutBp: 0,
  stalaIlosc: 0,
  czasWysylkiDni: 0,
  cennikDostaw: '-',
  stawkaVat: '23',
  zwrotyId: '-',
  reklamacjeId: '-',
  producentId: '-',
  bezpieczenstwoDomyslne: '-',
});

const napis = (w) => (typeof w === 'string' ? w.trim() : w == null ? '' : String(w).trim());

function json(w, domyslna = null) {
  if (w == null || w === '') return domyslna;
  try {
    return JSON.parse(w);
  } catch {
    return domyslna;
  }
}

/**
 * Jeden format czasu dla `ofertaAllegroZKarty`, która porównuje `wygasa_at > teraz` jako napisy: ISO UTC z „Z”
 * (`2026-11-14T12:00:00.000Z`). Zapis SQLite bez strefy (`2026-11-14 12:45:00`) to UTC; strefa (`+01:00`) przeliczona;
 * nieczytelny napis = wygasły (epoka), żeby zdjęcie poszło do ponownego wgrania, a nie z martwym adresem.
 */
export function czasIsoUtc(w) {
  if (w == null || w === '') return null;
  if (w instanceof Date) return Number.isFinite(w.getTime()) ? w.toISOString() : EPOKA;
  const s = napis(w);
  const bezStrefy = SQLITE_BEZ_STREFY.exec(s);
  const ms = Date.parse(bezStrefy ? `${bezStrefy[1]}T${bezStrefy[2]}Z` : s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : EPOKA;
}

/** Konta Allegro środowiska (pamięć opisów kategorii i oferty karty są na konto, mapa i reguły na środowisko). */
function kontaSrodowiska(db, srodowisko, konto) {
  let klucze = [];
  try {
    klucze = db
      .prepare("SELECT klucz FROM kanaly_sprzedazy WHERE typ = 'allegro' AND srodowisko = ? ORDER BY klucz")
      .all(srodowisko)
      .map((w) => String(w.klucz));
  } catch {
    klucze = [];
  } // baza bez modułu kanałów
  return konto ? [konto.klucz, ...klucze.filter((k) => k !== konto.klucz)] : klucze;
}

/** Opis kategorii wersji 2 z pamięci: najpierw konto oferty, potem inne konta środowiska (najświeższy). */
function opisZPamieci(wiersze, konta) {
  const kolejnosc = new Map(konta.map((k, i) => [k, i]));
  const opisy = [];
  for (const w of wiersze) {
    if (konta.length && !kolejnosc.has(w.polaczenie)) continue;
    const zapis = json(w.parametry_json, null);
    if (!zapis || Array.isArray(zapis) || zapis.wersja !== WERSJA_OPISU_KATEGORII) continue;
    opisy.push({
      w,
      opis: {
        wersja: zapis.wersja,
        lisc: zapis.lisc ?? null,
        tworzenieProduktu: zapis.tworzenieProduktu ?? null,
        sciezka: json(w.sciezka_json, []),
        parametry: Array.isArray(zapis.parametry) ? zapis.parametry : [],
      },
    });
  }
  opisy.sort(
    (a, b) =>
      (kolejnosc.get(a.w.polaczenie) === 0 ? 0 : 1) - (kolejnosc.get(b.w.polaczenie) === 0 ? 0 : 1) ||
      String(b.w.pobrano_at).localeCompare(String(a.w.pobrano_at)),
  );
  return opisy[0]?.opis ?? null;
}

/**
 * Oferta Allegro karty na koncie: odczyt z bazy i wynik `ofertaAllegroZKarty`.
 * @param {any} db
 * @param {number} kartaId
 * @param {{klucz: string, nazwa?: string, srodowisko?: 'produkcja'|'sandbox'} | null} konto `null` = wynik „bez konta”:
 *   tylko braki karty, bez zadania i bez zdjęć do wgrania.
 * @param {{srodowisko?: 'produkcja'|'sandbox', kontaSrodowiska?: string[], teraz?: Date|string, katalog?: object|null,
 *   migawka?: object, tworzenie?: boolean}} [opcje] `tworzenie` — podgląd/zatwierdzenie nowej oferty (odmowa wyjątku cennika spoza listy)
 */
export function ofertaAllegroKarty(db, kartaId, konto, opcje = {}) {
  const wiersz = db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(kartaId);
  if (!wiersz) {
    return {
      karta: null,
      bledy: [{ kod: 'karta', tekst: 'Karta produktu nie istnieje.' }],
      ostrzezenia: [],
      zadanie: null,
      droga: null,
      doWgrania: [],
      bezKonta: !konto,
    };
  }
  let opis = null;
  try {
    opis = wiersz.opis_sekcje_json ? JSON.parse(wiersz.opis_sekcje_json) : null;
  } catch {
    opis = { sekcje: 'niepoprawny JSON' };
  }
  const karta = { ...wiersz, opis };
  const srodowisko = konto?.srodowisko ?? opcje.srodowisko ?? 'produkcja';
  const konta = Array.isArray(opcje.kontaSrodowiska)
    ? [...new Set([...(konto ? [konto.klucz] : []), ...opcje.kontaSrodowiska.map(String)])]
    : kontaSrodowiska(db, srodowisko, konto);
  const teraz = czasIsoUtc(opcje.teraz ?? new Date());

  const zdjecia = db
    .prepare(
      `SELECT id, kolejnosc, adres_zrodlowy, sha256, typ, ai, ai_reczne FROM zdjecia_kart
    WHERE karta_id = ? ORDER BY kolejnosc, id`,
    )
    .all(kartaId);
  // Mapa wgranych zdjęć tylko tego konta — adres z innego konta Allegro nie zadziała.
  const wgraneZdjecia = db
    .prepare(
      `SELECT a.zdjecie_id, a.adres, a.ai, a.wygasa_at FROM zdjecia_kart_allegro a
    JOIN zdjecia_kart z ON z.id = a.zdjecie_id WHERE z.karta_id = ? AND a.konto = ?`,
    )
    .all(kartaId, konto?.klucz ?? '')
    .map((w) => ({ ...w, wygasa_at: czasIsoUtc(w.wygasa_at) }));

  const imp = db
    .prepare(
      `SELECT polaczenie, kategoria_id, produkt_id, parametry_json FROM karty_dane_kanalu
    WHERE karta_id = ? AND typ_kanalu = 'allegro'`,
    )
    .get(kartaId);
  const daneImportu =
    imp && (!konta.length || konta.includes(imp.polaczenie))
      ? { kategoria_id: imp.kategoria_id, produkt_id: imp.produkt_id, parametry: json(imp.parametry_json, null) }
      : null;
  const ka = db
    .prepare('SELECT nazwa, kategoria_id, parametry_json, produkt_id FROM karty_allegro WHERE karta_id = ?')
    .get(kartaId);
  const kartaAllegro = ka ? { ...ka, parametry: json(ka.parametry_json, []) } : null;

  // Kategoria karty (kategoria główna) i jej mapa w środowisku konta.
  const glowna = napis(karta.kategoria_glowna);
  const kategorieKarty = glowna ? [glowna] : [];
  const mapaKategorii = db
    .prepare(
      `SELECT kategoria_karty, kategoria_allegro_id FROM allegro_mapa_kategorii
    WHERE srodowisko = ? AND kategoria_karty = ?`,
    )
    .all(srodowisko, glowna)
    .map((w) => ({ kategoriaKarty: w.kategoria_karty, kategoriaAllegroId: napis(w.kategoria_allegro_id) }));
  // Ta sama kolejność co w `ofertaAllegroZKarty`: nadpisanie → import → mapa; reguły i opis czytamy dla tej jednej kategorii.
  const kategoria =
    napis(kartaAllegro?.kategoria_id) ||
    napis(daneImportu?.kategoria_id) ||
    napis(mapaKategorii[0]?.kategoriaAllegroId);
  const reguly = db
    .prepare(
      `SELECT kategoria_allegro_id, parametr_id, rodzaj, wartosc_json, pole, przelicznik
    FROM allegro_reguly_parametrow WHERE srodowisko = ? AND kategoria_allegro_id = ?`,
    )
    .all(srodowisko, kategoria)
    .map((w) => ({
      kategoriaAllegroId: napis(w.kategoria_allegro_id),
      parametrId: napis(w.parametr_id),
      rodzaj: w.rodzaj,
      wartosc: w.wartosc_json,
      pole: w.pole,
      przelicznik: w.przelicznik,
    }));
  const opisKategorii = opisZPamieci(
    db
      .prepare(
        `SELECT polaczenie, sciezka_json, parametry_json, pobrano_at
    FROM kanaly_kategorie WHERE kategoria_id = ?`,
      )
      .all(kategoria),
    konta,
  );
  const opisyKategorii = opisKategorii ? { [kategoria]: opisKategorii } : {};

  const marka = napis(karta.marka);
  const marki = db
    .prepare(
      `SELECT marka, wartosc_id, wartosc_tekst, kategorie_sprawdzone_json FROM allegro_marki
    WHERE srodowisko = ? AND marka = ?`,
    )
    .all(srodowisko, marka)
    .map((w) => ({
      marka: w.marka,
      wartoscId: w.wartosc_id,
      wartoscTekst: w.wartosc_tekst,
      kategorieSprawdzone: json(w.kategorie_sprawdzone_json, []),
    }));
  const producenciMarek = db
    .prepare(
      `SELECT marka, zrodlo, producent_id, osoba_odpowiedzialna_id FROM allegro_marki_gpsr
    WHERE konto = ? AND marka = ?`,
    )
    .all(konto?.klucz ?? '', marka)
    .map((w) => ({
      marka: w.marka,
      zrodlo: w.zrodlo,
      producentId: w.producent_id,
      osobaOdpowiedzialnaId: w.osoba_odpowiedzialna_id,
    }));

  // Oferty karty na kontach środowiska — rejestr OMS i lustro sklepu; ta sama oferta liczy się raz.
  const listaKont = JSON.stringify(konta);
  const rejestr = db
    .prepare(
      `SELECT kanal, id_zewnetrzne, stan FROM oferty_kanalow
    WHERE karta_id = ? AND kanal IN (SELECT value FROM json_each(?))`,
    )
    .all(kartaId, listaKont);
  const wRejestrze = new Set(rejestr.map((o) => `${o.kanal}\u0000${o.id_zewnetrzne}`));
  const lustro = db
    .prepare(
      `SELECT kanal, produkt_id, status_publikacji FROM produkty_sklepowe
    WHERE karta_id = ? AND zniknal_at IS NULL AND kanal IN (SELECT value FROM json_each(?))`,
    )
    .all(kartaId, listaKont)
    .filter((p) => !wRejestrze.has(`${p.kanal}\u0000${p.produkt_id}`));
  const ofertyKarty = [
    ...rejestr.map((o) => ({ zrodlo: 'rejestr', konto: o.kanal, stan: o.stan })),
    ...lustro.map((p) => ({ zrodlo: 'lustro', konto: p.kanal, stan: p.status_publikacji })),
  ];

  const wspolne = {
    karta,
    kategorieKarty,
    zdjecia,
    daneImportu,
    kartaAllegro,
    mapaKategorii,
    reguly,
    opisyKategorii,
    marki,
    ofertyKarty,
    katalog: opcje.katalog ?? null,
    teraz,
  };
  if (!konto) {
    const wynik = ofertaAllegroZKarty({
      ...wspolne,
      konto: { klucz: '', nazwa: 'Allegro' },
      znakInstalacji: 'BEZ-KONTA',
      ustawienia: USTAWIENIA_BEZ_KONTA,
      wgraneZdjecia: [],
      producenciMarek: [],
    });
    const zalaczniki = json(karta.informacja_bezpieczenstwa, null)?.typ === 'ATTACHMENTS';
    const bledy = wynik.bledy.filter((b) => !BLEDY_KONTA.has(b.kod) && !(zalaczniki && b.kod === 'bezpieczenstwo'));
    return {
      karta,
      bledy,
      ostrzezenia: wynik.ostrzezenia,
      zadanie: null,
      droga: wynik.droga,
      doWgrania: [],
      parametryWyliczone: wynik.parametryWyliczone,
      bezKonta: true,
    };
  }
  const ustawienia = ustawieniaOfertKonta(db, konto.klucz);
  // `opcje.migawka` (jedna na żądanie) → ilość z iloscDlaKanalu i bufora konta; bez niej dzisiejsza stała.
  const ilosc = iloscOferty(opcje.migawka, kartaId, ustawienia);
  // Wyjątek cennika dostaw z karty na tym koncie (podgląd, karta i pętla czytają ten sam).
  const wyjatek = wyjatekCennika(db, { kartaId, konto: konto.klucz });
  // Ręczna cena karty na tym koncie — ten sam odczyt dla podglądu, karty i pętli, żeby wysłana cena była
  // tą, którą sprzedawca zobaczył; brak wiersza = cena karty z narzutem konta.
  const recznaGr = cenyReczneKarty(db, kartaId).get(konto.klucz) ?? null;
  const wynik = ofertaAllegroZKarty({
    ...wspolne,
    konto,
    znakInstalacji: znakInstalacji(db),
    ustawienia,
    wgraneZdjecia,
    producenciMarek,
    ilosc,
    wyjatekCennika: wyjatek,
    recznaGr,
    tworzenie: opcje.tworzenie === true,
  });
  return { karta, ...wynik, bezKonta: false, ilosc: ilosc ?? null };
}
