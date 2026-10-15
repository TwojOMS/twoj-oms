// Przycisk „Akceptuję wycenę" w wersji HTML maila. Rozpoznanie idzie po SĄSIEDZTWIE
// (linia zakończona dwukropkiem, pod nią linia będąca samym adresem) — nie po treści
// etykiety, więc działa też po zmianie napisu w /settings.
import { describe, it, expect } from 'vitest';
import { renderMailHtml } from '../../../src/core/poczta/mail-html.js';

const LINK = 'https://pro.szkicownia.pl/?oferta=1293&t=abc';

describe('przycisk akceptacji w HTML', () => {
  it('para „etykieta: / adres" staje się przyciskiem', () => {
    const t = ['pozdrawiam', '', 'Akceptuję wycenę — przejdź do zamówienia:', LINK].join('\n');
    const h = renderMailHtml({ text: t });
    expect(h).toMatch(/<a[^>]+href="https:\/\/pro\.szkicownia\.pl\/\?oferta=1293&amp;t=abc"[^>]*>[\s\S]*?Akceptuję wycenę/);
    // Etykieta NIE zostaje osobnym akapitem nad przyciskiem.
    expect(h).not.toMatch(/<p[^>]*>Akceptuję wycenę — przejdź do zamówienia:<\/p>/);
  });

  // ⚠️ Bez tego zwykły adres w treści zamieniałby się w wielki przycisk wszędzie tam,
  // gdzie go nie chcemy — np. w mailu z danymi do przelewu.
  it('goły adres BEZ linii z dwukropkiem nad nim zostaje zwykłym linkiem', () => {
    const h = renderMailHtml({ text: `Dzień dobry\n${LINK}` });
    expect(h).toContain('href="https://pro.szkicownia.pl/?oferta=1293&amp;t=abc"');
    expect(h).not.toContain('display:inline-block');
  });

  it('adres w środku zdania nie robi przycisku', () => {
    const h = renderMailHtml({ text: `Zapraszamy: sklep pod adresem ${LINK} działa.` });
    expect(h).toContain('<a href=');
    expect(h).not.toContain('display:inline-block');
  });

  // ⚠️ „Wycena:" też kończy się dwukropkiem, a pod nią stoi pozycja — nie adres.
  // Nagłówek tabeli nie może zamienić się w przycisk.
  it('nagłówek tabeli wyceny zostaje nagłówkiem', () => {
    const t = ['Wycena:', '1x szablon - 100zł brutto/szt', 'Razem: 100zł (81,30zł netto)'].join('\n');
    const h = renderMailHtml({ text: t });
    expect(h).not.toContain('<a href=');
    // ⚠️ Nagłówek sekcji od 22.08.2026 rysuje się jako „eyebrow" (wersaliki, rozstrzelenie,
    // kolor akcentu) i BEZ dwukropka — dwukropek jest umową tekstową, nie tekstem dla oka.
    expect(h).toMatch(/letter-spacing:2px;text-transform:uppercase;color:[^"]*">Wycena<\/p>/);
  });

  it('pełny mail z wyceną: tabela ORAZ przycisk, każde na swoim miejscu', () => {
    const t = [
      'Wycena:', '1x szablon - 100zł brutto/szt',
      'przygotowanie projektu - w cenie', 'wysyłka kurierem DPD - gratis',
      'Razem: 100zł (81,30zł netto)', '',
      'pozdrawiam', '',
      'Akceptuję wycenę — przejdź do zamówienia:', LINK,
    ].join('\n');
    const h = renderMailHtml({ text: t });
    expect(h).toContain('<table');
    expect(h).toContain('display:inline-block');
    // Przycisk stoi PO tabeli — jest ostatnią rzeczą, którą klient widzi.
    expect(h.indexOf('display:inline-block')).toBeGreaterThan(h.indexOf('Razem'));
  });
});
