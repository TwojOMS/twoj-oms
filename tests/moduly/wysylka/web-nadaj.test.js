import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createNadanie, PACZKA_DOMYSLNA } from '../../../src/moduly/wysylka/services/nadanie.js';
import { zapiszUstawienia } from '../../../src/oms/db/ustawienia.js';
import { createDpdClient } from '../../../src/oms/kurierzy/dpd.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dir, 'fixtures', 'dpd', n), 'utf8');
const odp = (status, tekst) => ({ status, ok: status >= 200 && status < 300, text: async () => tekst });

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const NADAWCA = { nazwa: 'Lumina Marek Zywiecki', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL' };
// Adres odbiorcy, DOKŁADNIE taki, jaki GET wypełniłby na ekranie nadania z adresOdbiorcy()
// dla domyślnego `zmapowane()` niżej — od Zadania „adres edytowalny" POST wymaga go W
// FORMULARZU (patrz domain/adres-formularza.js: puste pole wymagane blokuje zatwierdzenie),
// więc każdy test, który ma dojść do prawdziwego wywołania nadaj(), musi go podać, tak jak
// PRAWDZIWA przeglądarka odesłałaby wartości, którymi GET wypełnił pola.
const ADRES = {
  nazwa: 'Jan Kowalski', company: 'Jan Kowalski', ulica: 'Polna 1', kod: '00-650',
  miasto: 'Pęki', kraj: 'PL', phone: '+48500600700', email: 'j@k.pl',
};
//  jest teraz czescia formularza nadania i trasa POST bez niej odmawia —
// to ona pilnuje podwojnego klikniecia (patrz komentarz przy POST /zamowienia/:id/nadaj).
const PACZKA = { waga: '1', dlugosc: '110', szerokosc: '75', wysokosc: '1', kolejnosc: '1', ...ADRES };

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1301, numer: '1301',
  klient: { email: 'j@k.pl', phone: '+48500600700' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', company: '', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '212.90',
  status_woo: 'processing', oplacone_at: '2026-07-29T13:00:00', anulowane: 0,
  utworzone_at: '2026-07-29T13:19:52', pozycje: [], ...nad,
});

// Klient DPD z fetchImpl stubem odpowiadajacym PRAWDZIWYMI fikstsurami z Zadania 8 — te same,
// z ktorych korzysta tests/oms/dpd.test.js. ZERO zadan sieciowych: fetchImpl nigdy nie
// dotyka dpdservices.dpd.com.pl.
function dpdKlient() {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(odp(200, fixture('v10-ok.xml')))
    .mockResolvedValueOnce(odp(200, fixture('v4-ok.xml')));
  const dpd = createDpdClient({ url: 'https://dpd/api', login: '99999999', haslo: 'x', fid: '278216', nadawca: NADAWCA, fetchImpl });
  return { dpd, fetchImpl };
}

let db;
beforeEach(() => {
  db = openOmsDb(':memory:');
});

// Wariant z TRZEMA kanonicznymi odpowiedziami (V10 + V4 PDF + V4 ZPL) — do testów
// „Nadaj i drukuj", które muszą mieć prawdziwy plik ZPL do wstawienia do kolejki.
// `dpdKlient()` wyżej mocka tylko dwie (V10 + PDF) CELOWO: trzecie żądanie (ZPL) wtedy
// „zawodzi" (fetchImpl bez trzeciej atrapy), co jest dokładnie tym, czego potrzeba
// do testu „brak ZPL nie blokuje „Nadaj i drukuj"".
function dpdKlientZZpl() {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(odp(200, fixture('v10-ok.xml')))
    .mockResolvedValueOnce(odp(200, fixture('v4-ok.xml')))
    .mockResolvedValueOnce(odp(200, fixture('v4-ok-zpl.xml')));
  const dpd = createDpdClient({ url: 'https://dpd/api', login: '99999999', haslo: 'x', fid: '278216', nadawca: NADAWCA, fetchImpl });
  return { dpd, fetchImpl };
}

function zServerem({ nad = {}, dpd, woo } = {}) {
  const katalogEtykiet = mkdtempSync(join(tmpdir(), 'oms-nadaj-'));
  const dpdKl = dpd ?? dpdKlient().dpd;
  const wooKl = woo ?? { dodajNotatke: vi.fn().mockResolvedValue({}) };
  const nadanie = createNadanie({ db, kurierzy: { dpd: dpdKl }, woo: wooKl, katalogEtykiet });
  const serwer = buildOmsServer({ db, config, poller, nadanie });
  const id = zapiszZamowienie(db, 'pro', zmapowane(nad), {});
  return { serwer, id };
}

describe('GET /zamowienia/:id/nadaj — ekran nadania', () => {
  it('niesie kontekst listy przez ekran, anulowanie i udane nadanie', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const powrot = '/?status=nowe&kanal=pro';
    const ekran = await serwer.inject({
      method: 'GET', url: `/zamowienia/${id}/nadaj?powrot=${encodeURIComponent(powrot)}`, headers: naglowek,
    });
    expect(ekran.body).toContain(`<input type="hidden" name="powrot" value="/?status=nowe&amp;kanal=pro">`);
    expect(ekran.body).toContain(`href="/zamowienia/${id}?powrot=%2F%3Fstatus%3Dnowe%26kanal%3Dpro"`);

    const zapis = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA, powrot },
    });
    expect(zapis.statusCode).toBe(302);
    expect(zapis.headers.location).toBe(`/zamowienia/${id}?powrot=%2F%3Fstatus%3Dnowe%26kanal%3Dpro`);
  });

  it('bez uwierzytelnienia → 401', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj` });
    expect(r.statusCode).toBe(401);
  });

  it('nieistniejące zamówienie → 404', async () => {
    const { serwer } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: '/zamowienia/9999/nadaj', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });

  it('bez skonfigurowanego nadawania → 503', async () => {
    const db2 = openOmsDb(':memory:');
    const serwer = buildOmsServer({ db: db2, config, poller });
    await serwer.ready();
    const id = zapiszZamowienie(db2, 'pro', zmapowane(), {});
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.statusCode).toBe(503);
  });

  it('pokazuje komplet adresu odbiorcy: imię, nazwisko, ulicę, kod, miasto, kraj, telefon, e-mail', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Jan');
    expect(r.body).toContain('Kowalski');
    expect(r.body).toContain('Polna 1');
    expect(r.body).toContain('00-650');
    expect(r.body).toContain('Pęki');
    expect(r.body).toContain('PL');
    expect(r.body).toContain('+48500600700');
    expect(r.body).toContain('j@k.pl');
  });

  // ⚠️ Decyzja właściciela 2026-08-04 (plan „ekran nadania"): OBA ostrzeżenia o
  // nieodwracalności znikają z ekranu — ani górne („UWAGA: zatwierdzenie jest
  // NIEODWRACALNE…"), ani dolne („Zatwierdzenie nada paczkę w DPD…"). To zmiana TEGO, co
  // widzi operator, NIE ochrony technicznej: numer kolejny niesiony przez formularz,
  // indeks częściowy `przesylki (zamowienie_id, kolejnosc)` i odmowa DPD dla powtórzonej
  // referencji zostają nietknięte — patrz testy niżej i w tests/oms/wiele-paczek.test.js.
  it('NIE ostrzega już, że zatwierdzenie jest nieodwracalne (decyzja właściciela 04.08)', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).not.toMatch(/NIEODWRACAL/i);
    expect(r.body).not.toContain('Zatwierdzenie nada paczkę w DPD i pobierze prawdziwy numer listu');
  });

  // Zadanie 5 (usunięcie pola „Komentarz", decyzja właściciela 04.08): pole nigdy nie
  // jechało do kuriera (trafiało wyłącznie do logu zamówienia), więc znika z ekranu.
  // POST i `nadanie.nadaj()` zostają nietknięte — bez pola przyjdzie `null`, tak jak dziś.
  //
  // ⚠️ ASERCJA CELOWO ZAWĘŻONA DO FORMULARZA. Wersja szukająca słowa „Komentarz" w CAŁEJ
  // stronie przechodziła wyłącznie przez PRZYPADEK: arkusz stylów (`layout-oms.ejs`) jedzie
  // w każdej stronie panelu i ma w komentarzach CSS słowo „komentarz" — małą literą.
  // Pierwszy komentarz zaczynający zdanie od „Komentarz…" wywaliłby ten test, mimo że pole
  // dalej byłoby usunięte. Pytanie brzmi „czy w FORMULARZU nadania jest pole Komentarz",
  // więc dokładnie o to pytamy.
  it('Zadanie 5: pole „Komentarz" zniknęło z ekranu nadania', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    const poczatek = r.body.indexOf(`action="/zamowienia/${id}/nadaj"`);
    expect(poczatek).toBeGreaterThan(-1);
    const formularz = r.body.slice(poczatek, r.body.indexOf('</form>', poczatek));
    expect(formularz).not.toContain('name="komentarz"');
    expect(formularz).not.toMatch(/Komentarz/i);
  });

  // Zadanie 2: lista pozycji zamówienia (tylko do odczytu — bez formularza edycji/usunięcia)
  // renderowana TYMI SAMYMI funkcjami co karta zamówienia (wierszePozycji + adresMiniatury).
  it('Zadanie 2: ekran nadania pokazuje zawartość paczki (pozycje), tylko do odczytu', async () => {
    const { serwer, id } = zServerem({
      nad: {
        pozycje: [{
          klucz: 'k1', nazwa: 'Szablon malarski Liście monstery', sku: 'SZM-MON-6090',
          ilosc: 2, cena_brutto: '110.00', cena_netto: '89.43', vat: 23,
        }],
      },
    });
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).toContain('Szablon malarski Liście monstery');
    expect(r.body).toContain('SZM-MON-6090');
    // Tylko do odczytu: żadnego formularza edycji ani przycisku usuwania pozycji.
    expect(r.body).not.toContain('Usuń');
    expect(r.body).not.toContain('/pozycje/zapisz');
    expect(r.body).not.toContain('Zapisz pozycje');
  });

  // Zadanie 3: trzy przyciski w stopce, „Anuluj" jest LINKIEM (button wysłałby formularz
  // i nadał paczkę — patrz przewodnik OMS).
  it('Zadanie 3: stopka ma trzy akcje, „Anuluj" jest odnośnikiem, nie przyciskiem', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).toContain('name="zatwierdzenie" value="nadaj">Nadaj przesyłkę<');
    expect(r.body).toContain('name="zatwierdzenie" value="nadaj_i_drukuj">Nadaj i drukuj<');
    expect(r.body).toMatch(/<a[^>]*href="\/zamowienia\/\d+"[^>]*>Anuluj<\/a>/);
  });

  it('formularz jest wypełniony wartościami domyślnymi właściciela: 1 kg / 110×75×1 cm', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).toContain(`value="${PACZKA_DOMYSLNA.waga}"`);
    expect(r.body).toContain(`value="${PACZKA_DOMYSLNA.dlugosc}"`);
    expect(r.body).toContain(`value="${PACZKA_DOMYSLNA.szerokosc}"`);
    expect(r.body).toContain(`value="${PACZKA_DOMYSLNA.wysokosc}"`);
  });

  // Zadanie 7 (paczkomaty InPost): ekran nadania dostał gałąź gabarytu A/B/C, ale DPD ma
  // zostać DOKŁADNIE taki, jak jest dziś — ani jednej zmiany w tej ścieżce. Ten test pilnuje
  // tego wprost, żeby regresja (np. przypadkowe pokazanie obu wariantów naraz) nie przeszła
  // niezauważona.
  it('Zadanie 7: DPD nadal ma pola wymiarów i NIE MA wyboru gabarytu paczkomatu', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).toContain('name="dlugosc"');
    expect(r.body).toContain('name="szerokosc"');
    expect(r.body).toContain('name="wysokosc"');
    expect(r.body).not.toContain('name="gabaryt"');
    expect(r.body).not.toContain('name="punkt_odbioru"');
  });

  // Doprecyzowanie właściciela (Zadanie „kolejka druku"): dwa przyciski zatwierdzające
  // w TYM SAMYM formularzu — „Nadaj przesyłkę" (zapisuje numer listu) i „Nadaj i drukuj"
  // (to samo, plus wstawienie etykiety do kolejki druku). Oba niosą własną tożsamość
  // w `name="zatwierdzenie"`, żeby trasa POST mogła je rozróżnić bez zgadywania.
  it('dwa przyciski zatwierdzające: „Nadaj przesyłkę" i „Nadaj i drukuj"', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).toContain('name="zatwierdzenie" value="nadaj">Nadaj przesyłkę<');
    expect(r.body).toContain('name="zatwierdzenie" value="nadaj_i_drukuj">Nadaj i drukuj<');
    expect(r.body).not.toContain('Nadaj paczkę');
  });

  // Dokładnie scenariusz z briefu: zamówienie założone w adminie sklepu potrafi mieć
  // całkowicie pusty blok `shipping`.
  it('pusty blok shipping → wyraźne ostrzeżenie przy KAŻDYM brakującym polu (ulica, kod, miasto)', async () => {
    const { serwer, id } = zServerem({ nad: { dostawa: { first_name: '', last_name: '', address_1: '', postcode: '', city: '', country: '' } } });
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    const wystapienia = (r.body.match(/BRAK — DPD wymaga tego pola/g) ?? []).length;
    expect(wystapienia).toBe(3);
  });

  it('brakuje tylko kodu pocztowego → ostrzeżenie tylko przy tym polu', async () => {
    const { serwer, id } = zServerem({ nad: { dostawa: { ...zmapowane().dostawa, postcode: '' } } });
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    const wystapienia = (r.body.match(/BRAK — DPD wymaga tego pola/g) ?? []).length;
    expect(wystapienia).toBe(1);
  });

  it('kompletny adres → BRAK ostrzeżeń o brakujących polach', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).not.toContain('BRAK — DPD wymaga tego pola');
  });

  // ⚠️ ZMIANA Z4 (2026-08-05): kwota pobrania przestala byc TEKSTEM („POBRANIE: 212.90 zl")
  // i stala sie POLEM EDYTOWALNYM, wypelnionym dzisiejsza kwota efektywna. Ten test pilnuje
  // dalej dokladnie tego samego, co pilnowal: ze operator widzi kwote, zanim zatwierdzi.
  // Komplet regul pola (kiedy istnieje, co znaczy puste, co jedzie do koperty) ma wlasny
  // plik — tests/oms/kwota-pobrania-nadania.test.js.
  it('pobranie → kwota pobrania jest widoczna wyraźnie, jako pole do potwierdzenia', async () => {
    const { serwer, id } = zServerem({ nad: { metoda_wysylki: 'dpd', pobranie: 1, kwota_pobrania: '212.90' } });
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).toMatch(/Kwota pobrania/i);
    expect(r.body).toContain('name="kwota_pobrania"');
    expect(r.body).toContain('212.90');
  });

  it('metoda zwykła (bez pobrania) → BRAK wzmianki o pobraniu', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).not.toMatch(/POBRANIE/);
  });

  // Kraj NIE jest polem operatora (panel obsluguje wylacznie przesylki krajowe) — ekran
  // ma go niesc dalej jako ukryte pole formularza, zeby odmowa dla zagranicy (nizej)
  // dalej dzialala takze PO tym, jak reszta adresu stala sie edytowalna.
  it('kraj zamówienia idzie do formularza jako ukryte pole, nie edytowalne', async () => {
    const { serwer, id } = zServerem({ nad: { dostawa: { ...zmapowane().dostawa, country: 'GB' } } });
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).toContain('type="hidden" name="kraj" value="GB"');
  });
});

// ——— ODNOŚNIK Z POZYCJI NA EKRANIE NADANIA ————————————————————————————————————————
//
// ⚠️ TEN OPIS ISTNIEJE PRZEZ KONKRETNĄ AWARIĘ, a nie dla kompletu. Gałąź `feat/oms-ekran-nadania`
// dołożyła na tym ekranie DRUGIE wywołanie `adresProduktu(baseUrl, w)`, a `master` w tym
// samym czasie zamienił ten moduł na `link-pozycji.js` z `odnosnikPozycji(z, w, …)`.
// Scalenie przeszło BEZ KONFLIKTU (git widział zmiany w różnych miejscach pliku) i zostawiło
// wywołanie funkcji, której już nie ma — `ReferenceError` na GET /zamowienia/:id/nadaj.
//
// Testy niżej ładują TRASĘ i renderują PRAWDZIWY HTML z pozycjami, w obu kanałach — bo tylko
// to sprawdza rzecz, która się zepsuła. Asercja na wartości zmiennej w widoku przeszłaby
// mimo wszystko.
//
// Reguła ma być TA SAMA, co na karcie zamówienia (tests/oms/karta-wyglad.test.js): odnośnik
// wisi na miniaturze, a gdy miniatury nie ma — na nazwie. Bez tego drugiego pozycja z Allegro
// nie ma na czym powiesić linku (Allegro nie oddaje zdjęcia pozycji).
describe('GET /zamowienia/:id/nadaj — pozycja prowadzi do swojego źródła', () => {
  const configZeSklepem = { auth: { user: 'adam', pass: 'x' }, sklepy: { pro: { baseUrl: 'https://pro.szkicownia.pl' } } };
  const ZDJECIE = 'https://pro.szkicownia.pl/wp-content/uploads/2026/07/szablon.jpg';

  // Własny wariant `zServerem` — inny sklep (kanał!) i konfiguracja z `baseUrl`. Reszta
  // pliku celowo pracuje na config bez sklepów, żeby nie zależała od adresu, którego
  // nie sprawdza.
  // ⚠️ `query` doszlo 2026-08-07. Zamowienie z Allegro dostaje teraz NAJPIERW ekran wyboru
  // kuriera (panel nie zna kuriera dla tego kanalu — patrz domain/kurier-nadania.js), wiec
  // formularz z tabela pozycji jest pod `?kurier=...`. Regula odnosnika sie NIE ZMIENILA —
  // zmienil sie adres, pod ktorym stoi ekran, ktory ja renderuje.
  const ekran = async ({ sklep = 'pro', nad = {}, config: cfg = configZeSklepem, query = '' } = {}) => {
    const katalogEtykiet = mkdtempSync(join(tmpdir(), 'oms-nadaj-link-'));
    const nadanie = createNadanie({
      db, kurierzy: { dpd: dpdKlient().dpd }, woo: { dodajNotatke: vi.fn() }, katalogEtykiet,
    });
    const serwer = buildOmsServer({ db, config: cfg, poller, nadanie });
    const id = zapiszZamowienie(db, sklep, zmapowane(nad), {});
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj${query}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    return r.body;
  };

  it('pozycja ze sklepu — odnośnik na miniaturze, tak jak na karcie', async () => {
    const html = await ekran({
      nad: {
        pozycje: [{
          nazwa: 'Szablon STOP', sku: 'PRO-1', ilosc: 1, cena_brutto: '100.00',
          brutto_linii: '100.00', vat: 23, zdjecie_url: ZDJECIE, produkt_id: 28040,
        }],
      },
    });
    // EJS escapuje `&` w `<%= %>`, więc w HTML-u jest `&amp;`, nie surowe `&`.
    expect(html).toContain('?post_type=product&amp;p=28040');
    expect(html).toContain('title="Otwórz produkt w sklepie"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  // ⚠️ POZYCJA Z ALLEGRO NIE MA MINIATURY (`zdjecie_url: null` w allegro-mapowanie.js).
  // Odnośnik przypięty WYŁĄCZNIE do obrazka nie pokazałby się w tym kanale ANI RAZU.
  it('pozycja z Allegro — odnośnik na nazwie, bo miniatury nie ma', async () => {
    const html = await ekran({
      sklep: 'allegro_szkicownia',
      query: '?kurier=dpd',
      nad: {
        metoda_wysylki: 'allegro_dpd',
        pozycje: [{
          nazwa: 'Lampa stołowa Mosiądz 30 cm', sku: null, ilosc: 1,
          cena_brutto: '100.00', brutto_linii: '100.00', vat: 23,
          zdjecie_url: null, produkt_id: null, oferta_id: '9000000001',
        }],
      },
    });
    expect(html).toContain('href="https://allegro.pl/oferta/9000000001"');
    expect(html).toContain('title="Otwórz ofertę na Allegro"');
    expect(html).toContain('rel="noopener noreferrer"');
    // Kanał Allegro nie ma `baseUrl` — adres sklepowy nie ma prawa się tu pojawić.
    expect(html).not.toContain('?post_type=product');
  });

  // Brak identyfikatora = BRAK odnośnika, a nie `allegro.pl/oferta/` — reguła repo
  // z domain/tracking.js: link donikąd jest gorszy niż jego brak.
  it('pozycja z Allegro bez identyfikatora oferty nie dostaje odnośnika', async () => {
    const html = await ekran({
      sklep: 'allegro_szkicownia',
      query: '?kurier=dpd',
      nad: {
        metoda_wysylki: 'allegro_dpd',
        pozycje: [{
          nazwa: 'Pozycja bez oferty', sku: null, ilosc: 1, cena_brutto: '100.00',
          brutto_linii: '100.00', vat: 23, zdjecie_url: null, produkt_id: null, oferta_id: null,
        }],
      },
    });
    expect(html).toContain('Pozycja bez oferty');
    expect(html).not.toContain('allegro.pl/oferta');
    expect(html).not.toContain('title="Otwórz ofertę na Allegro"');
  });

  // Pozycja SKLEPOWA ZE ZDJĘCIEM zostaje bez zmian: odnośnik dalej na miniaturze, nazwa
  // goła. Jedna reguła, dwa nośniki — nigdy dwa naraz w jednym wierszu.
  it('pozycja sklepowa ze zdjęciem trzyma odnośnik na miniaturze, nie na nazwie', async () => {
    const html = await ekran({
      nad: {
        pozycje: [{
          nazwa: 'Szablon STOP', sku: 'PRO-1', ilosc: 1, cena_brutto: '100.00',
          brutto_linii: '100.00', vat: 23, zdjecie_url: ZDJECIE, produkt_id: 28040,
        }],
      },
    });
    expect(html).not.toMatch(/<a[^>]*>Szablon STOP<\/a>/);
  });
});

// Kraj NIE jest edytowalny, ale MUSI nadal dotrzeć do dpd.js jako część adresu z
// formularza (ukryte pole) — inaczej ekran nadania po tej zmianie po cichu przestałby
// chronić przed przesyłką zagraniczną, mimo że sam mechanizm odmowy w dpd.js zostaje.
describe('POST /zamowienia/:id/nadaj — kraj (ukryte pole) dalej blokuje przesyłki zagraniczne', () => {
  it('zamówienie zagraniczne → POST odmawia, DPD NIETKNIĘTE, tak jak przed edytowalnym adresem', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: { dostawa: { ...zmapowane().dostawa, country: 'GB' } } });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kraj: 'GB' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/zagraniczne/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('POST /zamowienia/:id/nadaj — walidacja wagi i wymiarów', () => {
  it('poprawne wartości → nadaje paczkę z DOKŁADNIE podaną wagą i wymiarami', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA });
    expect(r.statusCode).toBe(302);
    const body = fetchImpl.mock.calls[0][1].body;
    expect(body).toContain('<weight>1</weight>');
    expect(body).toContain('<sizeX>110</sizeX>');
    expect(body).toContain('<sizeY>75</sizeY>');
    expect(body).toContain('<sizeZ>1</sizeZ>');
  });

  it('inna waga niż domyślna → DPD dostaje TĘ wagę, nie 1 kg / 40×30×10 z dawnej stałej', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { waga: '3.5', dlugosc: '20', szerokosc: '15', wysokosc: '10', kolejnosc: '1', ...ADRES },
    });
    const body = fetchImpl.mock.calls[0][1].body;
    expect(body).toContain('<weight>3.5</weight>');
    expect(body).toContain('<sizeX>20</sizeX>');
    expect(body).not.toContain('<weight>1</weight>');
  });

  it('przecinek dziesiętny w wadze („1,5") jest akceptowany, nie odrzucany', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA, waga: '1,5' },
    });
    expect(r.statusCode).toBe(302);
    expect(fetchImpl.mock.calls[0][1].body).toContain('<weight>1.5</weight>');
  });

  it('waga nieliczbowa → 400, czytelny komunikat, DPD NIETKNIĘTE', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA, waga: 'dużo' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/większą od zera/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('wymiar ujemny → 400, DPD NIETKNIĘTE, żadna rezerwacja przesyłki nie powstaje', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA, dlugosc: '-110' },
    });
    expect(r.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(pobierzZamowienie(db, id).przesylki).toEqual([]);
  });

  it('waga zero → 400 (musi być WIĘKSZA od zera)', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA, waga: '0' },
    });
    expect(r.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('brak pól paczki w ogóle → 400, nie ciche podstawienie wartości domyślnej', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: {} });
    expect(r.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('nieistniejące zamówienie → 404', async () => {
    const { serwer } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: '/zamowienia/9999/nadaj', headers: naglowek, payload: PACZKA });
    expect(r.statusCode).toBe(404);
  });
});

// Zadanie „adres edytowalny": puste pole adresu WYMAGANE PRZEZ DPD (ulica/kod/miasto) ma
// BLOKOWAĆ zatwierdzenie — dawniej (adres tylko do odczytu) to samo ostrzeżenie w widoku
// wyłącznie podświetlało pole, NIE zatrzymując POST-a przed wywołaniem DPD.
describe('POST /zamowienia/:id/nadaj — walidacja adresu odbiorcy', () => {
  // ⚠️ MUTACJA OBOWIĄZKOWA z briefu: „puste pole wymagane przepuszczone do DPD" musi
  // zaczerwienić każdy z tych testów.
  it.each([
    ['ulica', { ...PACZKA, ulica: '' }],
    ['kod', { ...PACZKA, kod: '' }],
    ['miasto', { ...PACZKA, miasto: '' }],
  ])('puste wymagane pole adresu (%s) → 400, czytelny komunikat, DPD NIETKNIĘTE', async (_pole, payload) => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/adres/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('puste wymagane pole adresu → żadna rezerwacja przesyłki nie powstaje (jak przy błędnych wymiarach)', async () => {
    const { dpd } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, miasto: '' } });
    expect(pobierzZamowienie(db, id).przesylki).toEqual([]);
  });

  it('same białe znaki w polu wymaganym → traktowane jak puste, 400', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, ulica: '   ' } });
    expect(r.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('kompletny adres (bez zmian wobec wartości z GET) → 302, nadanie się udaje', async () => {
    const { dpd } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA });
    expect(r.statusCode).toBe(302);
  });
});

// „Nadaj i drukuj" — drugi przycisk zatwierdzający na ekranie nadania (name="zatwierdzenie"
// value="nadaj_i_drukuj"). Znaczenie z briefu: „nadaj, a etykietę wstaw do kolejki" — NIE
// „nadaj tylko wtedy, gdy drukarka odpowiada".
describe('POST /zamowienia/:id/nadaj — „Nadaj i drukuj" (kolejka druku)', () => {
  it('zwykłe „Nadaj przesyłkę" (value=nadaj) NIE wstawia nic do kolejki druku, nawet gdy ZPL istnieje', async () => {
    const { dpd } = dpdKlientZZpl();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, zatwierdzenie: 'nadaj' },
    });
    expect(r.statusCode).toBe(302);
    expect(db.prepare('SELECT COUNT(*) c FROM kolejka_druku').get().c).toBe(0);
  });

  it('„Nadaj i drukuj" nadaje paczkę I wstawia pozycję do kolejki druku', async () => {
    const { dpd } = dpdKlientZZpl();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, zatwierdzenie: 'nadaj_i_drukuj' },
    });
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).przesylki[0].status).toBe('nadana');
    const wiersz = db.prepare('SELECT * FROM kolejka_druku').get();
    expect(wiersz).toBeTruthy();
    expect(wiersz.status).toBe('oczekuje');
  });

  // MUTACJA OBOWIĄZKOWA z briefu: „błąd wstawienia do kolejki wywala Nadaj i drukuj"
  // musi zaczerwienić ten test. Symulujemy PRAWDZIWĄ awarię bazy (nie atrapę funkcji):
  // brak tabeli kolejka_druku sprawia, że dodajDoKolejki naprawdę rzuca wyjątkiem SQL-a.
  it('awaria wstawienia do kolejki NIE cofa ani nie blokuje udanego nadania', async () => {
    const { dpd } = dpdKlientZZpl();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    db.exec('DROP TABLE kolejka_druku');
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, zatwierdzenie: 'nadaj_i_drukuj' },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${id}`);
    const p = pobierzZamowienie(db, id).przesylki[0];
    expect(p.status).toBe('nadana');
    expect(p.numer_listu).toBeTruthy();
    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'kolejka-druku.dodanie'").get(id);
    expect(wpis.wynik).toContain('BŁĄD');
  });

  // Zgaszony komputer produkcyjny (brak ZPL-a od DPD) nie ma prawa zatrzymać wysyłki —
  // dokładnie scenariusz z briefu.
  it('brak ZPL-a od DPD (drukarka/kolejka nieosiągalna) → nadanie i tak się udaje, kolejka pusta', async () => {
    const { dpd } = dpdKlient(); // celowo tylko 2 atrapy — ZPL "zawodzi"
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, zatwierdzenie: 'nadaj_i_drukuj' },
    });
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).przesylki[0].status).toBe('nadana');
    expect(db.prepare('SELECT COUNT(*) c FROM kolejka_druku').get().c).toBe(0);
  });
});

// ⚠️ NAJWAŻNIEJSZY TEST TEGO ZADANIA. Od Zadania „adres edytowalny" niezmiennik BRZMI
// INACZEJ niż dawniej: nie „ekran i DPD czytają to samo z zamówienia" (adres jest teraz
// formularzem, więc operator MOŻE go świadomie zmienić), tylko „do DPD leci DOKŁADNIE to,
// co było w formularzu w chwili zatwierdzenia" — GET pokazuje wartości startowe z
// adresOdbiorcy(zamowienie), a to, co POST faktycznie wyśle (czy to te same wartości, czy
// poprawione przez operatora), jest jedynym, co dotrze do kuriera. Gdyby POST (albo
// nadanie.js, albo dpd.js) po cichu wrócił do czytania adresu z ZAMÓWIENIA zamiast z
// PRZYSŁANEGO formularza, poprawka operatora byłaby POZORNA: ekran pokazywałby jeden
// adres, a do kuriera pojechałby inny (stary) — to najgroźniejszy możliwy błąd w całym
// zadaniu.
describe('ekran nadania i POST /nadaj: do DPD leci DOKŁADNIE to, co było w formularzu (anty-rozjazd)', () => {
  it('GET wypełnia formularz wartościami z adresOdbiorcy(zamówienia) — bez zmian wobec dziś', async () => {
    const MARKER = 'Zaznacz-Mnie-Unikalnie-9137';
    const { serwer, id } = zServerem({ nad: { dostawa: { ...zmapowane().dostawa, first_name: MARKER } } });
    await serwer.ready();
    const ekran = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(ekran.statusCode).toBe(200);
    expect(ekran.body).toContain(MARKER);
  });

  // Scenariusz „operator niczego nie poprawił": formularz wraca do POST z DOKŁADNIE tymi
  // wartościami, którymi GET go wypełnił (tak zachowałaby się prawdziwa przeglądarka).
  it('operator zatwierdza formularz BEZ zmian → DPD dostaje wartości z adresOdbiorcy(zamówienia)', async () => {
    const MARKER = 'Zaznacz-Mnie-Unikalnie-9137';
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: { dostawa: { ...zmapowane().dostawa, first_name: MARKER } } });
    await serwer.ready();
    const wyslanie = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA, nazwa: MARKER, company: MARKER },
    });
    expect(wyslanie.statusCode).toBe(302);
    expect(fetchImpl.mock.calls[0][1].body).toContain(MARKER);
  });

  // ⚠️ TO JEST DOWÓD, ŻE EDYCJA NIE JEST POZORNA. Operator POPRAWIA adres na ekranie —
  // formularz do POST niesie WARTOŚĆ INNĄ niż ta w zamówieniu ze sklepu. Sprawdzamy WPROST,
  // że do DPD pojechała wersja POPRAWIONA, a NIE oryginalny adres zamówienia (którego w tym
  // teście operator nigdy nawet nie widział na wejściu — payload jest jedynym źródłem).
  it('operator POPRAWIA miasto w formularzu → DPD dostaje POPRAWIONĄ wartość, NIE oryginalny adres zamówienia', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    // Zamówienie w sklepie ma miasto 'Pęki' (zmapowane() domyślnie) — operator w tym
    // teście wysyła formularz z INNYM miastem, jakby poprawił literówkę albo adres dosyłki.
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const wyslanie = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA, miasto: 'Miasto-Po-Poprawce-Operatora', ulica: 'Ulica-Po-Poprawce-Operatora' },
    });
    expect(wyslanie.statusCode).toBe(302);
    const kopertaDoDpd = fetchImpl.mock.calls[0][1].body;
    const receiver = kopertaDoDpd.match(/<receiver>[\s\S]*?<\/receiver>/)[0];
    expect(receiver).toContain('Miasto-Po-Poprawce-Operatora');
    expect(receiver).toContain('Ulica-Po-Poprawce-Operatora');
    // Kontrola negatywna: gdyby POST/nadanie.js/dpd.js po cichu wrócił do adresu z
    // zamówienia (edycja pozorna), <receiver> niósłby ORYGINALNE miasto zamówienia
    // ('Pęki' — patrz zmapowane().dostawa) zamiast poprawki operatora. Sprawdzamy
    // WYŁĄCZNIE <receiver>, nie całą kopertę: <sender> (nadawca, NADAWCA) legalnie
    // niesie 'Pęki' jako WŁASNE miasto i nie ma nic wspólnego z tą poprawką.
    expect(receiver).not.toContain('>Pęki<');
  });

  it('to samo dla miasta bez edycji — pole niebędące pierwszym w formularzu też musi się zgadzać', async () => {
    const MARKER = 'Miasto-Unikalne-4471';
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: { dostawa: { ...zmapowane().dostawa, city: MARKER } } });
    await serwer.ready();
    const ekran = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(ekran.body).toContain(MARKER);

    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, miasto: MARKER },
    });
    expect(fetchImpl.mock.calls[0][1].body).toContain(`<city>${MARKER}</city>`);
  });
});

describe('ekran nadania startuje wartościami z ustawień', () => {
  // ⚠️ Ten test jest o OKABLOWANIU, nie o regule. Reguła (domain/ustawienia-panelu.js) ma
  // własną suitę i świeci na zielono także wtedy, gdy trasa czyta stałą z kodu — a wtedy
  // panel wysyła do DPD paczkę o wymiarach sprzed zmiany, bez żadnego objawu na ekranie.
  it('formularz nadania pokazuje wymiary zapisane w ustawieniach', async () => {
    const { dpd } = dpdKlient();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszUstawienia(db, {
      'paczka.waga': '3', 'paczka.dlugosc': '60', 'paczka.szerokosc': '40', 'paczka.wysokosc': '20',
    });
    const nadanie = createNadanie({ db, kurierzy: { dpd }, katalogEtykiet: mkdtempSync(join(tmpdir(), 'oms-')) });
    const app = buildOmsServer({ db, config, poller, nadanie });
    await app.ready();

    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });

    expect(r.body).toContain('name="waga" value="3"');
    expect(r.body).toContain('name="dlugosc" value="60"');
    expect(r.body).toContain('name="szerokosc" value="40"');
    expect(r.body).toContain('name="wysokosc" value="20"');
  });

  it('bez ustawień formularz startuje dzisiejszymi wartościami panelu', async () => {
    const { dpd } = dpdKlient();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const nadanie = createNadanie({ db, kurierzy: { dpd }, katalogEtykiet: mkdtempSync(join(tmpdir(), 'oms-')) });
    const app = buildOmsServer({ db, config, poller, nadanie });
    await app.ready();

    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });

    expect(r.body).toContain(`name="waga" value="${PACZKA_DOMYSLNA.waga}"`);
    expect(r.body).toContain(`name="dlugosc" value="${PACZKA_DOMYSLNA.dlugosc}"`);
  });

  // ⚠️ NADANIE ZBIORCZE NIE MA FORMULARZA — paczka jedzie do DPD wprost, bez człowieka
  // pośrodku. To jedyne miejsce, w którym zła wartość w ustawieniach staje się złą etykietą
  // bez ani jednej okazji, żeby to zobaczyć.
  it('podgląd nadania zbiorczego pokazuje wymiary z ustawień', async () => {
    const { dpd } = dpdKlient();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszUstawienia(db, {
      'paczka.waga': '3', 'paczka.dlugosc': '60', 'paczka.szerokosc': '40', 'paczka.wysokosc': '20',
    });
    const nadanie = createNadanie({ db, kurierzy: { dpd }, katalogEtykiet: mkdtempSync(join(tmpdir(), 'oms-')) });
    const app = buildOmsServer({ db, config, poller, nadanie });
    await app.ready();

    const r = await app.inject({
      method: 'POST', url: '/zamowienia/masowe/nadaj-podglad',
      headers: naglowek,
      payload: { id: String(id) },
    });

    expect(r.body).toContain('3 kg');
    expect(r.body).toContain('60 × 40 × 20 cm');
  });

  // ⚠️⚠️ NAJWAŻNIEJSZY TEST TEGO ZADANIA. Nadanie zbiorcze wysyła paczkę do DPD BEZ
  // formularza i bez człowieka pośrodku — to jedyna droga, którą wymiary jadą do kuriera
  // niezobaczone. Sprawdzamy KOPERTĘ, a nie ekran: podgląd może pokazywać cokolwiek,
  // liczy się to, co naprawdę poszło w <sizeX>.
  it('nadanie zbiorcze wysyła do DPD wymiary z ustawień, nie stałą z kodu', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszUstawienia(db, {
      'paczka.waga': '3', 'paczka.dlugosc': '60', 'paczka.szerokosc': '40', 'paczka.wysokosc': '20',
    });
    const nadanie = createNadanie({
      db, kurierzy: { dpd }, woo: { dodajNotatke: vi.fn().mockResolvedValue({}) },
      katalogEtykiet: mkdtempSync(join(tmpdir(), 'oms-')),
    });
    const app = buildOmsServer({ db, config, poller, nadanie });
    await app.ready();

    await app.inject({
      method: 'POST', url: '/zamowienia/masowe/nadaj', headers: naglowek, payload: { id: String(id) },
    });

    expect(fetchImpl).toHaveBeenCalled();
    const koperta = fetchImpl.mock.calls[0][1].body;
    expect(koperta).toContain('<weight>3</weight>');
    expect(koperta).toContain('<sizeX>60</sizeX>');
    expect(koperta).toContain('<sizeY>40</sizeY>');
    expect(koperta).toContain('<sizeZ>20</sizeZ>');
  });
});
