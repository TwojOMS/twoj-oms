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
import { stronaOdmowy } from '../../../core/web/odmowa.js';

// EKRAN STAŁYCH KLIENTÓW.
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

// `zwolnionaFirma` — firma zwolniona z VAT (ta sama reguła co serwer); numer UE klienta to wtedy nie WDT.
export function registerKlienciRoutes(app, { db, gus = null, zwolnionaFirma = () => false }) {
  const ktoKlikal = (req) => req.uzytkownik ?? 'panel';

  // Lista i formularz mają osobne adresy, ale współdzielą szablon pól.
  function renderuj(reply, {
    formularz = {}, blad = null, edytowany = null, komunikat = null, otwarty = false,
    daneZGus = null, komunikatGus = null,
  } = {}) {
    return reply.view('klienci.ejs', { szerokosc: edytowany ? 'karta' : otwarty ? 'karta' : 'tabela',
      title: otwarty ? (edytowany ? `Klient: ${edytowany.nazwa}` : 'Nowy klient B2B') : 'Klienci B2B',
      okruszki: edytowany ? [{ tekst: 'Klienci B2B', href: '/klienci' },
        { tekst: edytowany.nazwa, href: `/klienci/${edytowany.id}/karta` }, { tekst: 'Edycja' }] : otwarty ? [{ tekst: 'Klienci B2B', href: '/klienci' }, { tekst: 'Nowy klient B2B' }] : undefined,
      otwarty,
      // ⚠️ RAZEM Z NIEAKTYWNYMI — to jest jedyny ekran, na którym wygaszony klient ma być
      // widoczny. Gdyby i tu go nie było, „wygaszenie" byłoby nieodwracalne przez panel.
      klienci: wszyscyKlienci(db, { tylkoAktywni: false }).map((k) => ({ ...k, opis: opisKlienta(k, { zwolniona: zwolnionaFirma() }) })),
      formularz,
      edytowany,
      blad,
      komunikat,
      daneZGus,
      komunikatGus,
      // Bez tej flagi widok kusiłby przyciskiem „Pobierz z GUS" także wtedy, gdy GUS nie jest
      // skonfigurowany — kliknięcie kończyłoby się komunikatem zamiast danymi.
      // Liczone przy każdym widoku — klucz zapisany w Ustawieniach pokazuje przycisk bez restartu.
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

  // Stare odnośniki przekierowują na osobny formularz. Sam `/klienci` oddaje listę.
  // Odmowa „nie ma takiego klienta” w układzie OMS (status i tekst bez zmian); powrót na listę klientów.
  const brakKlienta = (reply) => stronaOdmowy(reply, 404, 'Nie ma takiego klienta', {
    tytul: 'Nie ma takiego klienta', napisWroc: 'Wróć do klientów', wroc: '/klienci',
  });
  app.get('/klienci', async (req, reply) => {
    if (req.query?.nowy !== undefined) return reply.redirect('/klienci/nowy', 303);
    if (req.query?.edytuj !== undefined) {
      const klient = klientPoId(db, req.query.edytuj);
      if (!klient) return brakKlienta(reply);
      return reply.redirect(`/klienci/${klient.id}`, 303);
    }
    return renderuj(reply);
  });
  app.get('/klienci/nowy', async (req, reply) => renderuj(reply, { otwarty: true }));
  app.get('/klienci/:id', async (req, reply) => {
    const klient = klientPoId(db, req.params.id);
    if (!klient) return brakKlienta(reply);
    return renderuj(reply, { edytowany: klient, formularz: polaZKlienta(klient), otwarty: true });
  });

  // ——— KARTA KLIENTA: kliknięcie w nazwę klienta otwiera stronę z jego danymi
  // oraz historią zamówień ————————————————————————————————————————————————————————
  //
  // ⚠️ TO NIE JEST DRUGA KOPIA FORMULARZA — karta CZYTA, formularz ZAPISUJE. Pola
  // formularza istnieją w jednym szablonie (`klienci.ejs`), a ten ekran pokazuje wyłącznie to,
  // co w bazie już jest, plus historię, której formularz nie ma skąd znać.
  app.get('/klienci/:id/karta', async (req, reply) => {
    const klient = klientPoId(db, req.params.id);
    if (!klient) return brakKlienta(reply);
    // ⚠️ HISTORIA PO NIP-IE — powód i konsekwencje stoją przy `zamowieniaPoNip`
    // (db/zamowienia.js). Klient BEZ NIP-u dostaje pustą listę i zdanie, dlaczego:
    // milcząca pustka czytałaby się jak „nic nie zamawiał".
    const zamowienia = zamowieniaPoNip(db, klient.nip);
    return reply.view('klient.ejs', {
      title: `Klient: ${klient.nazwa}`,
      okruszki: [{ tekst: 'Klienci B2B', href: '/klienci' }, { tekst: klient.nazwa }],
      klient,
      opis: opisKlienta(klient, { zwolniona: zwolnionaFirma() }),
      zamowienia,
      podsumowanie: podsumowanieHistorii(zamowienia),
      // ⚠️ STATUS LICZY DOMENA, nie widok — ta sama funkcja, co na liście i na karcie
      // zamówienia. Druga reguła w szablonie oznaczałaby, że to samo zamówienie ma tu
      // inny status niż po kliknięciu w jego numer.
      wyliczStatus,
      ETYKIETY: etykietyStatusow(db),
      dostawy: DOSTAWY,
      // Grosze na złotówki zamienia domena (domena/kwoty.js), nie dzielenie w szablonie.
      zl,
    });
  });

  // Zgodność zapisanych wcześniej adresów edycji.
  app.get('/klienci/:id/edytuj', async (req, reply) => {
    const klient = klientPoId(db, req.params.id);
    if (!klient) return brakKlienta(reply);
    return reply.redirect(`/klienci/${klient.id}`, 303);
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
      // Awaria GUS-u NIE MOŻE wywalić ekranu razem z tym, co operator zdążył wpisać.
      // Pełna treść idzie do dziennika.
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
        + `REGON ${firma.regon ?? '—'}) — dane WSTAWIONE DO FORMULARZA klienta B2B, `
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
    if (id && !edytowany) return brakKlienta(reply);

    let dane;
    try {
      dane = znormalizujKlienta(req.body ?? {});
    } catch (e) {
      // ⚠️ ODMOWA ODDAJE FORMULARZ I ZOSTAWIA GO OTWARTYM. Skasowanie
      // wpisanych pól komunikatem byłoby karą za literówkę w jednym z nich, a formularz
      // zamknięty pokazywałby komunikat o polu, którego na ekranie nie ma.
      return renderuj(reply.code(400), {
        formularz: req.body ?? {}, edytowany, blad: komunikatDlaOperatora(e), otwarty: true,
      });
    }

    // Nie pozwalamy założyć umowy, której faktury nie miałyby dostępnego ekranu.
    if (dane.rozliczenie_zbiorcze === 1 && wylaczoneModuly(db).includes('okresy')) {
      return renderuj(reply.code(409), {
        formularz: req.body ?? {}, edytowany, otwarty: true,
        blad: 'Włącz Rozliczenia w Ustawieniach → System → Włączone funkcje przed zapisaniem umowy zbiorczej.',
      });
    }
    // Klucz do dziennika bierzemy Z BAZY: `dane.klucz` jest wyliczony z nazwy, a baza dokłada „-2”,
    // „klient-3” przy kolizji i nie zmienia klucza przy edycji.
    let kluczWBazie;
    try {
      if (edytowany) { zapiszKlienta(db, edytowany.id, dane); kluczWBazie = edytowany.klucz; }
      else kluczWBazie = klientPoId(db, dopiszKlienta(db, dane)).klucz;
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
        + `klienta B2B „${dane.nazwa}" (${kluczWBazie}) — ${opisKlienta(dane, { zwolniona: zwolnionaFirma() })}.`,
    });
    return reply.redirect('/klienci');
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
    prog_darmowej_dostawy_wlaczony: k.prog_darmowej_dostawy_gr != null ? 'on' : '',
    oplata_obslugi_wlaczony: k.oplata_obslugi_gr != null ? 'on' : '',
  };
}

const wZlotych = (gr) => (Number.isInteger(gr) ? zl(gr) : '');
