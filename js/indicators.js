// 기술적 지표 계산
const TA = {
  avg(arr) {
    if (!arr.length) return 0;
    let s = 0;
    for (const v of arr) s += v;
    return s / arr.length;
  },

  emaSeries(values, period) {
    const k = 2 / (period + 1);
    const out = new Array(values.length);
    let prev = values[0];
    for (let i = 0; i < values.length; i++) {
      prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  },

  ema(values, period) {
    const s = TA.emaSeries(values, period);
    return s[s.length - 1];
  },

  // Wilder RSI
  rsi(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * (period - 1) + Math.max(d, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    }
    if (loss === 0) return 100;
    return 100 - 100 / (1 + gain / loss);
  },

  macd(closes, fast = 12, slow = 26, signal = 9) {
    const ef = TA.emaSeries(closes, fast);
    const es = TA.emaSeries(closes, slow);
    const m = closes.map((_, i) => ef[i] - es[i]);
    const s = TA.emaSeries(m, signal);
    const n = closes.length - 1;
    return { macd: m[n], signal: s[n], hist: m[n] - s[n], prevHist: m[n - 1] - s[n - 1] };
  },

  // Wilder ATR
  atr(candles, period = 14) {
    if (candles.length < period + 1) {
      const last = candles[candles.length - 1];
      return last ? last.h - last.l : 0;
    }
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
    }
    let a = TA.avg(trs.slice(0, period));
    for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
    return a;
  },

  bollinger(closes, period = 20, k = 2) {
    const s = closes.slice(-period);
    const mean = TA.avg(s);
    const sd = Math.sqrt(TA.avg(s.map((v) => (v - mean) ** 2)));
    const upper = mean + k * sd, lower = mean - k * sd;
    const last = closes[closes.length - 1];
    return { mid: mean, upper, lower, pctB: (last - lower) / ((upper - lower) || 1), width: (upper - lower) / (mean || 1) };
  },

  roc(closes, n) {
    const a = closes[closes.length - 1 - n];
    return a ? (closes[closes.length - 1] - a) / a : 0;
  },
};
