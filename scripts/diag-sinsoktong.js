/**
 * 진단용 임시 스크립트 (2단계) — 신속통합기획 지도 ajax 엔드포인트 탐색 +
 * 모아타운 페이지 URL을 메뉴 구조에서 찾기.
 *
 * 1단계(정적 HTML 확인)는 완료: publicIntgrPlanSttn.do가 정적 테이블로
 * 크롤링 가능함을 확인함. 이번엔:
 *  1. publicIntgrPlanArea.do의 인라인 스크립트에서 ajax 호출 URL 추출
 *     (좌표까지 나오는 JSON API인지 확인)
 *  2. cleanup.seoul.go.kr 메인/사업유형 페이지에서 "모아"가 들어간
 *     링크를 찾아 모아타운 목록 페이지 URL을 알아냄
 */

const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
};

async function fetchWithTimeout(url, timeoutMs = 20000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders }, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function findAjaxEndpoints() {
  const url = 'https://cleanup.seoul.go.kr/cleanup/view/publicIntgrPlanArea.do';
  console.log(`\n=== ajax 엔드포인트 탐색: ${url} ===`);
  const res = await fetchWithTimeout(url);
  const html = await res.text();
  const $ = cheerio.load(html);
  const scripts = $('script:not([src])').map((_, el) => $(el).html() || '').get().join('\n');

  // ajax({url: '...'}) 또는 ajax('...') 패턴, 그리고 .do/.json 확장자를 가진 문자열 리터럴 전체 수집
  const urlLikeMatches = [...scripts.matchAll(/['"]([^'"]*\.(?:do|json)(?:\?[^'"]*)?)['"]/g)].map(m => m[1]);
  const uniqueUrls = [...new Set(urlLikeMatches)];
  console.log(`  스크립트 내 .do/.json 문자열 ${uniqueUrls.length}개:`);
  for (const u of uniqueUrls.slice(0, 30)) console.log(`    ${u}`);

  // ajax( 호출 주변 컨텍스트도 몇 개 보여주기
  const ajaxIdx = [];
  let idx = scripts.indexOf('ajax(');
  while (idx !== -1 && ajaxIdx.length < 5) {
    ajaxIdx.push(idx);
    idx = scripts.indexOf('ajax(', idx + 1);
  }
  for (const i of ajaxIdx) {
    console.log(`  --- ajax( 호출 컨텍스트 ---`);
    console.log('  ' + scripts.substring(i, i + 300).replace(/\s+/g, ' '));
  }

  return uniqueUrls;
}

async function findMoaTownLinks() {
  const pages = [
    'https://cleanup.seoul.go.kr/cleanup/mainPage.do',
    'https://cleanup.seoul.go.kr/cleanup/view/redevelop.do',
  ];
  for (const url of pages) {
    console.log(`\n=== 모아타운 링크 탐색: ${url} ===`);
    try {
      const res = await fetchWithTimeout(url);
      console.log(`  HTTP ${res.status}`);
      if (!res.ok) continue;
      const html = await res.text();
      const $ = cheerio.load(html);
      const links = $('a[href]').map((_, el) => ({ href: $(el).attr('href'), text: $(el).text().trim() })).get();
      const moaLinks = links.filter(l => /모아|moa/i.test(l.text) || /moa/i.test(l.href || ''));
      console.log(`  "모아" 관련 링크 ${moaLinks.length}개:`);
      for (const l of moaLinks.slice(0, 20)) console.log(`    "${l.text}" -> ${l.href}`);
      if (moaLinks.length === 0) {
        // 전체 view/*.do 링크 목록을 훑어서 후보를 유추
        const viewLinks = links.filter(l => (l.href || '').includes('/cleanup/view/'));
        const uniqueViewLinks = [...new Map(viewLinks.map(l => [l.href, l])).values()];
        console.log(`  (모아 링크 없음 — 전체 view/*.do 링크 ${uniqueViewLinks.length}개)`);
        for (const l of uniqueViewLinks.slice(0, 30)) console.log(`    "${l.text}" -> ${l.href}`);
      }
    } catch (e) {
      console.log(`  ✗ 실패: ${e.message}`);
    }
  }
}

async function main() {
  await findAjaxEndpoints();
  await findMoaTownLinks();
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
