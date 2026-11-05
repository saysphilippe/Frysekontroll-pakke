-- Frysekontroll: databaseskjema. Kjøres av `npm run deploy` (wrangler d1 migrations apply), og er trygt å kjøre flere ganger.

-- Fryser og skuff. Tom skuff betyr «hele fryseren». Steder legges til og fjernes i appen.
CREATE TABLE IF NOT EXISTS places (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  freezer TEXT NOT NULL,
  drawer  TEXT NOT NULL DEFAULT '',
  UNIQUE (freezer, drawer)
);

-- En vare med antall igjen (qty). `search` er navn, beskrivelse og stikkord i små bokstaver, til søket.
CREATE TABLE IF NOT EXISTS items (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  descr    TEXT NOT NULL DEFAULT '',
  tags     TEXT NOT NULL DEFAULT '',
  search   TEXT NOT NULL,
  qty      INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  place_id INTEGER REFERENCES places(id),
  expires  TEXT NOT NULL DEFAULT '',   -- best før / bør spises innen, YYYY-MM-DD, tom hvis ukjent
  frozen   INTEGER NOT NULL,
  created  INTEGER NOT NULL,
  updated  INTEGER NOT NULL,
  device   TEXT NOT NULL DEFAULT ''     -- nøklet hash av enheten som la inn varen; tom for varer fra før dette fantes
);
CREATE INDEX IF NOT EXISTS items_place ON items(place_id);

-- Bildet (JPEG som base64-tekst, nedskalert i nettleseren).
CREATE TABLE IF NOT EXISTS photos (
  item_id TEXT PRIMARY KEY,
  jpeg    TEXT NOT NULL
);

-- Hver endring av antallet: +n lagt inn, -n tatt ut.
CREATE TABLE IF NOT EXISTS moves (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  delta   INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  actor   TEXT NOT NULL DEFAULT ''   -- hvem som gjorde det (tom = felles passord)
);
CREATE INDEX IF NOT EXISTS moves_item ON moves(item_id);

-- Grenser: feil passord (kind = 'login') og bildetolkinger (kind = 'vision'), telt per time.
CREATE TABLE IF NOT EXISTS limits (
  kind TEXT NOT NULL,
  ts   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS limits_kind_ts ON limits(kind, ts);

-- Én rad per fysisk pakke: hver etikett har sin egen QR-kode. taken = tidspunktet pakken ble tatt ut (0 = ligger i fryseren).
CREATE TABLE IF NOT EXISTS packs (
  id      TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  taken   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS packs_item ON packs(item_id, taken);

-- Familiemedlemmer med eget navn og passord (PBKDF2). Det felles passordet virker fortsatt, uten navn.
CREATE TABLE IF NOT EXISTS users (
  name    TEXT PRIMARY KEY COLLATE NOCASE,
  salt    TEXT NOT NULL,
  hash    TEXT NOT NULL,
  created INTEGER NOT NULL
);
