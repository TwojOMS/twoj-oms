import { anulowaneEfektywnie } from './status-reczny.js';
import { sumaPozycjiZWysylkaGrosze, kwotaOczekiwanaGrosze, grosze, zl } from './suma-pozycji.js';

// Stan proformy jako CZYSTE funkcje — bez bazy, bez sieci, bez zegara. Tych samych
// odpowiedzi potrzebuja trzy niezalezne warstwy: serwis (czy w ogole wystawiac), karta
// (ktora proforma jest ta obowiazujaca) i generator PDF (jaki numer wydrukowac).

// ⚠️ SERIA TO `PF/`, NIE `PRO/` — i to jest decyzja, nie literowka. Apilo wystawia dzis
// proformy w serii `PRO/` i ma chodzic ROWNOLEGLE jako siatka bezpieczenstwa, dopoki panel
// nie udowodni, ze robi to dobrze. Ta sama seria w dwoch systemach naraz znaczy, ze przy
// jednej pomylce dwoch roznych klientow trzyma dokumenty o TYM SAMYM numerze i przelewa
// pieniadze z tym samym tytulem — czego po fakcie nie da sie rozplatac.
export const SERIA_PROFORMY = 'PF';

/**
 * Numer dokumentu: `PF/{n}/{mm}/{rrrr}`, np. `PF/1/08/2026`.
 *
 * ⚠️ MIESIAC DWUCYFROWO, LICZNIK BEZ WIODACYCH ZER — dokladnie jak we wzorze z Apilo
 * (`PRO_1_08_2026`). Numer trafia do tytulu przelewu klienta, wiec „PF/01/8/2026" bylby
 * z jego punktu widzenia INNYM dokumentem niz ten, ktory panel ma w bazie.
 *
 * Licznik zeruje sie co miesiac (patrz `nastepnyNumer` w db/proformy.js), wiec para
 * (miesiac, rok) jest czescia numeru, a nie ozdobnikiem.
 */
export function formatNumeru({ kolejny, miesiac, rok }) {
  return `${SERIA_PROFORMY}/${kolejny}/${String(miesiac).padStart(2, '0')}/${rok}`;
}

/**
 * Ta JEDNA proforma, ktora obowiazuje — albo `null`, gdy zadna.
 *
 * Aktualna jest nieuniewazniona (`uniewazniona_at IS NULL`). Historia zostaje w calosci,
 * bo klient moze mieć przed soba dowolny z wyslanych dokumentow, ale „ta obowiazujaca"
 * musi byc jednoznaczna: dwie wazne naraz to klient placacy wedlug starej kwoty.
 *
 * Gdyby (awaria miedzy zapisem a uniewaznieniem poprzedniej) zostaly dwie wazne, wygrywa
 * NOWSZA — to ona niesie kwote, ktora klient dostal ostatnia. Rownej dacie rozstrzyga `id`,
 * inaczej odpowiedz zalezalaby od kolejnosci wierszy oddanych przez baze i karta pokazywalaby
 * raz jedna, raz druga.
 */
export function aktualnaProforma(lista) {
  const wazne = (lista ?? []).filter((p) => p && !p.uniewazniona_at);
  if (wazne.length === 0) return null;
  return wazne.reduce((najnowsza, p) => (nowsza(p, najnowsza) ? p : najnowsza));
}

function nowsza(a, b) {
  const czasA = String(a.utworzona_at ?? '');
  const czasB = String(b.utworzona_at ?? '');
  if (czasA !== czasB) return czasA > czasB;
  return Number(a.id ?? 0) > Number(b.id ?? 0);
}

/**
 * Czy WAZNA proforma opiewa dzis na inna kwote niz zamowienie — `{ proformaZl, zamowienieZl }`
 * albo `null`, gdy nie ma o czym mowic.
 *
 * ⚠️ TO NIE JEST BLAD MIGAWKI I MIGAWKI NIE WOLNO „POPRAWIAC". Kwota na wystawionej
 * proformie ma zostac taka, jaka jest — klient dostal ten PDF i przeleje to, co na nim widzi.
 * Problemem jest CISZA: dopisanie pozycji albo zmiana wysylki po wystawieniu zostawia
 * dokument obowiazujacy na starsza kwote, a panel czeka na nowa. Skutek jest ten sam, przed
 * ktorym broni automatyczne uniewaznianie poprzednich proform (db/proformy.js) — klient
 * placi wedlug nieaktualnej kwoty — tylko droga jest CZESTSZA: doplata i zmiana wysylki
 * zdarzaja sie czesciej niz dwa klikniecia „Wystaw proformę".
 *
 * ⚠️ OSTRZEZENIE, NIE BLOKADA. Rozjazd bywa przejsciowy (operator wlasnie dopisuje pozycje)
 * i tylko czlowiek wie, czy klient ma doplacic, czy dokument ma byc wystawiony na nowo.
 *
 * Porownujemy z `kwotaOczekiwanaGrosze` — TA SAMA miara, ktorej uzywa bariera arytmetyczna
 * (domain/pozycje-faktury.js) i saldo wplat. Porownanie z `kwota_brutto` krzyczaloby przy
 * KAZDYM zamowieniu z recznie dopisana pozycja, bo kwota sklepowa o naszych dopiskach nie wie.
 *
 * Uszkodzona kwota daje `null`, nie ostrzezenie: „nie wiem, ile to jest" ma swoje wlasne
 * miejsce na karcie (ostrzezenie pod tabela pozycji), a ta funkcja nie ma prawa rzucic —
 * liczy sie przy kazdym otwarciu karty.
 */
export function rozjazdKwotyProformy(zamowienie, proforma) {
  if (!zamowienie || !proforma || proforma.uniewazniona_at) return null;
  try {
    const proformaGr = grosze(proforma.kwota_brutto, `proforma ${proforma.numer}`);
    const oczekiwanaGr = kwotaOczekiwanaGrosze(zamowienie);
    if (proformaGr === oczekiwanaGr) return null;
    return { numer: proforma.numer, proformaZl: zl(proformaGr), zamowienieZl: zl(oczekiwanaGr) };
  } catch {
    return null;
  }
}

/**
 * Czy wolno wystawic proforme do tego zamowienia — `{ wolno, powod }`.
 *
 * Liczone PRZED nadaniem numeru: nieudana proba nie ma prawa zuzyc numeru z serii, bo
 * dziury w numeracji nikt pozniej nie wyjasni.
 *
 * ⚠️ LISTA ODMOW JEST KROTKA I TO JEST CELOWE. Blokujemy wylacznie to, czego dokument
 * nie ma prawa opisac:
 *
 *  - ZAMOWIENIE ANULOWANE — proforma jest prosba o przelew za cos, czego nikt nie
 *    zrealizuje. Anulowanie ma dwa niezalezne zrodla (sklep i reka operatora) i oba licza
 *    sie tak samo, stad `anulowaneEfektywnie` zamiast wlasnego sprawdzenia kolumny.
 *  - ZAMOWIENIE BEZ POZYCJI — dokument na 0,00 zl, ktorego klient nie ma czego zaplacic,
 *    a numer z serii zostalby spalony bezpowrotnie.
 *  - DOKUMENT NA 0,00 ZL ALBO MNIEJ mimo istniejacych pozycji — ta sama szkoda, tylko
 *    wpuszczona inna droga (gratis, wymiana reklamacyjna, kupon na 100%, same korekty).
 *    Warunek patrzy na SUME, bo to ona jest trescia dokumentu; dlugosc tablicy pozycji
 *    nic o niej nie mowi.
 *
 * ⚠️ Czego tu NIE MA i nie ma byc:
 *
 *  - `chce_fakture` NIE JEST warunkiem. O proforme klient prosi telefonicznie albo mailem,
 *    a sklep o tej prosbie nie wie — znacznik checi faktury VAT nie ma z nia nic wspolnego.
 *  - BRAK WPLATY NIE JEST warunkiem. Proforma istnieje DOKLADNIE po to, zeby klient mial
 *    na podstawie czego zaplacic; odmowa „bo nieoplacone" wywracalaby caly sens dokumentu.
 *  - ISTNIEJACA PROFORMA NIE JEST warunkiem. Kolejna jest dozwolona (poprzednia zostanie
 *    uniewazniona) — to jest cala roznica wobec faktury VAT z `UNIQUE (zamowienie_id)`.
 */
export function czyWolnoWystawic(zamowienie) {
  if (!zamowienie) {
    return { wolno: false, powod: 'Nie ma takiego zamówienia — nie ma do czego wystawić proformy.' };
  }
  // PRZ-101.04: dołączone nie ma własnych dokumentów — proforma tylko z zamówienia głównego.
  if (zamowienie.scalone_do) {
    return { wolno: false, powod: `Zamówienie jest scalone z zamówieniem ${zamowienie.scalone_do_numer ?? `#${zamowienie.scalone_do}`} — proforma w zamówieniu głównym.` };
  }
  if (anulowaneEfektywnie(zamowienie)) {
    return {
      wolno: false,
      powod: 'To zamówienie jest anulowane — proforma prosiłaby klienta o przelew za coś,'
        + ' czego nikt nie zrealizuje.',
    };
  }
  if (!Array.isArray(zamowienie.pozycje) || zamowienie.pozycje.length === 0) {
    return {
      wolno: false,
      powod: 'To zamówienie nie ma ani jednej pozycji — proforma wyszłaby na 0,00 zł,'
        + ' a numer z serii zostałby zużyty bezpowrotnie.',
    };
  }
  // ⚠️ DRUGI WARUNEK PATRZY NA KWOTE, NIE NA DLUGOSC TABLICY — i to jest cala poprawka.
  // Sama pusta lista nie wyczerpuje „dokumentu na 0,00 zl": zamowienie z jedna pozycja
  // za 0,00 zl (gratis, wymiana reklamacyjna, kupon na 100%) przechodzilo przez warunek
  // wyzej i konczylo sie spalonym numerem z serii oraz prosba do klienta o przelew zera
  // zlotych. Suma ujemna (same korekty) jest tym samym problemem od drugiej strony.
  const kwotaGr = kwotaDokumentuGrosze(zamowienie);
  if (kwotaGr !== null && kwotaGr <= 0) {
    return {
      wolno: false,
      powod: `Ta proforma wyszłaby na ${zl(kwotaGr)} zł — klient nie miałby czego przelać,`
        + ' a numer z serii zostałby zużyty bezpowrotnie.',
    };
  }
  return { wolno: true, powod: null };
}

// Kwota, na ktora wyszedlby dokument — TA SAMA suma, ktora trafia na proforme
// (pozycje + wysylka, domain/suma-pozycji.js). Druga kopia tej arytmetyki rozjechalaby sie
// z dokumentem przy pierwszej zmianie.
//
// ⚠️ NIECZYTELNA KWOTA TO `null`, A NIE ZERO. „Nie wiem, ile to jest" i „to jest zero" to
// dwie rozne odpowiedzi: pierwsza nalezy do bariery arytmetycznej (domain/pozycje-faktury.js),
// ktora umie wskazac zepsuta pozycje. Ta funkcja NIE MOZE tez rzucic — wola ja karta przy
// kazdym otwarciu zamowienia (routes/zamowienia.js), a uszkodzona cena nie ma prawa
// wywalic ekranu. Ta sama zasada, co w `podsumowaniePozycji` (domain/tabela-pozycji.js).
function kwotaDokumentuGrosze(zamowienie) {
  try {
    return sumaPozycjiZWysylkaGrosze(zamowienie);
  } catch {
    return null;
  }
}
