import { wzorPoId, produktyWzoru, niepowiazaneOfertyAllegro } from '../../oms/db/magazyn.js';
import { propozycjeOfert } from '../../domena/dopasowanie-ofert.js';
import { adresKanalu } from '../../domena/kanaly.js';
import { miniaturaZLustra } from '../../domena/miniatura-pozycji.js';
import { opisWymiarow, centymetryZMilimetrow } from '../../domena/rozmiar.js';
import { czyPaczkomat } from '../../domena/paczkomat.js';
import { zl } from '../../domena/kwoty.js';
const ADRES_HTTP = /^https?:\/\//i;
const adresSklepu = (a) => (typeof a === 'string' && ADRES_HTTP.test(a.trim()) ? a.trim() : null);
const napis = (s) => typeof s === 'string' && s.trim() ? s.trim() : null;
function pole(body, klucz) {
  if (!body || !Object.hasOwn(body, klucz)) return null;
  const wartosc = body[klucz];
  return typeof wartosc === 'string' ? wartosc : null;
}

function listaTekstow(surowe) {
  if (typeof surowe !== 'string' || !surowe.trim()) return [];
  try {
    const lista = JSON.parse(surowe);
    return Array.isArray(lista) ? lista.filter((k) => typeof k === 'string' && k.trim()) : [];
  } catch { return []; }
}

/**
 * Galeria JEDNEGO produktu: miniatura na ekran, oryginal pod odnosnikiem.
 *
 * ⚠️ OSOBNO PER PRODUKT, A NIE JEDNYM WORKIEM. Ten sam wzor bywa sfotografowany inaczej na
 * PRO, inaczej na sklepie A i inaczej na Allegro, a przy pobieraniu zdjec do folderu wzoru
 * (Etap 2) trzeba wiedziec, skad ktore pochodzi.
 *
 * ⚠️ NA EKRAN IDZIE MINIATURA, nie oryginal: zmierzone przy zamowieniach 87 KB → 4 KB,
 * a galeria wzoru potrafi miec kilkanascie zdjec z trzech kanalow.
 *
 * ⚠️⚠️ ZDJECIE GLOWNE BIERZE ADRES Z LUSTRA, RESZTA ZOSTAJE PRZY ZGADYWANIU — i to nie jest
 * polowicznosc, tylko granica tego, co WIEMY. Kolumna `produkty_sklepowe.miniatura` trzyma
 * JEDNA wartosc: miniature zdjecia pierwszego z galerii (schema.sql). Podstawienie jej pod
 * kazdy kafelek pokazywaloby kilkanascie razy ten sam obrazek i klamaloby o tym, co w sklepie
 * naprawde lezy. Kafelki dalsze ida wiec dotychczasowa reguła — dokladnie tak, jak dzis.
 *
 * ⚠️ REGULA „lustro wygrywa, zgadywanie zostaje siatka" JEST TA SAMA, ktora dostaja ekrany
 * zamowien (`domain/miniatura-pozycji.js`). Osobna kopia tutaj rozjechalaby sie z nimi przy
 * pierwszej zmianie — a wlasnie z takiego rozjazdu wzieła sie cala ta poprawka.
 */
function galeriaProduktu(surowe, zapisanaMiniaturaGlownego) {
  const zdjecia = [];
  for (const adres of listaTekstow(surowe)) {
    // Ta sama bramka, co przy adresie produktu: adres z cudzego API laduje wprost w `href`.
    const oryginal = adresSklepu(adres);
    if (!oryginal) continue;
    const zLustra = zdjecia.length === 0 ? zapisanaMiniaturaGlownego : null;
    zdjecia.push({ oryginal, miniatura: miniaturaZLustra(zLustra, oryginal) });
  }
  return zdjecia;
}

/** Jeden powiazany produkt albo oferta — wiersz sekcji „Produkty i oferty". */
function wierszProduktuKarty(p, kanalyAllegro, definicje) {
  return {
    id: p.id,
    nazwa: p.nazwa,
    etykietaKanalu: adresKanalu(p.kanal, definicje),
    cena: p.cena_gr === null || p.cena_gr === undefined ? null : zl(p.cena_gr),
    adres: adresSklepu(p.adres),
    sku_sklepu: p.sku_sklepu ?? null,
    kategorie: listaTekstow(p.kategorie_json),
    zdjecia: galeriaProduktu(p.zdjecia_json, p.miniatura),
    // Produkt wycofany ze sklepu ZOSTAJE na karcie i MOWI, ze zniknal — patrz `produktyWzoru`.
    zniknal: Boolean(p.zniknal_at),
    // ⚠️⚠️ ODPIAC WOLNO WYLACZNIE OFERTE ALLEGRO. Produkt SKLEPOWY zbudowal ten wzor
    // („Utwórz wzory z niepowiązanych") — odpiecie zostawiloby wzor sierote: bez ceny,
    // bez zdjecia, bez kategorii i bez sladu, co go osierocilo. Bariera stoi w bazie
    // (`odepnijOferte` zna warunek kanalu); tutaj rozstrzyga sie, czy w ogole pokazac
    // przycisk, bo przycisk, ktory zawsze odmawia, jest gorszy niz jego brak.
    odpinalny: kanalyAllegro.includes(p.kanal),
  };
}

/** Jedna oferta do dopisania — z ocena, gdy przyszla z podpowiedzi. */
const kandydatKarty = (oferta, propozycja, definicje) => ({
  id: oferta.id,
  nazwa: oferta.nazwa,
  etykietaKanalu: adresKanalu(oferta.kanal, definicje),
  adres: adresSklepu(oferta.adres),
  // ⚠️ PROCENT SKLADA SIE TUTAJ (widok niczego nie liczy) i jest TA SAMA liczba, co na
  // ekranie powiazan — bo liczy ja ta sama funkcja, tylko zadana z drugiej strony.
  procent: propozycja ? `${Math.round(propozycja.ocena * 100)}%` : null,
  slowa: propozycja ? propozycja.wspolneSlowa.join(', ') : null,
});

// Ilu kandydatow podsuwa karta. Wiecej niz na ekranie powiazan (tam trzej mieszcza sie
// w wierszu tabeli), bo tutaj lista stoi w kolumnie i sluzy JEDNEMU wzorowi.
const ILE_PODPOWIEDZI = 5;

// Adres powrotu na liste (Zadanie 6). WYLACZNIE wlasny ekran magazynu — wartosc przychodzi
// z paska adresu (albo od kogos, kto podesle spreparowany odnosnik), wiec bez tej bariery
// karta bylaby przekaznikiem na DOWOLNY adres (open redirect), a `//host` przegladarka
// czyta jako adres absolutny bez schematu (`//evil.example` == `https://evil.example`
// na stronie serwowanej po https).
const bezpiecznyWroc = (surowy) => (
  typeof surowy === 'string' && /^\/magazyn(\?|$)/.test(surowy) && !surowy.includes('//')
    ? surowy : null
);

// Adres karty z PELNYM kompletem stanu ekranu: otwarta sekcja edycji, fraza, filtr konta
// i — od Zadania 6 — adres powrotu na liste (`wroc`, JUZ zwalidowany przez `bezpiecznyWroc`
// u kazdego wywolujacego). ⚠️ Ten sam powod, co przy `adresMagazynu` i `adresPowiazan`
// (niezmiennik 4.13b): odnosnik budowany od zera gubilby to, co czlowiek przed chwila
// ustawil — a tu gubilby TAKZE otwarty formularz i to, na jaka liste ma wrocic.
//
// ⚠️ `wroc` DOKLEJA SIE JAKO OSTATNI — kolejnosc parametrow ma zostac STALA (ta sama zasada,
// co przy `POLA` w domain/magazyn-filtry.js), zeby ten sam stan ekranu mial zawsze ten sam
// adres (zakladki, historia przegladarki, testy porownujace adresy).
function adresKarty(id, {
  edytuj, fraza, kanal, wroc,
} = {}) {
  const czesci = [];
  if (edytuj) czesci.push(['edytuj', edytuj]);
  if (fraza) czesci.push(['fraza', fraza]);
  if (kanal) czesci.push(['kanal', kanal]);
  if (wroc) czesci.push(['wroc', wroc]);
  if (!czesci.length) return `/magazyn/${id}`;
  return `/magazyn/${id}?${czesci.map(([k, w]) => `${k}=${encodeURIComponent(w)}`).join('&')}`;
}

// Dokleja „?wroc=…" do GOLEJ sciezki (bez reszty parametrow, ktorych „/odepnij" i „/powiaz"
// nie znaja — patrz pulapka sklejania przy `adresOdepnij`/`adresPowiaz` w `ekranKarty`).
// To ten sam encoding, co `wroc` wewnatrz `adresKarty` — wyciagniety, zeby nie zyl osobno
// w kazdym z tamtych dwoch miejsc.
const zWroc = (sciezka, wroc) => (
  wroc ? `${sciezka}?wroc=${encodeURIComponent(wroc)}` : sciezka
);

const BEZ_SKLEPOW = {
  title: 'Magazyn', naglowek: 'Magazyn',
  opis: 'Ten panel nie ma podpiętego żadnego sklepu ani konta Allegro, więc nie ma skąd wziąć katalogu — zakładka jest pusta celowo. Magazyn buduje się z odczytu sklepów; bez sekcji SKLEP_*/ALLEGRO_* w konfiguracji kontenera nie ma o co pytać.',
};

/**
 * Istniejący renderer karty współdzielony przez odczyt i odmowy zapisu.
 * @param {object} opcje
 * @param {import('node:sqlite').DatabaseSync} opcje.db
 * @param {readonly {klucz:string;etykieta?:string}[]} opcje.definicje
 * @param {string[]} opcje.kanalyAllegro — jawna lista kont do filtra i zapytania kandydatów
 */
export function createKartaMagazynu({ db, kanalyAllegro, definicje }) {
  const kanalAllegro = (surowy) => { const s = napis(surowy); return s !== null && kanalyAllegro.includes(s) ? s : null; };
  const brakWzoru = (reply, id) => reply.code(404).view('pusta-strona.ejs', {
    title: 'Magazyn — nie ma takiego wzoru',
    naglowek: 'Nie ma takiego wzoru',
    opis: `Nie ma wzoru o numerze ${String(id)}. Mógł zostać usunięty albo numer w adresie `
      + 'jest inny niż ten, o który chodziło. Wróć do magazynu i wejdź w wzór z listy: /magazyn',
  });

  function ekranKarty(req, reply, { wzor, blad = null, kod = 200 } = {}) {
    // ⚠️ FORMULARZ OTWIERA SIE WYLACZNIE NA `?edytuj=dane` — albo po ODMOWIE, zeby czlowiek
    // nie stracil tego, co wpisal. `typeof === 'string'` odsiewa powtorzony klucz w adresie
    // (`?edytuj=a&edytuj=b`), ktory Fastify oddaje jako TABLICE; biala lista jednej wartosci
    // odsiewa `constructor` i reszte prototypu (ta sama pulapka, co przy sortowaniu).
    const edytujParam = typeof req.query?.edytuj === 'string' ? req.query.edytuj : null;
    const edytujDane = edytujParam === 'dane' || Boolean(blad);

    // Adres powrotu na liste (Zadanie 6) — WYLACZNIE wlasny ekran magazynu, patrz
    // `bezpiecznyWroc`. Czytany TUTAJ (a nie osobno w kazdej trasie karty), zeby odczyt
    // i kazda odmowa pokazywaly ten sam odnosnik „Wróć" — ten sam powod, dla ktorego caly
    // ekran karty sklada sie w jednym miejscu.
    const wroc = bezpiecznyWroc(req.query?.wroc);
    const adresPowrotu = wroc ?? '/magazyn';

    const produkty = produktyWzoru(db, wzor.id).map(p => wierszProduktuKarty(p, kanalyAllegro, definicje));

    // Kandydaci do dopisania. ⚠️ WYLACZNIE OFERTY ALLEGRO — patrz komentarz przy trasie
    // `POST /magazyn/:id/powiaz`.
    const filtry = { fraza: napis(req.query?.fraza), kanal: kanalAllegro(req.query?.kanal) };
    const szukamy = Boolean(filtry.fraza || filtry.kanal);
    const oferty = niepowiazaneOfertyAllegro(db, kanalyAllegro);

    // ⚠️⚠️ SZUKANIE ZASTEPUJE PODPOWIEDZI, a nie doklada sie do nich. Pomiar obalil zalozenie
    // planu: tytuly na Allegro sa SPRZEDAZOWE, wiec podpowiedz trafia w mniejszosc przypadkow
    // („Zakaz palenia papierosów - DUŻY szablon malarski" wobec „Zakaz palenia – 64cm") —
    // i wlasnie wtedy czlowiek siega po fraze. Podpowiedzi domieszane do wynikow znaczylyby,
    // ze wyszukiwarka oddaje takze to, o co nikt nie pytal.
    const szukane = filtry.fraza ? filtry.fraza.toLowerCase() : null;
    const kandydaci = szukamy
      ? oferty
        .filter((o) => (!filtry.kanal || o.kanal === filtry.kanal))
        .filter((o) => (!szukane || String(o.nazwa ?? '').toLowerCase().includes(szukane)))
        .map((o) => kandydatKarty(o, null, definicje))
      // ⚠️⚠️ TA SAMA REGULA, CO NA EKRANIE POWIAZAN — zadana z drugiej strony (rozstrzygniecie
      // kontrolera 1). Zadnej wlasnej miary podobienstwa w tym pliku nie ma i byc nie moze:
      // dwie kopie rozjechalyby sie przy pierwszej poprawce, a wtedy karta podsuwalaby inna
      // oferte niz ekran obok. Podpowiedz NICZEGO NIE WIAZE — wiaze klikniecie.
      : propozycjeOfert(wzor, oferty, { ile: ILE_PODPOWIEDZI })
        .map((p) => kandydatKarty(p.oferta, p, definicje));

    // Pozycje pola wyboru kategorii glownej: to, co wzor ma dzis, PLUS komplet kategorii
    // powiazanych produktow. ⚠️ Wybor ma byc SWIADOMY (stad komplet obok kazdego produktu),
    // ale nie moze zgubic wartosci juz ustawionej — inaczej zapis czegokolwiek innego
    // kasowalby kategorie po cichu, bo pole wyboru nie mialoby jej wsrod pozycji.
    const kategorie = [...new Set([
      ...(wzor.kategoria_glowna ? [wzor.kategoria_glowna] : []),
      ...produkty.flatMap((p) => p.kategorie),
    ])].sort((a, b) => a.localeCompare(b, 'pl'));

    // Wartosci POL formularza. Po odmowie wygrywa to, co czlowiek WPISAL — inaczej traci
    // wszystko, co wstukal w pozostalych polach, i wpisuje od nowa.
    const zBazy = {
      nazwa: wzor.nazwa ?? '',
      sku: wzor.sku ?? '',
      szerokosc_cm: centymetryZMilimetrow(wzor.szerokosc_mm) ?? '',
      wysokosc_cm: centymetryZMilimetrow(wzor.wysokosc_mm) ?? '',
      kategoria_glowna: wzor.kategoria_glowna ?? '',
      paczkomat: czyPaczkomat(wzor) ?? '',
      opis: wzor.opis ?? '',
    };
    const wartosci = Object.create(null);
    for (const klucz of Object.keys(zBazy)) {
      const wpisane = blad ? pole(req.body, klucz) : null;
      wartosci[klucz] = wpisane === null ? zBazy[klucz] : wpisane;
    }

    return reply.code(kod).view('magazyn-wzor.ejs', {
      title: `Magazyn — ${wzor.nazwa}`,
      wzor: {
        id: wzor.id,
        nazwa: wzor.nazwa,
        sku: wzor.sku || null,
        // Milimetry → „70 × 100 cm" liczy domena, nie szablon (domain/rozmiar.js).
        wymiary: opisWymiarow(wzor),
        kategoria: wzor.kategoria_glowna || null,
        // Trzy stany; `null` znaczy „jeszcze nieoznaczone" i to CO INNEGO niz 'nie'.
        paczkomat: czyPaczkomat(wzor),
        opis: wzor.opis || null,
      },
      produkty,
      kandydaci,
      kategorie,
      edytujDane,
      blad,
      wartosci,
      szukamy,
      filtry,
      // Formularz szukania niesie UKRYTYM POLEM otwarta sekcje edycji i — od Zadania 6 —
      // adres powrotu. ⚠️ `wroc` MUSI byc TU, nie tylko w adresie akcji formularza: submit
      // formularza GET WYRZUCA query string z `action` i skleja nowy WYLACZNIE z named pol
      // (ten sam powod, dla ktorego tu juz stoi `edytuj`) — bez ukrytego pola szukanie
      // oferty cichaczem gubiloby powrot.
      ukryteWSzukajce: [
        ...(edytujDane ? [{ name: 'edytuj', value: 'dane' }] : []),
        ...(wroc ? [{ name: 'wroc', value: wroc }] : []),
      ],
      adresPowrotu,
      adresKarty: adresKarty(wzor.id, { wroc }),
      adresEdycji: adresKarty(wzor.id, {
        fraza: filtry.fraza, kanal: filtry.kanal, edytuj: 'dane', wroc,
      }),
      // ⚠️⚠️ PUŁAPKA SKLEJANIA: te dwa formularze doklejaly `/odepnij` i `/powiaz` PO gotowym
      // `adresKarty` (`<%= adresKarty %>/odepnij`). Skoro `adresKarty` moze dzis niesc
      // `?wroc=…`, naiwne doklejenie wsadzaloby ten dopisek W SRODEK wartosci parametru
      // zamiast za nim (query string ma prawo stac WYLACZNIE na koncu adresu) — trasa
      // `/magazyn/:id/odepnij` nigdy by nie trafiła. Dlatego licza sie OSOBNO, tutaj,
      // z tym samym `wroc`.
      adresOdepnij: zWroc(`/magazyn/${wzor.id}/odepnij`, wroc),
      adresPowiaz: zWroc(`/magazyn/${wzor.id}/powiaz`, wroc),
      kanalyDoFiltra: kanalyAllegro.map((klucz) => ({ klucz, etykieta: adresKanalu(klucz, definicje) })),
    });
  }

  return { ekranKarty, brakWzoru };
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {object} opcje
 * @param {import('node:sqlite').DatabaseSync} opcje.db
 * @param {unknown} opcje.magazyn — karta sprawdza tylko dostępność usługi, nie wywołuje jej metod
 * @param {readonly {klucz:string;etykieta?:string}[]} opcje.definicje
 * @param {string[]} opcje.kanalyAllegro
 */
export function registerKartaMagazynu(app, { db, magazyn, kanalyAllegro, definicje }) {
  const { ekranKarty, brakWzoru } = createKartaMagazynu({ db, kanalyAllegro, definicje });
  app.get('/magazyn/:id', async (req, reply) => {
    if (!magazyn) return reply.view('pusta-strona.ejs', BEZ_SKLEPOW);
    const wzor = wzorPoId(db, req.params.id);
    if (!wzor) return brakWzoru(reply, req.params.id);
    // ⚠️ TA TRASA WYLACZNIE CZYTA. Podpowiedzi sa PROPOZYCJA — wejscie na karte nie wiaze
    // ani jednej oferty (to samo rozstrzygniecie, co na ekranie powiazan).
    return ekranKarty(req, reply, { wzor });
  });

}
