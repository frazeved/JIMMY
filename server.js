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

// ─── Remittances helpers ───────────────────────────────────────────────────────
function _remitRound2(n) { return Math.round((n || 0) * 100) / 100; }
function _remitParseMoney(s) {
  if (s == null || s === '') return null;
  const n = parseFloat(String(s).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}
function _remitColLetter(ci) {
  let n = ci + 1, s = '';
  while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const _remitCache = { data: null, ts: 0 };
const REMIT_TTL   = 10 * 60 * 1000;

// ─── GET /api/remittances ──────────────────────────────────────────────────────
app.get('/api/remittances', async (req, res) => {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    return res.status(500).json({ error: 'Google credentials not configured' });

  const bypass = req.query.refresh === '1';
  if (!bypass && _remitCache.data && (Date.now() - _remitCache.ts) < REMIT_TTL)
    return res.json(_remitCache.data);

  try {
    const sa     = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth   = new google.auth.GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });

    const [mapRes, extractRes, whRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: MAP_SHEET_ID, range: `'ANTHRO MAP 2026'`, valueRenderOption: 'FORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' }),
      sheets.spreadsheets.values.get({ spreadsheetId: MAP_SHEET_ID, range: `'URBN PAY PORTAL EXTRACT'`, valueRenderOption: 'FORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'Warehouse Now Database'`, valueRenderOption: 'FORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' }),
    ]);

    const mapRows = mapRes.data.values || [], extractRows = extractRes.data.values || [], whRows = whRes.data.values || [];
    if (mapRows.length < 2) return res.json({ pos: [], kpi: {} });

    const MH = mapRows[0].map(h => (h || '').toString().trim().toLowerCase());
    const mc = name => MH.findIndex(h => h === name.toLowerCase());
    const mf = (...kws) => { for (const kw of kws) { const i = MH.findIndex(h => h.includes(kw.toLowerCase())); if (i >= 0) return i; } return -1; };
    const mCol = {
      status: mf('status'), supplier: mf('supplier'), style: mf('style #', 'style#'),
      po: mc('purchase order'), brand: mf('brand'), category: mf('category'),
      invDate: mf('urbn invoice date'), invTotal: mf('urbn invoice total'),
      payAmt: mc('anthro payment amount'), payment: mc('anthro payment'),
      chargeback: mc('charge back / po balance'), antroPayFarm: mc('antro pay farm'),
      comments: mc('last comments'), invQty: mf('anthro invoice qty'),
      receivedQty: mf('received qty'), subSupplier: mf('sub supplier'),
      fobPrice: mf('fob price'), supInvoice: mf('sup invoice #', 'sup invoice'),
      supQty: mf('sup qty'), supUnitCost: mf('sup unit cost'),
      supTotalInvoice: mf('sup total invoice'), awbFolder: mf('awb folder'),
      finalQty: mf('final qty'), channel: mf('channel'),
    };
    const mg = (row, ci) => ci >= 0 ? (row[ci] || '').toString().trim() : '';

    // Delivery map from Warehouse Now Database
    const deliveryMap = {};
    if (whRows.length >= 2) {
      const WH = whRows[0].map(h => (h || '').toString().trim().toLowerCase());
      const wf = (...kws) => { for (const kw of kws) { const i = WH.findIndex(h => h.includes(kw.toLowerCase())); if (i >= 0) return i; } return -1; };
      const wCol = { po: WH.findIndex(h => h === 'po#' || h === 'po number' || h === 'purchase order' || h.includes('po#')), tracking: wf('tracking number', 'tracking#', 'tracking', 'awb'), delivStatus: wf('delivery status', 'fedex status'), delivDate: WH.indexOf('delivery date') };
      const wg = (row, ci) => ci >= 0 ? (row[ci] || '').toString().trim() : '';
      for (let i = 1; i < whRows.length; i++) {
        const row = whRows[i], po = wg(row, wCol.po).replace(/\s+/g, '').trim();
        if (!po) continue;
        const delivStatus = wg(row, wCol.delivStatus), tracking = wg(row, wCol.tracking), delivDate = wg(row, wCol.delivDate);
        if (!deliveryMap[po] || (!deliveryMap[po].delivStatus && delivStatus)) { deliveryMap[po] = { delivStatus, tracking, delivDate }; }
        else if (delivStatus && deliveryMap[po].delivStatus) { const rank = s => s.toLowerCase().includes('delivered') ? 3 : s.toLowerCase().includes('transit') || s.toLowerCase().includes('out for') ? 2 : s ? 1 : 0; if (rank(delivStatus) > rank(deliveryMap[po].delivStatus)) deliveryMap[po] = { delivStatus, tracking, delivDate }; }
      }
    }

    // Extract map by PO#
    const extractMap = {};
    if (extractRows.length >= 2) {
      const EH = extractRows[0].map(h => (h || '').toString().trim().toLowerCase());
      const eCol = { invoice: EH.findIndex(h => h === 'invoice'), desc: EH.findIndex(h => h === 'invoice description'), date: EH.findIndex(h => h === 'invoice date'), type: EH.findIndex(h => h === 'type'), amount: EH.findIndex(h => h === 'amount'), payStatus: EH.findIndex(h => h === 'payment status'), dueDate: EH.findIndex(h => h === 'due date'), po: EH.findIndex(h => h === 'po#'), description: EH.findIndex(h => h === 'description') };
      const eg = (row, ci) => ci >= 0 ? (row[ci] || '').toString().trim() : '';
      for (let i = 1; i < extractRows.length; i++) {
        const row = extractRows[i], po = eg(row, eCol.po).replace(/\s+/g, '').trim();
        if (!po) continue;
        if (!extractMap[po]) extractMap[po] = [];
        extractMap[po].push({ invoice: eg(row, eCol.invoice), desc: eg(row, eCol.desc), date: eg(row, eCol.date), type: eg(row, eCol.type), amount: _remitParseMoney(eg(row, eCol.amount)), payStatus: eg(row, eCol.payStatus), description: eg(row, eCol.description) });
      }
    }

    // Group MAP rows by PO
    const poMap = new Map();
    for (let i = 1; i < mapRows.length; i++) {
      const row = mapRows[i], invDate = mg(row, mCol.invDate);
      if (!invDate) continue;
      const po = mg(row, mCol.po).replace(/\s+/g, '').trim();
      const invTotal = _remitParseMoney(mg(row, mCol.invTotal)) || 0;
      if (!poMap.has(po)) {
        poMap.set(po, { po, supplier: mg(row, mCol.supplier), brand: mg(row, mCol.brand), category: mg(row, mCol.category), invDate, invTotal: 0, payAmt: _remitParseMoney(mg(row, mCol.payAmt)), payment: _remitParseMoney(mg(row, mCol.payment)), chargeback: _remitParseMoney(mg(row, mCol.chargeback)), antroPayFarm: _remitParseMoney(mg(row, mCol.antroPayFarm)), comments: mg(row, mCol.comments), styles: [] });
      }
      const entry = poMap.get(po);
      entry.invTotal += invTotal;
      const invQty = parseInt((mg(row, mCol.invQty) || '0').replace(/,/g, ''), 10) || 0;
      const receivedQty = parseInt((mg(row, mCol.receivedQty) || '0').replace(/,/g, ''), 10) || 0;
      const finalQty = parseInt((mg(row, mCol.finalQty) || '0').replace(/,/g, ''), 10) || 0;
      const supQty = parseInt((mg(row, mCol.supQty) || '0').replace(/,/g, ''), 10) || 0;
      entry.styles.push({ style: mg(row, mCol.style), status: mg(row, mCol.status), supplier: mg(row, mCol.supplier), subSupplier: mg(row, mCol.subSupplier), invDate, invTotal, category: mg(row, mCol.category), fobPrice: mg(row, mCol.fobPrice), supInvoice: mg(row, mCol.supInvoice), supQty, supUnitCost: mg(row, mCol.supUnitCost), supTotalInvoice: mg(row, mCol.supTotalInvoice), awbFolder: mg(row, mCol.awbFolder), channel: mg(row, mCol.channel), invQty, finalQty, receivedQty });
      if (entry.payAmt === null)       entry.payAmt    = _remitParseMoney(mg(row, mCol.payAmt));
      if (entry.payment === null)      entry.payment   = _remitParseMoney(mg(row, mCol.payment));
      if (entry.chargeback === null)   entry.chargeback = _remitParseMoney(mg(row, mCol.chargeback));
      if (!entry.comments)             entry.comments  = mg(row, mCol.comments);
    }

    const pos = [];
    for (const data of poMap.values()) {
      data.invTotal = _remitRound2(data.invTotal);
      data.entries  = extractMap[data.po] || [];
      const del = deliveryMap[data.po] || {};
      data.delivStatus = del.delivStatus || ''; data.tracking = del.tracking || ''; data.delivDate = del.delivDate || '';
      const cb = data.chargeback || 0, comments = (data.comments || '').toUpperCase().trim();
      if (data.payAmt === null) { data.statusTag = 'PENDING'; }
      else if (cb === 0) { data.statusTag = 'PAID'; }
      else { const cbItems = comments.split('/').map(s => s.trim()).filter(Boolean); const onlyDefct = cbItems.length > 0 && cbItems.every(c => c.includes('1%') || c.includes('DEFCT') || c.includes('DEFECT')); data.statusTag = onlyDefct ? 'DEFCT' : 'CHARGEBACK'; }
      pos.push(data);
    }
    pos.sort((a, b) => new Date(b.invDate) - new Date(a.invDate));

    const kpi = { totalInvoiced: 0, totalPayment: 0, totalChargeback: 0, pendingCount: 0, pendingAmount: 0 };
    for (const p of pos) { kpi.totalInvoiced += p.invTotal || 0; if (p.payment !== null) kpi.totalPayment += p.payment; if (p.chargeback) kpi.totalChargeback += p.chargeback; if (p.statusTag === 'PENDING') { kpi.pendingCount++; kpi.pendingAmount += p.invTotal || 0; } }
    kpi.totalInvoiced = _remitRound2(kpi.totalInvoiced); kpi.totalPayment = _remitRound2(kpi.totalPayment); kpi.totalChargeback = _remitRound2(kpi.totalChargeback); kpi.pendingAmount = _remitRound2(kpi.pendingAmount);

    const result = { pos, kpi };
    _remitCache.data = result; _remitCache.ts = Date.now();
    res.json(result);
  } catch (e) {
    console.error('[remittances]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/remittances/sync ────────────────────────────────────────────────
app.post('/api/remittances/sync', async (req, res) => {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    return res.status(500).json({ error: 'Google credentials not configured' });
  try {
    const sa     = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth   = new google.auth.GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });

    const [mapRes, extractRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: MAP_SHEET_ID, range: `'ANTHRO MAP 2026'`, valueRenderOption: 'FORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' }),
      sheets.spreadsheets.values.get({ spreadsheetId: MAP_SHEET_ID, range: `'URBN PAY PORTAL EXTRACT'`, valueRenderOption: 'FORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' }),
    ]);

    const mapRows = mapRes.data.values || [], extractRows = extractRes.data.values || [];
    if (mapRows.length < 2) return res.json({ ok: true, updated: 0 });

    const MH = mapRows[0].map(h => (h || '').toString().trim().toLowerCase());
    const mc = name => MH.findIndex(h => h === name.toLowerCase());
    const mf = (...kws) => { for (const kw of kws) { const i = MH.findIndex(h => h.includes(kw.toLowerCase())); if (i >= 0) return i; } return -1; };
    const mCol = { po: mc('purchase order'), invTotal: mf('urbn invoice total'), payAmt: mc('anthro payment amount'), payment: mc('anthro payment'), chargeback: mc('charge back / po balance'), comments: mc('last comments') };
    if ([mCol.po, mCol.invTotal, mCol.payAmt, mCol.payment, mCol.chargeback, mCol.comments].includes(-1))
      return res.status(500).json({ error: 'Missing required columns in ANTHRO MAP 2026' });
    const mg = (row, ci) => ci >= 0 ? (row[ci] || '').toString().trim() : '';

    const extractMap = {};
    if (extractRows.length >= 2) {
      const EH = extractRows[0].map(h => (h || '').toString().trim().toLowerCase());
      const eColPO = EH.findIndex(h => h === 'po#'), eColDesc = EH.findIndex(h => h === 'invoice description'), eColAmount = EH.findIndex(h => h === 'amount');
      if (eColPO < 0) return res.status(500).json({ error: 'Missing PO# column in URBN PAY PORTAL EXTRACT' });
      const eg = (row, ci) => ci >= 0 ? (row[ci] || '').toString().trim() : '';
      for (let i = 1; i < extractRows.length; i++) {
        const row = extractRows[i], po = eg(row, eColPO).replace(/\s+/g, '').trim();
        if (!po) continue;
        if (!extractMap[po]) extractMap[po] = [];
        extractMap[po].push({ desc: eg(row, eColDesc).toUpperCase().trim(), amount: _remitParseMoney(eg(row, eColAmount)) || 0 });
      }
    }

    const isPayment = (d, a) => d.includes('PAYMENT') && a > 0;
    const isUnitErr = d => d.includes('UNIT');
    const isBalance = d => d.includes('BALANCE');
    const isDefct   = d => d.includes('1%') || d.includes('DEFCT') || d.includes('DEFECT');
    const cleanOther = d => (d || '').toString().trim().toUpperCase().replace(/\s+/g, ' ');
    const outPaymentAmount = [], outPayment = [], outChargeback = [], outComments = [];
    let updated = 0;

    for (let r = 1; r < mapRows.length; r++) {
      const row = mapRows[r], po = mg(row, mCol.po).replace(/\s+/g, '').trim(), urbnTotal = _remitParseMoney(mg(row, mCol.invTotal)) || 0;
      let anthroPaymentAmount = '', anthroPayment = '', chargebackValue = '', lastComments = '';
      if (po && extractMap[po]) {
        const entries = extractMap[po];
        let paymentRowsTotal = 0, largestPositive = 0, unitErrTotal = 0, balanceTotal = 0, otherNegativeTotal = 0, hasDefct = false;
        const comments = [];
        entries.forEach(item => {
          const amt = _remitRound2(item.amount), desc = item.desc;
          if (amt > 0 && amt > largestPositive) largestPositive = amt;
          if (isPayment(desc, amt))  { paymentRowsTotal += amt; return; }
          if (isDefct(desc))         { hasDefct = true; if (!comments.includes('1% DEFCT')) comments.push('1% DEFCT'); return; }
          if (isUnitErr(desc))       { if (amt < 0) unitErrTotal += amt; if (!comments.includes('UNIT ERR')) comments.push('UNIT ERR'); return; }
          if (isBalance(desc))       { if (amt > 0) balanceTotal += amt; return; }
          if (amt < 0)               { otherNegativeTotal += amt; const c = cleanOther(desc); if (c && !comments.includes(c)) comments.push(c); }
        });
        paymentRowsTotal = _remitRound2(paymentRowsTotal); largestPositive = _remitRound2(largestPositive); unitErrTotal = _remitRound2(unitErrTotal); balanceTotal = _remitRound2(balanceTotal); otherNegativeTotal = _remitRound2(otherNegativeTotal);
        if (paymentRowsTotal > 0)     anthroPaymentAmount = paymentRowsTotal;
        else if (largestPositive > 0) anthroPaymentAmount = largestPositive;
        else if (urbnTotal > 0)       anthroPaymentAmount = urbnTotal;
        let nonDefctChargeback = _remitRound2(unitErrTotal + otherNegativeTotal + balanceTotal);
        if (Math.abs(nonDefctChargeback) < 0.01) nonDefctChargeback = 0;
        const defctChargeback = hasDefct ? _remitRound2(-(urbnTotal * 0.01)) : 0;
        chargebackValue  = _remitRound2(nonDefctChargeback + defctChargeback);
        anthroPayment    = anthroPaymentAmount !== '' ? _remitRound2(anthroPaymentAmount + nonDefctChargeback) : '';
        lastComments     = chargebackValue === 0 && anthroPaymentAmount === urbnTotal ? 'PAYMENT' : comments.join(' / ');
        updated++;
      }
      outPaymentAmount.push([anthroPaymentAmount]); outPayment.push([anthroPayment]); outChargeback.push([chargebackValue]); outComments.push([lastComments]);
    }

    const numRows = mapRows.length - 1;
    const mkRange = ci => `'ANTHRO MAP 2026'!${_remitColLetter(ci)}2:${_remitColLetter(ci)}${numRows + 1}`;
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: MAP_SHEET_ID, requestBody: { valueInputOption: 'USER_ENTERED', data: [{ range: mkRange(mCol.payAmt), values: outPaymentAmount }, { range: mkRange(mCol.payment), values: outPayment }, { range: mkRange(mCol.chargeback), values: outChargeback }, { range: mkRange(mCol.comments), values: outComments }] } });
    _remitCache.data = null; _remitCache.ts = 0;
    res.json({ ok: true, updated });
  } catch (e) {
    console.error('[remittances/sync]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Email endpoints require Gmail OAuth — use the 305 Workspace instance for email features
app.post('/api/remittances/dispute-email', (_, res) => res.status(501).json({ error: 'Email drafts require Gmail OAuth. Use the 305 Workspace.' }));
app.post('/api/remittances/overdue-email',  (_, res) => res.status(501).json({ error: 'Email drafts require Gmail OAuth. Use the 305 Workspace.' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Jimmy running on port ${PORT}`));
