// PRZ-108.07 (zmiana B planu automatyzacji, sekcja 6; makieta makiety-2026-10-21/automatyzacje.html, kadry 1–6):
// reguły na ekranie Ustawienia → Automatyzacje — kreator (krok 1: zdarzenie; krok 2: opóźnienie, kanały, akcja,
// nazwa i limit), „Sprawdź na ostatnich 30 dniach” (bez zapisu), dziennik reguły, włącz / wyłącz, zaległe, usuń.
// Wszystko tylko dla admina (gość demo ogląda — tylkoAdmin z ekranu KSeF). Zapis tworzy regułę WYŁĄCZONĄ.
// Rejestry zdarzeń i akcji są parametrem (pusty rejestr = katalog przygaszony „wkrótce”, reguły nie da się zapisać).
// PRZ-108.08 (C1): status zdarzenia w kroku 1, warunki status / numer listu / dostawa / pobranie w kroku 2, podgląd
// maila w „Sprawdź na 30 dniach”, reguła z martwym statusem albo szablonem na czerwono (i bez włączenia).
import {
  sprawdzRegule, noweKanalyOdZapisu, zgodnoscSzablonu, pokazChwile, KATALOG_ZDARZEN, KATALOG_AKCJI, GRUPY_ZDARZEN,
  OPOZNIENIE_MAX_MIN, LIMIT_MIN, LIMIT_MAX, LIMIT_DOMYSLNY, BEZPIECZNIK_NARAZ, PRZETERMINOWANIE_H, wymagaNumeruListu,
} from '../../../domena/automatyzacje.js';
import { kanalyWidoku, rodzajKanalu } from '../../../domena/kanaly.js';
import { opisWarunkow } from '../../../domena/warunki-automatyzacji.js';
import { PALETA_STATUSOW } from '../../../domena/statusy-konfiguracja.js';
import { METODY_WYSYLKI, ETYKIETY_WYSYLKI } from '../../../domena/wysylka.js';
import { numeryPaczek } from '../../../domena/wiadomosc-wyslane.js';
import { statusyWKolejnosci } from '../../../oms/db/statusy.js';
import { pobierzZamowienie } from '../../../oms/db/zamowienia.js';
import { WBUDOWANE, NAZWA_WBUDOWANEGO } from '../../../domena/szablony-wiadomosci.js';
import { fmtDataCzasKrotko } from '../../../domena/format-daty.js';
import { wczytajSzablonyWiadomosci } from '../../../oms/db/szablony-wiadomosci.js';
import { nawigacjaUstawien } from '../../ustawienia/nawigacja.js';
import { tylkoAdmin, EKRAN_AUTOMATYZACJI } from '../../faktury/trasy/automat-ksef-ekran.js';
import {
  utworzRegule, zmienRegule, regulaRozpakowana, listaRegul, wlaczRegule, wylaczRegule, usunRegule, wyslijZalegle,
  pominZalegle, przelaczeniaReguly, wykonaniaReguly, liczbyRegul, zaleglychReguly, STANY_FILTRA,
} from '../db/reguly.js';
import { symulujRegule } from '../services/silnik.js';

const NOWA = `${EKRAN_AUTOMATYZACJI}/nowa`;
const SPRAWDZ = `${EKRAN_AUTOMATYZACJI}/sprawdz`;
const SZABLONY = '/ustawienia/szablony-wiadomosci';
const chwila = (iso) => pokazChwile(fmtDataCzasKrotko(iso));
const krotko = (iso) => chwila(iso).replace(/^(\d{2}\.\d{2})\.\d{4}/, '$1');

const UWAGI_KANALOW = {
  woo: 'Sklep sam wysyła kupującemu „Zamówienie zrealizowane”, gdy oznaczysz zamówienie jako wysłane — przy regule z mailem kupujący dostanie dwa maile. Numer listu i link śledzenia są tylko w tym z OMS-u.',
  allegro: 'Allegro samo powiadamia kupującego o wysyłce. Numer paczki nadanej poza panelem OMS pobiera dopiero przy otwarciu karty zamówienia.',
};
const UWAGA_WOO_POTWIERDZENIE = 'WooCommerce samo wysyła potwierdzenie przyjęcia zamówienia — z tą regułą kupujący dostanie dwa potwierdzenia. Sprawdź ustawienia maili w sklepie przed włączeniem reguły.';
const STANY = {
  zaplanowane: { etykieta: 'zaplanowane', klasa: 'znacznik--szary' },
  w_toku: { etykieta: 'w toku', klasa: 'znacznik--szary' },
  wyslane: { etykieta: 'wysłane', klasa: 'znacznik--wyslane' },
  pominiete: { etykieta: 'pominięte', klasa: 'znacznik--szary' },
  blad: { etykieta: 'błąd', klasa: 'znacznik--czerwony' },
  niepewne: { etykieta: 'niepewne', klasa: 'znacznik--w-realizacji' },
};
const FILTRY = [['', 'wszystkie'], ['wyslane', 'wysłane'], ['pominiete', 'pominięte'], ['zaplanowane', 'zaplanowane'],
  ['bledy', 'błędy i niepewne']];
const KODY_POMINIEC = { warunek: 'niespełniony warunek', brak_adresu: 'bez adresu e-mail', juz_wyslany: 'ten mail już poszedł',
  dolaczone: 'zamówienie dołączone', anulowane: 'anulowane', szablon_usuniety: 'szablon usunięty', brak_poczty: 'brak poczty',
  odmowa: 'mail niemożliwy' };
const KOMUNIKATY = { 1: 'Zapisano regułę. Jest wyłączona — włączysz ją przyciskiem niżej.', wlaczona: 'Reguła włączona.',
  wylaczona: 'Reguła wyłączona.', zalegle: 'Wstrzymanie zdjęte — zaległe wyjdą z limitami godzinowymi.',
  pominiete: 'Zaległe pominięte, wstrzymanie zdjęte.' };

const zamowien = (n) => (n === 1 ? 'zamówienia' : 'zamówień');
const minut = (n) => {
  if (n === 0) return 'od razu';
  if (n % 1440 === 0) return `po ${n / 1440} ${n === 1440 ? 'dniu' : 'dniach'}`;
  if (n % 60 === 0) return `po ${n / 60} ${n === 60 ? 'godzinie' : 'godzinach'}`;
  return `po ${n} min`;
};

/**
 * Zależności tras liczone przy każdym żądaniu: szablony, kanały i statusy mogą się zmienić bez restartu.
 * PRZ-108.08: zdarzenie z parametrem (status) niesie `opcje` — klucze, które dziś da się wybrać (walidacja domeny).
 */
function kontekstReguly({ db, definicje, zdarzenia, akcje }) {
  const wlasne = wczytajSzablonyWiadomosci(db).wlasne;
  const statusy = statusyWKolejnosci(db);
  return {
    kanaly: kanalyWidoku(definicje),
    zdarzenia: zdarzenia.map((d) => (d.opcjeParametru
      ? { ...d, opcje: d.opcjeParametru(db).filter((o) => o.dostepny).map((o) => o.klucz) } : d)),
    akcje,
    szablony: [...WBUDOWANE, ...wlasne.map((w) => w.id)],
    wlasne,
    statusy: statusy.map((s) => s.klucz),
    statusyWidoku: statusy,
    etykietyStatusow: Object.fromEntries(statusy.map((s) => [s.klucz, s.etykieta])),
  };
}

/** Etykieta parametru zdarzenia („Wysłane”, „Czeka na klosz”) albo `null`. */
function etykietaParametru(db, zdarzenie, param) {
  if (!param?.status || !zdarzenie?.opcjeParametru) return null;
  return zdarzenie.opcjeParametru(db).find((o) => o.klucz === param.status)?.etykieta ?? param.status;
}

/**
 * Kłopoty reguły, przez które nic nie zrobi (lista na czerwono, dziennik, odmowa włączenia): martwy parametr zdarzenia
 * (np. status własny usunięty z Ustawień) albo szablon, którego już nie ma.
 */
function klopotyReguly(db, r, k, zdarzenia) {
  const klopoty = [];
  const zdarzenie = zdarzenia.find((d) => d.klucz === r.zdarzenie);
  const blad = zdarzenie?.bladParametru?.(db, r.zdarzenie_param);
  if (blad) klopoty.push({ krotko: 'status nie istnieje', zdanie: blad });
  const szablon = r.akcja_param?.szablon;
  if (szablon && !nazwaSzablonu(szablon, k.wlasne)) {
    klopoty.push({ krotko: 'szablon usunięty', zdanie: 'Szablonu maila tej reguły już nie ma (usunięty w Ustawienia → Szablony wiadomości) — wybierz inny w edycji reguły.' });
  }
  return klopoty;
}

function nazwaSzablonu(id, wlasne) {
  return NAZWA_WBUDOWANEGO[id] ?? wlasne.find((w) => w.id === id)?.nazwa ?? null;
}
const etykietaZdarzenia = (klucz, zdarzenia) => zdarzenia.find((z) => z.klucz === klucz)?.etykieta
  ?? KATALOG_ZDARZEN.find((z) => z.klucz === klucz)?.etykieta ?? klucz;
const etykietaAkcji = (klucz, akcje) => akcje.find((a) => a.klucz === klucz)?.etykieta
  ?? KATALOG_AKCJI.find((a) => a.klucz === klucz)?.etykieta ?? klucz;

/** Jedno zdanie „kiedy → [warunki] → co” do listy reguł i nagłówka dziennika. */
function opisReguly(r, k, db = null) {
  const szablon = r.akcja_param?.szablon ? nazwaSzablonu(r.akcja_param.szablon, k.wlasne) : null;
  const zdarzenie = k.zdarzenia.find((d) => d.klucz === r.zdarzenie);
  const parametr = db ? etykietaParametru(db, zdarzenie, r.zdarzenie_param) : r.zdarzenie_param?.status ?? null;
  const warunki = opisWarunkow(r.warunki, { etykiety: k.etykietyStatusow });
  return `${etykietaZdarzenia(r.zdarzenie, k.zdarzenia).replace(/…$/, '')}${parametr ? `: ${parametr}` : ''} → ${minut(r.opoznienie_min)} → `
    + `${warunki ? `jeśli ${warunki} → ` : ''}`
    + `${etykietaAkcji(r.akcja, k.akcje)}${szablon ? ` „${szablon}”` : r.akcja_param?.szablon ? ' (szablon usunięty)' : ''}`;
}

/** Model sekcji reguł na ekranie Ustawienia → Automatyzacje (trasy/ekran.js). */
export function modelListyRegul({ db, definicje, zdarzenia, akcje, pocztaGotowa, teraz }) {
  const k = kontekstReguly({ db, definicje, zdarzenia, akcje });
  const kanaly = new Map(k.kanaly.map((x) => [x.klucz, x.etykieta]));
  const liczby = liczbyRegul(db, new Date(teraz().getTime() - 7 * 24 * 3600 * 1000).toISOString());
  const lista = listaRegul(db).map((r) => {
    const l = liczby.get(r.id) ?? {};
    return {
      id: r.id, nazwa: r.nazwa, opis: opisReguly(r, k, db), klopoty: klopotyReguly(db, r, k, zdarzenia),
      kanaly: (r.warunki.kanaly ?? []).map((x) => kanaly.get(x) ?? `${x} (nie ma już w konfiguracji)`).join(', '),
      wlaczona: r.wlaczona === 1, wstrzymana: r.wstrzymana_powod, od: r.wlaczona === 1 && r.granica_at ? krotko(r.granica_at) : null,
      wyslane: l.wyslane ?? 0, pominiete: l.pominiete ?? 0, niepewne: (l.niepewne ?? 0) + (l.blad ?? 0),
      zalegle: l.zaplanowane ?? 0,
    };
  });
  return { dostepne: zdarzenia.length > 0 && akcje.length > 0, lista, pocztaGotowa: Boolean(pocztaGotowa()),
    wstrzymane: lista.filter((r) => r.wlaczona && r.wstrzymana) };
}

function grupyKreatora(db, zdarzenia, wybrane = null, wybranyStatus = null) {
  const wpisy = [...KATALOG_ZDARZEN.map((z) => ({ ...z, ...(zdarzenia.find((d) => d.klucz === z.klucz) ?? {}) })),
    ...zdarzenia.filter((d) => !KATALOG_ZDARZEN.some((z) => z.klucz === d.klucz))]
    .map((z) => {
      const dostepne = zdarzenia.some((d) => d.klucz === z.klucz);
      // PRZ-108.08: zdarzenie z parametrem (status) — lista pod przyciskiem; domyślnie Wysłane (przypadek właściciela).
      const opcje = dostepne && z.opcjeParametru ? z.opcjeParametru(db) : null;
      const domyslny = opcje?.some((o) => o.klucz === wybranyStatus && o.dostepny) ? wybranyStatus
        : opcje?.find((o) => o.klucz === 'wyslane') ? 'wyslane' : opcje?.find((o) => o.dostepny)?.klucz ?? null;
      return { klucz: z.klucz, etykieta: z.etykieta, opis: z.opis ?? null, pomoc: dostepne ? z.pomoc ?? null : null, grupa: z.grupa, dostepne,
        zaznaczone: z.klucz === wybrane || (!wybrane && Boolean(opcje)), opcje, wybranyStatus: domyslny };
    });
  return GRUPY_ZDARZEN.map((g) => ({ ...g, zdarzenia: wpisy.filter((z) => z.grupa === g.klucz) }))
    .filter((g) => g.zdarzenia.length);
}

function widokKroku1(req, reply, z, { status = 200, blad = null } = {}) {
  return reply.code(status).view('automatyzacje-nowa.ejs', {
    nawigacja: nawigacjaUstawien(req, reply), title: 'Nowa automatyzacja', blad,
    grupy: grupyKreatora(z.db, z.zdarzenia, req.query?.zdarzenie ?? null, req.query?.zdarzenie_status ?? null),
    dostepnych: z.zdarzenia.length,
  });
}

/** Model formularza reguły (krok 2 kreatora i edycja). `formularz` — wartości do pól (zapisane albo wpisane). */
function modelFormularza(z, { formularz, regula = null, bledy = [], sprawdzenie = null }) {
  const k = kontekstReguly(z);
  const zaznaczone = new Set([formularz.kanaly ?? []].flat().map(String));
  const zmiany = regula ? noweKanalyOdZapisu(regula.warunki, k.kanaly) : { nowe: [], usuniete: [] };
  const etykiety = new Map(k.kanaly.map((x) => [x.klucz, x.etykieta]));
  const zdarzenie = String(formularz.zdarzenie ?? '');
  const wpisZdarzenia = z.zdarzenia.find((d) => d.klucz === zdarzenie);
  const zdarzenieStatus = wpisZdarzenia?.opcjeParametru ? String(formularz.zdarzenie_status ?? '') : null;
  // PRZ-108.08: warunki w chwili wykonania. Szablon „Zamówienie wysłane” wymusza „ma numer listu” — pole zaznaczone
  // i zablokowane, wartość jedzie ukrytym polem (zablokowane pole wyboru formularz pomija).
  const szablon = String(formularz.szablon ?? '');
  const wymuszony = wymagaNumeruListu(szablon);
  const zaznaczoneStatusy = new Set([formularz.statusy ?? []].flat().map(String));
  const numer = [formularz.ma_numer_listu ?? []].flat().map(String).at(-1);
  return {
    regula, bledy, sprawdzenie, formularz,
    akcjaFormularza: regula ? `${EKRAN_AUTOMATYZACJI}/${regula.id}` : NOWA,
    zdarzenie: { klucz: zdarzenie, etykieta: etykietaZdarzenia(zdarzenie, z.zdarzenia).replace(/…$/, ''),
      opis: wpisZdarzenia?.opis ?? null, status: zdarzenieStatus,
      statusEtykieta: zdarzenieStatus !== null ? etykietaParametru(z.db, wpisZdarzenia, { status: zdarzenieStatus }) : null },
    warunki: {
      statusDowolny: String(formularz.status_warunek ?? '') !== 'jeden_z',
      statusy: k.statusyWidoku.map((s) => ({ klucz: s.klucz, etykieta: s.etykieta, wlasny: Boolean(s.jak),
        klasa: PALETA_STATUSOW[s.kolor]?.klasa ?? 'szary', zaznaczony: zaznaczoneStatusy.has(s.klucz) })),
      numerWymuszony: wymuszony, numer: wymuszony || numer === '1',
      dostawa: [formularz.dostawa ?? ''].flat().map(String).at(-1) ?? '',
      metody: METODY_WYSYLKI.map((m) => ({ klucz: m, etykieta: ETYKIETY_WYSYLKI[m] ?? m })),
      pobranie: String(formularz.pobranie || 'dowolne'),
    },
    kanaly: k.kanaly.map((x) => {
      const rodzaj = rodzajKanalu(x.klucz, z.definicje);
      const potwierdzenieWoo = zdarzenie === 'zamowienie_nowe' && rodzaj?.klucz === 'woo';
      return { ...x, rodzaj, uwaga: potwierdzenieWoo ? UWAGA_WOO_POTWIERDZENIE : rodzaj ? UWAGI_KANALOW[rodzaj.klucz] ?? null : null,
        waznaUwaga: potwierdzenieWoo, zaznaczony: zaznaczone.has(x.klucz) };
    }),
    usuniete: zmiany.usuniete.filter((x) => zaznaczone.has(x)),
    noweKanaly: zmiany.nowe.map((x) => etykiety.get(x) ?? x),
    akcje: [...KATALOG_AKCJI.map((a) => ({ ...a, ...(z.akcje.find((d) => d.klucz === a.klucz) ?? {}) })),
      ...z.akcje.filter((d) => !KATALOG_AKCJI.some((a) => a.klucz === d.klucz))]
      .map((a) => ({ klucz: a.klucz, etykieta: a.etykieta, dostepna: z.akcje.some((d) => d.klucz === a.klucz),
        zaznaczona: a.klucz === String(formularz.akcja ?? (z.akcje.length === 1 ? z.akcje[0].klucz : '')) })),
    szablonowa: z.akcje.some((a) => a.szablon),
    szablonyWbudowane: WBUDOWANE.filter((id) => zgodnoscSzablonu(zdarzenie, id)).map((id) => ({ id, nazwa: NAZWA_WBUDOWANEGO[id] })),
    szablonyWlasne: k.wlasne.map((w) => ({ id: w.id, nazwa: w.nazwa })),
    SZABLONY, SPRAWDZ, OPOZNIENIE_MAX_MIN, LIMIT_MIN, LIMIT_MAX, BEZPIECZNIK_NARAZ, PRZETERMINOWANIE_H,
  };
}

function widokFormularza(req, reply, z, model, status = 200) {
  const title = model.regula ? model.regula.nazwa : 'Nowa automatyzacja';
  return reply.code(status).view('automatyzacje-regula.ejs', { nawigacja: nawigacjaUstawien(req, reply), title,
    ...modelFormularza(z, model) });
}

function formularzZReguly(r) {
  const w = r.warunki ?? {};
  return { nazwa: r.nazwa, zdarzenie: r.zdarzenie, zdarzenie_status: r.zdarzenie_param?.status ?? '',
    kanaly: w.kanaly ?? [], opoznienie: String(r.opoznienie_min),
    status_warunek: (w.statusy ?? []).length ? 'jeden_z' : 'dowolny', statusy: w.statusy ?? [],
    ma_numer_listu: w.maNumerListu ? '1' : '0', dostawa: (w.metody ?? [])[0] ?? '', pobranie: w.pobranie ?? 'dowolne',
    limit: String(r.limit_na_godzine), akcja: r.akcja, szablon: r.akcja_param?.szablon ?? '' };
}

/** Wartości startowe kroku 2 kreatora (makieta, kadr 4): opóźnienie 30 min, status zdarzenia jako warunek, „Zamówienie wysłane”. */
function formularzStartowy(z, zdarzenie, zdarzenieStatus) {
  const szablon = zdarzenie === 'zamowienie_nowe' ? 'potwierdzenie' : zgodnoscSzablonu(zdarzenie, 'wyslane') ? 'wyslane' : '';
  return { zdarzenie, zdarzenie_status: zdarzenieStatus ?? '', opoznienie: '30', limit: String(LIMIT_DOMYSLNY), kanaly: [],
    status_warunek: zdarzenieStatus ? 'jeden_z' : 'dowolny', statusy: zdarzenieStatus ? [zdarzenieStatus] : [],
    ma_numer_listu: wymagaNumeruListu(szablon) ? '1' : '0', dostawa: '', pobranie: 'dowolne',
    akcja: z.akcje.length === 1 ? z.akcje[0].klucz : '', szablon };
}

function idReguly(req, db) {
  const s = String(req.params.id ?? '');
  if (!/^\d{1,12}$/.test(s)) return null;
  const r = regulaRozpakowana(db, Number(s));
  return r && !r.usunieta_at ? r : null;
}

function modelDziennika(z, r, req) {
  const k = kontekstReguly(z);
  const filtr = Object.hasOwn(STANY_FILTRA, req.query?.stan) ? req.query.stan : '';
  const etykiety = new Map(k.kanaly.map((x) => [x.klucz, x.etykieta]));
  const zmiany = noweKanalyOdZapisu(r.warunki, k.kanaly);
  return {
    regula: r, opis: opisReguly(r, k, z.db), klopoty: klopotyReguly(z.db, r, k, z.zdarzenia),
    warunkiOpis: opisWarunkow(r.warunki, { etykiety: k.etykietyStatusow }),
    kanaly: (r.warunki.kanaly ?? []).map((x) => etykiety.get(x) ?? `${x} (nie ma już w konfiguracji)`),
    noweKanaly: zmiany.nowe.map((x) => etykiety.get(x) ?? x),
    granica: r.granica_at ? chwila(r.granica_at) : null,
    wlaczyl: przelaczeniaReguly(z.db, r.id).find((p) => p.wlaczona === 1)?.konto_login ?? null,
    historia: przelaczeniaReguly(z.db, r.id).map((p) => ({ kiedy: chwila(p.at), kto: p.konto_login ?? '—',
      zmiana: p.wlaczona === 1 ? 'włączenie' : p.at === r.utworzona_at ? 'zapis reguły (wyłączona)' : 'wyłączenie' })),
    zalegle: zaleglychReguly(z.db, r.id),
    filtr, FILTRY,
    wykonania: wykonaniaReguly(z.db, r.id, { stan: filtr || null }).map((w) => ({
      kiedy: krotko(w.zakonczone_at ?? w.wykryte_at), zamowienie_id: w.zamowienie_id, numer: w.numer_zamowienia ?? w.zamowienie_id,
      adresat: w.adresat, stan: STANY[w.stan] ?? { etykieta: w.stan, klasa: 'znacznik--szary' },
      powod: w.stan === 'zaplanowane' ? `wyjdzie ${krotko(w.nastepna_proba_at ?? w.termin_at)}${w.proby ? ` (próba ${w.proby + 1})` : ''}` : w.powod,
    })),
    zdarzenieDostepne: z.zdarzenia.some((d) => d.klucz === r.zdarzenie),
    akcjaDostepna: z.akcje.some((a) => a.klucz === r.akcja),
    pocztaGotowa: Boolean(z.pocztaGotowa()),
    zapisano: KOMUNIKATY[req.query?.zapisano] ?? null,
  };
}

function widokDziennika(req, reply, z, r, { status = 200, blad = null } = {}) {
  return reply.code(status).view('automatyzacje-dziennik.ejs', { nawigacja: nawigacjaUstawien(req, reply), title: r.nazwa,
    blad, ...modelDziennika(z, r, req) });
}

/** Powód, dla którego reguły nie da się włączyć, albo `null`. */
function przeszkodaWlaczenia(z, r) {
  if (!z.zdarzenia.some((d) => d.klucz === r.zdarzenie)) return 'Zdarzenie tej reguły jest niedostępne w tej wersji OMS-u — reguły nie da się włączyć.';
  const akcja = z.akcje.find((a) => a.klucz === r.akcja);
  if (!akcja) return 'Akcja tej reguły jest niedostępna w tej wersji OMS-u — reguły nie da się włączyć.';
  if (akcja.wymagaPoczty && !z.pocztaGotowa()) {
    return 'Poczta wychodząca nie jest podłączona — tej reguły nie włączysz. Podłącz pocztę w Ustawienia → Integracje → Poczta wychodząca.';
  }
  const klopot = klopotyReguly(z.db, r, kontekstReguly(z), z.zdarzenia)[0];
  return klopot ? `${klopot.zdanie} Tej reguły nie włączysz, dopóki tego nie poprawisz.` : null;
}

export function registerRegulyAutomatyzacji(app, zaleznosci) {
  const z = { teraz: () => new Date(), zdarzenia: [], akcje: [], sprawdzWarunki: undefined, pocztaGotowa: () => false,
    ...zaleznosci };
  const { db } = z;
  const login = (req) => req.konto?.login ?? null;
  const z303 = (reply, adres) => reply.code(303).redirect(adres);
  const zRegula = (obsluga) => async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const r = idReguly(req, db);
    if (!r) return reply.code(404).view('brak-dostepu.ejs', { title: 'Nie ma takiej reguły', wlasnyUklad: true });
    return obsluga(req, reply, r);
  };

  app.get(NOWA, async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const wybrane = req.query?.zdarzenie;
    if (wybrane === undefined || req.query?.zmien) return widokKroku1(req, reply, z);
    const wpis = z.zdarzenia.find((d) => d.klucz === wybrane);
    if (!wpis) {
      return widokKroku1(req, reply, z, { status: 400, blad: 'To zdarzenie jest niedostępne w tej wersji OMS-u — wybierz inne.' });
    }
    const status = wpis.opcjeParametru ? String(req.query?.zdarzenie_status ?? '') : null;
    if (status !== null && !wpis.opcjeParametru(db).some((o) => o.klucz === status && o.dostepny)) {
      return widokKroku1(req, reply, z, { status: 400, blad: 'Tego statusu nie da się (jeszcze) rozpoznać jako zdarzenia — wybierz inny.' });
    }
    return widokFormularza(req, reply, z, { formularz: formularzStartowy(z, wybrane, status) });
  });

  app.post(NOWA, async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const formularz = req.body ?? {};
    const w = sprawdzRegule(formularz, kontekstReguly(z));
    if (!w.ok) {
      if (!z.zdarzenia.some((d) => d.klucz === formularz.zdarzenie)) {
        return widokKroku1(req, reply, z, { status: 400, blad: w.bledy.join(' ') });
      }
      return widokFormularza(req, reply, z, { formularz, bledy: w.bledy }, 400);
    }
    const id = utworzRegule(db, w.regula, { login: login(req), teraz: z.teraz });
    return z303(reply, `${EKRAN_AUTOMATYZACJI}/${id}?zapisano=1`);
  });

  // „Sprawdź na ostatnich 30 dniach”: ten sam formularz (formaction), ZERO zapisów.
  app.post(SPRAWDZ, async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    const formularz = req.body ?? {};
    const regula = /^\d+$/.test(String(formularz.regula_id ?? '')) ? regulaRozpakowana(db, Number(formularz.regula_id)) : null;
    const istniejaca = regula && !regula.usunieta_at ? regula : null;
    if (!z.zdarzenia.some((d) => d.klucz === formularz.zdarzenie)) {
      return widokKroku1(req, reply, z, { status: 400, blad: 'To zdarzenie jest niedostępne w tej wersji OMS-u — wybierz inne.' });
    }
    const w = sprawdzRegule(formularz, kontekstReguly(z));
    if (!w.ok) return widokFormularza(req, reply, z, { formularz, regula: istniejaca, bledy: w.bledy }, 400);
    const wynik = await symulujRegule({ db, regula: { ...w.regula, id: istniejaca?.id ?? null },
      zdarzenie: z.zdarzenia.find((d) => d.klucz === w.regula.zdarzenie), akcja: z.akcje.find((a) => a.klucz === w.regula.akcja),
      sprawdzWarunki: z.sprawdzWarunki, teraz: z.teraz });
    const etykiety = new Map(kanalyWidoku(z.definicje).map((x) => [x.klucz, x.etykieta]));
    const akcja = z.akcje.find((a) => a.klucz === w.regula.akcja);
    // PRZ-108.08: przykłady z numerami paczek (stan z dziś) i podgląd maila na pierwszym, który by wyszedł — ta sama
    // funkcja co podgląd na karcie i wysyłka (`wiadomosci.podglad`). Podgląd niczego nie zapisuje.
    const przyklady = wynik.przyklady.map((p) => {
      const zam = pobierzZamowienie(db, p.zamowienie_id);
      return { ...p, kiedy: krotko(p.zdarzenie_at), numer: zam?.numer ?? p.zamowienie_id, paczki: zam ? numeryPaczek(zam) : '' };
    });
    const doPodgladu = przyklady.find((p) => p.ok);
    let podglad = null;
    if (doPodgladu && akcja?.podglad && w.regula.akcja_json?.szablon) {
      try {
        const m = await akcja.podglad({ zamowienie_id: doPodgladu.zamowienie_id, szablon: w.regula.akcja_json.szablon });
        if (m) podglad = { numer: doPodgladu.numer, do: m.do, temat: m.temat, tekst: m.tekst };
      } catch (e) { podglad = { numer: doPodgladu.numer, blad: e?.message ?? String(e) }; }
    }
    const sprawdzenie = {
      ...wynik, od: krotko(wynik.od),
      etykietaAkcji: etykietaAkcji(w.regula.akcja, z.akcje),
      pominieteOpis: Object.entries(wynik.pominiete).map(([kod, n]) => `${n} — ${KODY_POMINIEC[kod] ?? kod}`),
      odrzuconeOpis: Object.entries(wynik.odrzuconeKanalem).map(([k, n]) => `${etykiety.get(k) ?? k} (${n})`),
      odrzuconeRazem: Object.values(wynik.odrzuconeKanalem).reduce((a, b) => a + b, 0),
      zamowien: zamowien(wynik.razem),
      przyklady, podglad,
      opoznienie: w.regula.opoznienie_min,
    };
    return widokFormularza(req, reply, z, { formularz, regula: istniejaca, sprawdzenie });
  });

  app.get(`${EKRAN_AUTOMATYZACJI}/:id`, zRegula(async (req, reply, r) => widokDziennika(req, reply, z, r)));

  app.get(`${EKRAN_AUTOMATYZACJI}/:id/edytuj`, zRegula(async (req, reply, r) =>
    widokFormularza(req, reply, z, { formularz: formularzZReguly(r), regula: r })));

  app.post(`${EKRAN_AUTOMATYZACJI}/:id`, zRegula(async (req, reply, r) => {
    // Zdarzenie i jego parametr (status) zmienia się nową regułą, nie edycją — pola ukryte nie są źródłem prawdy.
    const formularz = { ...(req.body ?? {}), zdarzenie: r.zdarzenie, zdarzenie_status: r.zdarzenie_param?.status ?? '' };
    const w = sprawdzRegule(formularz, kontekstReguly(z));
    if (!w.ok) return widokFormularza(req, reply, z, { formularz, regula: r, bledy: w.bledy }, 400);
    zmienRegule(db, r.id, w.regula, { login: login(req), teraz: z.teraz });
    return z303(reply, `${EKRAN_AUTOMATYZACJI}/${r.id}?zapisano=1`);
  }));

  app.post(`${EKRAN_AUTOMATYZACJI}/:id/wlacz`, zRegula(async (req, reply, r) => {
    const przeszkoda = przeszkodaWlaczenia(z, r);
    if (przeszkoda) return widokDziennika(req, reply, z, r, { status: 409, blad: przeszkoda });
    // Już włączona (np. stara karta) → bez zmian, z powrotem na ekran reguły (recenzja 07, usterka 7).
    const wlaczona = wlaczRegule(db, r.id, { login: login(req), teraz: z.teraz });
    return z303(reply, `${EKRAN_AUTOMATYZACJI}/${r.id}${wlaczona ? '?zapisano=wlaczona' : ''}`);
  }));

  app.post(`${EKRAN_AUTOMATYZACJI}/:id/wylacz`, zRegula(async (req, reply, r) => {
    wylaczRegule(db, r.id, { login: login(req), teraz: z.teraz });
    return z303(reply, `${EKRAN_AUTOMATYZACJI}/${r.id}?zapisano=wylaczona`);
  }));

  app.post(`${EKRAN_AUTOMATYZACJI}/:id/usun`, zRegula(async (req, reply, r) => {
    usunRegule(db, r.id, { login: login(req), teraz: z.teraz });
    return z303(reply, EKRAN_AUTOMATYZACJI);
  }));

  app.post(`${EKRAN_AUTOMATYZACJI}/:id/zalegle/wyslij`, zRegula(async (req, reply, r) => {
    wyslijZalegle(db, r.id, { login: login(req), teraz: z.teraz });
    return z303(reply, `${EKRAN_AUTOMATYZACJI}/${r.id}?zapisano=zalegle`);
  }));

  app.post(`${EKRAN_AUTOMATYZACJI}/:id/zalegle/pomin`, zRegula(async (req, reply, r) => {
    pominZalegle(db, r.id, { login: login(req), teraz: z.teraz });
    return z303(reply, `${EKRAN_AUTOMATYZACJI}/${r.id}?zapisano=pominiete`);
  }));
}
