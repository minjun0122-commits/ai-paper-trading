// 대시보드 렌더링
const TZ_SHIFT = -new Date().getTimezoneOffset() * 60; // 차트를 현지 시간으로 표시
const toChartTime = (ms) => Math.floor(ms / 1000) + TZ_SHIFT;

const ACTION_LABEL = {
  OPEN_LONG: ['롱 진입', 'long'], OPEN_SHORT: ['숏 진입', 'short'],
  CLOSE_LONG: ['롱 청산', 'neutral'], CLOSE_SHORT: ['숏 청산', 'neutral'],
  LIQUIDATION: ['강제청산', 'liq'], FUNDING: ['펀딩비', 'neutral'],
  BUY: ['매수', 'long'], SELL: ['매도', 'short'],
};
const BY_LABEL = { 'AI-QUANT': '퀀트 AI', 'AI-CLAUDE': 'Claude', SYSTEM: '시스템', MANUAL: '수동' };
const LOG_LABEL = { ENTRY: '진입', EXIT: '청산', TRAIL: '스탑조정', SCAN: '분석', CLAUDE: 'Claude', ERROR: '오류' };

class UI {
  constructor(app) {
    this.app = app;
    this.sym = CONFIG.SYMBOLS[0];
    this.mkt = 'fut';
    this.tab = 'pos';
    this.tradeFilter = 'all';
    this.priceLines = [];
    this.priceLineKey = '';
    this.markerKey = '';
    this.lastTableRender = 0;
    this.$ = (id) => document.getElementById(id);
  }

  get ex() { return this.app.ex; }
  get market() { return this.app.market; }
  get state() { return this.app.ex.state; }

  init() {
    this.$('loading').classList.add('hidden');
    this.$('main').classList.remove('hidden');
    this.buildSymTabs();
    this.bindControls();
    this.initCharts();
    this.loadChartData();
    this.renderEquityChart(true);
    this.renderAll(true);
    setInterval(() => this.renderAll(false), 1000);
  }

  // ---------- 컨트롤 ----------
  bindControls() {
    this.$('modeSeg').addEventListener('click', (e) => {
      const m = e.target.closest('button')?.dataset.mode;
      if (!m) return;
      if (m === 'claude' && !this.app.settings.claudeKey) {
        this.toast('Claude AI 모드를 쓰려면 설정에서 Anthropic API 키를 입력하세요.', 'down');
        this.openSettings();
        return;
      }
      this.app.setMode(m);
    });
    this.$('mktSeg').addEventListener('click', (e) => {
      const m = e.target.closest('button')?.dataset.m;
      if (!m) return;
      this.mkt = m;
      this.loadChartData();
      this.renderAll(true);
    });
    this.$('tblTabs').addEventListener('click', (e) => {
      const t = e.target.closest('button')?.dataset.t;
      if (!t) return;
      this.tab = t;
      this.renderTable(true);
    });
    this.$('tblBody').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const sym = b.dataset.sym;
      if (b.dataset.act === 'closeFut' || b.dataset.act === 'sellSpot') {
        this.app.command({ type: b.dataset.act, sym });
      } else if (b.dataset.act === 'view') {
        this.selectSymbol(sym, b.dataset.mkt || this.mkt);
      }
    });
    this.$('signals').addEventListener('click', (e) => {
      const row = e.target.closest('[data-sym]');
      if (row) this.selectSymbol(row.dataset.sym, 'fut');
    });
    this.$('btnSettings').addEventListener('click', () => this.openSettings());
    this.$('modal').addEventListener('click', (e) => {
      if (e.target.matches('[data-close]') || e.target === this.$('modal')) this.closeSettings();
    });
    this.$('btnSave').addEventListener('click', () => this.saveSettings());
    this.$('btnReset').addEventListener('click', () => {
      const krw = +this.$('modal').querySelector('[name=initialKRW]').value || CONFIG.INITIAL_KRW;
      if (confirm(`계좌를 초기화할까요?\n모든 포지션, 거래내역, AI 로그가 삭제되고 ${krw.toLocaleString('ko-KR')}원으로 다시 시작합니다.`)) {
        this.saveSettings(false);
        this.app.resetAccount(krw);
        this.closeSettings();
      }
    });
    this.$('btnExport').addEventListener('click', () => {
      this.download(`ai-paper-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(this.state), 'application/json');
    });
    this.$('fileImport').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const s = JSON.parse(await f.text());
        if (!s || typeof s.cash !== 'number' || !Array.isArray(s.trades)) throw new Error('형식 오류');
        if (confirm('현재 계좌를 백업 파일로 덮어쓸까요?')) { this.app.loadState(s); this.closeSettings(); }
      } catch (err) { alert('백업 파일을 읽을 수 없습니다: ' + err.message); }
      e.target.value = '';
    });
  }

  selectSymbol(sym, mkt) {
    this.sym = sym;
    if (mkt) this.mkt = mkt;
    this.loadChartData();
    this.renderAll(true);
  }

  buildSymTabs() {
    this.$('symTabs').innerHTML = CONFIG.SYMBOLS.map((s) => `<button data-s="${s}">${U.base(s)}<span class="chg" data-chg="${s}"></span></button>`).join('');
    this.$('symTabs').addEventListener('click', (e) => {
      const s = e.target.closest('button')?.dataset.s;
      if (s) this.selectSymbol(s);
    });
  }

  openSettings() {
    const S = this.app.settings;
    const f = this.$('modal');
    for (const el of f.querySelectorAll('[name]')) {
      if (el.type === 'checkbox') el.checked = !!S[el.name];
      else el.value = S[el.name] ?? '';
    }
    const st = this.state;
    this.$('acctInfo').textContent = `현재 계좌: ${new Date(st.createdAt).toLocaleString('ko-KR')} 개설 · 초기자본 ${U.fmtKRW(st.initialKRW)} (= ${U.fmtNum(st.initialUSDT)} USDT, 환율 ${U.fmtNum(st.fxRate, 1)}원 고정). 초기 자본 변경은 '계좌 초기화' 시 적용됩니다.`;
    f.classList.remove('hidden');
  }
  closeSettings() { this.$('modal').classList.add('hidden'); }
  saveSettings(close = true) {
    const S = { ...this.app.settings };
    for (const el of this.$('modal').querySelectorAll('[name]')) {
      if (el.type === 'checkbox') S[el.name] = el.checked;
      else if (el.type === 'number') { const v = parseFloat(el.value); if (isFinite(v)) S[el.name] = v; }
      else S[el.name] = el.value.trim();
    }
    S.maxLeverage = U.clamp(Math.round(S.maxLeverage), 1, 50);
    S.maxPositions = U.clamp(Math.round(S.maxPositions), 1, 6);
    S.entryThreshold = U.clamp(S.entryThreshold, 0.2, 0.9);
    S.riskPct = U.clamp(S.riskPct, 0.1, 10);
    S.quantInterval = U.clamp(S.quantInterval, 5, 600);
    S.claudeInterval = U.clamp(S.claudeInterval, 1, 120);
    if (S.aiMode === 'claude' && !S.claudeKey) S.aiMode = 'quant';
    this.app.updateSettings(S);
    if (close) { this.closeSettings(); this.toast('설정을 저장했습니다.'); }
  }

  // ---------- 차트 ----------
  initCharts() {
    const LC = window.LightweightCharts;
    if (!LC) { this.$('priceChart').innerHTML = '<div class="empty">차트 라이브러리를 불러오지 못했습니다 (인터넷 연결 확인).</div>'; return; }
    const base = {
      layout: { background: { color: 'transparent' }, textColor: '#848e9c', fontFamily: 'JetBrains Mono, monospace' },
      grid: { vertLines: { color: 'rgba(43,49,57,.5)' }, horzLines: { color: 'rgba(43,49,57,.5)' } },
      rightPriceScale: { borderColor: '#2b3139' },
      timeScale: { borderColor: '#2b3139', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      autoSize: true,
    };
    this.chart = LC.createChart(this.$('priceChart'), base);
    this.candles = this.chart.addCandlestickSeries({
      upColor: '#0ecb81', downColor: '#f6465d', borderVisible: false, wickUpColor: '#0ecb81', wickDownColor: '#f6465d',
    });
    this.eqChart = LC.createChart(this.$('equityChart'), { ...base, timeScale: { ...base.timeScale, secondsVisible: false } });
    this.eqSeries = this.eqChart.addAreaSeries({
      lineColor: '#f0b90b', topColor: 'rgba(240,185,11,.28)', bottomColor: 'rgba(240,185,11,0)', lineWidth: 2,
      priceFormat: { type: 'custom', formatter: (v) => Math.round(v).toLocaleString('ko-KR') },
    });
  }

  book() { return this.mkt === 'fut' ? this.market.fut[this.sym] : this.market.spot[this.sym]; }

  loadChartData() {
    if (!this.candles) return;
    const b = this.book();
    const digits = U.priceDigits(b.price || 1);
    this.candles.applyOptions({ priceFormat: { type: 'price', precision: digits, minMove: 1 / 10 ** digits } });
    this.candles.setData(b.candles.map((c) => ({ time: toChartTime(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
    this.priceLineKey = '';
    this.markerKey = '';
    this.updateOverlays();
    this.chart.timeScale().scrollToRealTime();
  }

  onTick(kind, sym) {
    if (!this.candles || sym !== this.sym || kind !== this.mkt) return;
    const c = this.book().candles.at(-1);
    if (c) this.candles.update({ time: toChartTime(c.t), open: c.o, high: c.h, low: c.l, close: c.c });
  }

  updateOverlays() {
    if (!this.candles) return;
    const st = this.state;
    const lines = [];
    if (this.mkt === 'fut') {
      const p = st.futures[this.sym];
      if (p) {
        lines.push({ price: p.entry, color: '#3d8bfd', title: `${p.side === 'LONG' ? '롱' : '숏'} ${p.lev}x 진입` });
        if (p.sl != null) lines.push({ price: p.sl, color: '#f6465d', title: '손절', style: 2 });
        if (p.tp != null) lines.push({ price: p.tp, color: '#0ecb81', title: '익절', style: 2 });
        lines.push({ price: p.liq, color: '#ff8a00', title: '청산가', style: 1 });
      }
    } else {
      const h = st.spot[this.sym];
      if (h) {
        lines.push({ price: h.avg, color: '#3d8bfd', title: '평균단가' });
        if (h.sl != null) lines.push({ price: h.sl, color: '#f6465d', title: '손절', style: 2 });
        if (h.tp != null) lines.push({ price: h.tp, color: '#0ecb81', title: '익절', style: 2 });
      }
    }
    const key = lines.map((l) => l.title + l.price.toFixed(8)).join('|');
    if (key !== this.priceLineKey) {
      this.priceLineKey = key;
      for (const pl of this.priceLines) this.candles.removePriceLine(pl);
      this.priceLines = lines.map((l) => this.candles.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style ?? 0, axisLabelVisible: true, title: l.title }));
    }
    // 거래 마커
    const mk = this.mkt === 'fut' ? 'FUTURES' : 'SPOT';
    const first = this.book().candles[0]?.t || 0;
    const trades = st.trades.filter((t) => t.sym === this.sym && t.market === mk && t.action !== 'FUNDING' && t.time >= first);
    const mkey = `${this.sym}${mk}${trades.length}`;
    if (mkey !== this.markerKey) {
      this.markerKey = mkey;
      const markers = trades.map((t) => {
        const buyish = t.action === 'OPEN_LONG' || t.action === 'BUY' || t.action === 'CLOSE_SHORT';
        const label = ACTION_LABEL[t.action]?.[0] || t.action;
        return {
          time: toChartTime(Math.floor(t.time / 60000) * 60000),
          position: buyish ? 'belowBar' : 'aboveBar',
          color: t.action === 'LIQUIDATION' ? '#ff8a00' : buyish ? '#0ecb81' : '#f6465d',
          shape: buyish ? 'arrowUp' : 'arrowDown',
          text: t.closing ? `${label} ${t.net >= 0 ? '+' : ''}${U.fmtNum(t.net, 1)}$` : label,
        };
      }).sort((a, b) => a.time - b.time);
      this.candles.setMarkers(markers);
    }
  }

  renderEquityChart(full, point) {
    if (!this.eqSeries) return;
    const fx = this.state.fxRate;
    if (full) {
      const data = [];
      let lastT = -Infinity;
      for (const p of this.state.equity) {
        const t = p.t + TZ_SHIFT;
        if (t > lastT) { data.push({ time: t, value: p.v * fx }); lastT = t; }
      }
      this.eqSeries.setData(data);
      if (this.baseLine) this.eqSeries.removePriceLine(this.baseLine);
      this.baseLine = this.eqSeries.createPriceLine({ price: this.state.initialKRW, color: '#848e9c', lineWidth: 1, lineStyle: 2, title: '원금' });
      this.eqChart.timeScale().fitContent();
    } else if (point) {
      this.eqSeries.update({ time: point.t + TZ_SHIFT, value: point.v * fx });
    }
  }

  // ---------- 렌더 ----------
  renderAll(force) {
    this.renderStatus();
    this.renderKpis();
    this.renderSymInfo();
    this.renderSignals();
    this.updateOverlays();
    this.renderTable(force);
  }

  renderStatus() {
    const st = this.market.status;
    const cls = (v) => (v === 'live' ? 'live' : v === 'connecting' || v === 'pending' || v === 'stale' ? 'warn' : 'bad');
    const txt = { live: '연결됨', connecting: '연결 중', reconnecting: '재연결 중', pending: '대기', stale: '지연', fallback: '기본값' };
    const fx = this.market.fx;
    this.$('status').innerHTML = `
      <span><i class="dot ${cls(st.fut)}"></i>선물 WS ${txt[st.fut] || st.fut}</span>
      <span><i class="dot ${cls(st.spot)}"></i>현물 WS ${txt[st.spot] || st.spot}</span>
      <span><i class="dot ${cls(st.fx)}"></i>USDT ${U.fmtNum(fx.rate, 1)}원</span>
      ${this.engineBadge()}`;
    const mode = this.app.settings.aiMode;
    for (const b of this.$('modeSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
    for (const b of this.$('mktSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.m === this.mkt);
    for (const b of this.$('symTabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.s === this.sym);
    for (const b of this.$('tblTabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.t === this.tab);
    for (const el of this.$('symTabs').querySelectorAll('[data-chg]')) {
      const b = (this.mkt === 'fut' ? this.market.fut : this.market.spot)[el.dataset.chg];
      el.textContent = U.fmtPct(b.change24, 1);
      el.className = 'chg ' + U.cls(b.change24);
    }
  }

  engineBadge() {
    const app = this.app;
    if (app.role === 'viewer') {
      const age = Math.round((Date.now() - app.lastSync) / 1000);
      const ok = age < 10;
      return `<span title="창을 닫아도 AI는 백그라운드에서 계속 매매합니다"><i class="dot ${ok ? 'live' : 'warn'}"></i>백그라운드 AI 엔진 ${ok ? '실행 중' : `응답 대기 (${age}초)`}</span>`;
    }
    if (Sync.forced) return '<span><i class="dot live"></i>백그라운드 엔진</span>';
    return `<span title="start.bat 으로 실행하면 창을 닫아도 AI가 계속 매매합니다"><i class="dot warn"></i>이 창에서 AI 실행 중 (창을 닫으면 정지)</span>`;
  }

  renderKpis() {
    const sum = this.ex.summary();
    const st = this.state;
    const k = (v) => this.ex.krw(v);
    const pnl = sum.equity - st.initialUSDT;
    const upnl = sum.futUpnl + sum.spotUpnl;
    const items = [
      { k: '총 자산 (평가액)', v: U.fmtKRW(k(sum.equity)), s: `${U.fmtNum(sum.equity)} USDT`, main: true },
      { k: '총 손익 / 수익률', v: `<span class="${U.cls(pnl)}">${U.fmtSignedKRW(k(pnl))}</span>`, s: `<span class="${U.cls(pnl)}">${U.fmtPct(sum.returnPct)}</span> · 원금 ${U.fmtKRW(st.initialKRW)}` },
      { k: '실현 손익', v: `<span class="${U.cls(sum.realized)}">${U.fmtSignedKRW(k(sum.realized))}</span>`, s: `수수료 ${U.fmtKRW(k(sum.fees))} · 펀딩 ${U.fmtSignedKRW(k(sum.fundingTotal))}` },
      { k: '미실현 손익', v: `<span class="${U.cls(upnl)}">${U.fmtSignedKRW(k(upnl))}</span>`, s: `선물 ${U.fmtSignedKRW(k(sum.futUpnl))} · 현물 ${U.fmtSignedKRW(k(sum.spotUpnl))}` },
      { k: '가용 현금 / 사용 증거금', v: U.fmtKRW(k(sum.cash)), s: `증거금 ${U.fmtKRW(k(sum.futMargin))} · 현물 ${U.fmtKRW(k(sum.spotValue))}` },
      { k: '승률 (청산 기준)', v: sum.closes ? `${(sum.winRate * 100).toFixed(1)}%` : '-', s: `${sum.wins}승 ${sum.closes - sum.wins}패 · 총 ${st.trades.length}건` },
    ];
    this.$('kpis').innerHTML = items.map((i) => `<div class="kpi ${i.main ? 'main' : ''}"><div class="k">${i.k}</div><div class="v">${i.v}</div><div class="s">${i.s}</div></div>`).join('');
    const start = new Date(st.createdAt);
    this.$('eqInfo').textContent = `${start.toLocaleDateString('ko-KR')} 시작 · ${U.fmtDuration(Date.now() - st.createdAt)} 경과`;
  }

  renderSymInfo() {
    const b = this.book();
    const f = this.market.fut[this.sym];
    let html = `<span class="big ${U.cls(b.change24)}">${U.fmtPrice(b.price)}</span>
      <span class="item">24h<b class="${U.cls(b.change24)}">${U.fmtPct(b.change24)}</b></span>
      <span class="item">24h 거래대금<b>${U.fmtNum(b.vol24 / 1e6, 1)}M</b></span>
      <span class="item">원화<b>${U.fmtKRW(b.price * this.market.fx.rate)}</b></span>`;
    if (this.mkt === 'fut') {
      const left = Math.max(0, f.nextFunding - Date.now());
      html += `<span class="item">마크<b>${U.fmtPrice(f.mark)}</b></span>
        <span class="item">펀딩비<b class="${U.cls(f.funding)}">${(f.funding * 100).toFixed(4)}%</b></span>
        <span class="item">다음 펀딩<b>${String(Math.floor(left / 3600000)).padStart(2, '0')}:${String(Math.floor(left / 60000) % 60).padStart(2, '0')}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}</b></span>`;
    }
    this.$('symInfo').innerHTML = html;
  }

  renderSignals() {
    const S = this.app.settings;
    const sigs = this.app.quant.signals;
    const th = S.entryThreshold;
    const view = this.$('aiView');
    if (S.aiMode === 'claude') {
      const c = this.app.claude;
      const next = c.info.busy ? '분석 중…' : `다음 판단까지 ${Math.ceil(c.nextRunIn() / 1000)}초`;
      this.$('aiStatus').textContent = `Claude · ${next}`;
      view.classList.remove('hidden');
      view.innerHTML = c.lastError ? `<span class="down">오류: ${U.esc(c.lastError)}</span>` : (c.lastView ? `<b>Claude 시장 판단</b><br>${U.esc(c.lastView)}` : 'Claude의 첫 판단을 기다리는 중…');
    } else {
      view.classList.add('hidden');
      this.$('aiStatus').textContent = S.aiMode === 'off' ? 'AI 정지됨 (손절/익절은 계속 작동)' : `퀀트 AI 작동 중 · ${S.quantInterval}초 주기`;
    }
    this.$('signals').innerHTML = CONFIG.SYMBOLS.map((sym) => {
      const g = sigs[sym];
      if (!g) return `<div class="sig" data-sym="${sym}"><span class="name">${U.base(sym)}</span><span class="muted">데이터 수집 중</span><span></span></div>`;
      const w = Math.abs(g.score) * 50;
      const left = g.score >= 0 ? 50 : 50 - w;
      const color = g.score >= 0 ? 'var(--up)' : 'var(--down)';
      const hint = g.conf >= th ? (g.score > 0 ? '롱 신호' : '숏 신호') : '관망';
      return `<div class="sig" data-sym="${sym}" title="클릭하면 차트로 이동">
        <span class="name">${U.base(sym)}</span>
        <div class="bar"><div class="th" style="left:${50 - th * 50}%"></div><div class="th" style="left:${50 + th * 50}%"></div><div class="mid"></div><div class="fill" style="left:${left}%;width:${w}%;background:${color}"></div></div>
        <span class="score ${U.cls(g.score)}">${g.score >= 0 ? '+' : ''}${g.score.toFixed(2)}</span>
        <span class="meta">${hint} · 추세 ${g.trend.toFixed(2)} · RSI ${g.rsi.toFixed(0)} · 변동성 ${(g.volPct * 100).toFixed(2)}%</span>
      </div>`;
    }).join('');
  }

  renderTable(force) {
    const now = Date.now();
    if (!force && now - this.lastTableRender < 1000) return;
    this.lastTableRender = now;
    const st = this.state;
    this.$('cntPos').textContent = Object.keys(st.futures).length;
    this.$('cntSpot').textContent = Object.keys(st.spot).length;
    this.$('cntTrades').textContent = st.trades.length;
    // 사용자가 스크롤 중인 거래내역/로그는 강제 갱신 시에만 다시 그림
    if (!force && (this.tab === 'trades' || this.tab === 'ai') && this.$('tblBody').scrollTop > 0) return;
    const fn = { pos: 'tblPositions', spot: 'tblSpot', trades: 'tblTrades', ai: 'tblLog' }[this.tab];
    this[fn]();
  }

  tblPositions() {
    this.$('tblTools').innerHTML = '';
    const rows = Object.values(this.state.futures);
    if (!rows.length) { this.$('tblBody').innerHTML = '<div class="empty">보유 중인 선물 포지션이 없습니다. AI가 기회를 찾는 중입니다.</div>'; return; }
    const k = (v) => this.ex.krw(v);
    this.$('tblBody').innerHTML = `<table><thead><tr>
      <th>심볼</th><th>방향</th><th class="r">수량</th><th class="r">진입가</th><th class="r">마크가</th><th class="r">청산가</th>
      <th class="r">증거금</th><th class="r">미실현손익 (ROE)</th><th class="r">손절 / 익절</th><th>보유</th><th>주체</th><th></th></tr></thead><tbody>
      ${rows.map((p) => {
        const u = this.ex.upnl(p);
        return `<tr>
          <td><b>${U.base(p.sym)}</b>USDT <span class="muted small">Perp</span></td>
          <td><span class="tag ${p.side === 'LONG' ? 'long' : 'short'}">${p.side === 'LONG' ? '롱' : '숏'} ${p.lev}x</span></td>
          <td class="r num">${U.fmtQty(p.qty)}</td>
          <td class="r num">${U.fmtPrice(p.entry)}</td>
          <td class="r num">${U.fmtPrice(this.ex.markPrice(p.sym))}</td>
          <td class="r num" style="color:#ff8a00">${U.fmtPrice(p.liq)}</td>
          <td class="r num">${U.fmtKRW(k(p.margin))}</td>
          <td class="r num ${U.cls(u)}">${U.fmtSignedKRW(k(u))}<br><span class="small">${U.fmtPct(u / p.margin)}</span></td>
          <td class="r num"><span class="down">${U.fmtPrice(p.sl)}</span><br><span class="up">${U.fmtPrice(p.tp)}</span></td>
          <td>${U.fmtDuration(Date.now() - p.openedAt)}</td>
          <td><span class="tag by">${BY_LABEL[p.by] || p.by}</span></td>
          <td><button class="btn xs" data-act="view" data-sym="${p.sym}" data-mkt="fut">차트</button> <button class="btn xs danger" data-act="closeFut" data-sym="${p.sym}">청산</button></td>
        </tr>`;
      }).join('')}</tbody></table>`;
  }

  tblSpot() {
    this.$('tblTools').innerHTML = '';
    const rows = Object.entries(this.state.spot);
    if (!rows.length) { this.$('tblBody').innerHTML = '<div class="empty">보유 중인 현물이 없습니다.</div>'; return; }
    const k = (v) => this.ex.krw(v);
    this.$('tblBody').innerHTML = `<table><thead><tr>
      <th>자산</th><th class="r">수량</th><th class="r">평균단가</th><th class="r">현재가</th><th class="r">평가금액</th><th class="r">평가손익</th>
      <th class="r">손절 / 익절</th><th>보유</th><th>주체</th><th></th></tr></thead><tbody>
      ${rows.map(([sym, h]) => {
        const px = this.ex.spotPrice(sym);
        const u = (px - h.avg) * h.qty;
        return `<tr>
          <td><b>${U.base(sym)}</b> <span class="muted small">현물</span></td>
          <td class="r num">${U.fmtQty(h.qty)}</td>
          <td class="r num">${U.fmtPrice(h.avg)}</td>
          <td class="r num">${U.fmtPrice(px)}</td>
          <td class="r num">${U.fmtKRW(k(px * h.qty))}</td>
          <td class="r num ${U.cls(u)}">${U.fmtSignedKRW(k(u))}<br><span class="small">${U.fmtPct(px / h.avg - 1)}</span></td>
          <td class="r num"><span class="down">${U.fmtPrice(h.sl)}</span><br><span class="up">${U.fmtPrice(h.tp)}</span></td>
          <td>${U.fmtDuration(Date.now() - h.openedAt)}</td>
          <td><span class="tag by">${BY_LABEL[h.by] || h.by}</span></td>
          <td><button class="btn xs" data-act="view" data-sym="${sym}" data-mkt="spot">차트</button> <button class="btn xs danger" data-act="sellSpot" data-sym="${sym}">매도</button></td>
        </tr>`;
      }).join('')}</tbody></table>`;
  }

  tblTrades() {
    const tools = this.$('tblTools');
    if (!tools.querySelector('#tradeFilter')) {
      tools.innerHTML = `<select id="tradeFilter">
          <option value="all">전체</option><option value="FUTURES">선물</option><option value="SPOT">현물</option><option value="closing">청산/매도만</option>
        </select><button class="btn xs" id="btnCsv">CSV 내보내기</button>`;
      tools.querySelector('#tradeFilter').value = this.tradeFilter;
      tools.querySelector('#tradeFilter').addEventListener('change', (e) => { this.tradeFilter = e.target.value; this.renderTable(true); });
      tools.querySelector('#btnCsv').addEventListener('click', () => this.exportCsv());
    }
    const f = this.tradeFilter;
    const rows = this.state.trades.filter((t) => f === 'all' || (f === 'closing' ? t.closing : t.market === f)).slice(-300).reverse();
    if (!rows.length) { this.$('tblBody').innerHTML = '<div class="empty">아직 거래내역이 없습니다.</div>'; return; }
    const k = (v) => this.ex.krw(v);
    this.$('tblBody').innerHTML = `<table><thead><tr>
      <th>시간</th><th>시장</th><th>심볼</th><th>구분</th><th class="r">가격</th><th class="r">수량</th><th class="r">거래금액</th>
      <th class="r">수수료</th><th class="r">순손익</th><th>주체</th><th>AI 판단 근거</th></tr></thead><tbody>
      ${rows.map((t) => {
        const [label, cls] = ACTION_LABEL[t.action] || [t.action, 'neutral'];
        const lev = t.lev ? ` ${t.lev}x` : '';
        const pnl = t.closing ? `<span class="${U.cls(t.net)}">${U.fmtSignedKRW(k(t.net))}<br><span class="small">${U.fmtPct(t.roe)}</span></span>`
          : t.action === 'FUNDING' ? `<span class="${U.cls(t.amount)}">${U.fmtSignedKRW(k(t.amount))}</span>` : '-';
        return `<tr>
          <td class="num small">${U.fmtTime(t.time)}</td>
          <td>${t.market === 'FUTURES' ? '선물' : '현물'}</td>
          <td><b>${U.base(t.sym)}</b></td>
          <td><span class="tag ${cls}">${label}${t.market === 'FUTURES' && t.action !== 'FUNDING' ? lev : ''}</span></td>
          <td class="r num">${U.fmtPrice(t.price)}</td>
          <td class="r num">${U.fmtQty(t.qty)}</td>
          <td class="r num">${t.notional ? U.fmtKRW(k(t.notional)) : '-'}</td>
          <td class="r num">${t.fee ? U.fmtKRW(k(t.fee)) : '-'}</td>
          <td class="r num">${pnl}</td>
          <td><span class="tag by">${BY_LABEL[t.by] || t.by}</span></td>
          <td class="reason">${U.esc(t.reason)}</td>
        </tr>`;
      }).join('')}</tbody></table>
      ${this.state.trades.length > 300 ? '<div class="empty small">최근 300건 표시 · 전체 내역은 CSV로 내보내세요.</div>' : ''}`;
  }

  tblLog() {
    this.$('tblTools').innerHTML = '';
    const rows = this.state.aiLog.slice(-300).reverse();
    if (!rows.length) { this.$('tblBody').innerHTML = '<div class="empty">AI 판단 기록이 아직 없습니다.</div>'; return; }
    this.$('tblBody').innerHTML = `<div class="log">${rows.map((l) => `
      <div class="row">
        <span class="t">${U.fmtTime(l.t)}</span>
        <span class="lt ${l.type}">${LOG_LABEL[l.type] || l.type}</span>
        <div>${U.esc(l.text)}${l.detail ? `<div class="d">${U.esc(l.detail)}</div>` : ''}</div>
      </div>`).join('')}</div>`;
  }

  exportCsv() {
    const k = (v) => (v == null ? '' : Math.round(this.ex.krw(v)));
    const head = ['시간', '시장', '심볼', '구분', '레버리지', '가격(USDT)', '수량', '거래금액(원)', '수수료(원)', '순손익(원)', 'ROE', '주체', '근거'];
    const lines = [head.join(',')];
    for (const t of this.state.trades) {
      lines.push([
        new Date(t.time).toLocaleString('ko-KR'), t.market === 'FUTURES' ? '선물' : '현물', t.sym, ACTION_LABEL[t.action]?.[0] || t.action,
        t.lev || '', t.price, t.qty, k(t.notional), k(t.fee), t.closing ? k(t.net) : t.action === 'FUNDING' ? k(t.amount) : '',
        t.closing ? (t.roe * 100).toFixed(2) + '%' : '', BY_LABEL[t.by] || t.by, `"${String(t.reason || '').replace(/"/g, '""')}"`,
      ].join(','));
    }
    this.download(`거래내역-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + lines.join('\n'), 'text/csv');
  }

  download(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = text;
    this.$('toasts').appendChild(el);
    setTimeout(() => el.remove(), 6000);
    while (this.$('toasts').children.length > 4) this.$('toasts').firstChild.remove();
  }

  onTrade(t) {
    const [label] = ACTION_LABEL[t.action] || [t.action];
    let msg = `${U.base(t.sym)} ${t.market === 'FUTURES' ? '선물' : '현물'} ${label}${t.lev && t.market === 'FUTURES' ? ' ' + t.lev + 'x' : ''} @ ${U.fmtPrice(t.price)}`;
    let kind = '';
    if (t.closing) { msg += ` · ${U.fmtSignedKRW(this.ex.krw(t.net))}`; kind = t.net >= 0 ? 'up' : 'down'; }
    if (t.action !== 'FUNDING') this.toast(msg, kind);
    this.markerKey = '';
  }
}
