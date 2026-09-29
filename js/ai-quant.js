// 퀀트 AI 트레이더: 멀티 타임프레임 지표를 점수화해 스스로 진입/청산/손절 관리
class QuantAI {
  constructor(market, ex, getSettings, log) {
    this.market = market;
    this.ex = ex;
    this.getSettings = getSettings;
    this.log = log;
    this.signals = {};
    this.lastRun = 0;
    this.lastScanLog = 0;
  }

  analyze(sym) {
    const b = this.market.fut[sym];
    const cs = b.candles, c15 = b.candles15;
    if (cs.length < 60 || c15.length < 55 || !b.price) return null;
    if (b.updated != null && Date.now() - b.updated > 30_000) return null; // 실시간 시세가 끊기면 판단 보류
    const price = b.price;
    const closes = cs.map((x) => x.c);
    const ema9 = TA.ema(closes.slice(-200), 9);
    const ema21 = TA.ema(closes.slice(-200), 21);
    const atr1 = TA.atr(cs.slice(-100), 14) || price * 0.001;
    const rsi = TA.rsi(closes.slice(-150), 14);
    const m = TA.macd(closes.slice(-200));
    const bb = TA.bollinger(closes, 20, 2);
    const roc = TA.roc(closes, 10);
    const vols = cs.map((x) => x.v);
    const volRatio = TA.avg(vols.slice(-6, -1)) / (TA.avg(vols.slice(-51, -1)) || 1);

    const cl15 = c15.map((x) => x.c);
    const e20s = TA.emaSeries(cl15, 20);
    const e20 = e20s[e20s.length - 1];
    const e50 = TA.ema(cl15, 50);
    const atr15 = TA.atr(c15.slice(-100), 14) || atr1 * 4;
    const slope = (e20 - e20s[e20s.length - 4]) / atr15;

    // 각 요소를 -1 ~ +1 로 정규화 (+ 는 상승, - 는 하락 신호)
    const trend = U.clamp(((e20 - e50) / atr15) * 0.5 + slope * 0.5, -1, 1);
    const cross = U.clamp((ema9 - ema21) / (atr1 * 1.5), -1, 1);
    const macdS = U.clamp(m.hist / (atr1 * 0.3), -1, 1);
    let rsiS;
    if (rsi >= 70) rsiS = -U.clamp((rsi - 70) / 15, 0, 1);
    else if (rsi <= 30) rsiS = U.clamp((30 - rsi) / 15, 0, 1);
    else rsiS = (rsi - 50) / 40;
    let bbS = 0;
    if (bb.pctB > 1 && volRatio > 1.5) bbS = 0.8;          // 거래량 동반 상단 돌파
    else if (bb.pctB < 0 && volRatio > 1.5) bbS = -0.8;    // 거래량 동반 하단 이탈
    else if (bb.pctB > 1.05) bbS = -0.3;                   // 거래량 없는 과열
    else if (bb.pctB < -0.05) bbS = 0.3;
    const rocS = U.clamp(roc / ((atr1 / price) * 4), -1, 1);

    let score = 0.30 * trend + 0.20 * cross + 0.15 * macdS + 0.15 * rsiS + 0.10 * bbS + 0.10 * rocS;
    if (Math.sign(trend) !== Math.sign(cross) && Math.abs(trend) > 0.2) score *= 0.7; // 추세-단기 불일치 페널티
    score = U.clamp(score, -1, 1);

    return {
      sym, price, score, conf: Math.abs(score), trend, cross, macdS, rsiS, bbS, rocS,
      rsi, atr1, atr15, volPct: atr15 / price, volRatio, pctB: bb.pctB, macdHist: m.hist, roc,
      funding: b.funding, t: Date.now(),
    };
  }

  explain(g) {
    const parts = [];
    parts.push(`15분봉 추세 ${g.trend > 0.2 ? '상승' : g.trend < -0.2 ? '하락' : '횡보'}(${g.trend.toFixed(2)})`);
    parts.push(`1분봉 EMA9/21 ${g.cross > 0 ? '골든' : '데드'}크로스(${g.cross.toFixed(2)})`);
    parts.push(`MACD 히스토그램 ${g.macdHist > 0 ? '양(+)' : '음(−)'}`);
    parts.push(`RSI ${g.rsi.toFixed(1)}${g.rsi >= 70 ? ' 과매수' : g.rsi <= 30 ? ' 과매도' : ''}`);
    parts.push(`볼린저 %B ${g.pctB.toFixed(2)} · 거래량 ${g.volRatio.toFixed(1)}배`);
    return parts.join(' · ');
  }

  // readOnly: 대시보드(뷰어)에서 시그널 표시용으로만 계산하고 매매는 하지 않음
  step(readOnly = false) {
    const S = this.getSettings();
    const now = Date.now();
    if (now - this.lastRun < S.quantInterval * 1000) return;
    this.lastRun = now;
    for (const sym of this.market.symbols) {
      const g = this.analyze(sym);
      if (g) this.signals[sym] = g;
      else delete this.signals[sym];
    }
    if (readOnly || S.aiMode === 'off') return;
    this.manage(S);
    if (S.aiMode === 'quant') {
      this.entries(S);
      if (now - this.lastScanLog > 10 * 60_000 && Object.keys(this.signals).length) {
        this.lastScanLog = now;
        const top = Object.values(this.signals).sort((a, b) => b.conf - a.conf).slice(0, 3)
          .map((g) => `${U.base(g.sym)} ${g.score >= 0 ? '+' : ''}${g.score.toFixed(2)}`).join(', ');
        this.log({ type: 'SCAN', text: `시장 스캔 완료 — 신호 상위: ${top} (진입 기준 ±${S.entryThreshold})` });
      }
    }
  }

  // 보유 포지션 관리: 본전 스탑 → 트레일링 스탑, 신호 반전/시간 청산
  manage(S) {
    const s = this.ex.state;
    const now = Date.now();
    for (const p of Object.values(s.futures)) {
      const price = this.ex.futPrice(p.sym);
      if (!price) continue;
      const long = p.side === 'LONG';
      const R = Math.abs(p.entry - (p.initSl ?? p.entry * (long ? 0.99 : 1.01))) || p.entry * 0.01;
      const fav = long ? price - p.entry : p.entry - price;
      const r = fav / R;
      p.peak = long ? Math.max(p.peak, price) : Math.min(p.peak, price);
      let newSl = p.sl ?? (long ? -Infinity : Infinity);
      if (r >= 1) newSl = long ? Math.max(newSl, p.entry * 1.0012) : Math.min(newSl, p.entry * 0.9988);
      if (r >= 1.5) {
        const trail = long ? p.peak - R : p.peak + R;
        newSl = long ? Math.max(newSl, trail) : Math.min(newSl, trail);
      }
      if (isFinite(newSl) && newSl !== p.sl && (p.sl == null || Math.abs(newSl - p.sl) > R * 0.1)) {
        const old = p.sl;
        p.sl = newSl;
        this.log({ type: 'TRAIL', sym: p.sym, text: `${U.base(p.sym)} ${long ? '롱' : '숏'} 손절가 상향 조정 ${U.fmtPrice(old)} → ${U.fmtPrice(newSl)} (수익 ${r.toFixed(1)}R, 이익 보호)` });
      }

      if (S.aiMode !== 'quant') continue;
      const g = this.signals[p.sym];
      if (!g) continue;
      if ((long && g.score <= -0.35) || (!long && g.score >= 0.35)) {
        const res = this.ex.closeFutures(p.sym, { by: 'AI-QUANT', reason: `신호 반전 청산 (점수 ${g.score.toFixed(2)}) — ${this.explain(g)}` });
        if (res.ok) this.log({ type: 'EXIT', sym: p.sym, text: `${U.base(p.sym)} ${long ? '롱' : '숏'} 청산: 신호가 반대로 전환(${g.score.toFixed(2)}). 실현손익 ${U.fmtSignedKRW(this.ex.krw(res.trade.net))}` });
      } else if (now - p.openedAt > 4 * 3600_000 && r < 0.3) {
        const res = this.ex.closeFutures(p.sym, { by: 'AI-QUANT', reason: '4시간 경과, 추세 미전개로 시간 청산' });
        if (res.ok) this.log({ type: 'EXIT', sym: p.sym, text: `${U.base(p.sym)} 시간 청산: 4시간 동안 목표 방향으로 움직이지 않음. 실현손익 ${U.fmtSignedKRW(this.ex.krw(res.trade.net))}` });
      }
    }
    if (S.aiMode === 'quant') {
      for (const sym of Object.keys(s.spot)) {
        const g = this.signals[sym];
        if (g && g.score <= -0.3) {
          const res = this.ex.spotSell(sym, { by: 'AI-QUANT', reason: `현물 매도: 하락 신호(${g.score.toFixed(2)}) — ${this.explain(g)}` });
          if (res.ok) this.log({ type: 'EXIT', sym, text: `${U.base(sym)} 현물 전량 매도: 하락 전환 감지. 실현손익 ${U.fmtSignedKRW(this.ex.krw(res.trade.net))}` });
        }
      }
    }
  }

  entries(S) {
    const s = this.ex.state;
    const now = Date.now();
    const cands = Object.values(this.signals).filter((g) => now - g.t < 60_000).sort((a, b) => b.conf - a.conf);
    for (const g of cands) {
      const sum = this.ex.summary();
      const eq = sum.equity;
      const sym = g.sym;
      const openCount = Object.keys(s.futures).length;

      if (g.conf >= S.entryThreshold && !s.futures[sym] && openCount < S.maxPositions && now - (s.lastCloseAt[sym] || 0) > 180_000) {
        const side = g.score > 0 ? 'LONG' : 'SHORT';
        const span = Math.max(0.01, 1 - S.entryThreshold);
        let lev = Math.round(2 + ((Math.min(g.conf, 1) - S.entryThreshold) / span) * (S.maxLeverage - 2));
        lev = U.clamp(lev, 1, S.maxLeverage);
        if (g.volPct > 0.02) lev = Math.min(lev, 3);
        else if (g.volPct > 0.01) lev = Math.min(lev, 5);
        const price = g.price;
        const stopDist = Math.max(2 * g.atr1, 0.8 * g.atr15, price * 0.003);
        const risk = eq * S.riskPct / 100;
        let margin = (risk / stopDist) * price / lev;
        margin = Math.min(margin, eq * 0.25, eq * 0.7 - sum.futMargin, sum.cash * 0.95);
        if (margin < 10) continue;
        const sl = side === 'LONG' ? price - stopDist : price + stopDist;
        const tp = side === 'LONG' ? price + stopDist * 2.2 : price - stopDist * 2.2;
        const why = this.explain(g);
        const res = this.ex.openFutures(sym, side, margin, lev, { sl, tp, by: 'AI-QUANT', reason: `신뢰도 ${(g.conf * 100).toFixed(0)}% — ${why}` });
        if (res.ok) {
          const p = res.pos;
          this.log({
            type: 'ENTRY', sym,
            text: `${U.base(sym)} ${side === 'LONG' ? '롱' : '숏'} ${p.lev}x 진입 @ ${U.fmtPrice(p.entry)} · 증거금 ${U.fmtKRW(this.ex.krw(p.margin))} · 손절 ${U.fmtPrice(p.sl)} / 익절 ${U.fmtPrice(p.tp)} (손익비 1:2.2)`,
            detail: `신뢰도 ${(g.conf * 100).toFixed(0)}% · ${why} · 거래당 리스크 ${S.riskPct}% · 변동성(ATR15m) ${(g.volPct * 100).toFixed(2)}%`,
          });
        }
      } else if (S.spotEnabled && g.score >= 0.25 && g.score < S.entryThreshold && g.trend > 0.4 && !s.spot[sym]
        && Object.keys(s.spot).length < 3 && now - (s.lastCloseAt['spot:' + sym] || 0) > 600_000) {
        const sp = this.ex.spotPrice(sym);
        const amount = eq * 0.08;
        if (amount < 10 || amount > sum.cash * 0.9 || !sp) continue;
        const sl = sp - 3 * g.atr15, tp = sp + 5 * g.atr15;
        const why = this.explain(g);
        const res = this.ex.spotBuy(sym, amount, { sl, tp, by: 'AI-QUANT', reason: `완만한 상승 추세 현물 분할 매수 — ${why}` });
        if (res.ok) this.log({ type: 'ENTRY', sym, text: `${U.base(sym)} 현물 매수 ${U.fmtKRW(this.ex.krw(amount))} @ ${U.fmtPrice(sp)} · 손절 ${U.fmtPrice(sl)} / 익절 ${U.fmtPrice(tp)}`, detail: `점수 ${g.score.toFixed(2)} · ${why}` });
      }
    }
  }
}
