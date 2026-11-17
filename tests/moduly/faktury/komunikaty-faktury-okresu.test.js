// Treść dwóch komunikatów odmowy faktury okresu (services/faktura-okresu.js), które nie miały
// testu treści: (a) zamówienie okresu ma już własną fakturę, (b) program odpowiedział bez numeru i bez identyfikatora.
// Sprawdzamy zdania w całości (sens, nie tylko początek), na programie testowym „Testownik” — nazwa programu
// ma wejść w zdanie. Zwyczaje jednej firmy w tych zdaniach pilnuje `teksty-ksef-bez-zwyczajow`.
import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapewnijOkres, pobierzOkres } from '../../../src/oms/db/okresy.js';
import { createFakturaOkresu } from '../../../src/moduly/faktury/services/faktura-okresu.js';
import { STAN } from '../../../src/domena/okres-rozliczeniowy.js';
import { programTestowy } from '../../pomoc/program-testowy.js';

const NIP_PRACOWNI = '5250000009'; // zmyślony, z poprawną sumą kontrolną

function bazaZOkresem() {
  const db = openOmsDb();
  const okres = zapewnijOkres(db, { klientKlucz: 'polcien', rok: 2026, miesiac: 9 });
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id, utworzone_at)'
    + " VALUES ('reczne', 202600041, 'R/2026/041', '104.00', ?, '2026-09-10T10:00:00.000Z')",
  ).run(okres.id);
  const zamId = db.prepare('SELECT id FROM zamowienia WHERE numer = ?').get('R/2026/041').id;
  db.prepare(
    'INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo)'
    + " VALUES (?, 'Lampa wisząca Półksiężyc', 1, '100.00', '100.00', 'reczna'),"
    + " (?, 'Obsługa zamówienia', 1, '4.00', '4.00', 'reczna')",
  ).run(zamId, zamId);
  return { db, okres, zamId };
}

const komunikat = (obietnica) => obietnica.then(() => { throw new Error('oczekiwano odmowy'); }, (e) => e.message);

describe('komunikaty odmowy faktury okresu', () => {
  it('zamówienie okresu ma już własną fakturę: numer zamówienia i faktury, „NIE została wystawiona”, skasuj w programie dopóki nie poszła do KSeF, potem korekta', async () => {
    const { db, okres, zamId } = bazaZOkresem();
    db.prepare("INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_status, utworzona_at) VALUES (?, 'u-0', 'FV 0/09/2026', NULL, '2026-09-11T09:00:00.000Z')")
      .run(zamId);
    const program = programTestowy();
    const tekst = await komunikat(createFakturaOkresu({ db, program }).wystaw(okres.id, { nip: NIP_PRACOWNI }));
    expect(tekst).toContain('Zamówienie R/2026/041 ma już własną fakturę (FV 0/09/2026)');
    expect(tekst).toContain('faktura zbiorcza obciążyłaby klienta za ten sam towar drugi raz');
    expect(tekst).toContain('Faktura za okres NIE została wystawiona');
    expect(tekst).toContain('rozstrzygnij najpierw tamten dokument w Testowniku '
      + '(skasuj go, dopóki nie poszedł do KSeF; potem zostaje korekta).');
    expect(program.wystaw).not.toHaveBeenCalled();
    expect(pobierzOkres(db, okres.id).stan).toBe(STAN.OTWARTY);
  });

  it('program odpowiedział bez numeru i identyfikatora: sprawdź ręcznie w programie, skasuj jeśli nie poszła do KSeF, panel sam nie wyjdzie z blokady', async () => {
    const { db, okres } = bazaZOkresem();
    const program = programTestowy({ metody: { wystaw: async () => ({ uuid: null, numer: null }) } });
    const tekst = await komunikat(createFakturaOkresu({ db, program }).wystaw(okres.id, { nip: NIP_PRACOWNI }));
    expect(tekst).toContain('Testownik odpowiedział bez numeru i bez identyfikatora dokumentu '
      + '(puste albo nieczytelne ciało odpowiedzi) — faktura mogła powstać.');
    expect(tekst).toContain('Sprawdź RĘCZNIE w Testowniku, czy faktura za ten okres istnieje. '
      + 'Jeśli JEST i jeszcze nie poszła do KSeF — skasuj ją tam. '
      + 'Panel sam z tego stanu NIE WYJDZIE i wystawienia nie ponowi: okres zostaje zablokowany, '
      + 'dopóki ktoś go świadomie nie odblokuje.');
    expect(pobierzOkres(db, okres.id).blad_opis).toContain('Testownik odpowiedział bez numeru');
  });
});
