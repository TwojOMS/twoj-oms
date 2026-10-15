import { describe, it, expect } from 'vitest';
import { renderPotwierdzenieHtml } from '../../pomoc/potwierdzenie-html-parytetu.js';
import { modelPotwierdzenia } from '../../pomoc/potwierdzenie-parytetu.js';

// POTWIERDZENIE PRZYJĘCIA ZAMÓWIENIA — postać HTML (21.08.2026).
//
// ⚠️ Model budujemy PRAWDZIWĄ funkcją domeny, a nie literałem: test ma pilnować całej drogi
// „zamówienie → model → tabela", bo właśnie na tej drodze zginęła poprzednia wersja maila
// (tekst szedł do renderera napisanego pod maile z wyceną i wychodził bez tabeli).

const zam = (nad = {}) => ({
  numer: 'R/2026/015', utworzone_at: '2026-08-21T09:00:00Z', sklep: 'reczne',
  kwota_brutto: '990.00', koszt_dostawy_brutto: '0.00', metoda_wysylki: 'dpd',
  metoda_platnosci: 'Przelew', termin_platnosci: '14', anulowane: 0, chce_fakture: 1,
  nip: '1000001046',
  klient: {
    email: 'sklep@betamet.pl', company: '"BETAMET" SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ',
    address_1: 'ul. Przemysłowa 1', postcode: '62-070', city: 'Zakrzewo',
  },
  dostawa: {
    company: '"BETAMET" SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ',
    address_1: 'ul. Przemysłowa 1', postcode: '62-070', city: 'Zakrzewo',
  },
  pozycje: [{ nazwa: 'Szablon INWALIDA 70x100', ilosc: 10, cena_brutto: '99.00', brutto_linii: '990.00' }],
  ...nad,
});

const html = (nad = {}) => renderPotwierdzenieHtml(modelPotwierdzenia(zam(nad)));

describe('tabela pozycji', () => {
  // ⚠️⚠️ NAJWAŻNIEJSZY TEST TEGO PLIKU i powód, dla którego on istnieje. Poprzednia wersja
  // maila „miała tabelę" wyłącznie w opisie: renderer nie rozpoznawał jej linii, więc do
  // klienta szedł ciąg akapitów. Sprawdzamy STRUKTURĘ, nie obecność znaczników.
  it('ma nagłówki kolumn i wiersz na pozycję', () => {
    const h = html();
    expect(h).toMatch(/<table[\s\S]*Pozycja[\s\S]*Ilość[\s\S]*Cena[\s\S]*Wartość[\s\S]*<\/table>/);
    expect(h).toMatch(/Szablon INWALIDA 70x100[\s\S]{0,400}>10<[\s\S]{0,400}99,00 zł[\s\S]{0,400}990,00 zł/);
  });

  // ⚠️ „Razem" jest częścią TEJ SAMEJ tabeli, a nie akapitem pod nią — inaczej na wąskim
  // ekranie suma odjeżdża od kolumny, w której klient jej szuka.
  it('suma stoi w tej samej tabeli, co pozycje', () => {
    expect(html()).toMatch(/<table[\s\S]*Razem brutto[\s\S]*990,00 zł[\s\S]*<\/table>/);
  });

  it('wysyłka jest zwykłym wierszem tabeli', () => {
    const h = html({ koszt_dostawy_brutto: '19.00', kwota_brutto: '1009.00' });
    expect(h).toMatch(/Wysyłka[\s\S]{0,400}19,00 zł/);
    expect(h).toContain('1 009,00 zł'.replace(' ', '')); // 1009,00 zł — bez separatora tysięcy
  });
});

describe('nagłówki sekcji', () => {
  it('są wszystkie cztery i w tej kolejności', () => {
    expect(html()).toMatch(/Zamówienie[\s\S]*Płatność[\s\S]*Wysyłka[\s\S]*Faktura/);
  });

  it('płatność niesie uzgodniony termin', () => {
    expect(html()).toContain('Przelew, termin 14 dni');
  });
});

describe('sekcja faktury', () => {
  // Prośba właściciela wprost: „FAKTURA: tak, dane do faktury: …".
  it('przy „chcę fakturę" mówi TAK i wypisuje dane nabywcy', () => {
    const h = html();
    expect(h).toContain('Tak — wystawimy na:');
    expect(h).toContain('NIP 1000001046');
    expect(h).toContain('ul. Przemysłowa 1');
    expect(h).toContain('62-070 Zakrzewo');
  });

  // ⚠️ Pokazuje się ZAWSZE — także z odpowiedzią „Nie". To jedyny moment, w którym klient
  // może bezkosztowo sprostować, że jednak chce fakturę.
  it('bez faktury mówi NIE, zamiast milczeć', () => {
    const h = html({ chce_fakture: 0 });
    expect(h).toMatch(/Faktura[\s\S]{0,300}>Nie</);
    expect(h).not.toContain('wystawimy na');
  });

  // ⚠️ BEZ E-MAILA — na fakturze go nie ma, a wypisany kusi, żeby go poprawiać jako „dane
  // do faktury", czym nie jest.
  it('nie wypisuje adresu e-mail nabywcy', () => {
    expect(html()).not.toContain('sklep@betamet.pl');
  });
});

describe('adres dostawy', () => {
  it('idzie w całości', () => {
    expect(html()).toMatch(/ul\. Przemysłowa 1<br>62-070 Zakrzewo/);
  });

  // Ta sama reguła, co w wersji tekstowej: sama nazwa (bywa nią e-mail) nie jest adresem.
  it('bez ulicy i miasta mówi „do uzgodnienia"', () => {
    expect(html({ dostawa: { first_name: 'anna.nowak@example.org' } }))
      .toContain('adres do uzgodnienia');
  });
});

describe('higiena maila', () => {
  // ⚠️ CUDZYSŁOWY W NAZWIE FIRMY SĄ TU REGUŁĄ, NIE PRZYPADKIEM — „BETAMET" i FIRMA BUDOWLANA
  // „B.D.M." tak wyglądają w REGON-ie. Niezaescapowane rozwaliłyby atrybut `style` albo
  // `srcdoc` na ekranie podglądu.
  it('escapuje cudzysłowy w nazwie firmy', () => {
    const h = html();
    expect(h).toContain('&quot;BETAMET&quot;');
    expect(h).not.toContain('"BETAMET"');
  });

  it('style wyłącznie inline — Gmail i Outlook wycinają <style> z <head>', () => {
    expect(html()).not.toMatch(/<style[\s>]/);
  });

  it('żadnych zasobów z sieci — połowa klientów je blokuje', () => {
    const h = html();
    expect(h).not.toMatch(/<img\s/);
    expect(h).not.toMatch(/<link\s/);
    expect(h).not.toContain('src="http');
  });

  it('koperta jest ta sama, co w mailach z wyceną', () => {
    const h = html();
    expect(h).toMatch(/^<!doctype html>/);
    expect(h).toContain('SZKICOWNIA');
  });

  // ⚠️ Podpisujemy się MARKĄ, nie nazwą podmiotu (decyzja właściciela 21.08.2026).
  it('podpisuje się Szkicownia.pl', () => {
    const h = html();
    expect(h).toContain('Szkicownia.pl');
    expect(h).not.toContain('Lumina');
  });
});
