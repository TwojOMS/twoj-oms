import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import { idDokumentuDla } from '../../../domena/dokument-programu.js';
import {
  zapiszZgloszenieAllegro,
  zapiszWysylkeDoAllegro,
  zajmijWysylkeDoAllegro,
  zwolnijWysylkeDoAllegro,
} from '../db/faktury.js';
import { bladOperatora } from '../../../domena/bledy.js';
import { wolnoWyslacDoAllegro, nazwaPlikuFaktury, statusWeryfikacji } from '../../../domena/allegro-faktura.js';
// ⚠️ LIMIT ZE WSPOLNEJ STALEJ, nigdy wlasna kopia liczby — dokladnie tak, jak czuwacz bierze
// stad `LIMIT_ZAPYTANIA_PRZESYLEK_MS`. Druga kopia „2 MB" rozjechalaby sie z ta, ktora
// naprawde odbija plik od Allegro.
import { MAKS_ROZMIAR_FAKTURY_B } from '../../../oms/allegro/client.js';
import { stanWeryfikacji } from '../../../oms/db/stan-weryfikacji.js';
import { zProgramu } from '../../../integracje/program-fakturowy.ts';

// Czy to, co oddal inFakt, NIE JEST PDF-em nadajacym sie do wyslania — i DLACZEGO.
// Zwraca powod (tekst dla operatora) albo `null`, gdy plik jest w porzadku. Czysta funkcja:
// zadnego HTTP, zadnego zapisu, nigdy nie rzuca.
//
// ⚠️ SYGNATURA `%PDF`, a nie sama „dlugosc > 0": inFakt przy bledzie oddaje CIALO — JSON
// z komunikatem — wiec pusty bufor jest tu rzadszym przypadkiem niz smiec o niezerowej
// dlugosci. Ta sama kontrola, co przy pobraniu z inFaktu (infakt/client.js).
function zlyPdf(bajty, nazwa) {
  if (!Buffer.isBuffer(bajty) || bajty.subarray(0, 4).toString() !== '%PDF') {
    return (
      `${nazwa.mianownik} nie oddał PDF-u tej faktury (dostaliśmy coś innego — najpewniej komunikat ` +
      'błędu). Panel NIE zgłosił faktury w Allegro i nic kupującemu nie wysłał. Sprawdź ' +
      `dokument w ${nazwa.miejscownik} i spróbuj ponownie.`
    );
  }
  if (bajty.length > MAKS_ROZMIAR_FAKTURY_B) {
    return (
      `Plik faktury ma ${(bajty.length / 1024 / 1024).toFixed(2)} MB, a limit Allegro to 2 MB. ` +
      'Panel NIE zgłosił faktury w Allegro i nic kupującemu nie wysłał.'
    );
  }
  return null;
}

// Przeslanie PDF-u faktury na konto kupujacego w Allegro. Dwa wywolania zapisujace
// (metadane → plik) plus jeden odczyt, ktory chroni przed duplikatem.
//
// ⚠️⚠️ OPERACJA NIEODWRACALNA — najbardziej nieodwracalna w calym panelu. Dokument laduje
// u kupujacego i panel nie ma czym go stamtad zabrac; skasowanie faktury w inFakcie NIE
// zabiera jej kupujacemu z rak.
//
// ⚠️ DWIE DROGI DO TEJ USŁUGI, JEDNA BRAMKA: przycisk na karcie i automat po numerze KSeF
// (czuwacz, `wyslijDoAllegroJesliWolno` w services/po-numerze-ksef.js). Obie pytają
// `wolnoWyslacDoAllegro`, a odmowę i zajęcie wysyłki rozstrzyga `wyslij` niżej.
// PDF pobiera PROGRAM FAKTUROWY (`{ program }` albo stary `{ infakt }` przez `zProgramu`).
export function createFakturaAllegro({ db, program: programPodany = null, infakt = null, klienciKanalow = {} }) {
  const program = zProgramu({ program: programPodany, infakt });
  async function wyslij(zamowienieId) {
    const z = pobierzZamowienie(db, zamowienieId);
    // ⚠️ ODMOWA PRZED PIERWSZYM BAJTEM — przed inFaktem i przed Allegro. Bariera sprawdzana
    // po wyslaniu pliku jest zadna: dokument juz lezy u kupujacego.
    const zgoda = wolnoWyslacDoAllegro(z);
    if (!zgoda.wolno) throw bladOperatora(zgoda.powod);

    const klient = klienciKanalow[z.sklep];
    if (!klient) throw bladOperatora(`Panel nie ma połączenia z kanałem „${z.sklep}".`);

    const f = z.faktura;
    // Dokument innego programu niż moduł faktur OMS-u — odmowa 409 PRZED zajęciem wysyłki i PRZED
    // pierwszym bajtem do sieci (ani PDF z programu, ani nic do Allegro).
    const idDok = idDokumentuDla(f, program);
    const nazwa = nazwaPlikuFaktury(f.numer);

    // ⚠️⚠️ ATOMOWE ZAJĘCIE PRZED PIERWSZYM BAJTEM DO SIECI.
    //
    // Bariera wyzej czyta `z.faktura` SPRZED dwoch `await`-ow (PDF z inFaktu, lista faktur
    // z Allegro) i przed dwoma równoległymi żądaniami NIE CHRONI PRZED NICZYM — bez zajęcia
    // dwa `wyslij(id)` naraz dają 2 POST-y i 2 pliki, bez żadnego ostrzeżenia. Allegro
    // przyjmuje DO 10 FAKTUR na zamówienie, więc drugi POST nie odbiłby się od niczego także
    // po ICH stronie, a `GET .../invoices` oddaje dzis 400 — o pierwszym dokumencie panel nie
    // dowiedzialby sie NIGDY.
    //
    // Ten sam wzorzec, co `rozpocznijFakture`: rozstrzyga WARUNKOWY UPDATE w bazie, a nie
    // odczyt sprzed kilkuset milisekund. Zajęcie stoi TUTAJ, a nie w trasie, bo to jest reguła
    // usługi, a nie jednej ścieżki HTTP: dwa równoległe kliknięcia z dwóch kart (i automat
    // po numerze KSeF) muszą się wykluczyć niezależnie od tego, ile wejść prowadzi do usługi.
    if (!zajmijWysylkeDoAllegro(db, f.id)) {
      throw bladOperatora(
        `Wysyłka faktury ${f.numer} do Allegro WŁAŚNIE TRWA — drugie żądanie nic nie wysłało. ` +
          'Odśwież kartę za chwilę i sprawdź, czy dokument poszedł; jeśli nie, kliknij jeszcze raz. ' +
          'Panel odmawia tutaj celowo: dwa równoległe kliknięcia dałyby kupującemu DWA dokumenty, ' +
          'a Allegro przyjmuje do dziesięciu faktur na zamówienie i samo tego nie zatrzyma.',
      );
    }
    try {
      return await wyslijZajete({
        z,
        f,
        idDok,
        nazwa,
        klient,
        zamowienieId,
      });
    } finally {
      // ⚠️ ZAWSZE, TAKZE PO BLEDZIE. Dzierzawa zostawiona po zerwanej sieci blokowalaby
      // ponowienie — a ponowienie jest tu normalna droga: `allegro_invoice_id` juz mamy,
      // wiec `PUT .../file` PODMIENIA plik zamiast zglaszac druga fakture.
      zwolnijWysylkeDoAllegro(db, f.id);
    }
  }

  // Wlasciwa wysylka — wolana WYLACZNIE z zajeta dzierzawa (patrz `wyslij` wyzej).
  async function wyslijZajete({ z, f, idDok, nazwa, klient, zamowienieId }) {
    // PDF POBIERAMY NA SWIEZO z inFaktu — panel nie trzyma kopii dokumentu (services/faktura.js).
    // Numer KSeF jest W PIERWSZEJ LINII tego pliku, więc kupujący dostaje dokument z numerem
    // KSeF. Kopia trzymana u nas kłamałaby po korekcie.
    const bajty = await program.pobierzPdf(idDok);

    // ⚠️⚠️ SPRAWDZENIE PLIKU STOI PRZED PIERWSZYM ŻĄDANIEM DO ALLEGRO.
    //
    // Sama kontrola w `wyslijPlikFaktury` (allegro/client.js) stoi ZA nieodwracalnym
    // `POST`-em: gdy inFakt odda JSON błędu zamiast PDF-u, do Allegro I TAK poleciałoby
    // `zglosFakture` — a to znaczy:
    //   - spalony JEDEN Z DZIESIECIU slotow na faktury przy tym zamowieniu,
    //   - przy zamowieniu KUPUJACEGO wisi zgloszenie faktury BEZ PLIKU,
    //   - karta dalej pokazuje zielony przycisk, ktory w kolko oddaje ten sam blad
    //     i w kolko pali kolejne sloty.
    // Zadnego z tych trzech skutkow nie da sie cofnac.
    //
    // ⚠️ KONTROLA W KLIENCIE ZOSTAJE JAKO DRUGA LINIA i to nie jest duplikat do posprzatania:
    // ta tutaj chroni przed spaleniem slotu, tamta — przed wyslaniem smiecia kupujacemu,
    // takze wtedy, gdy plik przyjdzie kiedys inna droga niz przez te usluge.
    const powodOdrzucenia = zlyPdf(bajty, program.opis.nazwa);
    if (powodOdrzucenia) throw bladOperatora(powodOdrzucenia);

    // ⚠️ POMOCNICZY bezpiecznik przed duplikatem — I TYLKO POMOCNICZY.
    // Zasob oddaje dzis 400, wiec `pobierzFakturyZamowienia` zwraca wtedy pusta
    // liste i ta galaz MILCZY. OCHRONA, NA KTOREJ STOIMY, jest LOKALNA kolumna
    // `allegro_invoice_id`, zapisywana PRZED wyslaniem pliku — nie ta lista.
    //
    // Zostaje mimo to, bo zamyka luke, ktorej kolumna nie zamyka: gdyby proces padl MIEDZY
    // POST-em a zapisem, kolumna bylaby pusta, a Allegro mialoby juz dokument. Gdy zasob
    // kiedys zacznie odpowiadac (albo zacznie po pierwszej fakturze — to jedna z dwoch
    // nierozstrzygnietych hipotez), luka zniknie sama, bez zmiany w kodzie.
    //
    // ⚠️ PRZY OTWARTYM BEZPIECZNIKU POMIJAMY TO WYWOŁANIE. Nie tracimy nic:
    // przy martwym zasobie i tak oddaje `[]`, wiec ta galaz MILCZY tak czy tak — a operator
    // przestaje czekac przy przycisku na zadanie skazane na porazke. Gdy bezpiecznik sie
    // zamknie (pierwsza niepusta odpowiedz w czuwaczu), wywolanie wraca SAMO i luka „proces
    // padl miedzy POST-em a zapisem" domyka sie bez zmiany w kodzie.
    const bezpiecznikOtwarty = Boolean(stanWeryfikacji(db, z.sklep)?.bezpiecznik_od);
    const istniejace = bezpiecznikOtwarty ? [] : await klient.pobierzFakturyZamowienia(z.zrodlo_id);
    const juzZgloszona =
      istniejace.find((w) => w.id === f.allegro_invoice_id) ??
      istniejace.find((w) => w.invoiceNumber && w.invoiceNumber === f.numer);

    let invoiceId = juzZgloszona?.id ?? f.allegro_invoice_id ?? null;
    if (!invoiceId) {
      const zgloszona = await klient.zglosFakture(z.zrodlo_id, { nazwaPliku: nazwa, numerFaktury: f.numer });
      invoiceId = zgloszona.id;
      // ⚠️⚠️ REZERWACJA. Ta linia MUSI stac PRZED `wyslijPlikFaktury` — od niej ponowienie
      // dosyla plik do TEJ faktury, zamiast zglaszac druga. Przestawienie jej za PUT-a
      // znaczy, ze zerwana siec przy pliku zostawia zgloszenie bez sladu w bazie,
      // a nastepne klikniecie robi kupujacemu DRUGI dokument.
      zapiszZgloszenieAllegro(db, f.id, invoiceId);
      dopiszLog(db, zamowienieId, { akcja: 'faktura-allegro', wynik: `zgłoszona w Allegro (${invoiceId})` });
    } else if (invoiceId !== f.allegro_invoice_id) {
      // Adopcja zgloszenia, o ktorym baza nie wiedziala (proces padl miedzy POST-em a zapisem).
      zapiszZgloszenieAllegro(db, f.id, invoiceId);
      dopiszLog(db, zamowienieId, {
        akcja: 'faktura-allegro',
        wynik: `w Allegro była już zgłoszona faktura (${invoiceId}) — panel dosyła plik do niej, zamiast zgłaszać drugą`,
      });
    }

    const odp = await klient.wyslijPlikFaktury(z.zrodlo_id, invoiceId, bajty);
    // ⚠️ TO JEST PIERWSZE (i dziś jedyne pewne) ŹRÓDŁO stanu weryfikacji — odpytywanie
    // w czuwaczu stoi na zasobie, który oddaje 400. Brak pola czytamy jako 'WAITING':
    // plik poszedl, a Allegro jeszcze nic o nim nie powiedzialo.
    const weryfikacja = statusWeryfikacji(odp) ?? 'WAITING';
    zapiszWysylkeDoAllegro(db, f.id, { wyslanaAt: new Date().toISOString(), weryfikacja });
    dopiszLog(db, zamowienieId, {
      akcja: 'faktura-allegro',
      wynik: `plik ${nazwa} wysłany do Allegro (KSeF ${f.ksef_numer})`,
    });
    return { invoiceId, weryfikacja };
  }

  return { wyslij, gotowe: () => Object.keys(klienciKanalow).length > 0 };
}
