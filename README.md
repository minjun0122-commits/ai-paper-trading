# AI 모의투자 (Binance 현물 + 선물)

바이낸스 실시간 시세로 AI가 스스로 매매하는 모의투자 시스템입니다. 초기 자본은 **5,000,000원**입니다.

## 클라우드 버전 (PC를 꺼도 계속 매매)

- 대시보드: https://claude.ai/artifact/9oN4uEgQurLWsxQeFr9bmr (본인만 열람, 휴대폰에서도 열림)
- 클라우드 루틴 "AI 모의투자 클라우드 엔진 (매시간)": 매시 5분마다 Anthropic 클라우드에서 실행 (https://claude.ai/code/routines/trig_016ffjtrrcTNdYGHLHqXgqfb)
- 실행할 때마다 지난 1시간을 1분봉으로 재생해 손절·익절·청산·펀딩비를 실제 가격 시점으로 정산하고, Claude가 새 매매를 판단합니다.
- **처음 한 번 필요한 설정:** claude.ai/code 클라우드 환경(Default)의 네트워크 접근에서
  `fapi.binance.com`, `api.binance.com`, `data-api.binance.vision`, `api.upbit.com` 을 허용해야 시세를 받을 수 있습니다.
- 클라우드 계좌와 아래 PC 버전 계좌는 서로 별개입니다.

## PC 버전 실행

`start.bat`을 더블클릭하세요. 설치할 것은 없고, 인터넷 연결만 필요합니다.

- 보이지 않는 백그라운드 AI 엔진(헤드리스 Edge)과 로컬 서버가 켜지고, 대시보드(http://localhost:8787)가 열립니다.
- **브라우저 창을 닫아도 AI는 계속 매매합니다.** 대시보드는 언제든 `start.bat`으로 다시 열어 보면 됩니다.
- 완전히 멈추려면 `stop.bat`을 실행하세요.
- **컴퓨터가 켜져 있어야 합니다.** 전원을 끄거나 절전/최대 절전 모드로 들어가면 멈추고, `start.bat`을 다시 실행하면 이어서 진행됩니다.
  (꺼져 있는 동안 손절가를 넘어간 포지션은 재시작 직후 현재가로 정리됩니다.)
- 계좌 데이터는 `data/state.json`에 저장됩니다. 이 폴더를 지우면 계좌가 초기화됩니다.

## 기능

| 구분 | 내용 |
|---|---|
| 시세 | Binance USDⓈ-M 선물 + 현물 WebSocket 실시간 (BTC, ETH, SOL, BNB, XRP, DOGE) |
| 선물 | 롱/숏, 레버리지 1~50x, 격리 마진, 청산가 계산 및 강제청산, 8시간 펀딩비 정산 |
| 현물 | 매수/매도 (롱 전용) |
| 비용 | 수수료 현물 0.1% · 선물 0.05%, 슬리피지 0.02% |
| 퀀트 AI | 15분봉 추세 + 1분봉 EMA/MACD/RSI/볼린저/거래량을 점수화해 진입 → ATR 기반 손절/익절(1:2.2), 본전 스탑 → 트레일링 스탑, 신호 반전/시간 청산 |
| Claude AI (선택) | 설정에 Anthropic API 키를 넣으면 Claude가 N분마다 계좌와 시장 스냅샷을 보고 직접 매매를 결정합니다. 리스크 가드가 레버리지와 크기를 제한합니다. |
| 대시보드 | 총자산(원/USDT), 수익률, 실현/미실현 손익, 승률, 자산 추이 차트, 캔들 차트(진입·손절·익절·청산가 라인, 매매 마커), AI 시그널 |
| 기록 | 거래내역(판단 근거 포함, CSV 내보내기), AI 판단 로그, JSON 백업/복원 |

## 원화 환산

장부는 바이낸스와 같이 USDT로 관리합니다. 계좌를 개설할 때 업비트 KRW-USDT 시세로 500만 원을 USDT로 바꾸고, 이후 원화 표시는 **그 환율로 고정**합니다.
그래서 원화 수익률은 환율 변동 없이 순수한 매매 성과만 반영합니다.

## 파일 구성

```
index.html          대시보드
css/style.css
js/config.js        설정·유틸 (초기 자본, 수수료, 심볼)
js/indicators.js    기술적 지표
js/market.js        바이낸스 REST/WebSocket 시세
js/exchange.js      모의 거래소 엔진 (체결, 청산, 펀딩, 손익)
js/ai-quant.js      퀀트 AI 트레이더
js/ai-claude.js     Claude AI 트레이더
js/ui.js, js/app.js 화면/부트스트랩
serve.ps1           로컬 서버 + 상태 저장 API
background.ps1      백그라운드 엔진 시작/중지
start.bat, stop.bat 실행 / 중지
data/               계좌 상태·설정 (자동 생성)
```

설정의 **백업 내보내기**로 계좌를 JSON 파일로 따로 보관할 수 있습니다.
