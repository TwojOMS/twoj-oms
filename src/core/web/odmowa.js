// PRZ-152.G13 (właściciel 05.11: „trzeba sprawdzić wszystkie komunikaty, czy dobrze się wyświetlają”):
// odmowa trasy wołanej formularzem albo linkiem — strona w układzie OMS (menu, motyw, pasek uwagi,
// droga powrotu) zamiast gołego text/plain na czarnym tle. Status i tekst odmowy BEZ ZMIAN — zmienia
// się tylko opakowanie. Trasy dla programu (API, czuwacz, fetch) zostają przy swoim formacie.
// Spis miejsc i paczki: docs/plany/PRZ-152-G13-odmowy.md. Wzór: bladNadania (wysylka/trasy/nadanie.js).

// Powrót tylko na adres w obrębie panelu: „//host” i pełne adresy wypadają na listę zamówień.
export const adresLokalny = (a) => (typeof a === 'string' && a.startsWith('/') && !a.startsWith('//') && !a.startsWith('/\\') ? a : '/');

// Panel bez modułu web (sama kompozycja API, bez renderera) nie ma `reply.view` — wtedy odmowa zostaje
// gołym tekstem jak przed G13, zamiast wyjątku, który Fastify zamienia na JSON bez komunikatu.
export const stronaOdmowy = (reply, status, komunikat, { tytul = 'Nie udało się wykonać polecenia', wroc = '/', napisWroc = 'Wróć' } = {}) =>
  typeof reply.view !== 'function'
    ? reply.code(status).type('text/plain; charset=utf-8').send(komunikat)
    : reply.code(status).type('text/html; charset=utf-8').view('odmowa.ejs', { tytul, komunikat, wroc: adresLokalny(wroc), napisWroc });
