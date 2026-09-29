// 클라우드 실행 1회(틱) 로직 — PC가 꺼져 있어도 매시간 클라우드에서 실행됩니다.
// 브라우저/Node 공용: 네트워크 요청 함수 get(url) → JSON 을 주입받습니다.
//
// sync  : 지난 실행 이후 구간을 1분봉으로 재생(손절/익절/청산/펀딩 정산) → 사용자 명령 처리
//         → 퀀트 모드면 매매까지, Claude 모드면 판단용 스냅샷 생성
// apply : Claude가 내린 결정(JSON)을 리스크 가드와 함께 실행
const CloudTick = (() => {
  const MIN = 60_000;
  const FUT = 'https://fapi.binance.com';
  const SPOT = ['https://api.binance.com', 'https://data-api.binance.vision'];
  const MAX_REPLAY_MS = 7 * 24 * 3600_000;

  const parseK = (rows) => rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
  const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
  const px = (v) => (v == null || !isFinite(v) ? null : +(+v).toPrecision(7));
  const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

  function emptyMarket(symbols, now) {
    const m = { symbols, fut: {}, spot: {}, fx: { rate: CONFIG.FALLBACK_FX }, status: { fut: 'live', spot: 'live', fx: 'live' }, source: {} };
    for (const s of symbols) {
      m.fut[s] = { candles: [], candles15: [], candles1h: [], price: 0, mark: 0, funding: 0, nextFunding: 0, change24: 0, vol24: 0, updated: now };
      m.spot[s] = { candles: [], price: 0, change24: 0, vol24: 0, updated: now };
    }
    return m;
  }

  async function loadMarket(get, symbols, now) {
    const m = emptyMarket(symbols, now);
    const notes = [];
    let futOk = false, spotBase = null;
    try {
      await Promise.all(symbols.map(async (s) => {
        const [k1, k15, k1h, prem, t24] = await Promise.all([
          get(`${FUT}/fapi/v1/klines?symbol=${s}&interval=1m&limit=500`),
          get(`${FUT}/fapi/v1/klines?symbol=${s}&interval=15m&limit=200`),
          get(`${FUT}/fapi/v1/klines?symbol=${s}&interval=1h&limit=72`),
          get(`${FUT}/fapi/v1/premiumIndex?symbol=${s}`),
          get(`${FUT}/fapi/v1/ticker/24hr?symbol=${s}`),
        ]);
        const F = m.fut[s];
        F.candles = parseK(k1); F.candles15 = parseK(k15); F.candles1h = parseK(k1h);
        F.price = F.candles[F.candles.length - 1].c;
        F.mark = +prem.markPrice || F.price;
        F.funding = +prem.lastFundingRate || 0;
        F.nextFunding = +prem.nextFundingTime || 0;
        F.change24 = +t24.priceChangePercent / 100;
        F.vol24 = +t24.quoteVolume;
      }));
      futOk = true;
    } catch (e) { notes.push(`선물 API 접근 실패 (${e.message})`); }

    for (const base of SPOT) {
      try {
        await Promise.all(symbols.map(async (s) => {
          const [k1, t24, k15, k1h] = await Promise.all([
            get(`${base}/api/v3/klines?symbol=${s}&interval=1m&limit=500`),
            get(`${base}/api/v3/ticker/24hr?symbol=${s}`),
            futOk ? null : get(`${base}/api/v3/klines?symbol=${s}&interval=15m&limit=200`),
            futOk ? null : get(`${base}/api/v3/klines?symbol=${s}&interval=1h&limit=72`),
          ]);
          const S = m.spot[s];
          S.candles = parseK(k1);
          S.price = S.candles[S.candles.length - 1].c;
          S.change24 = +t24.priceChangePercent / 100;
          S.vol24 = +t24.quoteVolume;
          if (!futOk) {
            const F = m.fut[s];
            F.candles = S.candles; F.candles15 = parseK(k15); F.candles1h = parseK(k1h);
            F.price = F.mark = S.price; F.change24 = S.change24; F.vol24 = S.vol24;
          }
        }));
        spotBase = base;
        break;
      } catch (e) { notes.push(`현물 API 접근 실패: ${base.replace('https://', '')} (${e.message})`); }
    }

    if (!futOk && !spotBase) {
      const err = new Error(notes.join(' / '));
      err.network = true;
      throw err;
    }
    if (!futOk) notes.push('선물 API를 쓸 수 없어 현물 시세로 선물을 모의 계산했습니다 (펀딩비 0).');
    if (!spotBase) {
      for (const s of symbols) {
        const S = m.spot[s], F = m.fut[s];
        S.candles = F.candles; S.price = F.price; S.change24 = F.change24; S.vol24 = F.vol24;
      }
      notes.push('현물 API를 쓸 수 없어 선물 시세로 현물을 계산했습니다.');
    }
    m.source = { futOk, spotBase };
    return { market: m, notes };
  }

  async function fxRate(get) {
    try {
      const d = await get(CONFIG.FX_URL);
      const p = +d[0].trade_price;
      if (p > 0) return p;
    } catch {}
    return CONFIG.FALLBACK_FX;
  }

  async function fetchRange(get, url0, since, until) {
    const out = [];
    let start = since;
    for (let i = 0; i < 12 && start < until; i++) {
      const rows = await get(`${url0}&startTime=${start}&endTime=${until}&limit=1000`);
      if (!rows || !rows.length) break;
      const k = parseK(rows);
      out.push(...k);
      start = k[k.length - 1].t + MIN;
      if (rows.length < 1000) break;
    }
    return out;
  }

  function migrate(s) {
    s.aiLog = s.aiLog || [];
    s.lastCloseAt = s.lastCloseAt || {};
    s.funding = s.funding || {};
    s.equity = s.equity || [];
    s.spot = s.spot || {};
    s.futures = s.futures || {};
    s.trades = [];
    s.stats = s.stats || { realized: 0, closes: 0, wins: 0, fees: 0, funding: 0 };
    s.claudeInfo = s.claudeInfo || { view: '', error: '', lastRun: 0, busy: false };
    s.doneCmds = s.doneCmds || [];
    return s;
  }

  function fresh(krw, fx, now) {
    const s = migrate(PaperExchange.freshState(krw, fx));
    s.lastTick = now;
    s.aiLog.push({ t: now, type: 'SCAN', text: `계좌 개설: 초기 자본 ${U.fmtKRW(krw)} (${U.fmtNum(s.initialUSDT)} USDT, 환율 ${U.fmtNum(fx, 1)}원). 클라우드 AI가 매시간 시장을 분석합니다.` });
    return s;
  }

  function recentTrades(ledger, acct) {
    const all = [];
    for (const m of Object.keys(ledger || {}).sort()) for (const t of ledger[m].trades || []) if (t.acct === acct) all.push(t);
    return all.slice(-10);
  }

  // ---------- 1분봉 재생 ----------
  function stopReason(p) {
    const inProfit = p.side === 'LONG' ? p.sl > p.entry : p.sl < p.entry;
    return inProfit ? `트레일링 스탑 도달 (${U.fmtPrice(p.sl)})` : `손절가 도달 (${U.fmtPrice(p.sl)})`;
  }

  function trail(p, extreme, trails) {
    const long = p.side === 'LONG';
    const R = Math.abs(p.entry - (p.initSl ?? p.entry * (long ? 0.99 : 1.01))) || p.entry * 0.01;
    p.peak = long ? Math.max(p.peak, extreme) : Math.min(p.peak, extreme);
    const r = (long ? p.peak - p.entry : p.entry - p.peak) / R;
    let sl = p.sl ?? (long ? -Infinity : Infinity);
    if (r >= 1) sl = long ? Math.max(sl, p.entry * 1.0012) : Math.min(sl, p.entry * 0.9988);
    if (r >= 1.5) {
      const tr = long ? p.peak - R : p.peak + R;
      sl = long ? Math.max(sl, tr) : Math.min(sl, tr);
    }
    if (isFinite(sl) && sl !== p.sl) {
      if (!trails[p.sym]) trails[p.sym] = { from: p.sl };
      p.sl = sl;
      trails[p.sym].to = sl;
      trails[p.sym].r = r;
    }
  }

  function stepFut(ex, sym, c, S, trails) {
    const p = ex.state.futures[sym];
    if (!p || c.t + MIN <= p.openedAt) return;
    const long = p.side === 'LONG';
    const open = c.t >= p.openedAt ? c.o : null; // 진입 이전 가격은 갭 판단에 쓰지 않음
    const reason = (txt) => ({ by: 'SYSTEM', reason: txt });
    if (long) {
      if (p.sl != null && c.l <= p.sl) return ex.closeFutures(sym, { price: open != null ? Math.min(open, p.sl) : p.sl, ...reason(stopReason(p)) });
      if (c.l <= p.liq) return ex.liquidate(sym);
      if (p.tp != null && c.h >= p.tp) return ex.closeFutures(sym, { price: open != null ? Math.max(open, p.tp) : p.tp, ...reason(`익절가 도달 (${U.fmtPrice(p.tp)})`) });
    } else {
      if (p.sl != null && c.h >= p.sl) return ex.closeFutures(sym, { price: open != null ? Math.max(open, p.sl) : p.sl, ...reason(stopReason(p)) });
      if (c.h >= p.liq) return ex.liquidate(sym);
      if (p.tp != null && c.l <= p.tp) return ex.closeFutures(sym, { price: open != null ? Math.min(open, p.tp) : p.tp, ...reason(`익절가 도달 (${U.fmtPrice(p.tp)})`) });
    }
    if (S.aiMode !== 'off') trail(p, long ? c.h : c.l, trails);
  }

  function stepSpot(ex, sym, c) {
    const h = ex.state.spot[sym];
    if (!h || c.t + MIN <= h.openedAt) return;
    if (h.sl != null && c.l <= h.sl) return ex.spotSell(sym, { price: h.sl, by: 'SYSTEM', reason: `현물 손절가 도달 (${U.fmtPrice(h.sl)})` });
    if (h.tp != null && c.h >= h.tp) return ex.spotSell(sym, { price: h.tp, by: 'SYSTEM', reason: `현물 익절가 도달 (${U.fmtPrice(h.tp)})` });
  }

  function applyFunding(ex, ev) {
    const st = ex.state;
    const p = st.futures[ev.sym];
    if (!p || p.openedAt >= ev.t) return;
    const mark = ev.mark || ex.markPrice(ev.sym);
    const payment = ev.rate * p.qty * mark;
    const amount = p.side === 'LONG' ? -payment : payment;
    st.cash += amount;
    p.funding += amount;
    ex.record({
      market: 'FUTURES', sym: ev.sym, action: 'FUNDING', price: mark, qty: p.qty, fee: 0, amount, net: amount, rate: ev.rate,
      by: 'SYSTEM', reason: `펀딩비 정산 (비율 ${(ev.rate * 100).toFixed(4)}%, ${p.side === 'LONG' ? '롱' : '숏'})`, closing: false,
    });
  }

  async function replay(get, market, ex, S, since, now, log) {
    const st = ex.state;
    const futSyms = Object.keys(st.futures), spotSyms = Object.keys(st.spot);
    if (!futSyms.length && !spotSyms.length) return 0;
    const src = market.source;
    const futUrl = src.futOk ? `${FUT}/fapi/v1/klines` : `${src.spotBase}/api/v3/klines`;
    const spotUrl = src.spotBase ? `${src.spotBase}/api/v3/klines` : `${FUT}/fapi/v1/klines`;
    const events = [];
    const firstOpen = { fut: {}, spot: {} };
    await Promise.all([
      ...futSyms.map(async (s) => {
        const cs = await fetchRange(get, `${futUrl}?symbol=${s}&interval=1m`, since - MIN, now);
        for (const c of cs) if (c.t + MIN > since) {
          if (firstOpen.fut[s] == null) firstOpen.fut[s] = c.o;
          events.push({ t: Math.min(c.t + MIN - 1, now), kind: 'fut', sym: s, c });
        }
        if (src.futOk) {
          const fr = await get(`${FUT}/fapi/v1/fundingRate?symbol=${s}&startTime=${since}&endTime=${now}&limit=1000`);
          for (const f of fr || []) events.push({ t: +f.fundingTime, kind: 'funding', sym: s, rate: +f.fundingRate, mark: +f.markPrice || 0 });
        }
      }),
      ...spotSyms.map(async (s) => {
        const cs = await fetchRange(get, `${spotUrl}?symbol=${s}&interval=1m`, since - MIN, now);
        for (const c of cs) if (c.t + MIN > since) {
          if (firstOpen.spot[s] == null) firstOpen.spot[s] = c.o;
          events.push({ t: Math.min(c.t + MIN - 1, now), kind: 'spot', sym: s, c });
        }
      }),
    ]);
    const order = { funding: 0, fut: 1, spot: 2 };
    events.sort((a, b) => a.t - b.t || order[a.kind] - order[b.kind]);

    // 재생 동안 시계를 과거 시점으로 돌려 체결 시각을 정확히 기록
    const live = {};
    for (const s of market.symbols) live[s] = { p: market.fut[s].price, m: market.fut[s].mark, sp: market.spot[s].price };
    for (const [s, o] of Object.entries(firstOpen.fut)) { market.fut[s].price = market.fut[s].mark = o; }
    for (const [s, o] of Object.entries(firstOpen.spot)) market.spot[s].price = o;
    const trails = {};
    const realNow = Date.now;
    let sim = since;
    Date.now = () => sim;
    try {
      let lastEq = (st.equity.length ? st.equity[st.equity.length - 1].t : 0) * 1000;
      for (const ev of events) {
        sim = ev.t;
        if (ev.kind === 'fut') {
          const b = market.fut[ev.sym];
          b.price = b.mark = ev.c.c;
          stepFut(ex, ev.sym, ev.c, S, trails);
        } else if (ev.kind === 'spot') {
          market.spot[ev.sym].price = ev.c.c;
          stepSpot(ex, ev.sym, ev.c);
        } else {
          applyFunding(ex, ev);
        }
        if (sim - lastEq >= 15 * MIN) {
          st.equity.push({ t: Math.floor(sim / 1000), v: ex.summary().equity });
          lastEq = sim;
        }
      }
    } finally {
      Date.now = realNow;
      for (const s of market.symbols) { market.fut[s].price = live[s].p; market.fut[s].mark = live[s].m; market.spot[s].price = live[s].sp; }
    }
    for (const [sym, tr] of Object.entries(trails)) {
      if (st.futures[sym]) log({ type: 'TRAIL', sym, text: `${U.base(sym)} 손절가 상향 조정 ${U.fmtPrice(tr.from)} → ${U.fmtPrice(tr.to)} (최대 수익 ${tr.r.toFixed(1)}R, 이익 보호)` });
    }
    return events.length;
  }

  // ---------- 마무리: 저장할 상태 정리 ----------
  function finalize(ctx, env, extra) {
    const { ex, market, quant, S, notes, base } = env;
    const st = ex.state;
    const now = Date.now();
    const newTrades = st.trades.slice(base).map((t) => ({ ...t, acct: st.createdAt }));
    for (const t of newTrades) {
      st.stats.fees += t.fee || 0;
      if (t.action === 'FUNDING') st.stats.funding += t.amount || 0;
      if (t.closing) { st.stats.realized += t.net; st.stats.closes++; if (t.net > 0) st.stats.wins++; }
    }
    const sum = ex.summary();
    st.trades = [];

    const point = { t: Math.floor(now / 1000), v: sum.equity };
    const last = st.equity[st.equity.length - 1];
    if (last && point.t - last.t < 600) st.equity[st.equity.length - 1] = point; else st.equity.push(point);
    if (st.equity.length > 3000) {
      const old = st.equity.splice(0, 1500);
      st.equity.unshift(...old.filter((_, i) => i % 2 === 0));
    }
    if (st.aiLog.length > 300) st.aiLog.splice(0, st.aiLog.length - 300);

    st.market = {};
    st.signals = {};
    st.charts = {};
    for (const s of market.symbols) {
      const F = market.fut[s];
      st.market[s] = { price: px(F.price), mark: px(F.mark), spot: px(market.spot[s].price), change24: r4(F.change24), funding: F.funding, nextFunding: F.nextFunding, vol24: Math.round(F.vol24) };
      const g = quant.signals[s];
      if (g) st.signals[s] = { score: r4(g.score), trend: r4(g.trend), rsi: +g.rsi.toFixed(1), volPct: r4(g.volPct), cross: r4(g.cross) };
      st.charts[s] = F.candles15.slice(-96).map((c) => [c.t, px(c.o), px(c.h), px(c.l), px(c.c)]);
    }
    st.summary = {
      equity: sum.equity, cash: sum.cash, spotValue: sum.spotValue, spotUpnl: sum.spotUpnl, futMargin: sum.futMargin, futUpnl: sum.futUpnl,
      returnPct: sum.returnPct, realized: st.stats.realized, closes: st.stats.closes, wins: st.stats.wins,
      winRate: st.stats.closes ? st.stats.wins / st.stats.closes : 0, fees: st.stats.fees, fundingTotal: st.stats.funding, asOf: now,
    };
    st.settingsSeen = { aiMode: S.aiMode, riskPct: S.riskPct, maxLeverage: S.maxLeverage, maxPositions: S.maxPositions };

    // 월별 거래장부에 새 거래 추가
    const ledgerOut = {};
    for (const t of newTrades) {
      const m = monthOf(t.time);
      if (!ledgerOut[m]) ledgerOut[m] = { month: m, trades: ((ctx.ledger || {})[m]?.trades || []).slice() };
      ledgerOut[m].trades.push(t);
    }
    return { state: st, ledgerOut, newTrades: newTrades.length, notes, ...extra };
  }

  async function prepare(ctx, S) {
    const now = ctx.now || Date.now();
    const { market, notes } = await loadMarket(ctx.get, CONFIG.SYMBOLS, now);
    const ex = new PaperExchange(market);
    return { now, market, ex, notes };
  }

  function makeAgents(env) {
    const log = (e) => env.ex.state.aiLog.push({ t: Date.now(), ...e });
    env.log = log;
    env.quant = new QuantAI(env.market, env.ex, () => env.S, log);
    env.claude = new ClaudeAI(env.market, env.ex, env.quant, () => env.S, log);
  }

  function settingsOf(ctx) {
    return Object.assign({}, DEFAULT_SETTINGS, { aiMode: 'claude' }, ctx.settings || {});
  }

  function touchBooks(market) {
    const t = Date.now();
    for (const s of market.symbols) { market.fut[s].updated = t; market.spot[s].updated = t; }
  }

  async function sync(ctx) {
    const S = settingsOf(ctx);
    let state = ctx.state && ctx.state.cash != null ? migrate(ctx.state) : null;
    let prep;
    try {
      prep = await prepare(ctx, S);
    } catch (e) {
      // 네트워크 차단 등: 상태에 기록만 하고 종료
      const now = Date.now();
      if (!state) state = fresh(S.initialKRW || CONFIG.INITIAL_KRW, CONFIG.FALLBACK_FX, now);
      const wasOk = state.tick ? state.tick.ok : true;
      state.tick = { at: now, ok: false, mode: S.aiMode, error: e.message, network: !!e.network, runs: (state.tick?.runs || 0) + 1 };
      if (wasOk) state.aiLog.push({ t: now, type: 'ERROR', text: `시세를 가져오지 못해 이번 실행을 건너뜁니다: ${e.message}` });
      return { state, ledgerOut: {}, processed: [], needsDecision: false, ok: false, error: e.message };
    }
    const { now, market, ex, notes } = prep;
    if (!state) state = fresh(S.initialKRW || CONFIG.INITIAL_KRW, await fxRate(ctx.get), now);
    ex.state = state;
    state.trades = recentTrades(ctx.ledger, state.createdAt);
    const env = { ex, market, S, notes, base: state.trades.length };
    makeAgents(env);

    // 1) 지난 실행 이후 구간 재생
    const since = Math.max(state.lastTick || now, now - MAX_REPLAY_MS);
    let replayed = 0;
    if (now - since > MIN) {
      replayed = await replay(ctx.get, market, ex, S, since, now, env.log);
      if (replayed) notes.push(`지난 실행 이후 ${Math.round((now - since) / MIN)}분 구간을 1분봉으로 정산했습니다.`);
    }

    // 2) 대시보드에서 보낸 명령 처리 (id 기준 1회만)
    const done = new Set(state.doneCmds);
    const processed = [];
    for (const c of (ctx.commands && ctx.commands.queue) || []) {
      if (!c || !c.id) continue;
      processed.push(c.id);
      if (done.has(c.id)) continue;
      done.add(c.id);
      if (c.type === 'closeFut') {
        const r = ex.closeFutures(c.sym, { by: 'MANUAL', reason: '대시보드에서 수동 청산' });
        if (r.ok) env.log({ type: 'EXIT', sym: c.sym, text: `${U.base(c.sym)} 선물 수동 청산 · 실현손익 ${U.fmtSignedKRW(ex.krw(r.trade.net))}` });
      } else if (c.type === 'sellSpot') {
        const r = ex.spotSell(c.sym, { by: 'MANUAL', reason: '대시보드에서 수동 매도' });
        if (r.ok) env.log({ type: 'EXIT', sym: c.sym, text: `${U.base(c.sym)} 현물 수동 매도 · 실현손익 ${U.fmtSignedKRW(ex.krw(r.trade.net))}` });
      } else if (c.type === 'reset') {
        const krw = +c.krw > 0 ? +c.krw : CONFIG.INITIAL_KRW;
        const doneCmds = [...done];
        state = fresh(krw, await fxRate(ctx.get), Date.now());
        state.doneCmds = doneCmds;
        ex.state = state;
        env.base = 0;
        makeAgents(env);
      }
    }
    state.doneCmds = [...done].slice(-100);

    // 3) 판단
    touchBooks(market);
    env.quant.lastRun = 0;
    if (S.aiMode === 'quant') { env.quant.lastScanLog = 0; env.quant.step(false); }
    else env.quant.step(true);

    let snapshot = null;
    const needsDecision = S.aiMode === 'claude';
    if (needsDecision) {
      const snap = env.claude.snapshot(S);
      for (const m of snap.markets) m.closes_1h = market.fut[m.symbol].candles1h.slice(-48).map((c) => px(c.c));
      snapshot = {
        instructions: CLAUDE_SYSTEM + '\n\nCadence: you are called once per hour. Stops and take-profits you set are enforced minute by minute between calls, so always set them. The closes_1h / closes_15m / closes_1m series let you judge trend on several timeframes.',
        output_schema: CLAUDE_SCHEMA,
        notes,
        snapshot: snap,
      };
    }
    state.lastTick = now;
    state.tick = { at: now, ok: true, mode: S.aiMode, notes, replayedEvents: replayed, runs: (state.tick?.runs || 0) + 1, source: market.source };
    return finalize(ctx, env, { processed, needsDecision, snapshot, ok: true });
  }

  async function apply(ctx) {
    const S = settingsOf(ctx);
    const state = migrate(ctx.state);
    const { market, ex, notes } = await prepare(ctx, S);
    ex.state = state;
    state.trades = recentTrades(ctx.ledger, state.createdAt);
    const env = { ex, market, S, notes, base: state.trades.length };
    makeAgents(env);
    touchBooks(market);
    env.quant.lastRun = 0;
    env.quant.step(true);

    const d = ctx.decisions || {};
    const now = Date.now();
    env.claude.lastView = String(d.market_view || '');
    env.claude.lastError = '';
    env.claude.lastRun = now;
    env.log({ type: 'CLAUDE', text: `시장 판단: ${env.claude.lastView}` });
    const holds = [];
    for (const a of Array.isArray(d.actions) ? d.actions : []) {
      if (!a || !a.action) continue;
      if (a.action === 'HOLD') { holds.push(`${U.base(a.symbol || '')}: ${a.reason || ''}`); continue; }
      try { env.claude.execute(a, S); } catch (e) { env.log({ type: 'ERROR', text: `${a.action} 실행 오류: ${e.message}` }); }
    }
    if (holds.length) env.log({ type: 'SCAN', text: `관망 ${holds.length}건`, detail: holds.join(' / ') });
    return finalize(ctx, env, { ok: true });
  }

  return { sync, apply, monthOf, _internals: { replay, stepFut, loadMarket } };
})();
