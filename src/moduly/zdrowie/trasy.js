// GET /health — puls panelu dla czujki monitoring (zewnętrzny skrypt monitoringu).
//
// Trasa jest OTWARTA (wpis w TRASY_OTWARTE, security/logowanie-wspolne.js) i CELOWO gluchа
// na wszystko poza GET: czujka to skrypt sh z samym curl-em, bez poswiadczen. Odpowiedz
// niesie wylacznie wiek zegarow, progi i stan kanalow po bialej liscie stanKanalu() —
// zero danych klientow, zero sekretow (pilnuje tego test „nie zdradza sekretow").
//
// ⚠️ CALA OCENA SIEDZI W domain/zdrowie.js, a sklad wejscia w bootstrap.js — trasa jest
// tylko gniazdkiem. Logika tutaj rozjechalaby sie z testami domeny przy pierwszej zmianie.

export function registerZdrowieRoutes(app, { zdrowie }) {
  app.get('/health', { exposeHeadRoute: false }, async (req, reply) => {
    // Czujka pyta co godzine; odpowiedz zapamietana przez posrednika pokazywalaby zdrowie
    // sprzed awarii — czyli dokladnie wtedy klamala, kiedy ma krzyczec.
    reply.header('cache-control', 'no-store');
    return zdrowie();
  });
}
