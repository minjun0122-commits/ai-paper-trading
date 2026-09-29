// 전역 설정 및 공용 유틸리티
const CONFIG = {
  INITIAL_KRW: 5_000_000,          // 초기 자본 500만 원
  FALLBACK_FX: 1380,               // 환율 조회 실패 시 사용할 KRW/USDT
  SYMBOLS: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'],
  FEES: { SPOT: 0.001, FUT_TAKER: 0.0005 },   // 바이낸스 기본 수수료 (현물 0.1%, 선물 테이커 0.05%)
  SLIPPAGE: 0.0002,                // 시장가 체결 슬리피지 0.02%
  MMR: 0.005,                      // 유지증거금률 (격리 마진 청산 계산용)
  MAX_CANDLES: 600,
  STORAGE_KEY: 'binance-ai-paper.state.v1',
  SETTINGS_KEY: 'binance-ai-paper.settings.v1',
  REST: { FUT: 'https://fapi.binance.com', SPOT: 'https://api.binance.com' },
  // 첫 URL이 우선, 데이터가 끊기면 다음 URL로 순환
  WS: {
    FUT: ['wss://fstream.binance.com/market/stream?streams=', 'wss://fstream.binance.com/stream?streams='],
    SPOT: ['wss://stream.binance.com:9443/stream?streams=', 'wss://data-stream.binance.vision/stream?streams='],
  },
  FX_URL: 'https://api.upbit.com/v1/ticker?markets=KRW-USDT',
  CLAUDE_URL: 'https://api.anthropic.com/v1/messages',
};

const DEFAULT_SETTINGS = {
  initialKRW: CONFIG.INITIAL_KRW,
  aiMode: 'quant',          // off | quant | claude
  riskPct: 1.5,             // 거래당 계좌 대비 최대 손실 %
  maxLeverage: 10,
  maxPositions: 4,
  entryThreshold: 0.4,      // 퀀트 AI 진입 신뢰도 임계값 (0~1)
  quantInterval: 15,        // 퀀트 AI 판단 주기 (초)
  spotEnabled: true,
  claudeKey: '',
  claudeModel: 'claude-opus-5',
  claudeInterval: 5,        // Claude 판단 주기 (분)
};

const Settings = {
  load() {
    try {
      const raw = localStorage.getItem(CONFIG.SETTINGS_KEY);
      return Object.assign({}, DEFAULT_SETTINGS, raw ? JSON.parse(raw) : {});
    } catch { return { ...DEFAULT_SETTINGS }; }
  },
  save(s) {
    try { localStorage.setItem(CONFIG.SETTINGS_KEY, JSON.stringify(s)); } catch (e) { console.warn(e); }
  },
};

const Store = {
  load() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  save(state) {
    try { localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(state)); } catch (e) { console.warn('저장 실패', e); }
  },
  clear() {
    try { localStorage.removeItem(CONFIG.STORAGE_KEY); } catch {}
  },
};

const U = {
  clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
  uid: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
  base: (sym) => sym.replace(/USDT$/, ''),
  priceDigits(p) {
    const a = Math.abs(p);
    if (a >= 1000) return 2;
    if (a >= 10) return 3;
    if (a >= 1) return 4;
    return 5;
  },
  fmtPrice(p) {
    if (p == null || !isFinite(p)) return '-';
    const d = U.priceDigits(p);
    return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  fmtNum(v, d = 2) {
    if (v == null || !isFinite(v)) return '-';
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  fmtQty(q) {
    if (q == null || !isFinite(q)) return '-';
    const d = q >= 100 ? 2 : q >= 1 ? 4 : 6;
    return q.toLocaleString('en-US', { maximumFractionDigits: d });
  },
  fmtKRW(v) {
    if (v == null || !isFinite(v)) return '-';
    return Math.round(v).toLocaleString('ko-KR') + '원';
  },
  fmtSignedKRW(v) {
    if (v == null || !isFinite(v)) return '-';
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v)).toLocaleString('ko-KR') + '원';
  },
  fmtPct(v, d = 2) {
    if (v == null || !isFinite(v)) return '-';
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(d) + '%';
  },
  fmtTime(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },
  fmtDuration(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}분`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}시간 ${m % 60}분`;
    return `${Math.floor(h / 24)}일 ${h % 24}시간`;
  },
  cls: (v) => (v > 0 ? 'up' : v < 0 ? 'down' : ''),
  esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
};
