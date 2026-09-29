// 바이낸스 실시간 시세 수신 (선물: USDⓈ-M, 현물) + 원/달러(USDT) 환율
class Market {
  constructor(symbols) {
    this.symbols = symbols;
    this.fut = {};
    this.spot = {};
    for (const s of symbols) {
      this.fut[s] = { candles: [], candles15: [], price: 0, mark: 0, funding: 0, nextFunding: 0, change24: 0, vol24: 0, updated: 0 };
      this.spot[s] = { candles: [], price: 0, change24: 0, vol24: 0, updated: 0 };
    }
    this.fx = { rate: CONFIG.FALLBACK_FX, source: 'fallback', updated: 0 };
    this.status = { fut: 'connecting', spot: 'connecting', fx: 'pending' };
    this.ws = {};
    this.retry = { fut: 0, spot: 0 };
    this.lastMsg = { fut: 0, spot: 0 };
    this.watchdog = {};
    this.handlers = {};
  }

  on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); }
  emit(evt, ...args) {
    for (const fn of this.handlers[evt] || []) {
      try { fn(...args); } catch (e) { console.error(e); }
    }
  }

  setStatus(kind, v) { this.status[kind] = v; this.emit('status', this.status); }

  static parseKlines(rows) {
    return rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
  }

  async fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }

  async init() {
    await Promise.all([this.refreshFx(), ...this.symbols.map((s) => this.loadHistory(s))]);
    this.connect('fut');
    this.connect('spot');
    setInterval(() => this.refreshFx(), 60_000);
    setInterval(() => this.symbols.forEach((s) => this.load15m(s)), 5 * 60_000);
  }

  async refreshFx() {
    try {
      const d = await this.fetchJSON(CONFIG.FX_URL);
      const p = +d[0].trade_price;
      if (p > 0) {
        this.fx = { rate: p, source: 'Upbit KRW-USDT', updated: Date.now() };
        this.setStatus('fx', 'live');
      }
    } catch (e) {
      console.warn('환율 조회 실패', e);
      this.setStatus('fx', this.fx.updated ? 'stale' : 'fallback');
    }
  }

  async load15m(s) {
    try {
      const rows = await this.fetchJSON(`${CONFIG.REST.FUT}/fapi/v1/klines?symbol=${s}&interval=15m&limit=200`);
      this.fut[s].candles15 = Market.parseKlines(rows);
    } catch (e) { console.warn('15m 캔들 조회 실패', s, e); }
  }

  async loadHistory(s) {
    const [f1, f15, s1, prem, t24f, t24s] = await Promise.allSettled([
      this.fetchJSON(`${CONFIG.REST.FUT}/fapi/v1/klines?symbol=${s}&interval=1m&limit=500`),
      this.fetchJSON(`${CONFIG.REST.FUT}/fapi/v1/klines?symbol=${s}&interval=15m&limit=200`),
      this.fetchJSON(`${CONFIG.REST.SPOT}/api/v3/klines?symbol=${s}&interval=1m&limit=500`),
      this.fetchJSON(`${CONFIG.REST.FUT}/fapi/v1/premiumIndex?symbol=${s}`),
      this.fetchJSON(`${CONFIG.REST.FUT}/fapi/v1/ticker/24hr?symbol=${s}`),
      this.fetchJSON(`${CONFIG.REST.SPOT}/api/v3/ticker/24hr?symbol=${s}`),
    ]);
    const F = this.fut[s], S = this.spot[s];
    if (f1.status === 'fulfilled') { F.candles = Market.parseKlines(f1.value); F.price = F.candles.at(-1)?.c || 0; }
    if (f15.status === 'fulfilled') F.candles15 = Market.parseKlines(f15.value);
    if (s1.status === 'fulfilled') { S.candles = Market.parseKlines(s1.value); S.price = S.candles.at(-1)?.c || 0; }
    if (prem.status === 'fulfilled') {
      F.mark = +prem.value.markPrice; F.funding = +prem.value.lastFundingRate; F.nextFunding = +prem.value.nextFundingTime;
    }
    if (t24f.status === 'fulfilled') { F.change24 = +t24f.value.priceChangePercent / 100; F.vol24 = +t24f.value.quoteVolume; }
    if (t24s.status === 'fulfilled') { S.change24 = +t24s.value.priceChangePercent / 100; S.vol24 = +t24s.value.quoteVolume; }
  }

  connect(kind) {
    const streams = this.symbols.flatMap((s) => {
      const l = s.toLowerCase();
      return kind === 'fut'
        ? [`${l}@kline_1m`, `${l}@markPrice@1s`, `${l}@miniTicker`]
        : [`${l}@kline_1m`, `${l}@miniTicker`];
    });
    const bases = kind === 'fut' ? CONFIG.WS.FUT : CONFIG.WS.SPOT;
    this.urlIdx = this.urlIdx || { fut: 0, spot: 0 };
    const url = bases[this.urlIdx[kind] % bases.length] + streams.join('/');
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this.scheduleReconnect(kind, true); return; }
    this.ws[kind] = ws;
    this.setStatus(kind, 'connecting');
    let gotData = false;
    ws.onopen = () => this.setStatus(kind, 'connecting');
    ws.onmessage = (ev) => {
      if (!gotData) { gotData = true; this.retry[kind] = 0; this.setStatus(kind, 'live'); }
      this.lastMsg[kind] = Date.now();
      try {
        const m = JSON.parse(ev.data);
        if (m.data) this.handle(kind, m.data);
      } catch (e) { console.error(e); }
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
    ws.onclose = () => { if (this.ws[kind] === ws) this.scheduleReconnect(kind, !gotData); };
    // 워치독: 연결은 됐지만 20초간 데이터가 없으면 다음 URL로 재연결
    this.lastMsg[kind] = Date.now();
    clearInterval(this.watchdog[kind]);
    this.watchdog[kind] = setInterval(() => {
      if (this.ws[kind] === ws && Date.now() - this.lastMsg[kind] > 20_000) {
        console.warn(`${kind} 스트림 데이터 없음 → 재연결`);
        this.ws[kind] = null;
        try { ws.close(); } catch {}
        this.scheduleReconnect(kind, true);
      }
    }, 5000);
  }

  scheduleReconnect(kind, rotate) {
    if (this.status[kind] === 'reconnecting') return;
    clearInterval(this.watchdog[kind]);
    if (rotate) this.urlIdx[kind]++;
    this.setStatus(kind, 'reconnecting');
    const delay = Math.min(30_000, 1000 * 2 ** this.retry[kind]++);
    setTimeout(() => this.connect(kind), delay);
  }

  handle(kind, d) {
    const book = kind === 'fut' ? this.fut : this.spot;
    const b = book[d.s];
    if (!b) return;
    if (d.e === 'kline') {
      const k = d.k;
      const c = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v };
      const arr = b.candles;
      const last = arr[arr.length - 1];
      if (last && last.t === c.t) arr[arr.length - 1] = c;
      else if (!last || c.t > last.t) {
        arr.push(c);
        if (arr.length > CONFIG.MAX_CANDLES) arr.shift();
      }
      b.price = c.c;
      b.updated = Date.now();
      if (kind === 'fut' && b.candles15.length) {
        const t15 = Math.floor(c.t / 900_000) * 900_000;
        const l15 = b.candles15[b.candles15.length - 1];
        if (l15.t === t15) {
          l15.h = Math.max(l15.h, c.h); l15.l = Math.min(l15.l, c.l); l15.c = c.c;
        } else if (t15 > l15.t) {
          b.candles15.push({ t: t15, o: c.o, h: c.h, l: c.l, c: c.c, v: 0 });
          if (b.candles15.length > 300) b.candles15.shift();
        }
      }
      this.emit('tick', kind, d.s);
    } else if (d.e === 'markPriceUpdate') {
      b.mark = +d.p; b.funding = +d.r; b.nextFunding = +d.T;
      this.emit('mark', d.s);
    } else if (d.e === '24hrMiniTicker') {
      const o = +d.o;
      b.change24 = o ? (+d.c - o) / o : 0;
      b.vol24 = +d.q;
    }
  }
}
