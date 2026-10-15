import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import {
  zarejestrujPrzesylkeReczna, nastepnaKolejnosc, rozpocznijPrzesylke, zakonczPrzesylke, skasujPrzesylkeReczna,
} from '../../../src/moduly/wysylka/db/przesylki.js';

const zmapowane = (id) => ({
  zrodlo_id: id, numer: String(id), klient: {}, dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null,
  chce_fakture: 0, nip: null, kwota_brutto: '10.00', koszt_dostawy_brutto: '0.00', status_woo: 'processing',
  oplacone_at: null, anulowane: 0, utworzone_at: '2026-07-29T10:00:00', pozycje: [],
});

let db, id;
beforeEach(() => {
  db = openOmsDb(':memory:');
  id = zapiszZamowienie(db, 'pro', zmapowane(1701), {});
});

const wiersze = () => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ? ORDER BY id').all(id);

describe('zarejestrujPrzesylkeReczna', () => {
  it('tworzy przesylke NADANA, z numerem listu i znacznikiem recznosci', () => {
    const p = zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 1, numerListu: '0000123456789A' });
    expect(p).toMatchObject({ status: 'nadana', numer_listu: '0000123456789A', kolejnosc: 1, nadana_recznie: 1 });
    // Zadnych sladow po etykiecie: panel jej nigdy nie dostal, wiec nie wolno jej obiecywac.
    expect(p.etykieta_sciezka).toBeNull();
    expect(p.etykieta_zpl_sciezka).toBeNull();
  });

  it('numer listu jest wymagany — bez niego odmowa i ZERO wierszy', () => {
    expect(() => zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 1, numerListu: '  ' }))
      .toThrow(/numer listu/i);
    expect(wiersze()).toHaveLength(0);
  });

  // ⚠️ TEN SAM indeks unikalny, co przy nadaniu z panelu. Rejestracja reczna nie ma prawa
  // byc furtka omijajaca siatke, ktora chroni przed druga paczka pod tym samym numerem.
  it('druga rejestracja pod TYM SAMYM numerem kolejnym odbija sie od indeksu', () => {
    zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 1, numerListu: '0000111111111A' });
    expect(() => zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 1, numerListu: '0000222222222A' }))
      .toThrow(/ma juz nadana przesylke|ma już nadaną przesyłkę/i);
    expect(wiersze()).toHaveLength(1);
    expect(wiersze()[0].numer_listu).toBe('0000111111111A');
  });

  // Rejestracja reczna zajmuje numer kolejny TAK SAMO jak nadanie z panelu — inaczej
  // nastepna paczka pojechalaby do DPD z ta sama referencja.
  it('zajmuje numer kolejny widziany przez nastepnaKolejnosc', () => {
    expect(nastepnaKolejnosc(db, id)).toBe(1);
    zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 1, numerListu: '0000111111111A' });
    expect(nastepnaKolejnosc(db, id)).toBe(2);
    zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 2, numerListu: '0000222222222A' });
    expect(nastepnaKolejnosc(db, id)).toBe(3);
  });

  it('blokuje nadanie z panelu pod tym samym numerem kolejnym', () => {
    zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 1, numerListu: '0000111111111A' });
    expect(() => rozpocznijPrzesylke(db, id, 'dpd', 1)).toThrow(/ma juz nadana przesylke|ma już nadaną przesyłkę/i);
  });

  // Ta sama odmowa, co w rozpocznijPrzesylke: dopoki nie wiadomo, czy paczka u kuriera
  // powstala, dokladanie nastepnej jest wlasnie tym bledem, ktory panel ma wykluczac.
  it('odmawia, gdy inna paczka wisi w toku', () => {
    rozpocznijPrzesylke(db, id, 'dpd', 1);
    expect(() => zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 2, numerListu: '0000222222222A' }))
      .toThrow(/wlasnie trwa|właśnie trwa/i);
    expect(wiersze()).toHaveLength(1);
  });
});

describe('skasujPrzesylkeReczna', () => {
  it('kasuje wiersz zarejestrowany recznie i zwraca go (numer listu, kolejnosc) pod log', () => {
    const p = zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 1, numerListu: '0000123456789A' });
    const skasowana = skasujPrzesylkeReczna(db, p.id);
    expect(skasowana).toMatchObject({ numer_listu: '0000123456789A', kolejnosc: 1, nadana_recznie: 1 });
    expect(wiersze()).toHaveLength(0);
  });

  // ⚠️ GRANICA, ktorej nie wolno przekroczyc: przesylka nadana Z PANELU ma prawdziwy numer
  // listu przydzielony przez DPD, paczka fizycznie istnieje u kuriera. Skasowanie takiego
  // wiersza otworzyloby droge do drugiego nadania pod ta sama referencja.
  it('NIGDY nie kasuje przesylki nadanej z panelu (nadana_recznie nie ustawione)', () => {
    const p = zakonczPrzesylke(db, rozpocznijPrzesylke(db, id, 'dpd', 1).id, {
      numerListu: '0000999999999A', etykietaSciezka: '/tmp/e.pdf', surowa: '{}',
    });
    const wiersz = wiersze()[0];
    expect(() => skasujPrzesylkeReczna(db, wiersz.id)).toThrow(/nie jest zarejestrowana ręcznie|nie jest zarejestrowana recznie/i);
    expect(wiersze()).toHaveLength(1);
    expect(wiersze()[0].numer_listu).toBe('0000999999999A');
    void p;
  });

  // Sedno luki: po skasowaniu miejsce w indeksie (zamowienie_id, kolejnosc) ma byc WOLNE,
  // zeby dalo sie zarejestrowac poprawny numer pod tym samym numerem kolejnym.
  it('zwalnia miejsce w indeksie — ponowna rejestracja pod TYM SAMYM numerem kolejnym przechodzi', () => {
    const p = zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 1, numerListu: '0000LITEROWKA' });
    skasujPrzesylkeReczna(db, p.id);
    const poprawna = zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 1, numerListu: '0000POPRAWNY' });
    expect(poprawna).toMatchObject({ numer_listu: '0000POPRAWNY', kolejnosc: 1 });
    expect(wiersze()).toHaveLength(1);
  });

  // ⚠️ M-2. DRUGA GRANICA: przesylka odczytana z konta Allegro. Niesie `nadana_recznie = 1`
  // z powodu czysto technicznego (bez tego wisialaby przy niej wieczna sprawa „brak
  // etykiety"), wiec sprawdzenie wyzej ja PRZEPUSZCZA — a skutek skasowania nie jest
  // „mylacy", tylko TRWALY: karta pyta Allegro o przesylki wylacznie dopoki zamowienie nie
  // ma `wyslane_at`, wiec po oznaczeniu wysylki numer listu przepada bezpowrotnie. Literowki
  // przy nim byc nie moze — numeru nikt nie przepisywal, przyszedl z API.
  //
  // ⚠️ ROZPOZNAJE JA `zrodlo_numeru`, A NIE `kurier` (poprawka I-1 recenzji calej galezi) —
  // patrz test „literowka we WPISANYM Z REKI numerze" nizej, ktory jedzie z TYM SAMYM
  // kurierem i ma sie skasowac.
  it('NIGDY nie kasuje przesylki z ALLEGRO — numer listu przepadlby bezpowrotnie', () => {
    const p = zarejestrujPrzesylkeReczna(db, id, {
      kurier: 'allegro', kolejnosc: 1, numerListu: 'AD0LK57DLG0756H4H', zrodloNumeru: 'allegro',
    });
    expect(p.nadana_recznie).toBe(1); // wlasnie dlatego sprawdzenie `nadana_recznie` nie wystarcza

    expect(() => skasujPrzesylkeReczna(db, p.id)).toThrow(/Allegro/);
    expect(wiersze()).toHaveLength(1);
    expect(wiersze()[0].numer_listu).toBe('AD0LK57DLG0756H4H');
  });

  // ⚠️⚠️ I-1 (recenzja calej galezi). TEN SAM KURIER, INNE ZRODLO NUMERU — i dlatego wynik
  // musi byc ODWROTNY niz w tescie wyzej.
  //
  // `kurierWpisuRecznego('allegro_*')` (kurierzy/index.js) oddaje 'allegro' takze dla wiersza,
  // ktory czlowiek WPISAL Z REKI na karcie zamowienia z Allegro — i tam literowka jest jak
  // najbardziej mozliwa. Odmowa kluczowana kurierem obejmowala ten przypadek i uzasadniala go
  // zdaniem „numer panel PRZECZYTAL z konta Allegro", czyli nieprawda. Zly numer zostawal
  // WTEDY NA ZAWSZE: rejestracja reczna ustawia `wyslane_at`, wiec prawdziwy numer juz sie nie
  // dociagnie, a jedynym wyjsciem byl DELETE w pliku bazy (niezmiennik 4.9 wprost).
  it('KASUJE literowke we WPISANYM Z REKI numerze, choc kurier to „allegro"', () => {
    const p = zarejestrujPrzesylkeReczna(db, id, { kurier: 'allegro', kolejnosc: 1, numerListu: 'AD-LITEROWKA' });
    // Ksztalt wiersza jest tu NIEODROZNIALNY od odczytanego z API po obu starych kolumnach:
    expect(p.nadana_recznie).toBe(1);
    expect(p.kurier).toBe('allegro');

    const skasowana = skasujPrzesylkeReczna(db, p.id);
    expect(skasowana.numer_listu).toBe('AD-LITEROWKA');
    expect(wiersze()).toHaveLength(0);
    // …i miejsce w indeksie jest wolne, wiec poprawny numer da sie zarejestrowac od nowa.
    const poprawna = zarejestrujPrzesylkeReczna(db, id, { kurier: 'allegro', kolejnosc: 1, numerListu: 'AD-POPRAWNY' });
    expect(poprawna).toMatchObject({ numer_listu: 'AD-POPRAWNY', kolejnosc: 1 });
  });

  it('powod odmowy dla Allegro mowi CZLOWIEKOWI, o co chodzi', () => {
    const p = zarejestrujPrzesylkeReczna(db, id, {
      kurier: 'allegro', kolejnosc: 1, numerListu: 'AD1', zrodloNumeru: 'allegro',
    });
    const blad = (() => { try { skasujPrzesylkeReczna(db, p.id); return null; } catch (e) { return e; } })();

    // Komunikat idzie na ekran operatora, wiec musi byc oznaczony jako jego, a nie jako
    // „blad techniczny panelu" (ta sama zasada, co przy pozostalych odmowach tej funkcji).
    expect(blad.dlaOperatora).toBe(true);
    expect(blad.message).toContain('AD1');
    expect(blad.message).toMatch(/nie wróci|nie wroci|stracony|bezpowrotnie/i);
  });

  it('rzuca dla nieistniejacej przesylki', () => {
    expect(() => skasujPrzesylkeReczna(db, 999999)).toThrow(/nie ma takiej przesyłki|nie ma takiej przesylki/i);
  });
});
