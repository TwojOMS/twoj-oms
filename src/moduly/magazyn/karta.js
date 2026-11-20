import { kartaPoId, produktyKarty, niepowiazaneOfertyAllegro, zapiszKarte } from '../../oms/db/magazyn.js';
import { propozycjeOfert } from '../../domena/dopasowanie-ofert.js';
import { adresKanalu, rodzajKanalu } from '../../domena/kanaly.js';
import { gdzieOtworzyc } from '../../domena/link-pozycji.js';
import { miniaturaZLustra } from '../../domena/miniatura-pozycji.js';
import { opisWymiarow, centymetryZMilimetrow, kilogramyZGramow } from '../../domena/rozmiar.js';
import { daneOpisu } from './opis.js';
import { randomBytes } from 'node:crypto';
import { stanKarty, historiaKarty, dodajRuch } from '../../oms/db/stany-magazynowe.js';
import { czyPonizejProgu, klasaStanu } from '../../domena/niski-stan.js';
import { ETYKIETY_RUCHU, ruchZFormularza } from '../../domena/stany-magazynowe.js';
import { dzienWarszawa, fmtDataCzas, fmtDataCzasKrotko } from '../../domena/format-daty.js';
import {
  cenaObowiazujaca,
  cenaPrzyszla,
  dzienPolski,
  dzienZNapisu,
  zrodloCenyZakupu,
} from '../../domena/cena-zakupu.js';
import { historiaCenZakupu } from '../../oms/db/ceny-zakupu.js';
import { zl, zlotowki } from '../../domena/kwoty.js';
import { STAWKI_VAT } from '../../domena/vat.js';
import { danePrezentacjiKarty, bladTresciOferty } from './karta-prezentacja.js';
import { daneGalerii } from './galeria.js';
import {
  ofertyDoWidoku,
  zmianyPonowienia,
  mozeWznowic,
  opisDostawy,
  opcjeCennikowOms,
  nazwaCennikaKarty,
} from './oferty.js';
import { STATUS_USUNIETEJ_Z_OMS } from './oferty.js';
import { daneSprzedazyKarty } from './karta-sprzedaz-kanalow.js';
import {
  usunWyjatekCennika,
  wyjatekCennika,
  zapiszWyjatekCennika,
  zrodloWyjatkuCennika,
} from '../../oms/db/cenniki-kart.ts';
import { bladWyboruCennika, kontaZCennikami, nazwaCennikaKonta, odmowaDlaKonta } from './services/cenniki-kont.js';
import { cennikOmsKarty, maCennikiOms, ustawCennikKarty, wCalosci } from '../../oms/db/cenniki-oms.ts';
import { dobierzCennik, regulyKonta } from '../../domena/cennik-dostaw.js';
import { nazwySlownika } from './services/slowniki-kart.js';
import { czystaNazwa, markaZFormularza } from '../../domena/marka-karty.js';
import { dekodujEncje } from '../../domena/slowniki-kart.js';
import { znacznikStatusuOferty } from '../../domena/allegro-oferta.js';
import { stronaOdmowy } from '../../core/web/odmowa.js';
import { ofertaAllegroKarty } from './services/tresc-oferty-allegro.js';
import { createStatusWKanale, registerStatusWKanale } from './status-w-kanale.js';
import { daneGpsrKarty, registerGpsrKarty } from './karta-gpsr.js';
import { daneParametrowKarty, registerParametryKarty } from './karta-parametry.js';
import { dlugoscNazwyAllegro, LIMIT_NAZWY, PARAMETR_STAN } from '../../domena/allegro-oferta-z-karty.js';
import { WERSJA_OPISU_KATEGORII } from '../../domena/tresc-oferty-allegro.js';
import { naglowekOferty, zdanieCzekaniaOferty } from '../../domena/czekanie-oferty.js';
import { ofertaPoId, zmienOferte, ustawieniaOfertKonta } from '../../oms/db/oferty-kanalow.ts';
import { czyKonfliktErli, STANY_SYNCHRONIZACJI_ERLI, zamrozone } from './services/petla-ofert.js';
import { STANY_SYNCHRONIZACJI_ALLEGRO } from './services/petla-ofert-allegro.js';
const ADRES_HTTP = /^https?:\/\//i;
export const adresSklepu = (a) => (typeof a === 'string' && ADRES_HTTP.test(a.trim()) ? a.trim() : null);
const napis = (s) => (typeof s === 'string' && s.trim() ? s.trim() : null);
function pole(body, klucz) {
  if (!body || !Object.hasOwn(body, klucz)) return null;
  const wartosc = body[klucz];
  return typeof wartosc === 'string' ? wartosc : null;
}

export function polaSlownikowZFormularza(body) {
  const zmiany = {};
  const wpisanaKategoria = czystaNazwa(pole(body, 'kategoria_glowna_nowa'));
  const wybranaKategoria = pole(body, 'kategoria_glowna');
  if (wpisanaKategoria || wybranaKategoria !== null) {
    zmiany.kategoria_glowna = wpisanaKategoria || czystaNazwa(wybranaKategoria) || null;
  }
  const { marka } = markaZFormularza(body);
  if (marka !== undefined) zmiany.marka = marka;
  return zmiany;
}

function listaTekstow(surowe) {
  if (typeof surowe !== 'string' || !surowe.trim()) return [];
  try {
    const lista = JSON.parse(surowe);
    return Array.isArray(lista) ? lista.filter((k) => typeof k === 'string' && k.trim()) : [];
  } catch {
    return [];
  }
}

/**
 * Galeria JEDNEGO produktu: miniatura na ekran, oryginal pod odnosnikiem.
 *
 * ⚠️ OSOBNO PER PRODUKT, A NIE JEDNYM WORKIEM. Ta sama karta bywa sfotografowana inaczej na
 * sklepie B, inaczej na sklepie A i inaczej na Allegro, a przy kazdym uzyciu zdjecia
 * trzeba wiedziec, skad ktore pochodzi.
 *
 * ⚠️ NA EKRAN IDZIE MINIATURA, nie oryginal: zmierzone przy zamowieniach 87 KB → 4 KB,
 * a galeria karty potrafi miec kilkanascie zdjec z trzech kanalow.
 *
 * ⚠️⚠️ ZDJECIE GLOWNE BIERZE ADRES Z LUSTRA, RESZTA DOSTAJE ORYGINAL. Kolumna
 * `produkty_sklepowe.miniatura` trzyma JEDNA wartosc: miniature zdjecia pierwszego z galerii
 * (schema.sql). Podstawienie jej pod kazdy kafelek pokazywaloby kilkanascie razy ten sam
 * obrazek i klamaloby o tym, co w sklepie naprawde lezy.
 *
 * ⚠️ ODCHODZI OD REGULY EKRANOW ZAMOWIEN (`domena/miniatura-pozycji.js`), ktore bez lustra
 * ZGADUJA adres (`-150x150`, `s150`). Na karcie zgadywany adres dawal puste ramki tam, gdzie
 * sklep skaluje miniatury do wlasnego rozmiaru (404), a kazdy wiersz ma tu kilka zdjec naraz.
 * Oryginal jest adresem PEWNYM: ciezszy, ale `loading="lazy"` i stale wymiary w widoku
 * trzymaja koszt i uklad. Z domeny bierzemy tylko bramke adresu z lustra.
 */
function galeriaProduktu(surowe, zapisanaMiniaturaGlownego) {
  const zdjecia = [];
  for (const adres of listaTekstow(surowe)) {
    // Ta sama bramka, co przy adresie produktu: adres z cudzego API laduje wprost w `href`.
    const oryginal = adresSklepu(adres);
    if (!oryginal) continue;
    const zLustra = zdjecia.length === 0 ? zapisanaMiniaturaGlownego : null;
    // `miniaturaZLustra(x, null)` oddaje adres z lustra albo null — bez zgadywania.
    zdjecia.push({ oryginal, miniatura: miniaturaZLustra(zLustra, null) ?? oryginal });
  }
  return zdjecia;
}

/** Jeden powiazany produkt albo oferta — wiersz sekcji „Produkty i oferty". */
function wierszProduktuKarty(p, kanalyAllegro, definicje, status) {
  return {
    id: p.id,
    status,
    ...bladTresciOferty(p),
    nazwa: p.nazwa,
    etykietaKanalu: adresKanalu(p.kanal, definicje),
    cena: p.cena_gr === null || p.cena_gr === undefined ? null : zl(p.cena_gr),
    adres: adresSklepu(p.adres),
    // Napis liczy model z rodzaju kanalu; widok go tylko wypisuje.
    napisAdresu: `otwórz ${gdzieOtworzyc(rodzajKanalu(p.kanal, definicje)?.klucz)}`,
    sku_sklepu: p.sku_sklepu ?? null,
    kategorie: listaTekstow(p.kategorie_json),
    zdjecia: galeriaProduktu(p.zdjecia_json, p.miniatura),
    // Produkt wycofany ze sklepu ZOSTAJE na karcie i MOWI, ze zniknal — patrz `produktyKarty`.
    zniknal: Boolean(p.zniknal_at),
    // ⚠️⚠️ ODPIAC WOLNO WYLACZNIE OFERTE ALLEGRO. Produkt SKLEPOWY zbudowal te karte
    // („Utwórz karty z niepowiązanych") — odpiecie zostawiloby karte sierote: bez ceny,
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
  znacznik: znacznikStatusuOferty(oferta.status_publikacji),
  // ⚠️ PROCENT SKLADA SIE TUTAJ (widok niczego nie liczy) i jest TA SAMA liczba, co na
  // ekranie powiazan — bo liczy ja ta sama funkcja, tylko zadana z drugiej strony.
  procent: propozycja ? `${Math.round(propozycja.ocena * 100)}%` : null,
  slowa: propozycja ? propozycja.wspolneSlowa.join(', ') : null,
});

// Ilu kandydatow podsuwa karta. Wiecej niz na ekranie powiazan (tam trzej mieszcza sie
// w wierszu tabeli), bo tutaj lista stoi w kolumnie i sluzy JEDNEJ karcie.
const ILE_PODPOWIEDZI = 5;

// Adres powrotu na liste. WYLACZNIE wlasny ekran magazynu — wartosc przychodzi
// z paska adresu (albo od kogos, kto podesle spreparowany odnosnik), wiec bez tej bariery
// karta bylaby przekaznikiem na DOWOLNY adres (open redirect), a `//host` przegladarka
// czyta jako adres absolutny bez schematu (`//evil.example` == `https://evil.example`
// na stronie serwowanej po https).
const bezpiecznyWroc = (surowy) =>
  typeof surowy === 'string' && /^\/magazyn(\?|$)/.test(surowy) && !surowy.includes('//') ? surowy : null;

// Adres karty z PELNYM kompletem stanu ekranu: otwarta sekcja edycji, fraza, filtr konta
// i adres powrotu na liste (`wroc`, JUZ zwalidowany przez `bezpiecznyWroc`
// u kazdego wywolujacego). ⚠️ Ten sam powod, co przy `adresMagazynu` i `adresPowiazan`
// (reguła: filtry nie kasują frazy): odnosnik budowany od zera gubilby to, co czlowiek przed chwila
// ustawil — a tu gubilby TAKZE otwarty formularz i to, na jaka liste ma wrocic.
//
// ⚠️ `wroc` DOKLEJA SIE JAKO OSTATNI — kolejnosc parametrow ma zostac STALA (ta sama zasada,
// co przy `POLA` w domena/magazyn-filtry.js), zeby ten sam stan ekranu mial zawsze ten sam
// adres (zakladki, historia przegladarki, testy porownujace adresy).
function adresKarty(id, { edytuj, fraza, kanal, wroc, usunCene, wycofaj } = {}) {
  const czesci = [];
  if (edytuj) czesci.push(['edytuj', edytuj]);
  if (fraza) czesci.push(['fraza', fraza]);
  if (kanal) czesci.push(['kanal', kanal]);
  if (usunCene) czesci.push(['usun-cene', usunCene]);
  if (wycofaj) czesci.push(['wycofaj', 'tak']);
  if (wroc) czesci.push(['wroc', wroc]);
  if (!czesci.length) return `/magazyn/${id}`;
  return `/magazyn/${id}?${czesci.map(([k, w]) => `${k}=${encodeURIComponent(w)}`).join('&')}`;
}

// Dokleja „?wroc=…" do GOLEJ sciezki (bez reszty parametrow, ktorych „/odepnij" i „/powiaz"
// nie znaja — patrz pulapka sklejania przy `adresOdepnij`/`adresPowiaz` w `ekranKarty`).
// To ten sam encoding, co `wroc` wewnatrz `adresKarty` — wyciagniety, zeby nie zyl osobno
// w kazdym z tamtych dwoch miejsc.
const zWroc = (sciezka, wroc) => (wroc ? `${sciezka}?wroc=${encodeURIComponent(wroc)}` : sciezka);

function daneCenyZakupu(db, kartaId, dzis, usunParam, wroc) {
  const wpisy = historiaCenZakupu(db, kartaId);
  const biezaca = cenaObowiazujaca(wpisy, dzis);
  const przyszla = cenaPrzyszla(wpisy, dzis);
  const historia = wpisy.reverse().map((w) => ({
    id: w.id,
    cena: zlotowki(zl(w.cena_netto_gr)),
    od: dzienPolski(w.obowiazuje_od),
    kiedy: fmtDataCzasKrotko(w.wpisano_at),
    kto: w.kto,
    zrodlo: zrodloCenyZakupu(w.zrodlo),
    obowiazuje: w.id === biezaca?.id,
    przyszla: w.obowiazuje_od > dzis,
    potwierdzenie: `${adresKarty(kartaId, { wroc, usunCene: w.id })}#dane-karty`,
  }));
  const usunId = typeof usunParam === 'string' ? Number(usunParam) : NaN;
  const usuwany = historia.find((w) => w.id === usunId);
  return {
    cenaZakupu: historia.find((w) => w.id === biezaca?.id),
    cenaPrzyszla: historia.find((w) => w.id === przyszla?.id),
    historiaCenyZakupu: historia,
    usunCene: usuwany && { ...usuwany, akcja: zWroc(`/magazyn/${kartaId}/cena-zakupu/${usuwany.id}/usun`, wroc) },
  };
}

const BEZ_SKLEPOW = {
  title: 'Magazyn',
  naglowek: 'Magazyn',
  opis: 'Ten panel nie ma podpiętego żadnego sklepu ani konta Allegro, więc nie ma skąd wziąć katalogu — zakładka jest pusta celowo. Magazyn buduje się z odczytu sklepów; kanały dopisuje się w zmiennej OMS_KANALY w pliku konfiguracji OMS (instrukcja: docs/instalacja-docker.md, sekcja 9), a bez nich nie ma o co pytać.',
};

/**
 * Istniejący renderer karty współdzielony przez odczyt i odmowy zapisu.
 * @param {object} opcje
 * @param {import('node:sqlite').DatabaseSync} opcje.db
 * @param {readonly {klucz:string;etykieta?:string}[]} opcje.definicje
 * @param {string[]} opcje.kanalyAllegro — jawna lista kont do filtra i zapytania kandydatów
 * @param {() => readonly {klucz:string, cennikiDostaw?: readonly string[] | null}[]} [opcje.kontaErli]
 * @param {() => readonly {klucz:string, zgoda?:boolean, tylkoOdczyt?:() => boolean}[]} [opcje.kontaAllegro] — konta Allegro do sekcji „Allegro” karty
 * @param {Record<string, any>} [opcje.sklepy] — klienci Woo po kluczu kanału (kolumna Status)
 */
export function createKartaMagazynu({
  db,
  kanalyAllegro,
  definicje,
  kontaErli = /** @returns {{ klucz: string }[]} */ () => [],
  kontaAllegro = /** @returns {{ klucz: string }[]} */ () => [],
  sklepy = {},
}) {
  const statusy = createStatusWKanale({ db, definicje, sklepy, kontaAllegro });
  const kanalAllegro = (surowy) => {
    const s = napis(surowy);
    return s !== null && kanalyAllegro.includes(s) ? s : null;
  };
  const brakKarty = (reply, id) =>
    reply.code(404).view('pusta-strona.ejs', {
      title: 'Magazyn — nie ma takiej karty produktu',
      naglowek: 'Nie ma takiej karty produktu',
      opis:
        `Nie ma karty o numerze ${String(id)}. Mogła zostać usunięta albo numer w adresie ` +
        'jest inny niż ten, o który chodziło. Wróć do magazynu i wejdź w kartę z listy: /magazyn',
    });

  function ekranKarty(
    req,
    reply,
    {
      karta,
      blad = null,
      kod = 200,
      bladRuchu = null,
      bladPowiazania = null,
      bladStatusu = null,
      gpsr = null,
      parametry = null,
    } = {},
  ) {
    // ⚠️ FORMULARZ OTWIERA SIE WYLACZNIE NA `?edytuj=dane` — albo po ODMOWIE, zeby czlowiek
    // nie stracil tego, co wpisal. `typeof === 'string'` odsiewa powtorzony klucz w adresie
    // (`?edytuj=a&edytuj=b`), ktory Fastify oddaje jako TABLICE; biala lista jednej wartosci
    // odsiewa `constructor` i reszte prototypu (ta sama pulapka, co przy sortowaniu).
    const edytujParam = typeof req.query?.edytuj === 'string' ? req.query.edytuj : null;
    const edytujDane = edytujParam === 'dane' || Boolean(blad);

    // Adres powrotu na liste — WYLACZNIE wlasny ekran magazynu, patrz
    // `bezpiecznyWroc`. Czytany TUTAJ (a nie osobno w kazdej trasie karty), zeby odczyt
    // i kazda odmowa pokazywaly ten sam odnosnik „Wróć" — ten sam powod, dla ktorego caly
    // ekran karty sklada sie w jednym miejscu.
    const wroc = bezpiecznyWroc(req.query?.wroc);
    const adresPowrotu = wroc ?? '/magazyn';

    const wierszeLustra = produktyKarty(db, karta.id);
    const ofertyKarty = ofertyDoWidoku(db, karta.id);
    const admin = req.konto?.admin === true;
    const produkty = wierszeLustra.map((p) =>
      wierszProduktuKarty(
        p,
        kanalyAllegro,
        definicje,
        statusy.model(p, {
          admin,
          kartaId: karta.id,
          oferty: ofertyKarty,
          komunikat: bladStatusu?.produktId === p.id ? bladStatusu.tekst : null,
        }),
      ),
    );

    // Kandydaci do dopisania. ⚠️ WYLACZNIE OFERTY ALLEGRO — patrz komentarz przy trasie
    // `POST /magazyn/:id/powiaz`.
    const zrodloFiltrow = bladPowiazania ? req.body : req.query;
    const filtry = { fraza: napis(zrodloFiltrow?.fraza), kanal: kanalAllegro(zrodloFiltrow?.kanal) };
    const szukamy = Boolean(filtry.fraza || filtry.kanal);
    const oferty = niepowiazaneOfertyAllegro(db, kanalyAllegro);

    // ⚠️⚠️ SZUKANIE ZASTEPUJE PODPOWIEDZI, a nie doklada sie do nich. Tytuly na Allegro sa
    // SPRZEDAZOWE, wiec podpowiedz trafia w mniejszosc przypadkow
    // („Lampa stołowa Grzybek - DUŻA lampka nocna do sypialni" wobec „Lampa Grzybek – 30cm") —
    // i wlasnie wtedy czlowiek siega po fraze. Podpowiedzi domieszane do wynikow znaczylyby,
    // ze wyszukiwarka oddaje takze to, o co nikt nie pytal.
    const szukane = filtry.fraza ? filtry.fraza.toLowerCase() : null;
    const kandydaci = szukamy
      ? oferty
          .filter((o) => !filtry.kanal || o.kanal === filtry.kanal)
          .filter(
            (o) =>
              !szukane ||
              String(o.nazwa ?? '')
                .toLowerCase()
                .includes(szukane),
          )
          .map((o) => kandydatKarty(o, null, definicje))
      : // ⚠️⚠️ TA SAMA REGULA, CO NA EKRANIE POWIAZAN — zadana z drugiej strony (rozstrzygniecie
        // kontrolera 1). Zadnej wlasnej miary podobienstwa w tym pliku nie ma i byc nie moze:
        // dwie kopie rozjechalyby sie przy pierwszej poprawce, a wtedy karta podsuwalaby inna
        // oferte niz ekran obok. Podpowiedz NICZEGO NIE WIAZE — wiaze klikniecie.
        propozycjeOfert(karta, oferty, { ile: ILE_PODPOWIEDZI }).map((p) => kandydatKarty(p.oferta, p, definicje));

    // Pozycje pola wyboru kategorii glownej: to, co karta ma dzis, PLUS komplet kategorii
    // powiazanych produktow. ⚠️ Wybor ma byc SWIADOMY (stad komplet obok kazdego produktu),
    // ale nie moze zgubic wartosci juz ustawionej — inaczej zapis czegokolwiek innego
    // kasowalby kategorie po cichu, bo pole wyboru nie mialoby jej wsrod pozycji.
    // Do tego dochodzi słownik kategorii (strona Magazyn → Kategorie); nazwy sklepu bez encji HTML.
    const kategorie = [
      ...new Set([
        ...(karta.kategoria_glowna ? [karta.kategoria_glowna] : []),
        ...nazwySlownika(db, 'kategorie'),
        ...produkty.flatMap((p) => p.kategorie).map(dekodujEncje),
      ]),
    ].sort((a, b) => a.localeCompare(b, 'pl'));
    const marki = [...new Set([...(karta.marka ? [karta.marka] : []), ...nazwySlownika(db, 'marki')])].sort((a, b) =>
      a.localeCompare(b, 'pl'),
    );

    // Wartosci POL formularza. Po odmowie wygrywa to, co czlowiek WPISAL — inaczej traci
    // wszystko, co wstukal w pozostalych polach, i wpisuje od nowa.
    const dzis = dzienWarszawa(new Date().toISOString());
    const zBazy = {
      nazwa: karta.nazwa ?? '',
      sku: karta.sku ?? '',
      ean: karta.ean ?? '',
      cena_zl: Number.isSafeInteger(karta.cena_gr) ? zl(karta.cena_gr) : '',
      stawka_vat: karta.stawka_vat ?? '',
      cena_zakupu_netto: '',
      cena_zakupu_od: dzis,
      kategoria_glowna: karta.kategoria_glowna ?? '',
      kategoria_glowna_nowa: '',
      marka: karta.marka ?? '',
      marka_nowa: '',
      opis: karta.opis ?? '',
    };
    const wartosci = Object.create(null);
    for (const klucz of Object.keys(zBazy)) {
      const wpisane = blad ? pole(req.body, klucz) : null;
      wartosci[klucz] = wpisane === null ? zBazy[klucz] : wpisane;
    }

    const mozeZmieniacSprzedaz = req.konto?.admin === true;
    const potwierdzWycofanie = mozeZmieniacSprzedaz && karta.wycofana !== 1 && req.query?.wycofaj === 'tak';
    const allegroKarty = daneAllegroKarty(db, karta, kontaAllegro);
    return reply.code(kod).view('magazyn-karta.ejs', {
      szerokosc: 'tabela',
      ...danePrezentacjiKarty(db, karta.id, definicje, req.query?.tresc),
      galeriaKarty: daneGalerii(db, karta.id, definicje),
      sprzedazKanalow: daneSprzedazyKarty(db, karta.id, wierszeLustra, ofertyKarty, definicje, adresSklepu),
      ofertyKanalu: ofertyKarty.map((o) => ({
        ...o,
        kontoErli: kontaErli().some((k) => k.klucz === o.kanal),
        kontoAllegro: kontaAllegro().some((k) => k.klucz === o.kanal),
        wznow: mozeWznowic(o) && kontaAllegro().some((k) => k.klucz === o.kanal && k.zgoda !== false),
        ...opisOfertyKarty(db, o, kontaAllegro(), kontaErli()),
      })),
      mozeEdytowacOferty: req.konto?.admin === true,
      mozeZmieniacSprzedaz,
      wycofanieSprzedazy: potwierdzWycofanie ? ofertyDoZakonczenia(db, ofertyKarty, kontaAllegro(), kontaErli()) : null,
      usuniecieOferty: mozeZmieniacSprzedaz ? ofertaDoUsuniecia(ofertyKarty, req.query, kontaAllegro()) : null,
      usunietoOferte: usunietaOferta(db, karta.id, req.query),
      allegroKarty,
      gpsrKarty: daneGpsrKarty(db, karta, kontaAllegro, gpsr),
      parametryKarty: daneParametrowKarty(db, karta.id, {
        konto: req.konto,
        edytuj: edytujParam === 'parametry',
        blad: parametry?.blad ?? null,
        body: parametry?.body ?? null,
        stale: {
          wymiary: opisWymiarow(karta),
          waga: kilogramyZGramow(karta.waga_g),
          wartosci: {
            szerokosc_cm: centymetryZMilimetrow(karta.szerokosc_mm),
            wysokosc_cm: centymetryZMilimetrow(karta.wysokosc_mm),
            glebokosc_cm: centymetryZMilimetrow(karta.glebokosc_mm),
            waga_kg: kilogramyZGramow(karta.waga_g),
          },
        },
        adresy: {
          adresEdycji: adresKarty(karta.id, { edytuj: 'parametry', wroc }) + '#parametry-karty',
          adresZapisu: zWroc(`/magazyn/${karta.id}/parametry`, wroc),
          adresAnuluj: adresKarty(karta.id, { wroc }),
        },
      }),
      cennikiKarty: daneCennikowKarty(db, karta, { kontaAllegro, kontaErli, definicje }),
      title: `Magazyn — ${karta.nazwa}`,
      okruszki: [{ tekst: 'Magazyn', href: '/magazyn' }, { tekst: karta.nazwa }],
      karta: {
        id: karta.id,
        wycofana: karta.wycofana === 1,
        nazwa: karta.nazwa,
        sku: karta.sku || null,
        // Milimetry → „70 × 100 cm" liczy domena, nie widok (domena/rozmiar.js).
        wymiary: opisWymiarow(karta),
        kategoria: karta.kategoria_glowna || null,
        marka: karta.marka || null,
        opis: karta.opis || null,
        waga: kilogramyZGramow(karta.waga_g),
        // Grosze w bazie → „12,34 zł" na ekranie.
        ean: karta.ean || null,
        cena: Number.isSafeInteger(karta.cena_gr) ? zlotowki(zl(karta.cena_gr)) : null,
        stawkaVat: karta.stawka_vat || null,
      },
      stawkiVat: STAWKI_VAT,
      ...daneCenyZakupu(db, karta.id, dzis, req.query?.['usun-cene'], wroc),
      blednaDataCenyZakupu: blad && wartosci.cena_zakupu_od && Boolean(dzienZNapisu(wartosci.cena_zakupu_od).blad),
      opisKarty: daneOpisu(db, karta.id, req.opisFormularz),
      // Stan magazynowy — `null`, gdy stany są wyłączone (sekcji na karcie wtedy nie ma).
      stanMagazynowy: stanMagazynowyKarty(karta, bladRuchu, req.body, req.query),
      produkty,
      kandydaci,
      kategorie,
      marki,
      edytujDane,
      blad,
      bladPowiazania,
      przypietoOferte: kod === 200 && req.query?.przypieto === 'tak',
      zapisanoBezpieczenstwo: kod === 200 && req.query?.zapisano === 'bezpieczenstwo',
      wartosci,
      szukamy,
      filtry,
      // Formularz szukania niesie UKRYTYM POLEM otwarta sekcje edycji i
      // adres powrotu. ⚠️ `wroc` MUSI byc TU, nie tylko w adresie akcji formularza: submit
      // formularza GET WYRZUCA query string z `action` i skleja nowy WYLACZNIE z named pol
      // (ten sam powod, dla ktorego tu juz stoi `edytuj`) — bez ukrytego pola szukanie
      // oferty cichaczem gubiloby powrot.
      ukryteWSzukajce: [
        ...(edytujDane ? [{ name: 'edytuj', value: 'dane' }] : []),
        ...(wroc ? [{ name: 'wroc', value: wroc }] : []),
      ],
      adresPowrotu,
      adresKarty: adresKarty(karta.id, { wroc }),
      adresPotwierdzeniaWycofania: adresKarty(karta.id, { wycofaj: true, wroc }),
      adresEdycji:
        adresKarty(karta.id, {
          fraza: filtry.fraza,
          kanal: filtry.kanal,
          edytuj: 'dane',
          wroc,
        }) + '#dane-karty',
      // ⚠️⚠️ PUŁAPKA SKLEJANIA: te dwa formularze doklejaly `/odepnij` i `/powiaz` PO gotowym
      // `adresKarty` (`<%= adresKarty %>/odepnij`). Skoro `adresKarty` moze dzis niesc
      // `?wroc=…`, naiwne doklejenie wsadzaloby ten dopisek W SRODEK wartosci parametru
      // zamiast za nim (query string ma prawo stac WYLACZNIE na koncu adresu) — trasa
      // `/magazyn/:id/odepnij` nigdy by nie trafiła. Dlatego licza sie OSOBNO, tutaj,
      // z tym samym `wroc`.
      adresOdepnij: zWroc(`/magazyn/${karta.id}/odepnij`, wroc),
      adresPowiaz: zWroc(`/magazyn/${karta.id}/powiaz`, wroc),
      kanalyDoFiltra: kanalyAllegro.map((klucz) => ({ klucz, etykieta: adresKanalu(klucz, definicje) })),
    });
  }

  // Stan, historia i formularz ruchu. Klucz idempotencji powstaje przy RENDERZE formularza: drugie kliknięcie
  // tego samego formularza niesie ten sam klucz i ruch nie wchodzi drugi raz (ruchy_magazynowe.klucz UNIQUE).
  function stanMagazynowyKarty(karta, bladRuchu, body, query) {
    const { id: kartaId, prog_niskiego_stanu: prog } = karta;
    const stan = stanKarty(db, kartaId);
    if (!stan) return null;
    const klasa = klasaStanu(stan.stan, prog);
    return {
      ...stan,
      prog,
      naMinusie: klasa === 'minus',
      plakietka: czyPonizejProgu(stan.stan, prog) ? `niski stan (${stan.stan} ≤ ${prog})` : null,
      adresProgu: `/magazyn/${kartaId}/prog-stanu`,
      zapisanoProg: query?.zapisano === 'prog-stanu',
      historia: historiaKarty(db, kartaId)
        .slice(0, 30)
        .map((w) => ({
          kiedy: fmtDataCzas(w.utworzono_at),
          co:
            w.typ === 'zamowienie'
              ? `zamówienie ${w.numer}`
              : w.typ === 'przepiecie'
                ? 'przepięcie oferty'
                : ETYKIETY_RUCHU[w.rodzaj],
          adres: w.typ === 'zamowienie' ? `/zamowienia/${w.zamowienie_id}` : null,
          // Ślad przepięcia sam nie zmienia stanu — zamówienia przechodzą z ofertą i stoją we własnych wierszach.
          ilosc: w.typ === 'przepiecie' ? '—' : w.ilosc > 0 ? `+${w.ilosc}` : String(w.ilosc),
          kto: w.konto_login ?? null,
          powod: w.powod ?? null,
        })),
      klucz: randomBytes(12).toString('hex'),
      adresRuchu: `/magazyn/${kartaId}/ruch`,
      blad: bladRuchu,
      powtorzony: query?.ruch === 'powtorzony',
      wpisane: bladRuchu
        ? { rodzaj: String(body?.rodzaj ?? ''), ilosc: String(body?.ilosc ?? ''), powod: String(body?.powod ?? '') }
        : null,
    };
  }

  return { ekranKarty, brakKarty, statusy };
}

// ——— sekcja „Allegro” karty ————————————————————————————————————————————
// Braki liczy `ofertaAllegroKarty` (bez konta). Tu tylko: skąd kategoria i parametry, formularz nadpisań
// w `karty_allegro` i wybór produktu przy problemie oferty.
const ID_KATEGORII_ALLEGRO = /^[0-9A-Za-z-]{1,64}$/;
const PRZEDROSTEK_PARAMETRU = 'parametr:';
const idTekst = (v) => (v == null ? null : napis(String(v)));
const TYPY_LICZBOWE = new Set(['integer', 'float']);

function jsonLubNull(surowe) {
  if (typeof surowe !== 'string' || !surowe) return null;
  try {
    return JSON.parse(surowe);
  } catch {
    return null;
  }
}
/**
 * Nagłówek oferty i zdanie, na co czeka — z kont tych samych co pętle ofert.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('../../oms/db/oferty-kanalow.ts').OfertaKanalu} o
 * @param {readonly {klucz:string, nazwa?:string, zgoda?:boolean, tylkoOdczyt?:() => boolean}[]} kontaAllegro
 * @param {readonly {klucz:string, nazwa?:string}[]} kontaErli
 */
function opisOfertyKarty(db, o, kontaAllegro, kontaErli) {
  const allegro = kontaAllegro.find((k) => k.klucz === o.kanal);
  const erli = allegro ? null : kontaErli.find((k) => k.klucz === o.kanal);
  const rodzaj = allegro ? 'allegro' : erli ? 'erli' : null;
  const konto = allegro ?? erli ?? null;
  return {
    naglowek: naglowekOferty({ rodzaj, konto, oferta: o }),
    czeka: rodzaj
      ? zdanieCzekaniaOferty({
          rodzaj,
          konto,
          ustawienia: ustawieniaOfertKonta(db, o.kanal),
          oferta: o,
          teraz: Date.now(),
        })
      : null,
  };
}
/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {readonly {klucz:string, zgoda?:boolean, tylkoOdczyt?:() => boolean}[]} konta
 */
function kontaWstrzymaneWycofania(db, konta) {
  return konta
    .filter((k) => !ustawieniaOfertKonta(db, k.klucz).czynne || k.tylkoOdczyt?.() === true || k.zgoda === false)
    .map((k) => k.klucz)
    .sort();
}

/**
 * Licznik i ostrzeżenie opierają się na tym samym zestawie ofert zarejestrowanych do obsługi w pętlach.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {readonly import('../../oms/db/oferty-kanalow.ts').OfertaKanalu[]} oferty
 * @param {readonly {klucz:string, zgoda?:boolean, tylkoOdczyt?:() => boolean}[]} kontaAllegro
 * @param {readonly {klucz:string, tylkoOdczyt?:() => boolean}[]} kontaErli
 */
function ofertyDoZakonczenia(db, oferty, kontaAllegro, kontaErli) {
  const konta = [...kontaAllegro, ...kontaErli];
  const kluczeKont = new Set(konta.map((k) => k.klucz));
  const kluczeErli = new Set(kontaErli.map((k) => k.klucz));
  const wystawione = oferty.filter(
    (o) =>
      kluczeKont.has(o.kanal) &&
      o.tryb === 'zarzadzana' &&
      (kluczeErli.has(o.kanal)
        ? STANY_SYNCHRONIZACJI_ERLI.includes(o.stan) && !czyKonfliktErli(o) && !zamrozone(o.odczytZamrozone, 'status')
        : STANY_SYNCHRONIZACJI_ALLEGRO.includes(o.stan)) &&
      o.idZewnetrzne &&
      !o.idZewnetrzne.startsWith('ext:') &&
      !['ENDED', 'INACTIVE', 'inactive'].includes(o.odczytStatus ?? '') &&
      !o.odczytZarchiwizowana &&
      !o.wyslanePola?.wycofanoAt,
  );
  const kontaOfert = new Set(wystawione.map((o) => o.kanal));
  const wstrzymane = new Set(
    kontaWstrzymaneWycofania(
      db,
      konta.filter((k) => kontaOfert.has(k.klucz)),
    ),
  );
  return {
    liczba: wystawione.filter((o) => !wstrzymane.has(o.kanal)).length,
    kontaWstrzymane: [...wstrzymane],
  };
}

/** Środowisko sekcji „Allegro”: konto produkcyjne, gdy jest; inaczej pierwsze konto (brak kont → produkcja). */
export function srodowiskoAllegro(kontaAllegro) {
  const konta = kontaAllegro();
  const konto = konta.find((k) => k?.srodowisko === 'produkcja') ?? konta[0];
  return konto?.srodowisko === 'sandbox' ? 'sandbox' : 'produkcja';
}

function kontaSrodowiskaAllegro(db, srodowisko) {
  try {
    return db
      .prepare("SELECT klucz FROM kanaly_sprzedazy WHERE typ = 'allegro' AND srodowisko = ?")
      .all(srodowisko)
      .map((w) => String(w.klucz));
  } catch {
    return [];
  } // baza bez modułu kanałów
}

/** Najświeższy opis kategorii wersji 2 z pamięci kont środowiska (ten sam zapis, który czyta `ofertaAllegroKarty`). */
function opisKategoriiAllegro(db, kategoria, konta) {
  if (!kategoria) return null;
  const wiersze = db
    .prepare(
      'SELECT polaczenie, sciezka_json, parametry_json FROM kanaly_kategorie WHERE kategoria_id = ? ORDER BY pobrano_at DESC',
    )
    .all(kategoria);
  for (const w of wiersze) {
    if (konta.length && !konta.includes(String(w.polaczenie))) continue;
    const zapis = jsonLubNull(w.parametry_json);
    if (!zapis || Array.isArray(zapis) || zapis.wersja !== WERSJA_OPISU_KATEGORII) continue;
    const sciezka = jsonLubNull(w.sciezka_json);
    return {
      lisc: zapis.lisc ?? null,
      nazwa: Array.isArray(sciezka) ? napis(sciezka.at(-1)?.nazwa) : null,
      parametry: Array.isArray(zapis.parametry) ? zapis.parametry.filter((p) => idTekst(p?.id)) : [],
    };
  }
  return null;
}

/** Stan Allegro karty z bazy: nadpisania, import i kategoria skuteczna (kolejność: nadpisanie → import → mapa). */
function stanAllegroKarty(db, karta, srodowisko) {
  const konta = kontaSrodowiskaAllegro(db, srodowisko);
  const ka =
    db
      .prepare('SELECT nazwa, kategoria_id, parametry_json, produkt_id FROM karty_allegro WHERE karta_id = ?')
      .get(karta.id) ?? null;
  const imp = db
    .prepare(
      "SELECT polaczenie, kategoria_id, parametry_json FROM karty_dane_kanalu WHERE karta_id = ? AND typ_kanalu = 'allegro'",
    )
    .get(karta.id);
  const zImportu = imp && (!konta.length || konta.includes(String(imp.polaczenie))) ? imp : null;
  const zMapy = napisMapy(db, karta, srodowisko);
  const kategoriaZImportu = idTekst(zImportu?.kategoria_id);
  const [kategoria, skad] = idTekst(ka?.kategoria_id)
    ? [idTekst(ka.kategoria_id), 'nadpisanie']
    : kategoriaZImportu
      ? [kategoriaZImportu, 'import']
      : zMapy
        ? [zMapy, 'mapa']
        : [null, null];
  const parametry = jsonLubNull(ka?.parametry_json);
  return {
    ka,
    konta,
    kategoria,
    skad,
    kategoriaZImportu,
    zImportu,
    nadpisane: Array.isArray(parametry) ? parametry : [],
  };
}

const pierwszaWartosc = (p) =>
  String(p?.valuesIds?.[0] ?? p?.values?.[0] ?? (p?.rangeValue ? `${p.rangeValue.from}–${p.rangeValue.to}` : ''));
const SKAD_KATEGORII = {
  nadpisanie: 'nadpisana na karcie',
  import: 'z importu oferty Allegro',
  mapa: 'z mapy kategorii',
};

/** Wartość parametru w postaci żądania Allegro → tekst do tabeli (id ze słownika zamienione na nazwy). */
const tekstParametru = (w, slownik) => {
  if (w?.valuesIds?.length)
    return w.valuesIds
      .map((v) => napis(slownik?.find((o) => String(o.id) === String(v))?.wartosc) || String(v))
      .join(', ');
  if (w?.values?.length) return w.values.map(String).join(', ');
  return w?.rangeValue ? `${w.rangeValue.from}–${w.rangeValue.to}` : '';
};

/** Dane widoku `_karta-allegro.ejs`. */
export function daneAllegroKarty(db, karta, kontaAllegro) {
  const srodowisko = srodowiskoAllegro(kontaAllegro);
  const s = stanAllegroKarty(db, karta, srodowisko);
  const wynik = ofertaAllegroKarty(db, karta.id, null, { srodowisko });
  const opis = opisKategoriiAllegro(db, s.kategoria, s.konta);
  const reguly = new Map(
    db
      .prepare(
        `SELECT parametr_id, rodzaj, pole FROM allegro_reguly_parametrow
    WHERE srodowisko = ? AND kategoria_allegro_id = ?`,
      )
      .all(srodowisko, s.kategoria)
      .map((r) => [String(r.parametr_id), r]),
  );
  const nadpisane = new Map(s.nadpisane.map((p) => [idTekst(p?.id), p]));
  const importParametry = jsonLubNull(s.zImportu?.parametry_json);
  const zImportu = new Set(
    s.kategoria && s.kategoria === s.kategoriaZImportu
      ? [...(importParametry?.produkt ?? []), ...(importParametry?.oferta ?? [])].map((p) => idTekst(p?.id))
      : [],
  );
  // Słownika marek (setki wartości) opis kategorii nie trzyma — nazwę wartości marki karty daje mapa marek.
  const markaKarty = napis(karta.marka);
  const mapaMarki = markaKarty
    ? db
        .prepare('SELECT wartosc_id, wartosc_tekst FROM allegro_marki WHERE srodowisko = ? AND marka = ?')
        .get(srodowisko, markaKarty)
    : null;
  const wartoscMarki = napis(mapaMarki?.wartosc_id)
    ? [{ id: napis(mapaMarki.wartosc_id), wartosc: napis(mapaMarki.wartosc_tekst) || markaKarty }]
    : null;
  const parametry = [];
  for (const p of opis?.parametry ?? []) {
    const id = idTekst(p.id);
    const r = reguly.get(id);
    const wymagany = Boolean(p.wymagany || p.wymaganyDlaProduktu);
    if (!wymagany && !r && !nadpisane.has(id) && !zImportu.has(id)) continue;
    const skad = nadpisane.has(id)
      ? 'nadpisane na karcie'
      : zImportu.has(id)
        ? 'z importu oferty Allegro'
        : r?.rodzaj === 'stala'
          ? 'reguła kategorii: stała wartość'
          : r?.rodzaj === 'pole'
            ? `reguła kategorii: pole karty „${r.pole}”`
            : r?.rodzaj === 'na_karcie'
              ? 'uzupełnij na karcie'
              : id === PARAMETR_STAN
                ? 'domyślnie „Nowy”'
                : 'brak źródła';
    // Wartość, którą dostanie oferta, liczy domena (nadpisanie → import → reguła → „Nowy”) — tabela jej nie zgaduje.
    const wyliczona = wynik.parametryWyliczone?.get(id);
    const slownik = Array.isArray(p.slownik) && p.slownik.length ? p.slownik : null;
    const wartosc = wyliczona?.zKatalogu
      ? 'z produktu w Katalogu Allegro'
      : tekstParametru(wyliczona?.wartosc, slownik ?? wartoscMarki);
    parametry.push({
      id,
      nazwa: napis(p.nazwa) || id,
      wymagany,
      skad,
      wartosc,
      // Pole formularza pokazuje tylko nadpisanie: wpisana tam wartość reguły zamieniłaby regułę w nadpisanie.
      nadpisanie: pierwszaWartosc(nadpisane.get(id)),
      teraz: nadpisane.has(id) ? '' : wartosc,
      slownik,
      // Parametr produktu z Katalogu domena pomija — nadpisanie i tak by nie poszło, więc bez pola.
      edytowalny: !wyliczona?.zKatalogu,
    });
  }
  const nazwa = idTekst(s.ka?.nazwa);
  const problemy = [];
  for (const o of db
    .prepare("SELECT id, kanal, problemy_json FROM oferty_kanalow WHERE karta_id = ? AND stan = 'problem' ORDER BY id")
    .all(karta.id)) {
    for (const p of jsonLubNull(o.problemy_json) ?? []) {
      const kandydaci = kandydaciProduktu(p);
      if (kandydaci.length)
        problemy.push({ ofertaId: o.id, konto: o.kanal, kod: p.kod, parametr: napis(p.parametr) || null, kandydaci });
    }
  }
  return {
    srodowisko,
    nazwa: nazwa ?? '',
    nazwaKarty: karta.nazwa,
    dlugosc: dlugoscNazwyAllegro(nazwa || napis(karta.nazwa) || ''),
    limit: LIMIT_NAZWY,
    kategoria: s.kategoria,
    nazwaKategorii: opis?.nazwa || null,
    skadKategorii: s.skad ? SKAD_KATEGORII[s.skad] : null,
    wyjatek: idTekst(s.ka?.kategoria_id) ?? '',
    opisPobrany: Boolean(opis),
    parametry,
    produktId: idTekst(s.ka?.produkt_id),
    droga: wynik.droga,
    bledy: wynik.bledy,
    ostrzezenia: wynik.ostrzezenia,
    problemy,
  };
}

/** Kandydaci do wyboru z problemu oferty (kształt `PROBLEMY_ALLEGRO`). */
function kandydaciProduktu(p) {
  if (p?.kod === 'wiele-produktow' && Array.isArray(p.produkty)) {
    return p.produkty
      .filter((x) => idTekst(x?.id))
      .map((x) => ({ id: idTekst(x.id), nazwa: napis(x.nazwa) || idTekst(x.id), ean: idTekst(x.ean) }));
  }
  if (p?.kod === 'parameter-mismatch' && idTekst(p.produktId))
    return [{ id: idTekst(p.produktId), nazwa: idTekst(p.produktId), ean: null }];
  return [];
}

function transakcjaKarty(db, wykonaj) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const wynik = wykonaj();
    db.exec('COMMIT');
    return wynik;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
function zapiszKarteAllegro(db, kartaId, zmiany, pola, teraz) {
  db.prepare(`INSERT INTO karty_allegro (karta_id, zmieniono_at) VALUES (?, ?) ON CONFLICT (karta_id) DO NOTHING`).run(
    kartaId,
    teraz,
  );
  for (const [kolumna, wartosc] of Object.entries(zmiany)) {
    db.prepare(`UPDATE karty_allegro SET ${kolumna} = ?, zmieniono_at = ? WHERE karta_id = ?`).run(
      wartosc,
      teraz,
      kartaId,
    );
  }
  for (const pole of pola) {
    db.prepare(
      `INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at) VALUES (?, ?, 'reczne', 1, ?)
      ON CONFLICT (karta_id, pole) DO UPDATE SET zrodlo = 'reczne', reczne = 1, zmieniono_at = excluded.zmieniono_at`,
    ).run(kartaId, pole, teraz);
  }
}

/** Formularz sekcji → zmiany `karty_allegro` albo tekst odmowy. Pole nieobecne w formularzu zostaje bez zmian. */
function zmianyAllegroZFormularza(db, karta, body, srodowisko) {
  const s = stanAllegroKarty(db, karta, srodowisko);
  const zmiany = {};
  const pola = [];
  const nazwaWpisana = pole(body, 'nazwa');
  if (nazwaWpisana !== null) {
    const nazwa = napis(nazwaWpisana);
    const dlugosc = nazwa ? dlugoscNazwyAllegro(nazwa) : 0;
    if (dlugosc > LIMIT_NAZWY) {
      return {
        blad: `Nazwa dla Allegro ma ${dlugosc} znaków po zamianie encji (& liczy się jak 5) — dozwolone najwyżej ${LIMIT_NAZWY}.`,
      };
    }
    if (nazwa !== idTekst(s.ka?.nazwa)) {
      zmiany.nazwa = nazwa;
      pola.push('allegro:nazwa');
    }
  }
  let kategoria = s.kategoria;
  const kategoriaWpisana = pole(body, 'kategoria');
  if (kategoriaWpisana !== null) {
    const wyjatek = napis(kategoriaWpisana);
    if (wyjatek !== null && !ID_KATEGORII_ALLEGRO.test(wyjatek)) {
      return { blad: `„${wyjatek}” nie jest numerem kategorii Allegro — wpisz sam numer, np. 257.` };
    }
    if (wyjatek !== idTekst(s.ka?.kategoria_id)) {
      zmiany.kategoria_id = wyjatek;
      pola.push('allegro:kategoria');
      kategoria = wyjatek ?? (s.kategoriaZImportu || napisMapy(db, karta, srodowisko));
    }
  }
  const wpisane = Object.keys(body ?? {}).filter((k) => k.startsWith(PRZEDROSTEK_PARAMETRU));
  if (wpisane.length || 'kategoria_id' in zmiany) {
    const opis = opisKategoriiAllegro(db, kategoria, s.konta);
    // Formularz wysyła też puste pola parametrów starej kategorii — pusta wartość tylko zdejmuje nadpisanie.
    if (wpisane.some((k) => napis(pole(body, k)) !== null) && !opis) {
      return {
        blad: `Nie ma pobranego opisu kategorii Allegro ${kategoria ?? '(brak kategorii)'} — pobierz go w Magazyn → Kategorie, potem uzupełnij parametry.`,
      };
    }
    const wKategorii = new Map((opis?.parametry ?? []).map((p) => [idTekst(p.id), p]));
    const nowe = new Map(
      (opis ? s.nadpisane.filter((p) => wKategorii.has(idTekst(p?.id))) : s.nadpisane).map((p) => [idTekst(p?.id), p]),
    );
    for (const klucz of wpisane) {
      const id = klucz.slice(PRZEDROSTEK_PARAMETRU.length);
      const wartosc = napis(pole(body, klucz));
      if (wartosc === null) {
        nowe.delete(id);
        continue;
      }
      const p = wKategorii.get(id);
      if (!p)
        return {
          blad: `Parametr ${id} nie należy do kategorii Allegro ${kategoria} — odśwież kartę i wybierz parametr z listy.`,
        };
      if (Array.isArray(p.slownik) && p.slownik.length) {
        if (!p.slownik.some((w) => String(w?.id) === wartosc))
          return { blad: `Wartość spoza listy Allegro dla parametru „${napis(p.nazwa) || id}”.` };
        nowe.set(id, { id, valuesIds: [wartosc] });
      } else {
        if (TYPY_LICZBOWE.has(p.typ) && !Number.isFinite(Number(wartosc.replace(',', '.')))) {
          return { blad: `Parametr „${napis(p.nazwa) || id}” przyjmuje liczbę.` };
        }
        nowe.set(id, { id, values: [TYPY_LICZBOWE.has(p.typ) ? wartosc.replace(',', '.') : wartosc] });
      }
    }
    const json = JSON.stringify([...nowe.values()]);
    if (json !== JSON.stringify(s.nadpisane)) {
      zmiany.parametry_json = json;
      pola.push('allegro:parametry');
    }
  }
  return { zmiany, pola };
}
function napisMapy(db, karta, srodowisko) {
  const glowna = napis(karta.kategoria_glowna);
  return glowna
    ? idTekst(
        db
          .prepare(
            'SELECT kategoria_allegro_id FROM allegro_mapa_kategorii WHERE srodowisko = ? AND kategoria_karty = ?',
          )
          .get(srodowisko, glowna)?.kategoria_allegro_id,
      )
    : null;
}

const BLAD_CENNIKA_OMS = 'Wybierz cennik OMS z listy.';
const POLE_CENNIKA_KONTA = 'cennik_konta_';
const DOPISEK_SPOZA_LISTY = '(nie ma już na liście konta)';

/**
 * Sekcja „Cennik dostaw” karty: opcjonalny cennik OMS karty i na każde bieżące konto Allegro i ERLI własny wybór
 * cennika z pobranej listy konta. „Teraz” to cennik, który karta dostaje (ten sam dobór co podgląd „Wystaw na…”),
 * albo odmowa doboru. Wybór konta wygrywa z cennikiem OMS, a ten działa tylko na kontach z powiązaniem.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} karta wiersz `karty_produktow`
 * @param {{ kontaAllegro: () => readonly {klucz:string}[], kontaErli: () => readonly {klucz:string}[], definicje: readonly {klucz:string;etykieta?:string}[] }} opcje
 */
export function daneCennikowKarty(db, karta, { kontaAllegro, kontaErli, definicje }) {
  const opcje = opcjeCennikowOms(db);
  const wybor = String((maCennikiOms(db) ? cennikOmsKarty(db, karta.id)?.cennikId : null) ?? '');
  const konta = kontaZCennikami(db, { kontaAllegro: kontaAllegro(), kontaErli: kontaErli(), definicje }).map(
    (konto) => {
      const ustawienia = ustawieniaOfertKonta(db, konto.klucz);
      const zrodlo = zrodloWyjatkuCennika(db, { kartaId: karta.id, konto: konto.klucz });
      const wyjatek = wyjatekCennika(db, { kartaId: karta.id, konto: konto.klucz }) ?? '';
      const dobor = odmowaDlaKonta(
        konto,
        dobierzCennik({ karta, reguly: regulyKonta(ustawienia), wyjatek, nazwaWyjatku: zrodlo }),
      );
      // Wybór konta (nie cennik OMS) — to on trafia do pola; zapisany, a nieobecny na liście, zostaje z dopiskiem.
      const wybranyNaKoncie = zrodlo?.rodzaj === 'konto' ? wyjatek : '';
      const opcjeKonta = konto.cenniki ? konto.cenniki.map((p) => ({ wartosc: p.wartosc, nazwa: p.nazwa })) : null;
      if (opcjeKonta && wybranyNaKoncie && !nazwaCennikaKonta(konto, wybranyNaKoncie))
        opcjeKonta.push({ wartosc: wybranyNaKoncie, nazwa: `${wybranyNaKoncie} ${DOPISEK_SPOZA_LISTY}` });
      return {
        klucz: konto.klucz,
        pole: `${POLE_CENNIKA_KONTA}${konto.klucz}`,
        etykieta: konto.etykieta,
        opcje: opcjeKonta,
        wybrany: wybranyNaKoncie,
        nazwaWybranego: wybranyNaKoncie
          ? (nazwaCennikaKonta(konto, wybranyNaKoncie) ?? `${wybranyNaKoncie} ${DOPISEK_SPOZA_LISTY}`)
          : null,
        teraz: opisDostawy(ustawienia, konto.rodzaj, dobor, karta, zrodlo),
        odmowa: dobor.odmowa?.tekst ?? null,
      };
    },
  );
  return { opcje, wybor, nazwaWyboru: opcje.find((o) => o.id === wybor)?.etykieta ?? null, konta };
}

class BladCennikaKarty extends Error {}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {object} opcje
 * @param {import('node:sqlite').DatabaseSync} opcje.db
 * @param {unknown} opcje.magazyn — karta sprawdza tylko dostępność usługi, nie wywołuje jej metod
 * @param {readonly {klucz:string;etykieta?:string}[]} opcje.definicje
 * @param {string[]} opcje.kanalyAllegro
 * @param {() => readonly {klucz:string, cennikiDostaw?: readonly string[] | null}[]} [opcje.kontaErli]
 * @param {() => readonly {klucz:string, zgoda?:boolean, tylkoOdczyt?:() => boolean}[]} [opcje.kontaAllegro]
 * @param {Map<number, string>} [opcje.komunikatyNowychKart]
 * @param {Record<string, any>} [opcje.sklepy] — klienci Woo po kluczu kanału (kolumna Status)
 * @param {(db: any, karta: any, body: any) => { zmiany: any, blad?: string | null }} [opcje.zmianyZFormularza] — z pomocników magazynu
 */
export function registerKartaMagazynu(
  app,
  {
    db,
    magazyn,
    komunikatyNowychKart,
    kanalyAllegro,
    definicje,
    kontaErli = /** @returns {{ klucz: string }[]} */ () => [],
    kontaAllegro = /** @returns {{ klucz: string }[]} */ () => [],
    sklepy = {},
    zmianyZFormularza = () => {
      throw new Error('Zapis parametrów karty wymaga zmianyZFormularza z pomocników magazynu');
    },
  },
) {
  const { ekranKarty, brakKarty, statusy } = createKartaMagazynu({
    db,
    kanalyAllegro,
    definicje,
    kontaErli,
    kontaAllegro,
    sklepy,
  });
  registerStatusWKanale(app, { db, magazyn, statusy, ekranKarty, brakKarty, bezSklepow: BEZ_SKLEPOW });
  registerGpsrKarty(app, { db, magazyn, kontaAllegro, ekranKarty, brakKarty, bezSklepow: BEZ_SKLEPOW });
  registerParametryKarty(app, {
    db,
    zmianyZFormularza,
    magazyn,
    ekranKarty,
    brakKarty,
    bezSklepow: BEZ_SKLEPOW,
    transakcja: transakcjaKarty,
    adresPoZapisie: (id, wroc) => adresKarty(id, { wroc: bezpiecznyWroc(wroc) }),
  });
  app.get('/magazyn/:id', async (req, reply) => {
    if (!magazyn || magazyn.gotowy?.() === false) return reply.view('pusta-strona.ejs', BEZ_SKLEPOW);
    const karta = kartaPoId(db, req.params.id);
    if (!karta) return brakKarty(reply, req.params.id);
    // ⚠️ TA TRASA WYLACZNIE CZYTA. Podpowiedzi sa PROPOZYCJA — wejscie na karte nie wiaze
    // ani jednej oferty (to samo rozstrzygniecie, co na ekranie powiazan).
    const blad = req.query?.wynik === 'zdjecia' ? komunikatyNowychKart?.get(karta.id) : null;
    if (blad) komunikatyNowychKart.delete(karta.id);
    return ekranKarty(req, reply, { karta, blad });
  });

  // CSRF sprawdza wspólny hak panelu; zmiana sprzedaży wymaga flagi admina, jak akcje ofert.
  for (const akcja of ['wycofaj', 'przywroc'])
    app.post(`/magazyn/:id/${akcja}`, async (req, reply) => {
      const odmowa = (kod, tekst) =>
        stronaOdmowy(reply, kod, tekst, {
          tytul: 'Nie zmieniono sprzedaży karty',
          wroc: `/magazyn/${encodeURIComponent(req.params.id)}#naglowek-karty`,
          napisWroc: 'Wróć do karty',
        });
      if (req.konto?.admin !== true)
        return odmowa(403, 'Tylko administrator może wycofać lub przywrócić kartę do sprzedaży.');
      if (!magazyn || magazyn.gotowy?.() === false) return reply.view('pusta-strona.ejs', BEZ_SKLEPOW);
      const karta = kartaPoId(db, req.params.id);
      if (!karta) return brakKarty(reply, req.params.id);
      if (akcja === 'wycofaj' && pole(req.body, 'potwierdz') !== 'tak') {
        return odmowa(400, 'Potwierdź wycofanie karty ze sprzedaży w formularzu na karcie.');
      }
      zapiszKarte(db, karta.id, { wycofana: akcja === 'wycofaj' ? 1 : 0 });
      return reply.code(303).redirect(`/magazyn/${karta.id}#naglowek-karty`);
    });

  // Ruch ręczny (przyjęcie / korekta). Odmowa wraca na kartę z kodem 400 i tym, co wpisano.
  // Ten sam klucz drugi raz (podwójne kliknięcie) — przekierowanie jak po sukcesie, bez drugiego ruchu.
  app.post('/magazyn/:id/ruch', async (req, reply) => {
    if (!magazyn || magazyn.gotowy?.() === false) return reply.view('pusta-strona.ejs', BEZ_SKLEPOW);
    const karta = kartaPoId(db, req.params.id);
    if (!karta) return brakKarty(reply, req.params.id);
    if (!stanKarty(db, karta.id)) {
      return ekranKarty(req, reply, {
        karta,
        kod: 409,
        bladRuchu: 'Stany magazynowe są wyłączone — włącz je w Magazyn → Ustawienia → Stany magazynowe.',
      });
    }
    const { ruch, blad } = ruchZFormularza(req.body);
    if (blad) return ekranKarty(req, reply, { karta, kod: 400, bladRuchu: blad });
    const { dopisano } = dodajRuch(db, { kartaId: karta.id, ...ruch, konto: req.konto ?? null });
    // Powtórzony klucz (podwójne kliknięcie, cofnięcie w przeglądarce do starego formularza) — ruch NIE wszedł drugi raz
    // i ekran ma to powiedzieć, zamiast udawać zapis.
    return reply.code(303).redirect(`/magazyn/${karta.id}${dopisano ? '' : '?ruch=powtorzony'}#stan-karty`);
  });

  // Sekcja „Allegro”. CSRF i uprawnienie magazyn zapewniają wspólne haki panelu (jak galeria).
  const odmowaAllegro = (reply, id, kod, tekst) =>
    stronaOdmowy(reply, kod, tekst, {
      tytul: 'Nie zapisano danych dla Allegro',
      wroc: `/magazyn/${encodeURIComponent(id)}#allegro-karty`,
      napisWroc: 'Wróć do sekcji Allegro',
    });
  // Dane Allegro karty i wybór produktu zmienia tylko administrator — jak „Wystaw” i „Ponów”.
  const TYLKO_ADMIN_ALLEGRO = 'Tylko administrator może zmieniać dane Allegro tej karty.';
  app.post('/magazyn/:id/allegro', async (req, reply) => {
    if (!magazyn || magazyn.gotowy?.() === false) return reply.view('pusta-strona.ejs', BEZ_SKLEPOW);
    if (req.konto?.admin !== true) return odmowaAllegro(reply, req.params.id, 403, TYLKO_ADMIN_ALLEGRO);
    const karta = kartaPoId(db, req.params.id);
    if (!karta) return brakKarty(reply, req.params.id);
    const wynik = transakcjaKarty(db, () => {
      const w = zmianyAllegroZFormularza(db, karta, req.body, srodowiskoAllegro(kontaAllegro));
      if (!w.blad && w.pola.length) zapiszKarteAllegro(db, karta.id, w.zmiany, w.pola, new Date().toISOString());
      return w;
    });
    if (wynik.blad) return odmowaAllegro(reply, karta.id, 400, wynik.blad);
    return reply.code(303).redirect(`/magazyn/${karta.id}#allegro-karty`);
  });

  // Cennik OMS karty. CSRF zapewnia wspólny hak panelu; zapis to prawo edycji magazynu (administrator), jak
  // „Wystaw na…” i dane Allegro karty. Pole nieprzysłane niczego nie zmienia, puste wraca do doboru po rozmiarze.
  const odmowaCennika = (reply, id, kod, tekst) =>
    stronaOdmowy(reply, kod, tekst, {
      tytul: 'Nie zapisano cennika dostaw',
      wroc: `/magazyn/${encodeURIComponent(id)}#cenniki-karty`,
      napisWroc: 'Wróć do karty',
    });
  app.post('/magazyn/:id/cenniki', async (req, reply) => {
    if (!magazyn || magazyn.gotowy?.() === false) return reply.view('pusta-strona.ejs', BEZ_SKLEPOW);
    if (req.konto?.admin !== true) return odmowaCennika(reply, req.params.id, 403, 'Brak prawa edycji magazynu.');
    const karta = kartaPoId(db, req.params.id);
    if (!karta) return brakKarty(reply, req.params.id);
    const aktor = typeof req.konto?.login === 'string' ? req.konto.login : null;
    const opcje = { teraz: new Date().toISOString(), aktor };
    const konta = kontaZCennikami(db, {
      kontaAllegro: kontaAllegro(),
      kontaErli: kontaErli(),
      definicje,
    });
    // Jedna całość: pierwszy błędny wybór wycofuje także to, co formularz zdążył zapisać wcześniej.
    try {
      wCalosci(db, () => {
        const surowe = pole(req.body, 'cennik_oms');
        if (surowe !== null) {
          const cennik = surowe.trim();
          if (cennik && !opcjeCennikowOms(db).some((o) => o.id === cennik))
            throw new BladCennikaKarty(BLAD_CENNIKA_OMS);
          if (cennik !== String(cennikOmsKarty(db, karta.id)?.cennikId ?? ''))
            ustawCennikKarty(db, { kartaId: karta.id, cennikId: cennik ? Number(cennik) : null }, opcje);
        }
        for (const konto of konta) {
          const surowy = pole(req.body, `${POLE_CENNIKA_KONTA}${konto.klucz}`);
          if (surowy === null) continue;
          const wartosc = surowy.trim();
          const klucz = { kartaId: karta.id, konto: konto.klucz };
          const obecny = zrodloWyjatkuCennika(db, klucz)?.rodzaj === 'konto' ? (wyjatekCennika(db, klucz) ?? '') : '';
          const blad = bladWyboruCennika(konto, wartosc, obecny);
          if (blad) throw new BladCennikaKarty(blad);
          if (wartosc === obecny) continue;
          if (wartosc) zapiszWyjatekCennika(db, { ...klucz, cennik: wartosc }, opcje);
          else usunWyjatekCennika(db, klucz, opcje);
        }
      });
    } catch (e) {
      if (e instanceof BladCennikaKarty) return odmowaCennika(reply, karta.id, 400, e.message);
      throw e;
    }
    return reply.code(303).redirect(`/magazyn/${karta.id}#cenniki-karty`);
  });

  // Wybór produktu dla oferty bez numeru Allegro (`ext:`) — wiersz wraca do wysyłki.
  app.post('/magazyn/:id/allegro/produkt', async (req, reply) => {
    if (!magazyn || magazyn.gotowy?.() === false) return reply.view('pusta-strona.ejs', BEZ_SKLEPOW);
    if (req.konto?.admin !== true) return odmowaAllegro(reply, req.params.id, 403, TYLKO_ADMIN_ALLEGRO);
    const karta = kartaPoId(db, req.params.id);
    if (!karta) return brakKarty(reply, req.params.id);
    const ofertaId = Number(pole(req.body, 'ofertaId'));
    const produktId = idTekst(pole(req.body, 'produktId'));
    const oferta = Number.isSafeInteger(ofertaId) && ofertaId > 0 ? ofertaPoId(db, ofertaId) : null;
    if (!oferta || oferta.kartaId !== karta.id)
      return odmowaAllegro(reply, karta.id, 404, 'Nie ma takiej oferty na tej karcie.');
    if (oferta.stan !== 'problem')
      return odmowaAllegro(reply, karta.id, 409, 'Ta oferta nie czeka już na wybór produktu — odśwież kartę.');
    // Oferta z numerem już istnieje w Allegro — zmiana produktu tutaj by jej nie dotknęła.
    const numer = String(oferta.idZewnetrzne ?? '');
    if (numer !== '' && !numer.startsWith('ext:')) {
      return odmowaAllegro(
        reply,
        karta.id,
        409,
        `Oferta ${numer} ma już numer w Allegro — produktu nie da się tu zmienić. Popraw ją w Allegro.`,
      );
    }
    const kandydaci = (Array.isArray(oferta.problemy) ? oferta.problemy : [])
      .flatMap(kandydaciProduktu)
      .map((k) => k.id);
    if (!produktId || !kandydaci.includes(produktId)) {
      return odmowaAllegro(reply, karta.id, 400, 'Wybierz jeden z produktów, które wskazało Allegro.');
    }
    transakcjaKarty(db, () => {
      zapiszKarteAllegro(db, karta.id, { produkt_id: produktId }, ['allegro:produkt'], new Date().toISOString());
      zmienOferte(db, oferta.id, zmianyPonowienia(oferta, true));
    });
    return reply.code(303).redirect(`/magazyn/${karta.id}#allegro-karty`);
  });
}

// Potwierdzenie „Usuń z OMS” tylko dla oferty tej karty, której Allegro już nie zna — adres z innym id
// albo z ofertą żywą nie otwiera niczego.
function ofertaDoUsuniecia(oferty, query, kontaAllegro) {
  const id = typeof query?.['usun-oferte'] === 'string' ? Number(query['usun-oferte']) : NaN;
  const o = oferty.find((x) => x.id === id && x.brakWAllegro);
  if (!o) return null;
  const konto = kontaAllegro.find((k) => k.klucz === o.kanal);
  return { id: o.id, numer: o.idZewnetrzne, konto: konto?.nazwa ?? o.kanal };
}

// Komunikat po usunięciu bierze numer z dziennika zmian, nie z adresu — sam adres nie może ogłosić usunięcia,
// którego nie było.
function usunietaOferta(db, kartaId, query) {
  if (query?.ok !== 'oferta-usunieta' || typeof query?.oferta !== 'string') return null;
  const wpis = db
    .prepare(`SELECT 1 FROM zmiany_w_kanalach WHERE karta_id = ? AND cel = ? AND pole = 'status' AND nowa = ? LIMIT 1`)
    .get(kartaId, `oferta:${query.oferta}`, STATUS_USUNIETEJ_Z_OMS);
  return wpis ? query.oferta : null;
}
