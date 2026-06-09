require('dotenv').config();
const express  = require('express');
const path     = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SHEET_ID     = '1y0iL7PJldbVQmPIAnJi9wvA2hvjB8_aK2bU2kxvUf5Q';
const MAP_SHEET_ID = '1W88MKYr-q9g3F2fLFu2jjxvXzigK12PWohSVMsOQst4';

async function getSheets() {
  const sa   = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  return google.sheets({ version: 'v4', auth });
}

async function readTab(sheets, sheetId, tab) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab}'`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  return r.data.values || [];
}

function buildHMap(headers) {
  const m = {};
  (headers || []).forEach((v, i) => {
    const k = String(v || '').trim().toLowerCase();
    if (k) m[k] = i;
  });
  return m;
}

function findCol(m, ...names) {
  for (const n of names) {
    const k = n.toLowerCase();
    if (m[k] !== undefined) return m[k];
    const key = Object.keys(m).find(k2 => k2.includes(k) || k.includes(k2));
    if (key !== undefined) return m[key];
  }
  return -1;
}

function toNum(v) {
  if (v == null || v === '') return 0;
  return parseFloat(String(v).replace(/[$, ]/g, '')) || 0;
}

function parseDate(v) {
  if (v == null || v === '') return null;
  const d = new Date(String(v).trim());
  return isNaN(d.getTime()) ? null : d;
}

function sumByMonth(rows, dateCol, valCol, year) {
  const sums = new Array(12).fill(0);
  if (dateCol < 0 || valCol < 0) return sums;
  for (const row of rows) {
    const n = toNum(row[valCol]);
    if (!n) continue;
    const d = parseDate(row[dateCol]);
    if (!d || d.getFullYear() !== year) continue;
    sums[d.getMonth()] += n;
  }
  return sums;
}

function sumByMonthAndCat(rows, dateCol, valCol, catCol, year) {
  const cats = {};
  if (dateCol < 0 || valCol < 0 || catCol < 0) return cats;
  for (const row of rows) {
    const n = toNum(row[valCol]);
    if (!n) continue;
    const d = parseDate(row[dateCol]);
    if (!d || d.getFullYear() !== year) continue;
    const cat = String(row[catCol] || '').trim() || 'Other';
    if (!cats[cat]) cats[cat] = new Array(12).fill(0);
    cats[cat][d.getMonth()] += n;
  }
  return cats;
}

// 10-min cache
const _cache = { data: null, ts: 0 };
const TTL = 10 * 60 * 1000;

app.get('/api/forecast', async (req, res) => {
  try {
    if (_cache.data && !req.query.refresh && Date.now() - _cache.ts < TTL) {
      return res.json(_cache.data);
    }

    const sheets = await getSheets();
    const [tsData, mapData] = await Promise.all([
      readTab(sheets, SHEET_ID,     'TRADESTONE DATABASE'),
      readTab(sheets, MAP_SHEET_ID, 'ANTHRO MAP 2026'),
    ]);

    // ── TRADESTONE DATABASE columns ──────────────────────────────────────────
    const tsH          = buildHMap(tsData[0]);
    const tsInvValCol  = findCol(tsH, 'invoice value', 'invoice amount', 'inv amount');
    const tsInvDateCol = findCol(tsH, 'invoice date', 'inv date');
    const tsCancelCol  = findCol(tsH, 'cancel date', 'ship date');
    const tsFOBCol     = findCol(tsH, 'total fob', 'fob total', 'net amount', 'total amount', 'po wholesale', 'wholesale');
    const tsCatCol     = findCol(tsH, 'category 2', 'category2', 'category');
    const tsRows       = tsData.slice(1);

    // ── MAP ANTHRO 2026 columns ───────────────────────────────────────────────
    // Known: J=9 PO WHOLESALE, L=11 Cancel Date, AO=40 URBN INVOICE DATE, AP=41 URBN INVOICE TOTAL
    const mapH            = buildHMap(mapData[0]);
    const mapWholesaleCol = findCol(mapH, 'po wholesale', 'wholesale');
    const mapCancelCol    = findCol(mapH, 'cancel date');
    const mapInvDateCol   = findCol(mapH, 'urbn invoice date');
    const mapInvValCol    = findCol(mapH, 'urbn invoice total');
    const mapRows         = mapData.slice(1);

    // ── Compute monthly aggregates ────────────────────────────────────────────
    // All TRADESTONE DATABASE: 2025 invoiced, 2026 PO issued, 2026 invoiced, category breakdown
    // MAP ANTHRO 2026: 2026 forecast (planned POs — broader than confirmed TRADESTONE)
    const inv2025      = sumByMonth(tsRows,  tsInvDateCol,     tsInvValCol,     2025);
    const po2026       = sumByMonth(tsRows,  tsCancelCol,      tsFOBCol,        2026);
    const inv2026      = sumByMonth(tsRows,  tsInvDateCol,     tsInvValCol,     2026);
    const forecast2026 = sumByMonth(mapRows, mapCancelCol,     mapWholesaleCol, 2026);
    const catBreakdown = sumByMonthAndCat(tsRows, tsCancelCol, tsFOBCol, tsCatCol, 2026);

    const result = { inv2025, forecast2026, po2026, inv2026, catBreakdown };
    _cache.data = result;
    _cache.ts   = Date.now();
    res.json(result);
  } catch (e) {
    console.error('[forecast]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── FORECAST BY CATEGORY ──────────────────────────────────────────────────────
const _fcCatCache = { data: null, ts: 0 };

app.get('/api/forecast-by-category', async (req, res) => {
  try {
    if (_fcCatCache.data && !req.query.refresh && Date.now() - _fcCatCache.ts < TTL) {
      return res.json(_fcCatCache.data);
    }
    const sheets = await getSheets();
    const tsData  = await readTab(sheets, SHEET_ID, 'TRADESTONE DATABASE');
    const hm      = buildHMap(tsData[0]);

    const C = {
      style:      findCol(hm, 'vendor style #', 'style #', 'style#'),
      status:     findCol(hm, 'status'),
      supplier:   findCol(hm, 'vendor', 'supplier'),
      brand:      findCol(hm, 'brand'),
      category:   findCol(hm, 'category 2', 'category2', 'category'),
      qty:        findCol(hm, 'total qty', 'quantity', 'qty'),
      wholesale:  findCol(hm, 'total fob', 'fob total', 'net amount', 'po wholesale', 'wholesale'),
      invVal:     findCol(hm, 'invoice value', 'invoice amount'),
      invDate:    findCol(hm, 'invoice date'),
      cancelDate: findCol(hm, 'cancel date', 'ship date'),
    };

    const rows = tsData.slice(1).map(row => ({
      style:      C.style      >= 0 ? String(row[C.style]      || '') : '',
      status:     C.status     >= 0 ? String(row[C.status]     || '') : '',
      supplier:   C.supplier   >= 0 ? String(row[C.supplier]   || '') : '',
      brand:      C.brand      >= 0 ? String(row[C.brand]      || '') : '',
      category:   C.category   >= 0 ? String(row[C.category]   || '') : '',
      qty:        C.qty        >= 0 ? (toNum(row[C.qty]))           : 0,
      wholesale:  C.wholesale  >= 0 ? (toNum(row[C.wholesale]))     : 0,
      invoiced:   C.invVal     >= 0 ? (toNum(row[C.invVal]))        : 0,
      invDate:    C.invDate    >= 0 ? String(row[C.invDate]    || '') : '',
      cancelDate: C.cancelDate >= 0 ? String(row[C.cancelDate] || '') : '',
    })).filter(r => r.style || r.qty || r.wholesale);

    const suppliers  = [...new Set(rows.map(r => r.supplier).filter(Boolean))].sort();
    const brands     = [...new Set(rows.map(r => r.brand).filter(Boolean))].sort();
    const categories = [...new Set(rows.map(r => r.category).filter(Boolean))].sort();

    const result = { rows, filters: { suppliers, brands, categories } };
    _fcCatCache.data = result;
    _fcCatCache.ts   = Date.now();
    res.json(result);
  } catch (e) {
    console.error('[forecast-by-category]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── MAP ANTHRO OVERVIEW ────────────────────────────────────────────────────────
const _mapCache = { data: null, ts: 0 };

app.get('/api/map-overview', async (req, res) => {
  try {
    if (_mapCache.data && !req.query.refresh && Date.now() - _mapCache.ts < TTL) {
      return res.json(_mapCache.data);
    }
    const sheets  = await getSheets();
    const mapData = await readTab(sheets, MAP_SHEET_ID, 'ANTHRO MAP 2026');
    const hm      = buildHMap(mapData[0]);

    const C = {
      status:     findCol(hm, 'status'),
      supplier:   findCol(hm, 'supplier'),
      style:      findCol(hm, 'style #', 'style#'),
      po:         findCol(hm, 'purchase order'),
      qty:        findCol(hm, 'total qty'),
      boxQty:     findCol(hm, 'box qty'),
      fob:        findCol(hm, 'fob price'),
      wholesale:  findCol(hm, 'po wholesale', 'wholesale'),
      shipDate:   findCol(hm, 'ship date'),
      cancelDate: findCol(hm, 'cancel date'),
      exFactory:  findCol(hm, 'ex factory', 'flight date'),
      arrival:    findCol(hm, 'expected arrival'),
      brand:      findCol(hm, 'brand'),
      category:   findCol(hm, 'category'),
      subCat:     findCol(hm, 'sub-category', 'subcategory'),
      supQty:     findCol(hm, 'sup qty'),
      supCost:    findCol(hm, 'sup unit cost'),
      supInvoice: findCol(hm, 'sup total invoice'),
      realWhs:    findCol(hm, 'real wholesale total'),
      urbnDate:   findCol(hm, 'urbn invoice date'),
      urbnTotal:  findCol(hm, 'urbn invoice total'),
      chargeback: findCol(hm, 'charge back', 'chargeback', 'po balance'),
      airfreight: findCol(hm, 'airfreight cost'),
      groundFreight: findCol(hm, 'ground freight'),
      totalCosts: findCol(hm, 'total costs'),
      periodMonth: findCol(hm, 'period month'),
      year:       findCol(hm, 'year'),
      ndc:        findCol(hm, 'ndc', 'ndc month'),
    };

    const rows = mapData.slice(1)
      .map(row => {
        const r = {};
        for (const [k, i] of Object.entries(C)) r[k] = i >= 0 ? (row[i] ?? '') : '';
        return r;
      })
      .filter(r => r.style || r.po);

    const result = { rows, colNames: Object.keys(C) };
    _mapCache.data = result;
    _mapCache.ts   = Date.now();
    res.json(result);
  } catch (e) {
    console.error('[map-overview]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PROFIT & MARGIN ───────────────────────────────────────────────────────────
const _pmCache = { data: null, ts: 0 };

app.get('/api/profit-margin', async (req, res) => {
  try {
    if (_pmCache.data && !req.query.refresh && Date.now() - _pmCache.ts < TTL) {
      return res.json(_pmCache.data);
    }
    const sheets  = await getSheets();
    const mapData = await readTab(sheets, MAP_SHEET_ID, 'ANTHRO MAP 2026');
    const hm      = buildHMap(mapData[0]);

    const C = {
      awb:          findCol(hm, 'mawb/hawb', 'mawb', 'hawb'),
      awbFolder:    findCol(hm, 'awb folder'),
      supInvoice:   findCol(hm, 'sup invoice #', 'sup invoice#'),
      style:        findCol(hm, 'style #', 'style#'),
      supplier:     findCol(hm, 'supplier'),
      freight:      findCol(hm, 'freight'),
      supQty:       findCol(hm, 'sup qty'),
      supUnitCost:  findCol(hm, 'sup unit cost'),
      supTotal:     findCol(hm, 'sup total invoice'),
      anthroQty:    findCol(hm, 'anthro invoice qty'),
      urbnTotal:    findCol(hm, 'urbn invoice total'),
      airfreight:   findCol(hm, 'airfreight cost'),
      customEntry:  findCol(hm, 'custom entry cost'),
      groundFreight:findCol(hm, 'ground freight'),
      fobCommission:findCol(hm, 'fob commission'),
      chargeback:   findCol(hm, 'charge back', 'chargeback', 'po balance'),
      totalCosts:   findCol(hm, 'total costs'),
      profit:       findCol(hm, 'profit'),
      profitMargin: findCol(hm, 'profit magin', 'profit margin'),
      urbnDate:     findCol(hm, 'urbn invoice date'),
    };

    const rows = mapData.slice(1)
      .map(row => ({
        awb:          C.awb          >= 0 ? String(row[C.awb]          || '') : '',
        awbFolder:    C.awbFolder    >= 0 ? String(row[C.awbFolder]    || '') : '',
        supInvoice:   C.supInvoice   >= 0 ? String(row[C.supInvoice]   || '') : '',
        style:        C.style        >= 0 ? String(row[C.style]        || '') : '',
        supplier:     C.supplier     >= 0 ? String(row[C.supplier]     || '') : '',
        freight:      C.freight      >= 0 ? String(row[C.freight]      || '') : '',
        supQty:       C.supQty       >= 0 ? toNum(row[C.supQty])              : 0,
        supUnitCost:  C.supUnitCost  >= 0 ? toNum(row[C.supUnitCost])         : 0,
        supTotal:     C.supTotal     >= 0 ? toNum(row[C.supTotal])            : 0,
        anthroQty:    C.anthroQty    >= 0 ? toNum(row[C.anthroQty])           : 0,
        urbnTotal:    C.urbnTotal    >= 0 ? toNum(row[C.urbnTotal])           : 0,
        airfreight:   C.airfreight   >= 0 ? toNum(row[C.airfreight])          : 0,
        customEntry:  C.customEntry  >= 0 ? toNum(row[C.customEntry])         : 0,
        groundFreight:C.groundFreight>= 0 ? toNum(row[C.groundFreight])       : 0,
        fobCommission:C.fobCommission>= 0 ? toNum(row[C.fobCommission])       : 0,
        chargeback:   C.chargeback   >= 0 ? toNum(row[C.chargeback])          : 0,
        totalCosts:   C.totalCosts   >= 0 ? toNum(row[C.totalCosts])          : 0,
        profit:       C.profit       >= 0 ? toNum(row[C.profit])              : 0,
        profitMargin: C.profitMargin >= 0 ? toNum(row[C.profitMargin])        : 0,
        urbnDate:     C.urbnDate     >= 0 ? String(row[C.urbnDate]    || '') : '',
      }))
      .filter(r => r.style || r.awb);

    const result = { rows };
    _pmCache.data = result;
    _pmCache.ts   = Date.now();
    res.json(result);
  } catch (e) {
    console.error('[profit-margin]', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Jimmy running on port ${PORT}`));
