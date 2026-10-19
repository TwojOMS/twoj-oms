// PRZ-101.03: „Wstaw szablon" w odpowiedzi na wątek Allegro — treść szablonu (już z podstawionymi polami,
// policzona przez serwer w <template>) wchodzi w miejsce kursora, bez przeładowania strony, więc wybrane
// załączniki i wpisany tekst zostają. Bez tego skryptu formularz idzie zwykłym GET-em z ?szablon=.
(() => {
  for (const form of document.querySelectorAll('[data-wstaw-szablon]')) {
    const pole = document.getElementById('m-reply');
    const lista = form.querySelector('select');
    if (!pole || !lista) continue;
    form.addEventListener('submit', (zdarzenie) => {
      const wzor = [...form.querySelectorAll('template[data-szablon]')].find((t) => t.dataset.szablon === lista.value);
      if (!wzor) return;
      zdarzenie.preventDefault();
      const tekst = wzor.content.textContent;
      const { value: dotad } = pole;
      const od = dotad ? pole.selectionStart : 0;
      const doZnaku = dotad ? pole.selectionEnd : 0;
      pole.value = dotad.slice(0, od) + tekst + dotad.slice(doZnaku);
      pole.focus();
      pole.setSelectionRange(od + tekst.length, od + tekst.length);
      // Licznik znaków i szkic (messages-prz065.js) słuchają `input`.
      pole.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
})();
