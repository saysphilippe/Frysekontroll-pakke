// Veiviseren: noen få spørsmål, så en tilpasset liste over hva du gjør. Svarene ligger i adressen (#skriver=ja&telefon=android&…),
// så «tilbake» i nettleseren virker, og du kan dele en ferdig utfylt veiviser.
// Bytt REPO hvis du har laget din egen kopi og vil at knappene skal peke dit.
const REPO = "saysphilippe/Frysekontroll-pakke";
const [OWNER, NAME] = REPO.split("/");
const L = {
  mal: `https://github.com/${REPO}/generate`,
  deploy: `https://deploy.workers.cloudflare.com/?url=https://github.com/${REPO}`,
  cloudflare: "https://dash.cloudflare.com/sign-up",
  github: "https://github.com/signup",
  skriver: "https://www.niimbot.com/us/products/b21-bluetooth-thermal-label-printer",
  readme: `https://github.com/${REPO}#readme`,
  demo: `https://${OWNER}.github.io/${NAME}/`,
};

const SPORSMAL = [
  { id: "hvem", tittel: "Hvem skal bruke Frysekontroll?", valg: [
    { v: "meg", t: "Bare meg", s: "Én telefon. Varene ligger på telefonen din. Ingen passord og ingen ekstra konto." },
    { v: "familie", t: "Hele familien", s: "Flere telefoner ser de samme varene. Felles passord og bildetolking." },
  ] },
  { id: "telefon", tittel: "Hvilken telefon bruker du til å skrive ut etiketter?", valg: [
    { v: "android", t: "Android", s: "Du bruker Chrome." },
    { v: "iphone", t: "iPhone", s: "Du bruker appen Bluefy, siden Safari ikke kan snakke med skriveren." },
    { v: "pc", t: "Bare datamaskin", s: "Du bruker Chrome eller Edge." },
  ] },
  { id: "skriver", tittel: "Har du en etikettskriver av typen Niimbot B21?", hjelp: { t: "Se skriveren hos produsenten", href: L.skriver }, bilde: { src: "niimbot-b21.jpg", alt: "Niimbot-etikettskriver i grønn, sett skrått ovenfra", tekst: "Niimbot B21 Pro. Bilde: Niimbot. Frysekontroll er laget og testet for B21." }, valg: [
    { v: "ja", t: "Ja", s: "Skriveren og en rull med etiketter." },
    { v: "nei", t: "Nei, ikke ennå", s: "Du kan sette alt opp nå og skrive ut etiketter når du har skriveren." },
  ] },
  { id: "konto", tittel: "Har du en Cloudflare-konto?", bare: (s) => s.hvem === "familie", valg: [
    { v: "ja", t: "Ja", s: "Du kan logge inn på dash.cloudflare.com." },
    { v: "nei", t: "Nei", s: "Det er gratis å lage en, og tar to minutter." },
  ] },
];

const h = (tag, attrs = {}, ...barn) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v != null) e.setAttribute(k, v); }
  for (const b of barn.flat()) if (b != null) e.append(b.nodeType ? b : document.createTextNode(b));
  return e;
};
const lenke = (href, tekst, klasse = "btn") => h("a", { class: klasse, href, target: "_blank", rel: "noopener noreferrer" }, tekst);

const lesSvar = () => Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
const synlige = (s) => SPORSMAL.filter((q) => !q.bare || q.bare(s));
const nesteHash = (s, id, v) => {
  const p = new URLSearchParams();
  for (const q of SPORSMAL) { if (q.id === id) p.set(id, v); else if (s[q.id]) p.set(q.id, s[q.id]); }
  return "#" + p.toString();
};

function fremdrift(ferdig, totalt) {
  return h("div", { class: "fremdrift", "aria-hidden": "true" }, Array.from({ length: totalt }, (_, i) => h("span", { class: i < ferdig ? "ferdig" : "" })));
}

function visSporsmal(q, s, nr, totalt) {
  const svar = s[q.id];
  return h("div", { class: "card" },
    h("div", { class: "steg" }, `Spørsmål ${nr} av ${totalt}`),
    fremdrift(nr - 1, totalt),
    h("h1", {}, q.tittel),
    q.bilde ? h("figure", { class: "produkt" }, h("img", { src: q.bilde.src, alt: q.bilde.alt, width: "220" }), h("figcaption", {}, q.bilde.tekst)) : null,
    h("div", { class: "valg", role: "group", "aria-label": q.tittel },
      q.valg.map((o) => h("a", { href: nesteHash(s, q.id, o.v), "aria-current": svar === o.v ? "true" : null }, h("b", {}, o.t), h("small", {}, o.s)))),
    q.hjelp ? h("p", { class: "muted" }, "Vet du ikke hva det er? ", lenke(q.hjelp.href, q.hjelp.t, "")) : null,
    nr > 1 ? h("div", { class: "row" }, h("button", { class: "btn sec", type: "button", id: "tilbake" }, "Tilbake")) : null);
}

function resultat(s) {
  const familie = s.hvem === "familie";
  const trinn = familie
    ? [
        s.konto === "nei" ? ["Lag en gratis Cloudflare-konto. ", lenke(L.cloudflare, "Lag konto", "")] : null,
        ["Trykk Deploy-knappen under. Logg inn på Cloudflare og la den kopiere prosjektet til GitHub-kontoen din (har du ikke en, ", lenke(L.github, "lag en gratis", ""), ")."],
        ["Cloudflare spør etter ", h("b", {}, "FRYS_PASSWORD"), ". Det er det felles passordet familien bruker. Velg et langt passord og skriv det ned."],
        ["Trykk Deploy og vent et par minutter. Adressen står i Cloudflare når den er ferdig. Åpne den på telefonen og logg inn."],
        ["Under «Familie» i appen kan hvert medlem få eget navn og passord."],
      ]
    : [
        ["Trykk «Lag din kopi» under. Du trenger en gratis GitHub-konto (", lenke(L.github, "lag en her", ""), " om du ikke har). Velg et navn, og la repoet være offentlig. Det inneholder ingen varer."],
        ["I din kopi: ", h("b", {}, "Settings → Pages → Source: GitHub Actions"), "."],
        ["Gå til fanen ", h("b", {}, "Actions"), " og vent på grønt merke ved «Publiser på GitHub Pages» (første gang kan du måtte trykke «Run workflow»)."],
        ["Adressen står under Settings → Pages, og ser ut som ", h("code", {}, "https://ditt-brukernavn.github.io/navnet/"), ". Åpne den på telefonen."],
        ["Legg appen på hjemskjermen. Last av og til ned en sikkerhetskopi under «Kopi» i appen."],
      ];

  const telefon = {
    android: "Åpne Frysekontroll i Chrome. Skriveren kobles til med Bluetooth fra nettleseren.",
    iphone: "Installer Bluefy fra App Store og åpne Frysekontroll der. Safari og Chrome på iPhone kan ikke koble til skriveren.",
    pc: "Åpne Frysekontroll i Chrome eller Edge. Firefox og Safari kan ikke koble til skriveren.",
  }[s.telefon];
  const skriver = s.skriver === "ja"
    ? "Trykk «Koble til skriver» i appen. Finner du den ikke, bruk «Vis alle enheter (feilsøking)». Skriv ut en testetikett først for å se at størrelsen stemmer."
    : "Uten skriver kan du legge inn og søke i varer. Når du har fått B21, skriver du ut etikettene fra varens side. Du trenger ikke sette opp noe på nytt.";
  const skriverLenke = lenke(L.skriver, "Se Niimbot B21 hos produsenten", "");

  const noter = [
    telefon, s.skriver === "ja" ? skriver : [skriver, " ", skriverLenke],
    familie ? "Alle med passordet kommer inn. Be familien åpne den samme adressen på sin egen telefon." : "Varene ligger bare i nettleseren på denne ene telefonen. Tømmer du nettleserdata eller bytter telefon, er de borte uten en sikkerhetskopi.",
    familie ? "Bildetolkingen bruker Cloudflares Workers AI, som har en daglig gratiskvote. Du kan la være å bruke den." : null,
  ].filter(Boolean);

  return h("div", { class: "resultat" },
    h("div", { class: "card" },
      h("span", { class: "anbefalt" }, familie ? "Variant B: delt via Cloudflare" : "Variant A: bare i nettleseren"),
      h("h1", {}, "Slik setter du opp Frysekontroll"),
      h("p", { class: "muted" }, familie
        ? "Dere er flere som skal se de samme varene, så varene må ligge på nett. Cloudflare lager databasen og siden for deg. Det er gratis for en familie."
        : "Du er alene om den, så varene kan ligge på telefonen. Ingen konto utenom GitHub, ingen passord og ingen kostnad."),
      h("div", { class: "knapper" },
        familie ? lenke(L.deploy, "Deploy til Cloudflare") : lenke(L.mal, "Lag din kopi"),
        lenke(L.demo, "Se hvordan den ser ut", "btn sec"))),
    h("div", { class: "card" }, h("h2", {}, "Trinnene"), h("ol", { class: "trinn" }, trinn.filter(Boolean).map((t) => h("li", {}, t)))),
    h("div", { class: "card" }, h("h2", {}, "Telefon og skriver"), h("ul", { class: "notater" }, noter.map((n) => h("li", {}, n)))),
    h("div", { class: "row" },
      h("a", { class: "btn sec", href: "#" }, "Start på nytt"),
      lenke(L.readme, "Les hele veiledningen", "btn sec")));
}

function tegn() {
  const rot = document.getElementById("veiviser");
  const s = lesSvar();
  const liste = synlige(s);
  // Første spørsmål uten svar. Er alle besvart, vises resultatet.
  const idx = liste.findIndex((q) => !s[q.id] || !q.valg.some((o) => o.v === s[q.id]));
  rot.replaceChildren(idx === -1 ? resultat(s) : visSporsmal(liste[idx], s, idx + 1, liste.length));
  const tilbake = document.getElementById("tilbake");
  if (tilbake) tilbake.onclick = () => history.back();
  document.title = idx === -1 ? "Slik setter du opp Frysekontroll" : "Kom i gang med Frysekontroll";
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", tegn);
tegn();
