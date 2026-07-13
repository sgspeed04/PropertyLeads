/**
 * 진단용 임시 스크립트 — 신속통합기획 후보지 데이터를 정비사업 정보몽땅
 * (cleanup.seoul.go.kr)에서 크롤링 가능한지 확인.
 *
 * 확인할 것:
 *  1. HTTP 상태코드 (봇 차단 여부)
 *  2. 응답이 정적 HTML(테이블/리스트)인지, JS로 나중에 데이터를 채우는 방식인지
 *  3. 각 구역의 구/동 이름, 상태 등을 뽑을 수 있는 선택자가 있는지
 *
 * 결과 확인 후 실제 파이프라인에 편입하거나, 안 되면 이 파일은 삭제한다.
 */

const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
};

const TARGETS = [
  { name: '신속통합기획 선정구역(지도)',   url: 'https://cleanup.seoul.go.kr/cleanup/view/publicIntgrPlanArea.do' },
  { name: '신속통합기획 1차 선정구역',     url: 'https://cleanup.seoul.go.kr/cleanup/view/publicIntgrPlanSttn.do' },
  { name: '신속통합기획 메인',             url: 'https://cleanup.seoul.go.kr/cleanup/view/publicIntgrPlan.do' },
];

async function fetchWithTimeout(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function diagnose({ name, url }) {
  console.log(`\n=== ${name} (${url}) ===`);
  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch (e) {
    console.log(`  ✗ 요청 실패: ${e.message}`);
    return;
  }
  console.log(`  HTTP ${res.status} ${res.statusText}`);
  if (!res.ok) return;

  const html = await res.text();
  console.log(`  응답 길이: ${html.length}자`);

  const $ = cheerio.load(html);
  const tableCount = $('table').length;
  const rowCount = $('table tbody tr').length;
  const listItemCount = $('ul li').length;
  console.log(`  <table>: ${tableCount}개, <table tbody tr>: ${rowCount}개, <ul li>: ${listItemCount}개`);

  // 구/동 이름이 정적 HTML 안에 텍스트로 존재하는지 확인 (JS 렌더링이면 없어야 정상)
  const bodyText = $('body').text();
  const guNames = ['종로구','중구','용산구','성동구','광진구','동대문구','중랑구','성북구','강북구','도봉구',
    '노원구','은평구','서대문구','마포구','양천구','강서구','구로구','금천구','영등포구','동작구',
    '관악구','서초구','강남구','송파구','강동구'];
  const foundGu = guNames.filter(g => bodyText.includes(g));
  console.log(`  본문에서 발견된 구 이름: ${foundGu.length ? foundGu.join(', ') : '(없음 — JS 렌더링 의심)'}`);

  // 테이블 행 샘플 출력
  const rows = $('table tbody tr').slice(0, 5);
  rows.each((i, el) => {
    const cells = $(el).find('td').map((_, td) => $(td).text().trim()).get();
    console.log(`  ROW[${i}]: ${JSON.stringify(cells)}`);
  });

  // script 태그 중 ajax/fetch로 데이터를 불러오는 흔적이 있는지 확인
  const scripts = $('script:not([src])').map((_, el) => $(el).html() || '').get().join('\n');
  const hints = ['ajax(', 'fetch(', '.get(', '.post(', 'axios'];
  const foundHints = hints.filter(h => scripts.includes(h));
  console.log(`  인라인 스크립트 내 비동기 호출 흔적: ${foundHints.length ? foundHints.join(', ') : '(없음)'}`);
}

async function main() {
  for (const t of TARGETS) {
    await diagnose(t);
  }
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
