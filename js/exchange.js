// 모의 거래소 엔진: 현물 + USDⓈ-M 선물(격리 마진, 롱/숏, 레버리지, 청산, 펀딩비)
// 내부 장부는 USDT 기준이며, 원화 표시는 계좌 생성 시점 환율(state.fxRate)로 고정 환산합니다.
class PaperExchange {
  constructor(market) {
    this.market = market;
    this.state = null;
    this.listeners = [];
    this.lastSnapshot = 0;
  }

  static freshState(initialKRW, fxRate) {
    const usdt = initialKRW / fxRate;
    return {
      version: 1,
      createdAt: Date.now(),
      initialKRW,
      fxRate,
      initialUSDT: usdt,
      cash: usdt,
      spot: {},        // sym -> { qty, avg, sl, tp, openedAt, by, reason }
      futures: {},     // sym -> position (one-way 모드: 심볼당 1개)
      trades: [],
      equity: [{ t: Math.floor(Date.now() / 1000), v: usdt }],
      aiLog: [],
      lastCloseAt: {},
      funding: {},     // sym -> { T, rate } 다음 정산 대기 정보
    };
  }

  onChange(fn) { this.listeners.push(fn); }
  notify(type, payload) { for (const fn of this.listeners) { try { fn(type, payload); } catch (e) { console.error(e); } } }

  futPrice(sym) { return this.market.fut[sym]?.price || 0; }
  markPrice(sym) { const b = this.market.fut[sym]; return b?.mark || b?.price || 0; }
  spotPrice(sym) { return this.market.spot[sym]?.price || this.futPrice(sym); }
  krw(usdt) { return usdt * this.state.fxRate; }

  upnl(p) {
    const m = this.markPrice(p.sym);
    if (!m) return 0;
    return p.side === 'LONG' ? (m - p.entry) * p.qty : (p.entry - m) * p.qty;
  }

  summary() {
    const s = this.state;
    let spotValue = 0, spotCost = 0, futMargin = 0, futUpnl = 0, futNotional = 0;
    for (const [sym, h] of Object.entries(s.spot)) {
      spotValue += h.qty * this.spotPrice(sym);
      spotCost += h.qty * h.avg;
    }
    for (const p of Object.values(s.futures)) {
      futMargin += p.margin;
      futUpnl += this.upnl(p);
      futNotional += p.qty * this.markPrice(p.sym);
    }
    const equity = s.cash + spotValue + futMargin + futUpnl;
    let realized = 0, wins = 0, closes = 0, fees = 0, fundingTotal = 0;
    for (const t of s.trades) {
      fees += t.fee || 0;
      if (t.action === 'FUNDING') fundingTotal += t.net ?? t.amount ?? 0;
      if (t.closing) { realized += t.net; closes++; if (t.net > 0) wins++; }
    }
    return {
      cash: s.cash, spotValue, spotUpnl: spotValue - spotCost, futMargin, futUpnl, futNotional, equity,
      returnPct: equity / s.initialUSDT - 1,
      realized, closes, wins, winRate: closes ? wins / closes : 0, fees, fundingTotal,
    };
  }

  record(t) {
    t.id = U.uid();
    t.time = t.time || Date.now();
    this.state.trades.push(t);
    this.notify('trade', t);
    return t;
  }

  liqPrice(side, entry, lev) {
    const m = CONFIG.MMR;
    return side === 'LONG' ? entry * (1 - 1 / lev) / (1 - m) : entry * (1 + 1 / lev) / (1 + m);
  }

  // ---------- 선물 ----------
  openFutures(sym, side, margin, lev, meta = {}) {
    const s = this.state;
    if (s.futures[sym]) return { ok: false, error: `${sym} 선물 포지션이 이미 있습니다` };
    const px = this.futPrice(sym);
    if (!px) return { ok: false, error: '시세 없음' };
    lev = U.clamp(Math.round(lev), 1, 125);
    const feeRate = CONFIG.FEES.FUT_TAKER;
    const maxMargin = s.cash / (1 + lev * feeRate) * 0.999;
    margin = Math.min(margin, maxMargin);
    if (!(margin >= 5)) return { ok: false, error: '증거금 부족 (최소 5 USDT)' };
    const fill = side === 'LONG' ? px * (1 + CONFIG.SLIPPAGE) : px * (1 - CONFIG.SLIPPAGE);
    const notional = margin * lev;
    const qty = notional / fill;
    const fee = notional * feeRate;
    const liq = this.liqPrice(side, fill, lev);
    let { sl = null, tp = null } = meta;
    // 손절가가 청산가 너머에 있으면 청산가 안쪽으로 당김
    if (sl != null) {
      if (side === 'LONG' && sl <= liq) sl = liq + (fill - liq) * 0.2;
      if (side === 'SHORT' && sl >= liq) sl = liq - (liq - fill) * 0.2;
    }
    s.cash -= margin + fee;
    const pos = {
      sym, side, qty, entry: fill, lev, margin, liq, sl, tp, initSl: sl,
      openedAt: Date.now(), openFee: fee, funding: 0, peak: fill,
      by: meta.by || 'MANUAL', reason: meta.reason || '',
    };
    s.futures[sym] = pos;
    const b = this.market.fut[sym];
    s.funding[sym] = { T: b.nextFunding || 0, rate: b.funding || 0 };
    this.record({
      market: 'FUTURES', sym, action: side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
      price: fill, qty, notional, fee, lev, margin, sl, tp, by: pos.by, reason: pos.reason, closing: false,
    });
    return { ok: true, pos };
  }

  closeFutures(sym, meta = {}) {
    const s = this.state;
    const p = s.futures[sym];
    if (!p) return { ok: false, error: '포지션 없음' };
    const px = meta.price || this.futPrice(sym);
    const fill = p.side === 'LONG' ? px * (1 - CONFIG.SLIPPAGE) : px * (1 + CONFIG.SLIPPAGE);
    const pnl = p.side === 'LONG' ? (fill - p.entry) * p.qty : (p.entry - fill) * p.qty;
    const fee = fill * p.qty * CONFIG.FEES.FUT_TAKER;
    const back = Math.max(0, p.margin + pnl) - fee;
    s.cash += back;
    const net = Math.max(-p.margin, pnl) - fee - p.openFee + p.funding;
    delete s.futures[sym];
    s.lastCloseAt[sym] = Date.now();
    const t = this.record({
      market: 'FUTURES', sym, action: p.side === 'LONG' ? 'CLOSE_LONG' : 'CLOSE_SHORT',
      price: fill, qty: p.qty, notional: fill * p.qty, fee, lev: p.lev, margin: p.margin,
      entry: p.entry, pnl, net, roe: net / p.margin, holdMs: Date.now() - p.openedAt,
      by: meta.by || 'MANUAL', reason: meta.reason || '', closing: true,
    });
    return { ok: true, trade: t };
  }

  liquidate(sym) {
    const s = this.state;
    const p = s.futures[sym];
    if (!p) return;
    delete s.futures[sym];
    s.lastCloseAt[sym] = Date.now();
    const net = -p.margin - p.openFee + p.funding;
    this.record({
      market: 'FUTURES', sym, action: 'LIQUIDATION', price: p.liq, qty: p.qty, notional: p.liq * p.qty,
      fee: 0, lev: p.lev, margin: p.margin, entry: p.entry, pnl: -p.margin, net, roe: net / p.margin,
      holdMs: Date.now() - p.openedAt, by: 'SYSTEM', reason: `강제 청산 (${p.side === 'LONG' ? '롱' : '숏'} ${p.lev}x, 청산가 ${U.fmtPrice(p.liq)})`, closing: true,
    });
  }

  setStops(sym, { sl, tp }) {
    const p = this.state.futures[sym];
    if (!p) return false;
    if (sl != null) {
      if (p.side === 'LONG') sl = Math.max(sl, p.liq * 1.001);
      else sl = Math.min(sl, p.liq * 0.999);
      p.sl = sl;
    }
    if (tp != null) p.tp = tp;
    return true;
  }

  // ---------- 현물 ----------
  spotBuy(sym, usdt, meta = {}) {
    const s = this.state;
    const px = this.spotPrice(sym);
    if (!px) return { ok: false, error: '시세 없음' };
    usdt = Math.min(usdt, s.cash);
    if (!(usdt >= 5)) return { ok: false, error: '잔고 부족 (최소 5 USDT)' };
    const fill = px * (1 + CONFIG.SLIPPAGE);
    const fee = usdt * CONFIG.FEES.SPOT;
    const qty = (usdt - fee) / fill;
    const h = s.spot[sym];
    if (h) {
      h.avg = (h.avg * h.qty + usdt) / (h.qty + qty);
      h.qty += qty;
      if (meta.sl != null) h.sl = meta.sl;
      if (meta.tp != null) h.tp = meta.tp;
    } else {
      s.spot[sym] = { qty, avg: usdt / qty, sl: meta.sl ?? null, tp: meta.tp ?? null, openedAt: Date.now(), by: meta.by || 'MANUAL', reason: meta.reason || '' };
    }
    s.cash -= usdt;
    this.record({ market: 'SPOT', sym, action: 'BUY', price: fill, qty, notional: usdt, fee, sl: meta.sl, tp: meta.tp, by: meta.by || 'MANUAL', reason: meta.reason || '', closing: false });
    return { ok: true };
  }

  spotSell(sym, meta = {}) {
    const s = this.state;
    const h = s.spot[sym];
    if (!h) return { ok: false, error: '보유 없음' };
    const px = meta.price || this.spotPrice(sym);
    const fill = px * (1 - CONFIG.SLIPPAGE);
    const proceeds = h.qty * fill;
    const fee = proceeds * CONFIG.FEES.SPOT;
    s.cash += proceeds - fee;
    const net = proceeds - fee - h.avg * h.qty;
    delete s.spot[sym];
    s.lastCloseAt['spot:' + sym] = Date.now();
    const t = this.record({
      market: 'SPOT', sym, action: 'SELL', price: fill, qty: h.qty, notional: proceeds, fee, entry: h.avg,
      pnl: net + fee, net, roe: net / (h.avg * h.qty), holdMs: Date.now() - h.openedAt,
      by: meta.by || 'MANUAL', reason: meta.reason || '', closing: true,
    });
    return { ok: true, trade: t };
  }

  // ---------- 실시간 트리거 ----------
  onTick(kind, sym) {
    const s = this.state;
    if (!s) return;
    if (kind === 'fut') {
      const p = s.futures[sym];
      if (p) {
        const m = this.markPrice(sym), last = this.futPrice(sym);
        if ((p.side === 'LONG' && m <= p.liq) || (p.side === 'SHORT' && m >= p.liq)) {
          this.liquidate(sym);
        } else if (p.sl != null && ((p.side === 'LONG' && last <= p.sl) || (p.side === 'SHORT' && last >= p.sl))) {
          const inProfit = p.side === 'LONG' ? p.sl > p.entry : p.sl < p.entry;
          this.closeFutures(sym, { by: 'SYSTEM', reason: inProfit ? `트레일링 스탑 도달 (${U.fmtPrice(p.sl)})` : `손절가 도달 (${U.fmtPrice(p.sl)})` });
        } else if (p.tp != null && ((p.side === 'LONG' && last >= p.tp) || (p.side === 'SHORT' && last <= p.tp))) {
          this.closeFutures(sym, { by: 'SYSTEM', reason: `익절가 도달 (${U.fmtPrice(p.tp)})` });
        }
      }
    } else {
      const h = s.spot[sym];
      if (h) {
        const last = this.spotPrice(sym);
        if (h.sl != null && last <= h.sl) this.spotSell(sym, { by: 'SYSTEM', reason: `현물 손절가 도달 (${U.fmtPrice(h.sl)})` });
        else if (h.tp != null && last >= h.tp) this.spotSell(sym, { by: 'SYSTEM', reason: `현물 익절가 도달 (${U.fmtPrice(h.tp)})` });
      }
    }
  }

  // 펀딩비 정산: 정산 시각(T)이 지나고 다음 T로 넘어가면 직전 펀딩비율로 정산
  onMark(sym) {
    const s = this.state;
    if (!s) return;
    const b = this.market.fut[sym];
    const p = s.futures[sym];
    const f = s.funding[sym];
    if (p && f && f.T && b.nextFunding > f.T && Date.now() >= f.T && p.openedAt < f.T) {
      const payment = f.rate * p.qty * this.markPrice(sym);
      const amount = p.side === 'LONG' ? -payment : payment;
      s.cash += amount;
      p.funding += amount;
      this.record({
        market: 'FUTURES', sym, action: 'FUNDING', price: this.markPrice(sym), qty: p.qty, fee: 0, amount, net: amount,
        rate: f.rate, by: 'SYSTEM', reason: `펀딩비 정산 (비율 ${(f.rate * 100).toFixed(4)}%, ${p.side === 'LONG' ? '롱' : '숏'})`, closing: false,
      });
    }
    s.funding[sym] = { T: b.nextFunding, rate: b.funding };
  }

  maybeSnapshot() {
    const now = Date.now();
    if (now - this.lastSnapshot < 10_000) return null;
    this.lastSnapshot = now;
    const eq = this.state.equity;
    const t = Math.floor(now / 1000);
    if (eq.length && eq[eq.length - 1].t >= t) return null;
    const point = { t, v: this.summary().equity };
    eq.push(point);
    if (eq.length > 20_000) {
      // 오래된 절반을 1/2로 다운샘플링
      const half = eq.splice(0, 10_000);
      eq.unshift(...half.filter((_, i) => i % 2 === 0));
    }
    return point;
  }
}
