import { describe, it, expect } from 'vitest';
import { readFileSync } from './pliki-historyczne.js';

// UKLAD BELKI AKCJI — pilnuje KONTRAKTU EKRANU, ktorego zadien test tras nie widzi:
// (1) cztery akcje jako <details name="akcja"> w JEDNEJ belce nad tabela;
// (2) formaction i pary zakresow NIETKNIETE wzgledem stanu sprzed przebudowy;
// (3) belka jest przyklejona (position: sticky) — regula w arkuszu layoutu.
const widok = readFileSync('src/oms/web/views/magazyn-lista.ejs', 'utf8');
const layout = readFileSync('src/oms/web/views/layout-oms.ejs', 'utf8');

describe('belka akcji magazynu', () => {
  it('cztery akcje w details name="akcja" wewnątrz jednej belki', () => {
    // ⚠️ Koniec wycinka kotwiczymy forma ATRYBUTU `class="przewijak-tabeli"` — samo slowo
    // `przewijak-tabeli` pada wczesniej, wewnatrz komentarza ostrzegawczego nad divem, wiec
    // indexOf na golym slowie trafia w proze, a nie w element (i przycina wycinek za wczesnie).
    const belka = widok.slice(widok.indexOf('class="belka-akcji"'), widok.indexOf('class="przewijak-tabeli"'));
    expect((belka.match(/<details class="akcja" name="akcja"/g) ?? []).length).toBe(4);
    for (const tytul of ['Ustaw pola', 'Nadaj SKU', 'Przejmij numery', 'Zapisz do sklepów']) {
      expect(belka).toContain(`<summary>${tytul}</summary>`);
    }
    // ⚠️ ZADNA akcja nie jest rozwinieta z serwera. `open` na `.odczyt-szczegoly` wyzej JEST
    // regula (trwanie i blad odczytu), ale tutaj bylby wylacznie ozdoba: cztery ciala
    // rozwiniete naraz to dokladnie ten ekran, ktory ta przebudowa zwija.
    expect(belka).not.toMatch(/<details class="akcja" name="akcja"[^>]*\bopen\b/);
  });

  it('belka stoi NAD przewijakiem tabeli, nie w nim ani pod nim', () => {
    // ⚠️ Ta sama pulapka, co wyzej: kotwiczyc `class="przewijak-tabeli"`, nie gole slowo.
    const indeksBelki = widok.indexOf('class="belka-akcji"');
    const indeksPrzewijaka = widok.indexOf('class="przewijak-tabeli"');
    expect(indeksBelki).toBeGreaterThan(-1);
    expect(indeksPrzewijaka).toBeGreaterThan(-1);
    // sticky umiera pod KAZDYM przodkiem z overflow innym niz visible — .przewijak-tabeli ma
    // `overflow-x: auto`, wiec wciagniecie belki do srodka (albo za niego) odklei ja po cichu:
    // znacznik i klasy nadal wygladaja poprawnie, a belka zjezdza z ekranu przy przewinieciu.
    expect(indeksBelki).toBeLessThan(indeksPrzewijaka);
  });

  it('belka i checkbox "zaznaczone" siedza w TYM SAMYM formularzu na /magazyn/hurt', () => {
    const indeksBelki = widok.indexOf('class="belka-akcji"');
    // ⚠️ Widok ma pieć formularzy (odswiez, utworz-karty, filtry, szukajka, hurt) — kotwiczyc
    // WYLACZNIE po literalnym action tego jednego, inaczej mozna zlapac cudzy </form>.
    const indeksFormularza = widok.indexOf('action="/magazyn/hurt"');
    expect(indeksFormularza).toBeGreaterThan(-1);
    expect(indeksBelki).toBeGreaterThan(-1);
    // pierwszy </form> PO belce jest jej wlasnym zamknieciem — wczesniejsze naleza do
    // formularzy filtrow/szukajki/odswiezania i nie wolno ich zlapac jako granicy.
    const koniecFormularza = widok.indexOf('</form>', indeksBelki);
    expect(koniecFormularza).toBeGreaterThan(-1);
    // belka poza tym formularzem = osiem martwych przyciskow (submit bez formularza-rodzica
    // nie wysyla nic) — kolejnosc w zrodle jest jedynym dowodem, ze naprawde siedzi w srodku.
    expect(indeksFormularza).toBeLessThan(indeksBelki);
    expect(indeksBelki).toBeLessThan(koniecFormularza);
    const indeksZaznaczone = widok.indexOf('name="zaznaczone"');
    expect(indeksZaznaczone).toBeGreaterThan(-1);
    // dowod, ze checkboxy wierszy i belka dzielą ten sam formularz, a nie tylko sasiaduja.
    expect(indeksZaznaczone).toBeGreaterThan(indeksBelki);
    expect(indeksZaznaczone).toBeLessThan(koniecFormularza);
  });

  it('pary przycisków zakresu i formaction bez zmian', () => {
    for (const adres of ['/magazyn/sku-podglad', '/magazyn/przejmij-podglad', '/magazyn/podglad-zapisu']) {
      expect((widok.match(new RegExp(`formaction="${adres}"`, 'g')) ?? []).length).toBe(2);
    }
    // hurt bez formaction — trafia w action formularza:
    expect(widok).toContain('action="/magazyn/hurt"');
    expect((widok.match(/name="zakres" value="zaznaczone"/g) ?? []).length).toBe(4);
    expect((widok.match(/name="zakres" value="pasujace"/g) ?? []).length).toBe(4);
    // ⚠️ LICZBA, NIE OBECNOSC: duplikat ukrytego `zawezenie` (pole powtorzone przy kolejnej
    // akcji) wraca z Fastify TABLICA, `pole()` scina ja do null i caly hurtowy zakres znika
    // po cichu w formularzu, ktory go ustawia — `toContain` by tego nie zlapal, bo string
    // nadal go zawiera.
    expect((widok.match(/name="zawezenie"/g) ?? []).length).toBe(1);
  });

  it('belka jest przyklejona regułą w arkuszu layoutu', () => {
    const start = layout.indexOf('.belka-akcji {');
    // ⚠️ Koniec okna to PIERWSZA „}" po otwarciu, nie „start + 400": stare okno konczylo sie
    // tam, gdzie zaczynalo (indexOf na golym „.belka-akcji ” bez klamry trafia w TEN SAM
    // znak co otwarcie reguly), wiec polykalo tez kolejne reguly (np. .belka-akcji-etykieta)
    // i sticky przeniesiony tam dalej wciaz dawalby zielony test.
    const koniec = layout.indexOf('}', start);
    expect(koniec).toBeGreaterThan(start);
    const regula = layout.slice(start, koniec);
    expect(regula).toContain('position: sticky');
  });
});
