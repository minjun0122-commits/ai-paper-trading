// 앱 부트스트랩: 시세 → 모의거래소 → AI → 대시보드 연결
//
// 역할(role)
//  - engine : AI가 실제로 매매하고 상태를 서버(data/state.json)에 저장하는 인스턴스.
//             백그라운드 헤드리스 Edge(?engine=1)가 기본 엔진이며, 엔진이 없으면 열린 창이 엔진이 됩니다.
//  - viewer : 엔진이 이미 돌고 있을 때 여는 대시보드. 상태를 받아 보여주고, 조작은 엔진에 명령으로 전달합니다.
const Sync = {
  id: U.uid(),
  forced: new URLSearchParams(location.search).has('engine'),
  available: false,

  async json(url, opts) {
    const r = await fetch(url, { cache: 'no-store', ...opts });
    return { status: r.status, body: await r.json().catch(() => null) };
  },
  async getState() { return (await this.json('/api/state')).body; },
  async putState(state) {
    const r = await fetch(`/api/state?id=${this.id}${this.forced ? '&force=1' : ''}`, { method: 'PUT', body: JSON.stringify(state) });
    return r.status;
  },
  async getSettings() { return (await this.json('/api/settings')).body; },
  putSettings(s) { return fetch('/api/settings', { method: 'PUT', body: JSON.stringify(s) }).catch(() => {}); },
  sendCmd(c) { return fetch('/api/cmd', { method: 'POST', body: JSON.stringify(c) }).catch(() => {}); },
  async takeCmds() { return (await this.json(`/api/cmd?id=${this.id}`)).body || []; },
  release() { try { navigator.sendBeacon(`/api/release?id=${this.id}`); } catch {} },
};

const App = {
  settings: Settings.load(),
  role: 'engine',
  market: null,
  ex: null,
  quant: null,
  claude: null,
  ui: null,
  lastSave: 0,
  saving: false,
  lastPoll: 0,
  polling: false,
  lastCmdPoll: 0,
  lastSettingsPoll: 0,
  lastSync: 0,
  pollFailSince: 0,

  async start() {
    this.market = new Market(CONFIG.SYMBOLS);
    this.ex = new PaperExchange(this.market);
    this.ui = new UI(this);
    await this.market.init();

    // 서버 동기화 가능 여부 확인 (start.bat 서버로 열었을 때)
    let srv = null;
    try {
      srv = await Sync.getState();
      Sync.available = !!(srv && srv.engine);
    } catch { Sync.available = false; }

    if (Sync.available) {
      try {
        const ss = await Sync.getSettings();
        if (ss) this.settings = Object.assign({}, DEFAULT_SETTINGS, ss);
        else Sync.putSettings(this.settings);
      } catch {}
    }

    const engineAlive = Sync.available && srv.engine.id && srv.engine.age >= 0 && srv.engine.age < 20_000;
    this.role = Sync.available && !Sync.forced && engineAlive && srv.state ? 'viewer' : 'engine';

    let state = (Sync.available && srv.state) || (this.role === 'engine' && !Sync.available ? Store.load() : null);
    if (!state && this.role === 'engine' && !Sync.forced) state = Store.load();
    this.ex.state = state || PaperExchange.freshState(this.settings.initialKRW, this.market.fx.rate);
    this.migrate(this.ex.state);

    const log = (e) => this.log(e);
    this.quant = new QuantAI(this.market, this.ex, () => this.settings, log);
    this.claude = new ClaudeAI(this.market, this.ex, this.quant, () => this.settings, log);

    this.ex.onChange((type, payload) => {
      if (type === 'trade') { this.ui.onTrade(payload); this.persist(true); }
    });

    this.market.on('tick', (kind, sym) => {
      if (this.role === 'engine') this.ex.onTick(kind, sym);
      this.ui.onTick(kind, sym);
      this.loop();
    });
    this.market.on('mark', (sym) => { if (this.role === 'engine') this.ex.onMark(sym); });

    // WebSocket 메시지가 끊겨도 AI/저장 루프가 돌도록 보조 타이머
    setInterval(() => this.loop(), 1000);

    if (this.role === 'engine' && !this.ex.state.aiLog.length) {
      this.log({ type: 'SCAN', text: `계좌 개설: 초기 자본 ${U.fmtKRW(this.ex.state.initialKRW)} (${U.fmtNum(this.ex.state.initialUSDT)} USDT, 환율 ${U.fmtNum(this.ex.state.fxRate, 1)}원). AI 트레이더가 시장을 분석합니다.` });
    }
    this.quant.lastRun = 0;
    this.quant.step(this.role !== 'engine');
    this.ui.init();
    if (this.role === 'engine') this.persist(true);
    window.addEventListener('beforeunload', () => {
      if (this.role === 'engine') { Store.save(this.ex.state); if (Sync.available && !Sync.forced) Sync.release(); }
    });
  },

  migrate(s) {
    s.aiLog = s.aiLog || [];
    s.lastCloseAt = s.lastCloseAt || {};
    s.funding = s.funding || {};
    s.equity = s.equity || [];
    s.claudeInfo = s.claudeInfo || { view: '', error: '', lastRun: 0, busy: false };
  },

  loop() {
    if (!this.ex.state) return;
    const now = Date.now();
    if (this.role === 'engine') {
      this.quant.step(false);
      this.claude.maybeRun();
      const pt = this.ex.maybeSnapshot();
      if (pt) this.ui.renderEquityChart(false, pt);
      this.persist(false);
      if (Sync.available) {
        if (now - this.lastCmdPoll > 2000) { this.lastCmdPoll = now; this.pollCommands(); }
        if (now - this.lastSettingsPoll > 3000) { this.lastSettingsPoll = now; this.pollSettings(); }
      }
    } else {
      this.quant.step(true); // 시그널 표시용 계산만 (매매 없음)
      if (now - this.lastPoll > 2000) { this.lastPoll = now; this.pollState(); }
    }
  },

  log(e) {
    const s = this.ex.state;
    s.aiLog.push({ t: Date.now(), ...e });
    if (s.aiLog.length > 1000) s.aiLog.splice(0, s.aiLog.length - 1000);
  },

  persist(force) {
    if (this.role !== 'engine') return;
    const now = Date.now();
    if (!force && now - this.lastSave < 5000) return;
    this.lastSave = now;
    this.ex.state.savedAt = now;
    if (!Sync.forced) Store.save(this.ex.state);
    if (Sync.available && !this.saving) {
      this.saving = true;
      Sync.putState(this.ex.state).then((code) => {
        if (code === 200) this.lastSync = Date.now();
        if (code === 409) this.becomeViewer();
      }).catch(() => {}).finally(() => { this.saving = false; });
    }
  },

  // ---------- 엔진: 뷰어가 보낸 명령/설정 반영 ----------
  async pollCommands() {
    let cmds;
    try { cmds = await Sync.takeCmds(); } catch { return; }
    for (const c of cmds) this.execCommand(c);
  },

  execCommand(c) {
    const ex = this.ex;
    if (c.type === 'closeFut') {
      const r = ex.closeFutures(c.sym, { by: 'MANUAL', reason: '사용자 수동 청산' });
      if (r.ok) this.log({ type: 'EXIT', sym: c.sym, text: `${U.base(c.sym)} 선물 수동 청산 · 실현손익 ${U.fmtSignedKRW(ex.krw(r.trade.net))}` });
    } else if (c.type === 'sellSpot') {
      const r = ex.spotSell(c.sym, { by: 'MANUAL', reason: '사용자 수동 매도' });
      if (r.ok) this.log({ type: 'EXIT', sym: c.sym, text: `${U.base(c.sym)} 현물 수동 매도 · 실현손익 ${U.fmtSignedKRW(ex.krw(r.trade.net))}` });
    } else if (c.type === 'reset') {
      this.resetAccount(c.krw, true);
    } else if (c.type === 'load' && c.state) {
      this.loadState(c.state, true);
    }
    this.persist(true);
    this.ui.renderAll(true);
  },

  async pollSettings() {
    let ss;
    try { ss = await Sync.getSettings(); } catch { return; }
    if (!ss) return;
    const next = Object.assign({}, DEFAULT_SETTINGS, ss);
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return;
    const modeChanged = next.aiMode !== this.settings.aiMode;
    this.settings = next;
    if (!Sync.forced) Settings.save(next);
    this.quant.lastRun = 0;
    if (modeChanged) {
      this.log({ type: 'SCAN', text: this.modeLabel(next.aiMode) });
      if (next.aiMode === 'claude') this.ex.state.claudeInfo.lastRun = 0;
    }
    this.persist(true);
  },

  // ---------- 뷰어: 엔진 상태 수신 ----------
  async pollState() {
    if (this.polling) return;
    this.polling = true;
    try {
      const srv = await Sync.getState();
      const ss = await Sync.getSettings();
      if (ss) this.settings = Object.assign({}, DEFAULT_SETTINGS, ss);
      if (!srv) return;
      const alive = srv.engine.id && srv.engine.age >= 0 && srv.engine.age < 30_000;
      if (!alive) { this.becomeEngine(srv.state); return; }
      if (srv.state) {
        const prev = this.ex.state;
        this.migrate(srv.state);
        const newTrades = srv.state.trades.length > prev.trades.length ? srv.state.trades.slice(prev.trades.length) : [];
        const eqChanged = srv.state.equity.length && srv.state.equity.at(-1)?.t !== prev.equity.at(-1)?.t;
        const reset = srv.state.createdAt !== prev.createdAt;
        this.ex.state = srv.state;
        this.lastSync = Date.now();
        if (reset) { this.ui.loadChartData(); this.ui.renderEquityChart(true); }
        else if (eqChanged) this.ui.renderEquityChart(false, srv.state.equity.at(-1));
        for (const t of newTrades) this.ui.onTrade(t);
        this.ui.renderAll(newTrades.length > 0 || reset);
      }
      this.pollFailSince = 0;
    } catch {
      // 서버가 30초 이상 응답하지 않으면 이 창이 엔진 역할을 이어받음 (서버가 돌아오면 다시 동기화)
      if (!this.pollFailSince) this.pollFailSince = Date.now();
      else if (Date.now() - this.pollFailSince > 30_000) this.becomeEngine(null);
    } finally {
      this.polling = false;
    }
  },

  becomeEngine(state) {
    if (this.role === 'engine') return;
    this.role = 'engine';
    if (state) { this.migrate(state); this.ex.state = state; }
    this.log({ type: 'SCAN', text: '백그라운드 엔진이 응답하지 않아 이 창이 AI 매매를 이어받았습니다.' });
    this.quant.lastRun = 0;
    this.persist(true);
    this.ui.toast('백그라운드 엔진 없음 → 이 창에서 AI 매매를 계속합니다.', 'down');
    this.ui.renderAll(true);
  },

  becomeViewer() {
    if (this.role === 'viewer') return;
    this.role = 'viewer';
    this.ui.toast('백그라운드 엔진이 매매를 담당합니다. 이 창은 보기 전용으로 전환됩니다.');
    this.lastPoll = 0;
    this.ui.renderAll(true);
  },

  // ---------- 사용자 조작 (역할에 따라 직접 실행 또는 엔진에 전달) ----------
  command(c) {
    if (this.role === 'viewer') {
      Sync.sendCmd(c);
      this.ui.toast('요청을 백그라운드 엔진에 전달했습니다.');
      this.lastPoll = 0;
    } else {
      this.execCommand(c);
    }
  },

  modeLabel(m) {
    return { off: 'AI 매매 정지 (기존 포지션의 손절/익절은 유지)', quant: '퀀트 AI 자동매매 시작', claude: 'Claude AI 자동매매 시작' }[m];
  },

  setMode(m) {
    const prev = this.settings.aiMode;
    this.settings.aiMode = m;
    this.saveSettingsEverywhere();
    const label = this.modeLabel(m);
    if (this.role === 'engine' && prev !== m) {
      this.log({ type: 'SCAN', text: label });
      if (m === 'claude') this.ex.state.claudeInfo.lastRun = 0;
      this.quant.lastRun = 0;
    }
    this.ui.toast(label);
    this.ui.renderAll(true);
  },

  updateSettings(S) {
    this.settings = S;
    this.saveSettingsEverywhere();
    this.quant.lastRun = 0;
    this.ui.renderAll(true);
  },

  saveSettingsEverywhere() {
    Settings.save(this.settings);
    if (Sync.available) Sync.putSettings(this.settings);
  },

  resetAccount(krw, fromCmd) {
    if (this.role === 'viewer' && !fromCmd) return this.command({ type: 'reset', krw });
    this.ex.state = PaperExchange.freshState(krw, this.market.fx.rate);
    this.migrate(this.ex.state);
    this.log({ type: 'SCAN', text: `계좌 초기화: 초기 자본 ${U.fmtKRW(krw)} (${U.fmtNum(this.ex.state.initialUSDT)} USDT, 환율 ${U.fmtNum(this.ex.state.fxRate, 1)}원)` });
    this.persist(true);
    this.ui.loadChartData();
    this.ui.renderEquityChart(true);
    this.ui.renderAll(true);
  },

  loadState(s, fromCmd) {
    if (this.role === 'viewer' && !fromCmd) return this.command({ type: 'load', state: s });
    this.migrate(s);
    this.ex.state = s;
    this.persist(true);
    this.ui.loadChartData();
    this.ui.renderEquityChart(true);
    this.ui.renderAll(true);
  },
};

App.start().catch((e) => {
  console.error(e);
  document.getElementById('loading').innerHTML = `<div class="down">시작 실패: ${U.esc(e.message)}</div><div class="muted small">인터넷 연결을 확인하고 새로고침하세요.</div>`;
});
