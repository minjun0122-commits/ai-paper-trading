#!/usr/bin/env node
// 클라우드 루틴용 실행기 (Node 22, 외부 패키지 없음)
//
//   node engine.mjs sync  <dir>   입력: <dir>/acct/state.json, control/settings.json, control/commands.json, ledger/*.json
//   node engine.mjs apply <dir>   입력: <dir>/out/* (sync 결과) + <dir>/decisions.json
//
// 출력: <dir>/out/state.json, out/ledger/<YYYY-MM>.json, out/processed_cmds.json,
//       out/snapshot.json (Claude 모드일 때 판단 자료), out/result.json (요약)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [cmd, dirArg] = process.argv.slice(2);
const dir = path.resolve(dirArg || '.');
const outDir = path.join(dir, 'out');

// 브라우저 앱과 같은 엔진 코드를 그대로 불러옴
const libs = ['config.js', 'indicators.js', 'exchange.js', 'ai-quant.js', 'ai-claude.js', 'tick-core.js'];
const bundle = libs.map((f) => fs.readFileSync(path.join(here, f), 'utf8')).join('\n;\n') + '\n;({ CloudTick })';
const { CloudTick } = vm.runInThisContext(bundle, { filename: 'engine-bundle.js' });

// 클라우드 샌드박스는 HTTPS 프록시를 거치므로 curl 로 요청 (Node fetch 는 프록시 환경변수를 따르지 않음)
function get(url) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sS', '-m', '20', '--retry', '2', '-w', '\n%{http_code}', url], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().slice(0, 160)));
      const i = stdout.lastIndexOf('\n');
      const code = +stdout.slice(i + 1);
      const body = stdout.slice(0, i);
      if (code < 200 || code >= 300) return reject(new Error(`HTTP ${code} ${url.split('?')[0].replace('https://', '')}`));
      try { resolve(JSON.parse(body)); } catch { reject(new Error(`잘못된 응답 ${url.split('?')[0]}`)); }
    });
  });
}

// ArtifactData out_dir 파일은 문서 본문이거나 {data, version,...} 래퍼일 수 있어 둘 다 처리
function readDoc(file) {
  if (!fs.existsSync(file)) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (j && typeof j === 'object' && j.data && typeof j.data === 'object' && ('version' in j || 'id' in j || 'exists' in j)) return j.data;
  return j;
}

function readLedger(ledgerDir) {
  const out = {};
  if (!fs.existsSync(ledgerDir)) return out;
  for (const f of fs.readdirSync(ledgerDir)) {
    if (!f.endsWith('.json')) continue;
    const d = readDoc(path.join(ledgerDir, f));
    if (d) out[f.replace(/\.json$/, '')] = d;
  }
  return out;
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

function writeOutputs(res, extra = {}) {
  writeJSON(path.join(outDir, 'state.json'), res.state);
  const months = [];
  for (const [m, doc] of Object.entries(res.ledgerOut || {})) {
    writeJSON(path.join(outDir, 'ledger', `${m}.json`), doc);
    months.push(m);
  }
  const s = res.state.summary || {};
  const result = {
    ok: res.ok, error: res.error || null, mode: res.state.tick?.mode, needsDecision: !!res.needsDecision,
    newTrades: res.newTrades || 0, ledgerMonths: months, notes: res.notes || [],
    equityKRW: s.equity ? Math.round(s.equity * res.state.fxRate) : null,
    returnPct: s.returnPct != null ? +(s.returnPct * 100).toFixed(2) : null,
    openFutures: Object.keys(res.state.futures || {}), spot: Object.keys(res.state.spot || {}),
    stateBytes: JSON.stringify(res.state).length,
    ...extra,
  };
  writeJSON(path.join(outDir, 'result.json'), result);
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  if (cmd === 'sync') {
    const ctx = {
      get,
      now: Date.now(),
      state: readDoc(path.join(dir, 'acct', 'state.json')),
      settings: readDoc(path.join(dir, 'control', 'settings.json')),
      commands: readDoc(path.join(dir, 'control', 'commands.json')),
      ledger: readLedger(path.join(dir, 'ledger')),
    };
    const res = await CloudTick.sync(ctx);
    writeJSON(path.join(outDir, 'processed_cmds.json'), res.processed || []);
    if (res.snapshot) writeJSON(path.join(outDir, 'snapshot.json'), res.snapshot);
    // apply 단계가 참조할 수 있도록 기존 장부 + 이번 거래를 합친 장부를 남김
    const merged = { ...ctx.ledger, ...res.ledgerOut };
    writeJSON(path.join(outDir, 'ledger_all.json'), merged);
    writeOutputs(res);
  } else if (cmd === 'apply') {
    const decisions = readDoc(path.join(dir, 'decisions.json'));
    if (!decisions) throw new Error('decisions.json 이 없습니다');
    const prevLedger = readDoc(path.join(outDir, 'ledger_all.json')) || {};
    const ctx = {
      get,
      now: Date.now(),
      state: readDoc(path.join(outDir, 'state.json')),
      settings: readDoc(path.join(dir, 'control', 'settings.json')),
      ledger: prevLedger,
      decisions,
    };
    const res = await CloudTick.apply(ctx);
    // sync 단계에서 이미 갱신된 달의 장부 파일은 유지하고, 이번에 바뀐 달만 덮어씀
    writeOutputs(res, { needsDecision: false });
  } else {
    console.error('usage: node engine.mjs sync|apply <dir>');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error('ENGINE ERROR:', e && e.stack || e);
  process.exit(1);
});
