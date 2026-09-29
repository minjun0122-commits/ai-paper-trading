// Claude AI 트레이더 (선택): 시장/계좌 스냅샷을 Claude에게 보내고 JSON 결정을 받아 실행
// API 키는 이 브라우저의 localStorage에만 저장되며 api.anthropic.com 으로만 전송됩니다.
const CLAUDE_SYSTEM = `You are an autonomous crypto trader managing a PAPER-TRADING account on Binance (spot + USDⓈ-M perpetual futures, isolated margin).
Your goal is to grow account equity over time while strictly controlling drawdowns. You act on your own; no human confirms your orders.

Each call you receive a JSON snapshot: account, open futures positions, spot holdings, recent trades, and per-symbol market data
(price, 24h change, funding rate, precomputed indicators, recent 15m and 1m closes). Decide what to do right now.

Rules:
- Only trade the listed symbols. One futures position per symbol (one-way mode). Spot is long-only.
- OPEN_LONG / OPEN_SHORT: set leverage (1..max_leverage), size_pct = margin as % of equity, stop_loss_pct and take_profit_pct as % price distance from entry.
- SPOT_BUY: size_pct = % of equity to spend. stop_loss_pct / take_profit_pct as price distance %.
- CLOSE_FUTURES / SPOT_SELL: close the whole position.
- ADJUST_STOPS: move stop/take-profit of an open futures position (percent distance from CURRENT price).
- HOLD when there is no clear edge. Doing nothing is often correct; avoid overtrading (fees are 0.05% futures, 0.1% spot per side).
- Always use a stop loss. Keep risk per trade (size_pct * leverage * stop_loss_pct / 100) near or below risk_per_trade_pct of equity.
- Fields that don't apply to an action: use 0.
- Write market_view and every reason in Korean, concise (1-2 sentences), citing the concrete evidence you used.`;

const CLAUDE_SCHEMA = {
  type: 'object',
  properties: {
    market_view: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string', enum: CONFIG.SYMBOLS },
          action: { type: 'string', enum: ['OPEN_LONG', 'OPEN_SHORT', 'CLOSE_FUTURES', 'SPOT_BUY', 'SPOT_SELL', 'ADJUST_STOPS', 'HOLD'] },
          leverage: { type: 'integer' },
          size_pct: { type: 'number' },
          stop_loss_pct: { type: 'number' },
          take_profit_pct: { type: 'number' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['symbol', 'action', 'leverage', 'size_pct', 'stop_loss_pct', 'take_profit_pct', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['market_view', 'actions'],
  additionalProperties: false,
};

class ClaudeAI {
  constructor(market, ex, quant, getSettings, log) {
    this.market = market;
    this.ex = ex;
    this.quant = quant;
    this.getSettings = getSettings;
    this.log = log;
    this.busy = false;
  }

  // 진행 상태는 계좌 상태(state.claudeInfo)에 저장해 대시보드와 공유
  get info() {
    const s = this.ex.state;
    if (!s.claudeInfo) s.claudeInfo = { view: '', error: '', lastRun: 0, busy: false };
    return s.claudeInfo;
  }
  get lastRun() { return this.info.lastRun; }
  set lastRun(v) { this.info.lastRun = v; }
  get lastView() { return this.info.view; }
  set lastView(v) { this.info.view = v; }
  get lastError() { return this.info.error; }
  set lastError(v) { this.info.error = v; }

  nextRunIn() {
    const S = this.getSettings();
    return Math.max(0, this.lastRun + S.claudeInterval * 60_000 - Date.now());
  }

  maybeRun() {
    const S = this.getSettings();
    if (S.aiMode !== 'claude' || !S.claudeKey || this.busy) return;
    if (this.market.status.fut !== 'live') return; // 실시간 시세가 없으면 판단 보류
    if (Date.now() - this.lastRun < S.claudeInterval * 60_000) return;
    this.run();
  }

  snapshot(S) {
    const st = this.ex.state;
    const sum = this.ex.summary();
    const r = (v, d = 4) => (v == null || !isFinite(v) ? null : +v.toFixed(d));
    const px = (v) => (v == null ? null : +v.toPrecision(7));
    return {
      time: new Date().toISOString(),
      account: {
        equity_usdt: r(sum.equity, 2), cash_usdt: r(sum.cash, 2), initial_usdt: r(st.initialUSDT, 2),
        return_pct: r(sum.returnPct * 100, 2), realized_pnl_usdt: r(sum.realized, 2), futures_margin_used_usdt: r(sum.futMargin, 2),
      },
      limits: { max_leverage: S.maxLeverage, max_futures_positions: S.maxPositions, risk_per_trade_pct: S.riskPct },
      futures_positions: Object.values(st.futures).map((p) => ({
        symbol: p.sym, side: p.side, leverage: p.lev, entry: px(p.entry), mark: px(this.ex.markPrice(p.sym)),
        margin_usdt: r(p.margin, 2), unrealized_pnl_usdt: r(this.ex.upnl(p), 2), roe_pct: r(this.ex.upnl(p) / p.margin * 100, 2),
        stop_loss: px(p.sl), take_profit: px(p.tp), liquidation: px(p.liq), held_min: Math.round((Date.now() - p.openedAt) / 60000),
      })),
      spot_holdings: Object.entries(st.spot).map(([sym, h]) => ({
        symbol: sym, qty: r(h.qty, 6), avg_price: px(h.avg), price: px(this.ex.spotPrice(sym)),
        pnl_pct: r((this.ex.spotPrice(sym) / h.avg - 1) * 100, 2), stop_loss: px(h.sl), take_profit: px(h.tp),
      })),
      recent_trades: st.trades.filter((t) => t.action !== 'FUNDING').slice(-10).map((t) => ({
        time: new Date(t.time).toISOString(), symbol: t.sym, market: t.market, action: t.action, price: px(t.price),
        net_pnl_usdt: t.closing ? r(t.net, 2) : null,
      })),
      markets: this.market.symbols.map((sym) => {
        const f = this.market.fut[sym];
        const g = this.quant.signals[sym];
        return {
          symbol: sym, price: px(f.price), change_24h_pct: r(f.change24 * 100, 2), funding_rate_pct: r(f.funding * 100, 4),
          indicators: g ? {
            quant_score: r(g.score, 3), trend_15m: r(g.trend, 3), ema_cross_1m: r(g.cross, 3), rsi_1m: r(g.rsi, 1),
            macd_1m_norm: r(g.macdS, 3), bollinger_pctB: r(g.pctB, 3), atr_1m_pct: r(g.atr1 / g.price * 100, 3),
            atr_15m_pct: r(g.volPct * 100, 3), volume_ratio: r(g.volRatio, 2),
          } : null,
          closes_15m: f.candles15.slice(-24).map((c) => px(c.c)),
          closes_1m: f.candles.slice(-30).map((c) => px(c.c)),
        };
      }),
    };
  }

  buildRequest(S, snap) {
    const model = S.claudeModel;
    const body = {
      model,
      max_tokens: 16000,
      system: CLAUDE_SYSTEM,
      messages: [{ role: 'user', content: 'Current snapshot:\n' + JSON.stringify(snap) }],
      output_config: { format: { type: 'json_schema', schema: CLAUDE_SCHEMA } },
    };
    const headers = {
      'content-type': 'application/json',
      'x-api-key': S.claudeKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    if (model !== 'claude-haiku-4-5') {
      body.thinking = { type: 'adaptive' };
      body.output_config.effort = 'medium';
    }
    if (model === 'claude-opus-5') {
      // 안전 분류기 거절 시 서버 측 대체 모델로 자동 라우팅
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      body.fallbacks = 'default';
    }
    return { headers, body };
  }

  async call(S, snap) {
    let { headers, body } = this.buildRequest(S, snap);
    let res = await fetch(CONFIG.CLAUDE_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    let data = await res.json().catch(() => ({}));
    if (!res.ok && body.fallbacks && /fallback/i.test(data?.error?.message || '')) {
      delete body.fallbacks; delete headers['anthropic-beta'];
      res = await fetch(CONFIG.CLAUDE_URL, { method: 'POST', headers, body: JSON.stringify(body) });
      data = await res.json().catch(() => ({}));
    }
    if (!res.ok) throw new Error(`API ${res.status}: ${data?.error?.message || res.statusText}`);
    if (data.stop_reason === 'refusal') throw new Error('모델이 요청을 거절했습니다 (refusal)');
    if (data.stop_reason === 'max_tokens') throw new Error('응답이 max_tokens에서 잘렸습니다');
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text);
  }

  async run() {
    const S = this.getSettings();
    this.busy = true;
    this.info.busy = true;
    this.lastRun = Date.now();
    this.log({ type: 'CLAUDE', text: `Claude(${S.claudeModel})에게 시장 분석 요청 중…` });
    try {
      const out = await this.call(S, this.snapshot(S));
      this.lastView = out.market_view || '';
      this.lastError = '';
      this.log({ type: 'CLAUDE', text: `시장 판단: ${this.lastView}` });
      const holds = [];
      for (const a of out.actions || []) {
        if (a.action === 'HOLD') { holds.push(`${U.base(a.symbol)}: ${a.reason}`); continue; }
        this.execute(a, S);
      }
      if (holds.length) this.log({ type: 'SCAN', text: `관망 ${holds.length}건`, detail: holds.join(' / ') });
    } catch (e) {
      this.lastError = e.message;
      this.log({ type: 'ERROR', text: `Claude 호출 실패: ${e.message}` });
    } finally {
      this.busy = false;
      this.info.busy = false;
    }
  }

  execute(a, S) {
    const st = this.ex.state;
    const sym = a.symbol;
    if (!CONFIG.SYMBOLS.includes(sym)) return;
    const sum = this.ex.summary();
    const eq = sum.equity;
    const reason = a.reason || '';
    const by = 'AI-CLAUDE';
    const logRes = (res, okText) => {
      if (res.ok) this.log({ type: a.action.startsWith('OPEN') || a.action === 'SPOT_BUY' ? 'ENTRY' : 'EXIT', sym, text: okText, detail: reason });
      else this.log({ type: 'ERROR', sym, text: `${U.base(sym)} ${a.action} 실행 불가: ${res.error}`, detail: reason });
    };

    switch (a.action) {
      case 'OPEN_LONG':
      case 'OPEN_SHORT': {
        const side = a.action === 'OPEN_LONG' ? 'LONG' : 'SHORT';
        if (st.futures[sym]) return logRes({ ok: false, error: '이미 포지션 보유' });
        if (Object.keys(st.futures).length >= S.maxPositions) return logRes({ ok: false, error: '최대 동시 포지션 초과' });
        const lev = U.clamp(Math.round(a.leverage || 1), 1, S.maxLeverage);
        const slPct = U.clamp(a.stop_loss_pct || 1.5, 0.3, 15) / 100;
        const tpPct = U.clamp(a.take_profit_pct || 3, 0.5, 40) / 100;
        let margin = eq * U.clamp(a.size_pct || 5, 1, 25) / 100;
        // 리스크 가드: 손실 한도(거래당 리스크 %의 1.5배) 초과 시 증거금 축소
        const maxLoss = eq * S.riskPct * 1.5 / 100;
        margin = Math.min(margin, maxLoss / (lev * slPct), eq * 0.7 - sum.futMargin);
        const price = this.ex.futPrice(sym);
        const sl = side === 'LONG' ? price * (1 - slPct) : price * (1 + slPct);
        const tp = side === 'LONG' ? price * (1 + tpPct) : price * (1 - tpPct);
        const res = this.ex.openFutures(sym, side, margin, lev, { sl, tp, by, reason });
        return logRes(res, res.ok ? `${U.base(sym)} ${side === 'LONG' ? '롱' : '숏'} ${res.pos.lev}x 진입 @ ${U.fmtPrice(res.pos.entry)} · 증거금 ${U.fmtKRW(this.ex.krw(res.pos.margin))} · 손절 ${U.fmtPrice(res.pos.sl)} / 익절 ${U.fmtPrice(res.pos.tp)}` : '');
      }
      case 'CLOSE_FUTURES': {
        const res = this.ex.closeFutures(sym, { by, reason });
        return logRes(res, res.ok ? `${U.base(sym)} 선물 청산 · 실현손익 ${U.fmtSignedKRW(this.ex.krw(res.trade.net))}` : '');
      }
      case 'SPOT_BUY': {
        const amount = eq * U.clamp(a.size_pct || 5, 1, 20) / 100;
        const price = this.ex.spotPrice(sym);
        const sl = price * (1 - U.clamp(a.stop_loss_pct || 3, 0.5, 20) / 100);
        const tp = price * (1 + U.clamp(a.take_profit_pct || 6, 0.5, 50) / 100);
        const res = this.ex.spotBuy(sym, amount, { sl, tp, by, reason });
        return logRes(res, `${U.base(sym)} 현물 매수 ${U.fmtKRW(this.ex.krw(amount))} @ ${U.fmtPrice(price)}`);
      }
      case 'SPOT_SELL': {
        const res = this.ex.spotSell(sym, { by, reason });
        return logRes(res, res.ok ? `${U.base(sym)} 현물 매도 · 실현손익 ${U.fmtSignedKRW(this.ex.krw(res.trade.net))}` : '');
      }
      case 'ADJUST_STOPS': {
        const p = st.futures[sym];
        if (!p) return logRes({ ok: false, error: '포지션 없음' });
        const price = this.ex.futPrice(sym);
        const long = p.side === 'LONG';
        const sl = a.stop_loss_pct > 0 ? price * (long ? 1 - a.stop_loss_pct / 100 : 1 + a.stop_loss_pct / 100) : null;
        const tp = a.take_profit_pct > 0 ? price * (long ? 1 + a.take_profit_pct / 100 : 1 - a.take_profit_pct / 100) : null;
        this.ex.setStops(sym, { sl, tp });
        return this.log({ type: 'TRAIL', sym, text: `${U.base(sym)} 손절/익절 조정 → 손절 ${U.fmtPrice(p.sl)} / 익절 ${U.fmtPrice(p.tp)}`, detail: reason });
      }
    }
  }
}
