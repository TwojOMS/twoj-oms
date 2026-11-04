/** Czytelny opis neutralnej odmowy, wspólny dla programów fakturowych. */
export function opisOdrzuceniaKorekty({ nazwaProgramu, bledy }) {
  const szczegoly = bledy.map(({ pole, komunikaty }) => `${pole} — ${komunikaty.join(', ')}`).join('; ');
  const tresc = `${nazwaProgramu} nie wystawił korekty${szczegoly ? `: ${szczegoly}` : '.'}`;
  const wskazowka = ' Popraw i wystaw ponownie.';
  return tresc.slice(0, 500 - wskazowka.length) + wskazowka;
}
