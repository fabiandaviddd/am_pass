'use strict';

/* =========================================================
   AM PASS – Schritt 1
   Datenmodell, IndexedDB, Personenverwaltung, Erfassungsmaske
   ========================================================= */

/* ---------- Konstanten ---------- */

const DB_NAME = 'am-pass';
const DB_VERSION = 1;

const KATEGORIEN = ['beobachtung', 'gespraech', 'vereinbarung', 'lob'];
const KATEGORIE_NAMEN = {
  beobachtung: 'Beobachtung',
  gespraech: 'Gespräch',
  vereinbarung: 'Vereinbarung',
  lob: 'Lob'
};

const QUELLEN = ['selbst gesehen', 'von Dritten berichtet'];

const STANDARD_FRISTEN = {
  beobachtung: 180,
  gespraech: 730,
  vereinbarung: 730,
  lob: 730
};

/* ---------- Zustand ---------- */

let db = null;

const auswahl = {
  personId: null,
  personName: '',
  kategorie: null,
  quelle: QUELLEN[0]
};

/* ---------- Kleine Helfer ---------- */

function neueId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function heuteIso() {
  const jetzt = new Date();
  const monat = String(jetzt.getMonth() + 1).padStart(2, '0');
  const tag = String(jetzt.getDate()).padStart(2, '0');
  return jetzt.getFullYear() + '-' + monat + '-' + tag;
}

/* Addiert Tage auf ein ISO-Datum (JJJJ-MM-TT); null bei ungültiger Eingabe. */
function isoPlusTage(iso, tage) {
  if (typeof iso !== 'string' || !Number.isInteger(tage)) return null;
  const teile = iso.split('-').map(Number);
  if (teile.length !== 3 || teile.some(function (n) { return !Number.isInteger(n); })) return null;
  const datum = new Date(teile[0], teile[1] - 1, teile[2], 12, 0, 0);
  if (Number.isNaN(datum.getTime())) return null;
  datum.setDate(datum.getDate() + tage);
  const monat = String(datum.getMonth() + 1).padStart(2, '0');
  const tag = String(datum.getDate()).padStart(2, '0');
  return datum.getFullYear() + '-' + monat + '-' + tag;
}

let meldungTimer = null;

function zeigeMeldung(text, art) {
  const el = document.getElementById('meldung');
  el.textContent = text;
  el.classList.toggle('meldung-fehler', art === 'fehler');
  el.hidden = false;
  clearTimeout(meldungTimer);
  meldungTimer = setTimeout(function () { el.hidden = true; }, art === 'fehler' ? 6000 : 2500);
}

function dbFehlerText(fehler) {
  const detail = fehler && fehler.message ? ' (' + fehler.message + ')' : '';
  return 'Speichern in der lokalen Datenbank nicht möglich' + detail +
    '. Deine Eingabe bleibt erhalten – bitte erneut versuchen. ' +
    'Hinweis: Privates Surfen in Safari kann die Speicherung verhindern.';
}

/* ---------- IndexedDB ---------- */

function oeffneDb() {
  return new Promise(function (aufloesen, ablehnen) {
    if (!('indexedDB' in window)) {
      ablehnen(new Error('Dieser Browser unterstützt IndexedDB nicht.'));
      return;
    }
    const anfrage = indexedDB.open(DB_NAME, DB_VERSION);
    anfrage.onupgradeneeded = function () {
      const d = anfrage.result;
      if (!d.objectStoreNames.contains('personen')) {
        d.createObjectStore('personen', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('eintraege')) {
        const store = d.createObjectStore('eintraege', { keyPath: 'id' });
        store.createIndex('personId', 'personId', { unique: false });
      }
      if (!d.objectStoreNames.contains('einstellungen')) {
        d.createObjectStore('einstellungen', { keyPath: 'schluessel' });
      }
    };
    anfrage.onsuccess = function () { aufloesen(anfrage.result); };
    anfrage.onerror = function () {
      ablehnen(anfrage.error || new Error('Datenbank konnte nicht geöffnet werden.'));
    };
    anfrage.onblocked = function () {
      ablehnen(new Error('Die Datenbank ist durch ein anderes Fenster blockiert.'));
    };
  });
}

/* Führt eine Arbeit in einem Store aus und löst erst nach Abschluss
   der Transaktion auf – so gilt ein Eintrag erst als gespeichert,
   wenn er wirklich geschrieben wurde. */
function inStore(storeName, modus, arbeit) {
  return new Promise(function (aufloesen, ablehnen) {
    if (!db) {
      ablehnen(new Error('Keine Datenbankverbindung.'));
      return;
    }
    let ergebnis;
    let transaktion;
    try {
      transaktion = db.transaction(storeName, modus);
    } catch (fehler) {
      ablehnen(fehler);
      return;
    }
    transaktion.oncomplete = function () { aufloesen(ergebnis); };
    transaktion.onerror = function () {
      ablehnen(transaktion.error || new Error('Datenbankfehler.'));
    };
    transaktion.onabort = function () {
      ablehnen(transaktion.error || new Error('Datenbankvorgang abgebrochen.'));
    };
    const anfrage = arbeit(transaktion.objectStore(storeName));
    if (anfrage) {
      anfrage.onsuccess = function () { ergebnis = anfrage.result; };
    }
  });
}

async function stelleEinstellungenSicher() {
  const vorhanden = await inStore('einstellungen', 'readonly', function (store) {
    return store.get('fristenTage');
  });
  if (!vorhanden) {
    await inStore('einstellungen', 'readwrite', function (store) {
      return store.put({ schluessel: 'fristenTage', wert: Object.assign({}, STANDARD_FRISTEN) });
    });
  }
}

/* Liefert die Fristen; fehlende oder ungültige Werte fallen auf den Standard zurück. */
async function ladeFristen() {
  const eintrag = await inStore('einstellungen', 'readonly', function (store) {
    return store.get('fristenTage');
  });
  const gespeichert = eintrag && eintrag.wert ? eintrag.wert : {};
  const fristen = {};
  KATEGORIEN.forEach(function (kategorie) {
    const wert = gespeichert[kategorie];
    fristen[kategorie] = (Number.isInteger(wert) && wert > 0) ? wert : STANDARD_FRISTEN[kategorie];
  });
  return fristen;
}

function ladePersonen() {
  return inStore('personen', 'readonly', function (store) { return store.getAll(); });
}

/* ---------- Navigation ---------- */

function zeigeScreen(name) {
  document.querySelectorAll('.screen').forEach(function (screen) {
    screen.hidden = screen.id !== 'screen-' + name;
  });
  document.querySelectorAll('.haupt-nav button').forEach(function (knopf) {
    if (knopf.dataset.screen === name) {
      knopf.setAttribute('aria-current', 'page');
    } else {
      knopf.removeAttribute('aria-current');
    }
  });
  if (name === 'erfassen') {
    zeigePersonenwahl();
    renderPersonenKacheln();
  }
  if (name === 'verwalten') {
    renderVerwalten();
  }
}

/* ---------- ERFASSEN ---------- */

async function renderPersonenKacheln() {
  const raster = document.getElementById('personen-kacheln');
  const leerHinweis = document.getElementById('keine-personen');
  let personen = [];
  try {
    personen = await ladePersonen();
  } catch (fehler) {
    zeigeMeldung(dbFehlerText(fehler), 'fehler');
    return;
  }
  const aktive = personen
    .filter(function (person) { return person.aktiv; })
    .sort(function (a, b) { return a.anzeigename.localeCompare(b.anzeigename, 'de'); });

  raster.textContent = '';
  leerHinweis.hidden = aktive.length > 0;

  aktive.forEach(function (person) {
    const kachel = document.createElement('button');
    kachel.type = 'button';

    const name = document.createElement('span');
    name.className = 'kachel-name';
    name.textContent = person.anzeigename;

    const rolle = document.createElement('span');
    rolle.className = 'kachel-rolle';
    rolle.textContent = person.rolle;

    kachel.appendChild(name);
    kachel.appendChild(rolle);
    kachel.addEventListener('click', function () {
      starteEintrag(person);
    });
    raster.appendChild(kachel);
  });
}

function zeigePersonenwahl() {
  document.getElementById('personenwahl').hidden = false;
  document.getElementById('eintrag-form').hidden = true;
}

function starteEintrag(person) {
  auswahl.personId = person.id;
  auswahl.personName = person.anzeigename;
  auswahl.kategorie = null;
  auswahl.quelle = QUELLEN[0];

  document.getElementById('gewaehlte-person').textContent = person.anzeigename;
  document.getElementById('eintrag-text').value = '';
  aktualisiereKategorieKnoepfe();
  aktualisiereQuelleKnoepfe();

  document.getElementById('personenwahl').hidden = true;
  document.getElementById('eintrag-form').hidden = false;
}

function aktualisiereKategorieKnoepfe() {
  document.querySelectorAll('#kategorie-wahl button').forEach(function (knopf) {
    knopf.setAttribute('aria-pressed', String(knopf.dataset.kategorie === auswahl.kategorie));
  });
}

function aktualisiereQuelleKnoepfe() {
  document.querySelectorAll('#quelle-wahl button').forEach(function (knopf) {
    knopf.setAttribute('aria-pressed', String(knopf.dataset.quelle === auswahl.quelle));
  });
}

async function speichereEintrag() {
  const textFeld = document.getElementById('eintrag-text');
  const text = textFeld.value.trim();

  if (!auswahl.personId) {
    zeigeMeldung('Bitte zuerst eine Person auswählen.', 'fehler');
    return;
  }
  if (!KATEGORIEN.includes(auswahl.kategorie)) {
    zeigeMeldung('Bitte eine Kategorie antippen.', 'fehler');
    return;
  }
  if (!QUELLEN.includes(auswahl.quelle)) {
    zeigeMeldung('Bitte die Quelle wählen.', 'fehler');
    return;
  }
  if (!text) {
    zeigeMeldung('Bitte einen konkreten Satz eintragen.', 'fehler');
    textFeld.focus();
    return;
  }

  let fristen;
  try {
    fristen = await ladeFristen();
  } catch (fehler) {
    zeigeMeldung(dbFehlerText(fehler), 'fehler');
    return;
  }

  const datum = heuteIso();
  const loeschAm = isoPlusTage(datum, fristen[auswahl.kategorie]);
  if (!loeschAm) {
    zeigeMeldung('Die Löschfrist konnte nicht berechnet werden – der Eintrag wurde nicht gespeichert.', 'fehler');
    return;
  }

  const eintrag = {
    id: neueId(),
    personId: auswahl.personId,
    datum: datum,
    kategorie: auswahl.kategorie,
    quelle: auswahl.quelle,
    text: text,
    loeschAm: loeschAm
  };

  try {
    await inStore('eintraege', 'readwrite', function (store) { return store.add(eintrag); });
  } catch (fehler) {
    zeigeMeldung(dbFehlerText(fehler), 'fehler');
    return;
  }

  zeigeMeldung('Gespeichert für ' + auswahl.personName + ' (' + KATEGORIE_NAMEN[eintrag.kategorie] + ').');
  zeigePersonenwahl();
  renderPersonenKacheln();
}

/* ---------- VERWALTEN ---------- */

async function renderVerwalten() {
  await renderPersonenListe();
  await renderFristen();
}

async function renderPersonenListe() {
  const liste = document.getElementById('personen-liste');
  const leerHinweis = document.getElementById('keine-personen-verwalten');
  let personen = [];
  try {
    personen = await ladePersonen();
  } catch (fehler) {
    zeigeMeldung(dbFehlerText(fehler), 'fehler');
    return;
  }
  personen.sort(function (a, b) { return a.anzeigename.localeCompare(b.anzeigename, 'de'); });

  liste.textContent = '';
  leerHinweis.hidden = personen.length > 0;

  personen.forEach(function (person) {
    const zeile = document.createElement('li');

    const angaben = document.createElement('div');
    angaben.className = 'person-angaben';

    const name = document.createElement('div');
    name.className = 'person-name';
    name.textContent = person.anzeigename;

    const rolle = document.createElement('div');
    rolle.className = 'person-rolle';
    rolle.textContent = person.rolle;

    angaben.appendChild(name);
    angaben.appendChild(rolle);
    if (!person.aktiv) {
      const status = document.createElement('div');
      status.className = 'person-status';
      status.textContent = 'deaktiviert';
      angaben.appendChild(status);
    }

    const knopf = document.createElement('button');
    knopf.type = 'button';
    knopf.textContent = person.aktiv ? 'Deaktivieren' : 'Aktivieren';
    knopf.addEventListener('click', function () {
      schaltePersonAktiv(person.id);
    });

    zeile.appendChild(angaben);
    zeile.appendChild(knopf);
    liste.appendChild(zeile);
  });
}

async function schaltePersonAktiv(personId) {
  try {
    const person = await inStore('personen', 'readonly', function (store) { return store.get(personId); });
    if (!person) {
      zeigeMeldung('Person wurde nicht gefunden.', 'fehler');
      return;
    }
    person.aktiv = !person.aktiv;
    await inStore('personen', 'readwrite', function (store) { return store.put(person); });
    zeigeMeldung(person.anzeigename + ' wurde ' + (person.aktiv ? 'aktiviert.' : 'deaktiviert.'));
  } catch (fehler) {
    zeigeMeldung(dbFehlerText(fehler), 'fehler');
    return;
  }
  renderPersonenListe();
}

async function legePersonAn() {
  const nameFeld = document.getElementById('person-name');
  const rolleFeld = document.getElementById('person-rolle');
  const name = nameFeld.value.trim();
  const rolle = rolleFeld.value.trim();

  if (!name) {
    zeigeMeldung('Bitte einen Vornamen oder ein Kürzel angeben.', 'fehler');
    nameFeld.focus();
    return;
  }
  if (/\s/.test(name)) {
    zeigeMeldung('Bitte nur einen Vornamen oder ein Kürzel verwenden – ohne Nachnamen.', 'fehler');
    nameFeld.focus();
    return;
  }
  if (!rolle) {
    zeigeMeldung('Bitte eine Rolle angeben, z. B. Service oder Bar.', 'fehler');
    rolleFeld.focus();
    return;
  }

  const person = {
    id: neueId(),
    anzeigename: name,
    rolle: rolle,
    aktiv: true
  };

  try {
    await inStore('personen', 'readwrite', function (store) { return store.add(person); });
  } catch (fehler) {
    zeigeMeldung(dbFehlerText(fehler), 'fehler');
    return;
  }

  nameFeld.value = '';
  rolleFeld.value = '';
  zeigeMeldung(person.anzeigename + ' wurde angelegt.');
  renderPersonenListe();
}

async function renderFristen() {
  const liste = document.getElementById('fristen-liste');
  let fristen;
  try {
    fristen = await ladeFristen();
  } catch (fehler) {
    zeigeMeldung(dbFehlerText(fehler), 'fehler');
    return;
  }
  liste.textContent = '';
  KATEGORIEN.forEach(function (kategorie) {
    const zeile = document.createElement('li');

    const name = document.createElement('span');
    name.textContent = KATEGORIE_NAMEN[kategorie];

    const wert = document.createElement('span');
    wert.className = 'frist-wert';
    wert.textContent = fristen[kategorie] + ' Tage';

    zeile.appendChild(name);
    zeile.appendChild(wert);
    liste.appendChild(zeile);
  });
}

/* ---------- Verdrahtung und Start ---------- */

function verdrahteOberflaeche() {
  document.querySelectorAll('.haupt-nav button').forEach(function (knopf) {
    knopf.addEventListener('click', function () {
      zeigeScreen(knopf.dataset.screen);
    });
  });

  document.getElementById('zurueck-zur-personenwahl').addEventListener('click', function () {
    zeigePersonenwahl();
  });

  document.querySelectorAll('#kategorie-wahl button').forEach(function (knopf) {
    knopf.addEventListener('click', function () {
      auswahl.kategorie = knopf.dataset.kategorie;
      aktualisiereKategorieKnoepfe();
      document.getElementById('eintrag-text').focus();
    });
  });

  document.querySelectorAll('#quelle-wahl button').forEach(function (knopf) {
    knopf.addEventListener('click', function () {
      auswahl.quelle = knopf.dataset.quelle;
      aktualisiereQuelleKnoepfe();
    });
  });

  document.getElementById('eintrag-form').addEventListener('submit', function (ereignis) {
    ereignis.preventDefault();
    speichereEintrag();
  });

  document.getElementById('person-form').addEventListener('submit', function (ereignis) {
    ereignis.preventDefault();
    legePersonAn();
  });
}

async function start() {
  try {
    db = await oeffneDb();
    await stelleEinstellungenSicher();
  } catch (fehler) {
    zeigeMeldung('Die lokale Datenbank konnte nicht geöffnet werden: ' +
      (fehler && fehler.message ? fehler.message : 'unbekannter Fehler') +
      ' Ohne sie kann AM PASS nichts speichern.', 'fehler');
    return;
  }
  verdrahteOberflaeche();
  zeigeScreen('erfassen');
}

document.addEventListener('DOMContentLoaded', start);
