/**
 * 위반건축물 공시송달 공고 자동 수집 스크립트 (파일럿: 강남·광진·송파·성동·용산구)
 *
 * ── 배경 ──────────────────────────────────────────────────────────────────
 *  위반건축물은 서울시/경기도 재개발 데이터(fetch-redevelopment.js)와 달리
 *  전국 통합 오픈API가 없다. 대신 각 구청이 "공시송달/고시공고" 게시판에
 *  위반건축물 철거명령·이행강제금 공고를 다른 기관 공고(토지거래허가, 채용,
 *  결혼중개업법 위반 등)와 섞어서 올린다. 첫 실행 결과 최근 10건 중
 *  위반건축물 관련 공고가 없어, 제목에 관련 키워드가 있는 것만 걸러낸다.
 *
 *  게시판은 과거 글로 갈수록 게시글 번호가 급격히 낮아지는 것으로 보아
 *  pageIndex 파라미터로 과거 아카이브까지 훑는 건 비현실적이다(수천 페이지
 *  차이). 따라서 이 스크립트는 "매일 최근 게시물 중 신규 위반건축물 공고를
 *  잡아내는" 용도로 설계했다 — 과거 이력 백필용이 아니다.
 *
 *  실전 실행으로 5개 구 모두 검증 완료(광진구는 실제 위반건축물 공고 3건
 *  수집). 강동구는 목록이 자바스크립트로 렌더링되는 방식(CSR)이라 단순
 *  HTTP 요청 + HTML 파싱으로는 목록 자체를 못 읽어와 제외했다 — 필요하면
 *  headless 브라우저(Playwright 등)를 추가해야 하는데, 그러면 이 구 하나
 *  때문에 전체 파이프라인이 무거워져서 우선 보류.
 * ─────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const DATA_FILE = path.join(__dirname, '..', 'data', 'violations_notices.json');
const TODAY = new Date().toISOString().split('T')[0];
const MAX_PAGES = 3;

const VIOLATION_KEYWORDS = [
  '위반건축물', '철거명령', '이행강제금', '무단증축', '무단용도변경',
  '불법건축', '불법가설물', '원상복구', '시정명령',
];

const BOARDS = [
  {
    district: '강남구',
    listUrl: 'https://www.gangnam.go.kr/board/B_000046/list.do?mid=ID05_050209',
    pageParam: 'pageIndex',
  },
  {
    // 고시공고/입법예고 게시판 — 실제 위반건축물 공고 수집 확인됨
    district: '광진구',
    listUrl: 'https://www.gwangjin.go.kr/portal/bbs/B0000003/list.do?menuNo=200192',
    pageParam: 'pageIndex',
  },
  {
    // 공지사항 게시판 — 실전 검증 완료
    district: '송파구',
    listUrl: 'https://www.songpa.go.kr/www/selectBbsNttList.do?bbsNo=92&key=2775',
    pageParam: 'pageIndex',
  },
  {
    // 고시공고(토지관리과) 게시판 — 실전 검증 완료
    district: '성동구',
    listUrl: 'https://www.sd.go.kr/main/selectBbsNttList.do?bbsNo=184&key=3730',
    pageParam: 'pageIndex',
  },
  {
    // 고시공고 게시판 — 실전 검증 완료
    district: '용산구',
    listUrl: 'https://www.yongsan.go.kr/portal/bbs/B0000168/list.do?menuNo=200846',
    pageParam: 'pageIndex',
  },
];

// 리스트 행에서 (제목, 링크)를 뽑아내기 위한 선택자 후보들 — 사이트마다 마크업이
// 달라서 위에서부터 순서대로 시도하고, 처음으로 결과가 나오는 후보를 사용한다.
const ROW_SELECTORS = [
  'table tbody tr td.subject a, table tbody tr td.title a',
  'table tbody tr a[href*="view.do" i]',
  'table tbody tr a[href*="ntt" i]',
  'ul.board-list li a[href*="view.do" i]',
  'a[href*="view.do" i]',
  'a[href*="ntt" i]',
];

function absoluteUrl(base, href) {
  try { return new URL(href, base).toString(); } catch { return href; }
}

function extractDate(text) {
  const m = (text || '').match(/(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseListHtml(html, baseUrl) {
  const $ = cheerio.load(html);

  let usedSelector = null;
  let anchors = $();
  for (const sel of ROW_SELECTORS) {
    const found = $(sel);
    if (found.length > 0) { usedSelector = sel; anchors = found; break; }
  }

  console.log(`  [PARSE] 선택자 "${usedSelector}" 로 ${anchors.length}개 링크 발견`);
  if (anchors.length === 0) {
    // 페이지 전체 <a href>를 훑어서 실제 상세보기 링크 패턴(파일명 기준)을 빈도순으로 보여준다.
    // 내비게이션 메뉴 등 노이즈에 섞여도, 게시글 개수만큼 반복되는 패턴이 상위에 뜬다.
    const hrefCounts = new Map();
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/([A-Za-z0-9_]+\.do)/);
      const key = m ? m[1] : (href.split('?')[0] || href).slice(0, 40);
      if (!key || key === '#' || key.startsWith('javascript')) return;
      hrefCounts.set(key, (hrefCounts.get(key) || 0) + 1);
    });
    const top = [...hrefCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`  [PARSE] 진단: 전체 <a> ${$('a[href]').length}개, href 패턴 빈도 상위 10개:`);
    top.forEach(([k, c]) => console.log(`    ${c}회 — ${k}`));

    // href가 아니라 onclick(javascript:)으로 상세보기를 여는 사이트도 있어 함께 확인한다.
    const onclickCounts = new Map();
    $('[onclick]').each((_, el) => {
      const oc = $(el).attr('onclick') || '';
      const m = oc.match(/^[A-Za-z_][A-Za-z0-9_]*\(/);
      const key = m ? m[0] : oc.slice(0, 30);
      onclickCounts.set(key, (onclickCounts.get(key) || 0) + 1);
    });
    const topOnclick = [...onclickCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (topOnclick.length) {
      console.log(`  [PARSE] 진단: onclick 속성 ${$('[onclick]').length}개, 패턴 빈도 상위 5개:`);
      topOnclick.forEach(([k, c]) => console.log(`    ${c}회 — ${k}`));
    }
    return [];
  }

  const items = [];
  anchors.each((_, el) => {
    const $el = $(el);
    const title = $el.text().trim().replace(/\s+/g, ' ');
    const href = $el.attr('href');
    if (!title || !href) return;
    const row = $el.closest('tr, li');
    const rowText = row.length ? row.text() : title;
    items.push({
      title,
      url: absoluteUrl(baseUrl, href),
      detected_date: extractDate(rowText),
    });
  });
  return items;
}

async function fetchBoard(board) {
  const all = [];
  const seenUrls = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${board.listUrl}${board.listUrl.includes('?') ? '&' : '?'}${board.pageParam}=${page}`;
    let html;
    try {
      html = await fetchPage(url);
    } catch (e) {
      console.warn(`  [${board.district}] 페이지 ${page} 요청 실패: ${e.message}`);
      break;
    }
    const items = parseListHtml(html, url).filter(it => !seenUrls.has(it.url));
    if (items.length === 0) { console.log(`  [${board.district}] 페이지 ${page}: 신규 항목 없음 — 중단`); break; }
    items.forEach(it => seenUrls.add(it.url));
    all.push(...items);
    console.log(`  [${board.district}] 페이지 ${page}: ${items.length}건 수집 (누계 ${all.length})`);
    await new Promise(r => setTimeout(r, 300));
  }
  return all.map((it, i) => ({
    id: `${board.district}_${i}_${Buffer.from(it.url).toString('base64').slice(0, 10)}`,
    district: board.district,
    title: it.title,
    url: it.url,
    detected_date: it.detected_date,
    collected_at: TODAY,
  }));
}

function matchesViolationKeyword(title) {
  return VIOLATION_KEYWORDS.some(k => title.includes(k));
}

async function main() {
  let existing = { updated_at: TODAY, notices: [] };
  if (fs.existsSync(DATA_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch {}
  }

  let rawCount = 0;
  const matched = [];
  for (const board of BOARDS) {
    console.log(`[BOARD] ${board.district} 공고 게시판 수집 시작 — ${board.listUrl}`);
    try {
      const items = await fetchBoard(board);
      rawCount += items.length;
      const boardMatched = items.filter(it => matchesViolationKeyword(it.title));
      console.log(`[BOARD] ${board.district} 완료 — 전체 ${items.length}건 중 위반건축물 관련 ${boardMatched.length}건`);
      matched.push(...boardMatched);
    } catch (e) {
      console.error(`[BOARD] ${board.district} 실패: ${e.message}`);
    }
  }

  if (rawCount === 0) {
    console.warn('[DONE] 게시판에서 아무 항목도 못 읽었습니다 — 사이트 구조 변경 가능성, 선택자 점검 필요. 기존 데이터 유지.');
    return;
  }

  if (matched.length === 0) {
    console.log('[DONE] 게시판은 정상 수집됐지만 위반건축물 관련 공고는 없었습니다. updated_at만 갱신.');
  }

  // 기존 공고와 URL 기준 병합 (중복 제거, 최신 수집 결과 우선)
  const byUrl = new Map(existing.notices.map(n => [n.url, n]));
  matched.forEach(n => byUrl.set(n.url, n));

  const merged = { updated_at: TODAY, notices: [...byUrl.values()] };
  fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`[DONE] 위반건축물 관련 공고 누계 ${merged.notices.length}건 저장 완료 (이번 실행 신규 매칭 ${matched.length}건)`);
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
