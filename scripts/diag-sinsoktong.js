/**
 * 진단용 임시 스크립트 (3단계) — 새로 발견한 두 페이지가 정적 테이블인지 확인.
 *  - publicIntgrPlanSttn2.do : 신속통합기획 "재건축" 추진현황
 *  - garoHouse.do            : 가로주택정비
 * (1단계에서 publicIntgrPlanSttn.do가 정적 테이블임은 이미 확인함)
 */

const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
};

const TARGETS = [
  { name: '신속통합기획 재건축 추진현황', url: 'https://cleanup.seoul.go.kr/cleanup/view/publicIntgrPlanSttn2.do' },
  { name: '가로주택정비',                url: 'https://cleanup.seoul.go.kr/cleanup/view/garoHouse.do' },
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
  const $ = cheerio.load(html);
  const rowCount = $('table tbody tr').length;
  console.log(`  응답 길이: ${html.length}자, <table tbody tr>: ${rowCount}개`);

  if (rowCount === 0) {
    // 테이블이 없으면 ul/li나 다른 반복 구조가 있는지, ajax 흔적이 있는지 확인
    console.log(`  <ul li>: ${$('ul li').length}개, <div class*="list">: ${$('[class*="list"]').length}개`);
    const scripts = $('script:not([src])').map((_, el) => $(el).html() || '').get().join('\n');
    console.log(`  ajax( 포함 여부: ${scripts.includes('ajax(')}`);
    return;
  }

  // 헤더 행(th) 확인
  const headers = $('table thead th, table tr th').map((_, el) => $(el).text().trim()).get();
  console.log(`  헤더: ${JSON.stringify(headers)}`);

  const rows = $('table tbody tr').slice(0, 5);
  rows.each((i, el) => {
    const cells = $(el).find('td').map((_, td) => $(td).text().trim()).get();
    console.log(`  ROW[${i}]: ${JSON.stringify(cells)}`);
  });
  console.log(`  총 ${rowCount}건`);
}

async function main() {
  for (const t of TARGETS) await diagnose(t);
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
