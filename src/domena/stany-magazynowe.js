// STANY MAGAZYNOWE (PRZ-091, decyzje właściciela 17.10.2026) — reguły czyste, bez bazy i bez HTTP.
//
// ⚠️⚠️ ROZCHÓD Z ZAMÓWIEŃ JEST WYLICZANY, A NIE ZAPISYWANY RUCHEM. Pozycje zamówień z kanałów są przy każdym
// odczycie kasowane i wstawiane od nowa (oms/db/zamowienia.js, `zapiszPozycje`), zamówienie bywa poprawiane ręcznie
// (`pozycje_reczne_json`), anulowane w kanale albo przy panelu i przywracane. Ruch zapisywany przy każdej z tych dróg
// to kilka miejsc do pilnowania i podwójne odjęcie przy pierwszym przeoczonym. Wyliczenie z bieżących pozycji
// daje przy każdym z tych zdarzeń tę samą liczbę — idempotencja z definicji, nie z dyscypliny.
//
//   stan(karta) = Σ ruchów ręcznych (otwarcie, przyjęcie, korekta)
//               − Σ ilości z pozycji zamówień nieanulowanych, złożonych od chwili włączenia stanów,
//                 powiązanych z kartą JEDNOZNACZNIE.
//
// Koszt przyjęty świadomie: przepięcie oferty do innej karty zmienia stan wstecz (od chwili włączenia).
//
// ⚠️ ŻADNEGO DOPASOWANIA PO NAZWIE ANI PO SKU. Pozycja, której nie da się przypiąć do karty po identyfikatorze
// produktu/wariantu/oferty, trafia na listę „pozycje bez karty” i nie rusza stanu. Zgadnięty towar to stan,
// który kłamie po cichu w obie strony.

/** Rodzaje ruchów ręcznych — jedna lista dla migracji (CHECK), formularza i ekranu. */
export const RODZAJE_RUCHU = Object.freeze(['otwarcie', 'przyjecie', 'korekta']);
export const ETYKIETY_RUCHU = Object.freeze({ otwarcie: 'stan otwarcia', przyjecie: 'przyjęcie', korekta: 'korekta' });

const napis = (x) => (x === null || x === undefined ? '' : String(x).trim());

/**
 * Statusy WooCommerce, w których zamówienia NIE MA jako zakupu: nieudana płatność, kosz, szkic koszyka.
 * ⚠️ `refunded` CELOWO NIE: zwrot pieniędzy nie oznacza, że towar wrócił — stan rośnie dopiero po przyjęciu
 * (korekta na karcie), tak jak w planie stanów (wiki „Twój OMS — stany magazynowe i zwroty”). `pending` też nie:
 * decyzja „rozchód od razu przy zamówieniu”.
 */
export const STATUSY_WOO_BEZ_ROZCHODU = Object.freeze(['failed', 'trash', 'checkout-draft']);

/**
 * Czy zamówienie zdejmuje towar. Anulowane (w kanale albo ręcznie przy panelu) — nie; w statusie Woo bez zakupu — nie.
 * ⚠️ Anulowanie: ten sam warunek co `czyAnulowane` w domena/status-reczny.js (suma logiczna obu kolumn).
 * Ten sam warunek stoi w SQL grup (oms/db/stany-magazynowe.js) — pilnuje go test na obu drogach.
 */
export function zamowienieZdejmuje(z) {
  if (STATUSY_WOO_BEZ_ROZCHODU.includes(String(z?.status_woo ?? ''))) return false;
  return !(Number(z?.anulowane) || Number(z?.anulowane_recznie));
}

/**
 * Karta, z którą pozycja jest powiązana — albo powód, dla którego nie jest.
 *
 * @param {object} p pozycja (efektywna, po nadpisaniach): `oferta_id`, `produkt_id`, `wariant_id`, `zrodlo`
 * @param {string} kanal kanał zamówienia (`zamowienia.sklep`)
 * @param {(zapytanie: {kanal: string|null, produktId: string, wariantId: string|null}) => number[]} kartyLustra
 *   różne `karta_id` wierszy lustra pasujących do identyfikatora (`kanal: null` = dowolny kanał sklepu)
 * @returns {{ kartaId: number } | { kartaId: null, powod: string } | null} `null` = pozycja bez towaru
 *   (bez identyfikatora produktu: dopłata, usługa, pozycja wpisana z ręki) — nie śledzimy jej wcale
 */
export function kartaPozycji(p, kanal, kartyLustra) {
  const oferta = napis(p?.oferta_id);
  const produkt = napis(p?.produkt_id);
  const wariant = napis(p?.wariant_id) || null;
  if (!oferta && !produkt) return null;

  const zapytanie = oferta
    ? { kanal, produktId: oferta, wariantId: null }
    // Pozycja ręczna „z magazynu” nie niesie kanału cennika — szukamy po identyfikatorze we wszystkich sklepach.
    : { kanal: p?.zrodlo === 'reczna' ? null : kanal, produktId: produkt, wariantId: wariant };
  // ⚠️ WIERSZ LUSTRA BEZ KARTY TEŻ SIĘ LICZY (`null`). Identyfikator pasujący do dwóch wierszy, z których jeden ma kartę,
  // a drugi nie (dwa sklepy z tym samym numerem produktu, wariant bez karty), nie jest jednoznaczny — wybranie jedynej
  // karty zdejmowałoby z niej towar cicho, a lista „bez karty” milczałaby (recenzja PRZ-091).
  const wszystkie = [...new Set(kartyLustra(zapytanie).map((k) => (k === null || k === undefined ? null : Number(k))))];
  const karty = wszystkie.filter((k) => k !== null);
  if (karty.length === 1 && wszystkie.length === 1) return { kartaId: karty[0] };
  if (!karty.length) {
    return { kartaId: null, powod: oferta
      ? 'oferta nie jest powiązana z żadną kartą produktu'
      : 'produkt ze sklepu nie jest powiązany z żadną kartą produktu' };
  }
  return { kartaId: null, powod: wariant
    ? 'ten sam identyfikator wariantu ma kilka kart — nie zgaduję, którą zdjąć'
    : 'produkt ma kilka wariantów z różnymi kartami, a zamówienie nie mówi, który kupiono' };
}

/**
 * Zużycie kart z zamówień: `Map karta_id → ilość` oraz lista pozycji bez karty.
 *
 * @param {Array<{ zamowienie: object, pozycje: object[] }>} zamowienia zamówienia od granicy, z pozycjami
 *   EFEKTYWNYMI (po ręcznych poprawkach ilości — ta sama ilość, co na fakturze)
 */
export function zuzycieZZamowien(zamowienia, kartyLustra) {
  const zuzycie = new Map();
  const bezKarty = [];
  for (const { zamowienie, pozycje } of zamowienia ?? []) {
    if (!zamowienieZdejmuje(zamowienie)) continue;
    for (const p of pozycje ?? []) {
      const ilosc = Number(p?.ilosc);
      if (!Number.isInteger(ilosc) || ilosc <= 0) continue;
      const wynik = kartaPozycji(p, zamowienie.sklep, kartyLustra);
      if (wynik === null) continue;
      if (wynik.kartaId === null) {
        bezKarty.push({ zamowienie_id: zamowienie.id, numer: zamowienie.numer, sklep: zamowienie.sklep,
          nazwa: p.nazwa, ilosc, powod: wynik.powod });
        continue;
      }
      zuzycie.set(wynik.kartaId, (zuzycie.get(wynik.kartaId) ?? 0) + ilosc);
    }
  }
  return { zuzycie, bezKarty };
}

/**
 * Zużycie z GRUP pozycji zsumowanych w bazie (kanał, źródło, produkt, wariant, oferta → Σ ilości, liczba pozycji).
 * Ta sama reguła `kartaPozycji`, rozstrzygana RAZ na grupę zamiast raz na pozycję — pomiar PRZ-091: 15 000 zamówień
 * od granicy liczone pozycja po pozycji to 280–760 ms przy każdym otwarciu listy i karty zamówienia.
 * Grupy dostają wyłącznie zamówienia zdejmujące towar i bez ręcznych poprawek (te liczy `zuzycieZZamowien`).
 * @returns {{ zuzycie: Map<number, number>, bezKarty: number }} `bezKarty` — liczba POZYCJI bez karty
 */
export function zuzycieZGrup(grupy, kartyLustra) {
  const zuzycie = new Map();
  let bezKarty = 0;
  for (const g of grupy ?? []) {
    const ilosc = Number(g?.ilosc);
    if (!Number.isInteger(ilosc) || ilosc <= 0) continue;
    const wynik = kartaPozycji(g, g.sklep, kartyLustra);
    if (wynik === null) continue;
    if (wynik.kartaId === null) { bezKarty += Number(g.pozycji ?? 1); continue; }
    zuzycie.set(wynik.kartaId, (zuzycie.get(wynik.kartaId) ?? 0) + ilosc);
  }
  return { zuzycie, bezKarty };
}

// ——— FORMULARZE ——————————————————————————————————————————————————————————————

const LICZBA_CALKOWITA = /^[+-]?\d+$/u;

/**
 * Ruch ręczny z formularza karty. `{ ruch, blad }`.
 * Przyjęcie: liczba dodatnia. Korekta: liczba różna od zera, ze znakiem (−2 = ubytek). Powód obowiązkowy przy korekcie.
 * ⚠️ Klucz idempotencji przychodzi z ukrytego pola formularza — drugie kliknięcie tego samego formularza
 * niesie ten sam klucz i baza (UNIQUE) go nie wpuści.
 */
export function ruchZFormularza(body) {
  const rodzaj = napis(body?.rodzaj);
  const surowa = napis(body?.ilosc).replace(/\s+/gu, '');
  const powod = napis(body?.powod) || null;
  const klucz = napis(body?.klucz);
  if (!['przyjecie', 'korekta'].includes(rodzaj)) return { ruch: null, blad: 'Nieznany rodzaj ruchu — wybierz przyjęcie albo korektę.' };
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(klucz)) return { ruch: null, blad: 'Formularz jest nieaktualny — odśwież kartę i wpisz ruch jeszcze raz.' };
  if (!LICZBA_CALKOWITA.test(surowa)) return { ruch: null, blad: `„${napis(body?.ilosc)}” to nie jest liczba sztuk. Wpisz liczbę całkowitą.` };
  const ilosc = Number(surowa);
  if (rodzaj === 'przyjecie' && !(ilosc > 0)) return { ruch: null, blad: 'Przyjęcie musi być liczbą dodatnią — ubytek wpisz jako korektę.' };
  if (ilosc === 0) return { ruch: null, blad: 'Korekta o zero sztuk niczego nie zmienia.' };
  if (rodzaj === 'korekta' && !powod) return { ruch: null, blad: 'Korekta wymaga powodu (np. „inwentaryzacja”, „uszkodzone”).' };
  return { ruch: { rodzaj, ilosc, powod, klucz }, blad: null };
}

/**
 * Import stanu otwarcia: wiersze „SKU;ilość” (także tabulator albo przecinek) → plan.
 *
 * @param {string} tekst
 * @param {(sku: string) => {id: number, nazwa: string} | null} kartaPoSku
 * @param {Set<number>} maOtwarcie karty, które mają już stan otwarcia od bieżącej granicy
 * @returns {{ doZapisu: Array<{karta_id, nazwa, sku, ilosc}>, odrzucone: Array<{wiersz, tekst, powod}> }}
 *
 * ⚠️ PONOWNY IMPORT NIE PODWAJA ZAPASU: karta z otwarciem od tej granicy jest odrzucana z powodem
 * (zmianę robi się korektą), a ten sam SKU dwa razy w jednym pliku — odrzucony w obu wierszach.
 */
export function planImportuOtwarcia(tekst, kartaPoSku, maOtwarcie = new Set()) {
  const wiersze = String(tekst ?? '').split(/\r?\n/u).map((w, i) => ({ nr: i + 1, tekst: w.trim() }))
    .filter((w) => w.tekst && !/^sku[;,\t]/iu.test(w.tekst));
  const odrzucone = [];
  const kandydaci = [];
  for (const w of wiersze) {
    const czesci = w.tekst.split(/[;\t,]/u).map((c) => c.trim());
    if (czesci.length !== 2) { odrzucone.push({ wiersz: w.nr, tekst: w.tekst, powod: 'oczekuję dwóch pól: SKU i ilość' }); continue; }
    const [sku, ilosc] = czesci;
    if (!LICZBA_CALKOWITA.test(ilosc) || Number(ilosc) < 0) { odrzucone.push({ wiersz: w.nr, tekst: w.tekst, powod: 'ilość musi być liczbą całkowitą ≥ 0' }); continue; }
    const karta = kartaPoSku(sku);
    if (!karta) { odrzucone.push({ wiersz: w.nr, tekst: w.tekst, powod: `nie ma karty z SKU „${sku}”` }); continue; }
    kandydaci.push({ wiersz: w.nr, tekst: w.tekst, karta_id: karta.id, nazwa: karta.nazwa, sku, ilosc: Number(ilosc) });
  }
  const liczba = new Map();
  for (const k of kandydaci) liczba.set(k.karta_id, (liczba.get(k.karta_id) ?? 0) + 1);
  const doZapisu = [];
  for (const k of kandydaci) {
    if (liczba.get(k.karta_id) > 1) { odrzucone.push({ wiersz: k.wiersz, tekst: k.tekst, powod: 'ta sama karta występuje w pliku więcej niż raz' }); continue; }
    if (maOtwarcie.has(k.karta_id)) { odrzucone.push({ wiersz: k.wiersz, tekst: k.tekst, powod: 'karta ma już stan otwarcia — zmień go korektą na karcie' }); continue; }
    if (k.ilosc === 0) continue; // zero sztuk to stan domyślny, nie ruch
    doZapisu.push({ karta_id: k.karta_id, nazwa: k.nazwa, sku: k.sku, ilosc: k.ilosc });
  }
  odrzucone.sort((a, b) => a.wiersz - b.wiersz);
  return { doZapisu, odrzucone };
}
