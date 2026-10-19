import { ETYKIETY } from './status.js';
import { idsDolaczonych } from './scalanie.js';

// ⚠️ SEDNO: status w tym panelu NIE JEST KOLUMNA DO PRZESTAWIANIA — wynika z faktow
// (patrz wyliczStatus w domain/status.js). „Ustaw status X" znaczy wiec: ZAPISZ TAKI
// ZESTAW FAKTOW, zeby wyliczStatus oddal X. Ten plik jest czystym mapperem tej zamiany;
// zapisu do bazy nie robi (to db/zamowienia.js: zapiszFaktyStatusu).
//
// Dokladnie ten sam wzorzec dziala w panelu zamowien indywidualnych (domain/manual-status.js
// — factsForStatus). Powod jest w obu miejscach ten sam: dopoki status jest wynikiem, lista
// i karta nie moga sie rozjechac, a cofniecie faktu cofa status samo. Kolumna `status`
// zaczelaby zyc wlasnym zyciem juz przy pierwszej paczce nadanej z innego ekranu.

// Statusy osiagalne RECZNIE.
//
// ⚠️ „wyslane" JEST TU od 2026-07-31 i to jest zmiana wobec pierwotnej zasady. Wczesniej
// status ten wynikal z istnienia nadanej paczki, wiec ustawienie go wprost byloby zdaniem
// o stanie u kuriera, ktore panel zmyslil. Dzis wynika z wlasnego faktu (`wyslane_at`),
// bo etykieta powstaje przy PAKOWANIU, a paczka wyjezdza dopiero z kurierem — panel nie
// zna momentu wyjazdu i nie ma jak go zgadnac. Zna go czlowiek, wiec to on go zapisuje.
// ⚠️ „zwrot" ZNIKL STAD 08.2026 i to nie jest przeoczenie. Zwrot niesie od tej pory kwote
// i pozycje (tabela `zwroty`), a druga droga ustawiajaca sam status produkowalaby
// zwroty-widma: niewidoczne w raporcie, bez korekty, bez kwoty. Rejestracja idzie przez
// /zamowienia/:id/zwrot. `faktyDlaStatusu` ma nadal galaz 'zwrot' wylacznie po to, zeby
// nie zmieniac zachowania dla zamowien ze starym `zwrot_at` — nikt jej juz nie wola.
export const STATUSY_RECZNE = ['nowe', 'w_realizacji', 'wyslane', 'anulowane'];

// Etykiety bierzemy z ETYKIETY, a nie przepisujemy: druga kopia rozjechalaby sie z lista
// i z panelem bocznym przy pierwszej zmianie nazwy.
export const OPCJE_STATUSU = STATUSY_RECZNE.map((klucz) => ({ klucz, etykieta: ETYKIETY[klucz] }));

// Anulowanie ma DWA niezalezne zrodla i trzeba je umiec rozroznic:
//  - `anulowane` — FAKT ZE SKLEPU (poller przepisuje te kolumne co dwie minuty);
//  - `anulowane_recznie` — decyzja czlowieka przy panelu, chroniona przed pollerem
//    (kolumny nie ma na liscie pol w UPDATE zapiszZamowienie — to cala jej ochrona).
//
// Obie funkcje sa IDEMPOTENTNE: dzialaja tak samo na surowym wierszu z bazy i na wierszu
// przepuszczonym przez zLinii (gdzie `anulowane` jest juz wartoscia EFEKTYWNA, a sklepowa
// lezy w `anulowane_sklep`). Bez tego karta pytajaca drugi raz dostawalaby inna odpowiedz.
export function anulowaneWSklepie(z) {
  if (!z) return false;
  return Boolean(Object.hasOwn(z, 'anulowane_sklep') ? z.anulowane_sklep : z.anulowane);
}

// Suma logiczna, i to W JEDNA STRONE — tu siedzi cala zasada „odanulowac sie nie da".
// Reczne anulowanie potrafi WLACZYC anulowanie, ale zadna wartosc `anulowane_recznie`
// nie potrafi WYLACZYC anulowania przyslanego przez sklep.
export function anulowaneEfektywnie(z) {
  return Boolean(z?.anulowane || z?.anulowane_recznie);
}

const tekst = (surowa) => {
  const t = String(surowa ?? '').trim();
  return t || null;
};

/**
 * Odmowa recznej zmiany statusu — `null` znaczy „wolno". Liczona PRZED zapisem, zeby
 * odmowa nie zostawiala polowicznie zapisanych faktow.
 */
export function powodOdmowyStatusu(z, docelowy) {
  // Pusty wybor ma WLASNY komunikat. Bierze sie z realnego stanu karty: przy zamowieniu
  // wyslanym lista startuje na pozycji-zaslepce (bo „Wyslane" nie jest do ustawienia),
  // wiec zatwierdzenie bez wybrania czegokolwiek jest normalna pomylka — a „Nieznany
  // status: „"" nie mowiloby czlowiekowi absolutnie nic.
  if (!docelowy) return 'Nie wybrano statusu — panel niczego nie zmienił.';
  if (!STATUSY_RECZNE.includes(docelowy) && !(z?.statusy_wlasne ?? []).some(s => s.klucz === docelowy)) return `Nieznany status: „${docelowy}".`;
  // PRZ-101.04: dołączone jest częścią głównego — jego „Wysłane” przenosi zapis głównego
  // (oms/db/zamowienia.js). Anulowanie głównego zostawiłoby dołączone ukryte i bez właściciela.
  if (z?.scalone_do) {
    return `Zamówienie jest scalone z zamówieniem ${z.scalone_do_numer ?? `#${z.scalone_do}`} — status zmieniasz w zamówieniu głównym.`;
  }
  if (docelowy === 'anulowane' && idsDolaczonych(z).length) {
    return 'To zamówienie ma dołączone zamówienia — najpierw je rozdziel (karta → „Rozdziel”), potem anuluj.';
  }
  // Anulowanie DZIALA TYLKO W JEDNA STRONE. Odanulowanie zamowienia, ktore klient anulowal
  // w sklepie, otworzyloby droge do nadania mu paczki i do wystawienia faktury — a karta
  // mowi dzis wprost „najpierw wycofaj anulowanie w sklepie" i to zdanie ma zostac prawdziwe.
  if (anulowaneWSklepie(z) && docelowy !== 'anulowane') {
    return 'To zamówienie jest anulowane W SKLEPIE — panel nie odanuluje go za sklep. '
      + 'Najpierw wycofaj anulowanie w sklepie, potem wróć tutaj.';
  }
  // ⚠️ BEZ TEJ ODMOWY KLIKNIECIE NIC BY NIE ROBILO — i wygladaloby na wykonane.
  // `wyliczStatus` czyta tabele `zwroty`, wiec status i tak wrocilby na „Zwrot" przy
  // pierwszym odswiezeniu, a `faktyDlaStatusu` skasowalby przy okazji `zwrot_at`.
  // Akcja, ktora udaje skutek, jest gorsza niz jej brak. Wyjsciem jest skasowanie zwrotu.
  if (z?.ma_zwrot) {
    return `To zamówienie ma zarejestrowany zwrot — status „${z?.etykiety_statusow?.zwrot ?? ETYKIETY.zwrot}" wynika z tego faktu `
      + 'i nie da się go przestawić. Jeśli zwrot wpisano omyłkowo, skasuj go na ekranie zwrotu.';
  }
  return null;
}

/**
 * Komplet faktow dla wybranego statusu. KAZDE pole jawnie (wartosc albo null = skasuj),
 * bo zapis idzie JEDNYM UPDATE-em — ta sama zasada, co przy dacie wplaty ze znacznikiem
 * recznosci i przy zwrocie z powodem: polowa zapisu przy awarii miedzy dwoma UPDATE-ami
 * zostawialaby stan, ktorego nikt nie chcial (zwrot bez powodu, anulowanie bez daty).
 *
 * Istniejace daty ZOSTAJA, brakujace dostaja `teraz` — cofniecie nie gubi historii,
 * a awans nie zmysla przeszlosci.
 */
export function faktyDlaStatusu(z, docelowy, { powod = null, teraz = new Date().toISOString() } = {}) {
  const wlasny = (z?.statusy_wlasne ?? []).find(s => s.klucz === docelowy);
  if (wlasny && ['nowe', 'w_realizacji'].includes(wlasny.jak)) {
    return { ...faktyDlaStatusu(z, wlasny.jak, { powod, teraz }), status_wlasny: docelowy };
  }
  if (!STATUSY_RECZNE.includes(docelowy)) throw new Error(`Nieznany status: ${docelowy}`);
  switch (docelowy) {
    // „Nowe" to WYCZYSZCZENIE recznych faktow, nie osobny znacznik — nie ma czego ustawiac,
    // bo `wyliczStatus` oddaje 'nowe' wlasnie wtedy, gdy nie ma zadnego innego faktu.
    case 'nowe':
      return { w_realizacji_at: null, wyslane_at: null, zwrot_at: null, zwrot_powod: null, anulowane_recznie: 0 };
    case 'w_realizacji':
      return {
        w_realizacji_at: z?.w_realizacji_at || teraz,
        // Cofniecie z „Wyslane" do „W realizacji" MUSI skasowac date wysylki — inaczej
        // status wrocilby na Wyslane przy pierwszym odswiezeniu karty.
        wyslane_at: null,
        zwrot_at: null, zwrot_powod: null, anulowane_recznie: 0,
      };
    // Wyslane to wlasny fakt: data wyjazdu paczki, ktora zna czlowiek, a nie panel.
    // Realizacja ZOSTAJE — wysylka nastepuje po niej, a jej skasowanie zmyslaloby przeszlosc.
    case 'wyslane':
      return {
        w_realizacji_at: z?.w_realizacji_at ?? null,
        wyslane_at: z?.wyslane_at || teraz,
        zwrot_at: null, zwrot_powod: null, anulowane_recznie: 0,
      };
    case 'zwrot':
      return {
        // Realizacja ZOSTAJE: zwrot nastepuje PO niej, a jej skasowanie zmyslaloby przeszlosc.
        w_realizacji_at: z?.w_realizacji_at ?? null,
        // Data wysylki ZOSTAJE: paczka pojechala i zwrot tego nie odstal.
        wyslane_at: z?.wyslane_at ?? null,
        zwrot_at: z?.zwrot_at || teraz,
        // Pusty powod NIE kasuje powodu juz zapisanego — inaczej ponowne zatwierdzenie tego
        // samego statusu (odswiezenie karty, poprawka innego pola) gubiloby jedyna
        // informacje o tym, po co zwrot nadano.
        zwrot_powod: tekst(powod) ?? z?.zwrot_powod ?? null,
        anulowane_recznie: 0,
      };
    // Anulowanie NIE jest wymazaniem historii: paczka pojechala, zwrot byl — te fakty
    // zostaja i dalej sa widoczne na karcie (patrz anulowaneWymagaUwagi).
    case 'anulowane':
      return {
        w_realizacji_at: z?.w_realizacji_at ?? null,
        wyslane_at: z?.wyslane_at ?? null,
        zwrot_at: z?.zwrot_at ?? null,
        zwrot_powod: z?.zwrot_powod ?? null,
        anulowane_recznie: 1,
      };
    // Nieosiagalne (lista sprawdzona wyzej) — zostaje jako straznik na wypadek dolozenia
    // klucza do STATUSY_RECZNE bez dopisania faktow tutaj.
    default:
      throw new Error(`Nieznany status: ${docelowy}`);
  }
}
