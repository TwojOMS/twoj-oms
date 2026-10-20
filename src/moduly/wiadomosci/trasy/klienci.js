import { etykietyStatusow } from '../../../oms/db/statusy.js';
import { znormalizujKlienta, opisKlienta } from '../../../domena/klient-staly.js';
import { RABAT_MAX } from '../../../domena/rabat.js';
// ⚠️ TA SAMA funkcja kopiująca, której używa ekran zakładania zamówienia — nie druga kopia
// reguły. Oba formularze niosą DOKŁADNIE te same nazwy pól (`f_*` / `w_*`), więc i decyzje
// („imię, nazwisko i telefon zostają nietknięte", „pusty e-mail nie kasuje") są te same.
import { DOSTAWY, PLATNOSCI, skopiujFaktureDoWysylki } from '../../../domena/nowe-zamowienie.js';
import { PRZY_ODBIORZE, BEZ_TERMINU, TERMINY_DNI } from '../../../domena/termin-platnosci.js';
import { nipDoZapytania, komunikatAwariiGus } from '../../../domena/gus.js';
import { gusDostepny, KOMUNIKAT_BRAK_GUS } from '../../../domena/konfiguracja-gus.js';
import { wylaczoneModuly } from '../../../oms/db/moduly-opcjonalne.js';
import {
  wszyscyKlienci, klientPoId, dopiszKlienta, zapiszKlienta,
} from '../../../oms/db/klienci.js';
import { dopiszLog, zamowieniaPoNip } from '../../../oms/db/zamowienia.js';
import { podsumowanieHistorii } from '../../../domena/historia-klienta.js';
import { wyliczStatus } from '../../../domena/status.js';
import { zl } from '../../../domena/kwoty.js';
import { komunikatDlaOperatora } from '../../../domena/bledy.js';

// EKRAN STAŁYCH KLIENTÓW (21.08.2026).
//
// ⚠️ BEZ NIEGO BAZA JEST WORKIEM BEZ DNA. Wpisy powstają głównie z pracy — przyciskiem
// „Zapamiętaj tego klienta" na karcie — a to znaczy, że prędzej czy później wpadnie tam
// literówka w NIP-ie albo klient, który przestał zamawiać. Bez ekranu przeglądu jedno i
// drugie zostaje na zawsze i kusi przy każdym telefonie.
//
// ⚠️ NIE MA TU KASOWANIA i mieć nie będzie — jest wygaszanie (`aktywny = 0`). Zamówienia
// założone z danych klienta są MIGAWKĄ i zostają, więc skasowanie wpisu niczego nie
// naprawia, a odbiera możliwość sprawdzenia, skąd wzięły się dane na fakturze sprzed pół
// roku. Ta sama zasada, co przy firmach w słowniku kosztów (db/firmy-reczne.js).

export function registerKlienciRoutes(app, { db, gus = null }) {
  const ktoKlikal = (req) => req.uzytkownik ?? 'panel';

  // ⚠️ `otwarty` ROZSTRZYGA, CZY FORMULARZ W OGÓLE WYCHODZI (prośba właściciela: „na górze
  // strony lista klientów + przycisk Dodaj nowego klienta"). Ekran istnieje po to, żeby
  // ZOBACZYĆ bazę; formularz jest tu czynnością rzadką — klient dopisuje się zwykle
  // przyciskiem na karcie zamówienia. Rozwinięty na stałe kazał przewijać piętnaście pustych
  // pól do tego, po co się przyszło.
  //
  // Ten sam idiom, co `?edytuj=szczegoly` na karcie zamówienia: stan ekranu siedzi w ADRESIE,
  // więc „wróć" w przeglądarce i odświeżenie robią to, czego człowiek oczekuje, a panel dalej
  // nie potrzebuje ani grama JavaScriptu.
  function renderuj(reply, {
    formularz = {}, blad = null, edytowany = null, komunikat = null, otwarty = false,
    daneZGus = null, komunikatGus = null,
  } = {}) {
    return reply.view('klienci.ejs', {
      title: 'Stali klienci',
      otwarty,
      // ⚠️ RAZEM Z NIEAKTYWNYMI — to jest jedyny ekran, na którym wygaszony klient ma być
      // widoczny. Gdyby i tu go nie było, „wygaszenie" byłoby nieodwracalne przez panel.
      klienci: wszyscyKlienci(db, { tylkoAktywni: false }).map((k) => ({ ...k, opis: opisKlienta(k) })),
      formularz,
      edytowany,
      blad,
      komunikat,
      daneZGus,
      komunikatGus,
      // Bez tej flagi widok kusiłby przyciskiem „Pobierz z GUS" także wtedy, gdy GUS nie jest
      // skonfigurowany — kliknięcie kończyłoby się komunikatem zamiast danymi.
      // PRZ-102.11: liczone przy każdym widoku — klucz zapisany w Ustawieniach pokazuje przycisk bez restartu.
      gusDziala: gusDostepny(gus),
      dostawy: DOSTAWY,
      platnosci: PLATNOSCI,
      terminy: { przyOdbiorze: PRZY_ODBIORZE, bezTerminu: BEZ_TERMINU, dni: TERMINY_DNI },
      rabatMax: RABAT_MAX,
    });
  }

  /** Wpis, którego dotyczy formularz — albo `null` przy dopisywaniu nowego. */
  const klientZFormularza = (body) => {
    const id = String(body?.id ?? '').trim();
    return id ? klientPoId(db, id) : null;
  };

  // `?nowy` otwiera pusty formularz. Sam `/klienci` oddaje WYŁĄCZNIE listę.
  app.get('/klienci', async (req, reply) => renderuj(reply, { otwarty: req.query?.nowy !== undefined }));

  // ——— KARTA KLIENTA (21.08.2026, prośba właściciela: „kliknięcie w nazwę klienta otwiera
  // stronę z jego danymi oraz historią zamówień") ————————————————————————————————————
  //
  // ⚠️ TO NIE JEST DRUGA KOPIA FORMULARZA — karta CZYTA, formularz ZAPISUJE. Piętnaście pól
  // dalej istnieje w jednym szablonie (`klienci.ejs`), a ten ekran pokazuje wyłącznie to,
  // co w bazie już jest, plus historię, której formularz nie ma skąd znać.
  app.get('/klienci/:id', async (req, reply) => {
    const klient = klientPoId(db, req.params.id);
    if (!klient) return reply.code(404).send('Nie ma takiego klienta');
    // ⚠️ HISTORIA PO NIP-IE — powód i konsekwencje stoją przy `zamowieniaPoNip`
    // (db/zamowienia.js). Klient BEZ NIP-u dostaje pustą listę i zdanie, dlaczego:
    // milcząca pustka czytałaby się jak „nic nie zamawiał".
    const zamowienia = zamowieniaPoNip(db, klient.nip);
    return reply.view('klient.ejs', {
      title: `Klient: ${klient.nazwa}`,
      klient,
      opis: opisKlienta(klient),
      zamowienia,
      podsumowanie: podsumowanieHistorii(zamowienia),
      // ⚠️ STATUS LICZY DOMENA, nie widok — ta sama funkcja, co na liście i na karcie
      // zamówienia. Druga reguła w szablonie oznaczałaby, że to samo zamówienie ma tu
      // inny status niż po kliknięciu w jego numer.
      wyliczStatus,
      ETYKIETY: etykietyStatusow(db),
      dostawy: DOSTAWY,
      // Grosze na złotówki zamienia domena (domain/kwoty.js), nie dzielenie w szablonie.
      zl,
    });
  });

  // Edycja otwiera TEN SAM ekran listy z wypełnionym formularzem — jedna droga, jeden
  // szablon. Osobny ekran edycji byłby drugą kopią piętnastu pól, rozjeżdżającą się przy
  // pierwszym nowym ustawieniu.
  //
  // ⚠️ ADRES ZMIENIŁ SIĘ 21.08.2026 z `/klienci/:id` na `/klienci/:id/edytuj`, bo goły
  // `/klienci/:id` należy teraz do KARTY klienta. Kliknięcie w nazwę ma pokazywać, a nie
  // od razu otwierać formularz nad wszystkim.
  app.get('/klienci/:id/edytuj', async (req, reply) => {
    const klient = klientPoId(db, req.params.id);
    if (!klient) return reply.code(404).send('Nie ma takiego klienta');
    return renderuj(reply, { edytowany: klient, formularz: polaZKlienta(klient), otwarty: true });
  });

  // ---------------------------------------------------------------------------------
  // POBIERZ Z GUS — trzecie miejsce z tym przyciskiem w panelu (karta zamówienia, ekran
  // zakładania, teraz baza klientów) i za każdym razem TA SAMA obietnica: NICZEGO NIE
  // ZAPISUJE, wypełnia pola do sprawdzenia.
  //
  // ⚠️ Osobna trasa od tamtych dwóch, bo oddaje INNY EKRAN. Reguła numeru (`nipDoZapytania`)
  // i klient GUS-u są wspólne, więc rozjechać się może wyłącznie to, co i tak jest tu inne.
  //
  // ⚠️ `edytowany` MUSI PRZEJŚĆ PRZEZ POBRANIE. Bez tego pobranie danych w trakcie
  // POPRAWIANIA klienta przestawiałoby nagłówek ekranu w tryb „nowy", a ukryte pole `id`
  // jechałoby dalej w ciele żądania — więc „Zapisz" i tak trafiłby w istniejący wpis.
  // Formularz mówiłby wtedy co innego, niż robi.
  // ---------------------------------------------------------------------------------
  app.post('/klienci/gus', async (req, reply) => {
    const formularz = req.body ?? {};
    const edytowany = klientZFormularza(formularz);
    const odmowa = (tekst, rodzaj = 'blad') => renderuj(reply, {
      formularz, edytowany, otwarty: true, komunikatGus: { rodzaj, tekst },
    });

    if (!gusDostepny(gus)) return odmowa(KOMUNIKAT_BRAK_GUS);

    let nip;
    try {
      // NIP bierzemy z pola FAKTUROWEGO, bo to przy nim stoi przycisk. Pole `nip` wyżej
      // (identyfikator klienta) uzupełni się z odpowiedzi — patrz szablon.
      nip = nipDoZapytania(formularz.f_nip || formularz.nip);
    } catch (e) {
      return odmowa(komunikatDlaOperatora(e));
    }

    let firma = null;
    try {
      firma = await gus.firmaPoNip(nip);
    } catch (e) {
      // Awaria GUS-u NIE MOŻE wywalić ekranu razem z tym, co operator zdążył wpisać — ta sama
      // zasada, co przy odpytywaniu DPD o status. Pełna treść idzie do dziennika.
      dopiszLog(db, null, { akcja: 'klient.gus', wynik: `BŁĄD: ${e.message}` });
      return odmowa(komunikatAwariiGus(e));
    }

    if (!firma) {
      dopiszLog(db, null, { akcja: 'klient.gus', wynik: `GUS: nie znaleziono firmy o NIP ${nip}.` });
      return odmowa(`GUS nie zna firmy o NIP ${nip}. Sprawdź numer albo wpisz dane ręcznie.`, 'brak');
    }

    dopiszLog(db, null, {
      akcja: 'klient.gus',
      wynik: `GUS (${ktoKlikal(req)}): pobrano „${firma.firma}" (NIP ${firma.nip ?? nip}, `
        + `REGON ${firma.regon ?? '—'}) — dane WSTAWIONE DO FORMULARZA stałego klienta, `
        + 'nic jeszcze nie zapisano.',
    });
    return renderuj(reply, {
      formularz,
      edytowany,
      otwarty: true,
      daneZGus: firma,
      komunikatGus: {
        rodzaj: 'ok',
        tekst: `GUS: ${firma.firma}${firma.regon ? ` (REGON ${firma.regon})` : ''}. `
          + 'Sprawdź dane i zapisz — dopóki tego nie zrobisz, nic się nie zmieniło.',
      },
    });
  });

  // ⚠️ NIC NIE ZAPISUJE — przestawia wartości między polami i oddaje formularz z powrotem.
  // Bliźniak z karty zamówienia MUSI zapisywać (tam zamówienie już istnieje); tutaj i na
  // ekranie zakładania nie ma czego, więc obie te drogi wołają jedną funkcję domeny.
  app.post('/klienci/kopiuj-do-wysylki', async (req, reply) => renderuj(reply, {
    formularz: skopiujFaktureDoWysylki(req.body ?? {}),
    edytowany: klientZFormularza(req.body ?? {}),
    otwarty: true,
  }));

  app.post('/klienci', async (req, reply) => {
    const id = String(req.body?.id ?? '').trim();
    const edytowany = klientZFormularza(req.body ?? {});
    if (id && !edytowany) return reply.code(404).send('Nie ma takiego klienta');

    let dane;
    try {
      dane = znormalizujKlienta(req.body ?? {});
    } catch (e) {
      // ⚠️ ODMOWA ODDAJE FORMULARZ I ZOSTAWIA GO OTWARTYM. Piętnaście pól wpisanych
      // i skasowanych komunikatem byłoby karą za literówkę w jednym z nich, a formularz
      // zamknięty pokazywałby komunikat o polu, którego na ekranie nie ma.
      return renderuj(reply.code(400), {
        formularz: req.body ?? {}, edytowany, blad: komunikatDlaOperatora(e), otwarty: true,
      });
    }

    // Nie pozwalamy założyć umowy, której faktury nie miałyby dostępnego ekranu.
    if (dane.rozliczenie_zbiorcze === 1 && wylaczoneModuly(db).includes('okresy')) {
      return renderuj(reply.code(409), {
        formularz: req.body ?? {}, edytowany, otwarty: true,
        blad: 'Włącz Rozliczenia w Ustawieniach → Moduły przed zapisaniem umowy zbiorczej.',
      });
    }
    try {
      if (edytowany) zapiszKlienta(db, edytowany.id, dane);
      else dopiszKlienta(db, dane);
    } catch (e) {
      return renderuj(reply.code(400), {
        formularz: req.body ?? {}, edytowany, blad: komunikatDlaOperatora(e), otwarty: true,
      });
    }

    // ⚠️ DZIENNIK BEZ ZAMÓWIENIA (`null`) — ta sama droga, co przy GUS-ie i przy wstawianiu
    // klienta do formularza. Wpis w bazie klientów zmienia to, co panel podpowie przy
    // następnym telefonie, więc ma zostawiać ślad, kto go zmienił.
    dopiszLog(db, null, {
      akcja: 'klient.zapis',
      wynik: `Ręcznie (${ktoKlikal(req)}): ${edytowany ? 'poprawiono' : 'dopisano'} `
        + `stałego klienta „${dane.nazwa}" (${dane.klucz}) — ${opisKlienta(dane)}.`,
    });
    // ⚠️ POPRAWKA WRACA NA KARTĘ TEGO KLIENTA, dopisanie — na listę. Człowiek wchodzi
    // w edycję z karty (przycisk „Edytuj" stoi tam i na liście), więc odesłanie go na
    // listę kazałoby szukać wpisu, przy którym przed chwilą stał. Nowy klient karty
    // jeszcze nie miał, więc tam wracać nie ma dokąd.
    return reply.redirect(edytowany ? `/klienci/${edytowany.id}` : '/klienci');
  });
}

/** Wiersz bazy → pola formularza tego ekranu (przedrostki `f_` i `w_`, jak przy zamówieniu). */
function polaZKlienta(k) {
  const f = k.faktura ?? {};
  const w = k.wysylka ?? {};
  return {
    id: k.id, klucz: k.klucz, nazwa: k.nazwa, nip: k.nip ?? '',
    f_firma: f.firma ?? '', f_nip: f.nip ?? k.nip ?? '', f_ulica: f.ulica ?? '',
    f_kod: f.kod ?? '', f_miasto: f.miasto ?? '', f_email: f.email ?? '',
    w_nazwa: w.nazwa ?? '', w_firma: w.firma ?? '', w_ulica: w.ulica ?? '',
    w_kod: w.kod ?? '', w_miasto: w.miasto ?? '', w_telefon: w.telefon ?? '', w_email: w.email ?? '',
    b2b: k.b2b ? 'on' : '', rabat_procent: String(k.rabat_procent ?? 0),
    chce_fakture: k.chce_fakture ? 'on' : '',
    metoda_wysylki: k.metoda_wysylki, koszt_dostawy_brutto: k.koszt_dostawy_brutto,
    platnosc: k.platnosc, termin_platnosci: k.termin_platnosci ?? '',
    komentarz: k.komentarz ?? '', aktywny: k.aktywny ? 'on' : '',
    // ⚠️ KWOTY WRACAJĄ DO FORMULARZA W ZŁOTYCH, bo w złotych je wpisano — w bazie leżą
    // w groszach. Pusty napis przy `null` jest tu ISTOTNY: „0,00" w polu twierdziłoby,
    // że ktoś ustalił zerowy próg, a nie że nie ustalił niczego.
    rozliczenie_zbiorcze: k.rozliczenie_zbiorcze ? 'on' : '',
    prog_darmowej_dostawy: wZlotych(k.prog_darmowej_dostawy_gr),
    oplata_obslugi: wZlotych(k.oplata_obslugi_gr),
    oplata_kurierska: wZlotych(k.oplata_kurierska_gr),
  };
}

const wZlotych = (gr) => (Number.isInteger(gr) ? zl(gr) : '');
