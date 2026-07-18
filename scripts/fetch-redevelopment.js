/**
 * 수도권(서울+경기) 재개발·재건축 데이터 자동 업데이트 스크립트
 *
 * ── GitHub Secrets ────────────────────────────────────────────────────────────
 *  SEOUL_API_KEY   : data.seoul.go.kr   (서울시 열린데이터광장)
 *  GG_API_KEY      : openapi.gg.go.kr   (경기도 공공데이터포털)
 *  VWORLD_KEY      : api.vworld.kr      (국토교통부 공간정보 오픈API, 지오코딩용)
 *    ※ VWorld는 GitHub Actions 러너(Azure 클라우드 IP)에서의 요청을 게이트웨이
 *      단에서 전부 502로 차단함(주소/검색/데이터 API 공통, 헤더 조정 무관) —
 *      키 자체는 정상(사용자 휴대폰 등 일반 회선에서는 정상 응답 확인됨).
 *      따라서 이 자동화 파이프라인에서는 geocodeProjects()가 매일 실패하는 게
 *      정상이며(지터 좌표 유지로 안전하게 폴백), 실제 지오코딩은 별도로
 *      사용자 브라우저(비클라우드 IP)에서 1회성 도구를 통해 수행하고 그 결과를
 *      데이터에 병합하는 방식으로 우회함. rowToProject()가 addr 필드(PSTN_NM)를
 *      결과 JSON에 영구 보존하는 것도 이 우회 경로를 위함.
 *
 * ── 사용 API ──────────────────────────────────────────────────────────────────
 *  [서울] openapi.seoul.go.kr
 *    OA-2253 upisRebuild (HTTPS:443)        : 정비구역 현황 — 구역 위치·유형·PRJC_CD
 *    OA-2254 CleanupBussinessProgress (HTTP:8088) : 추진경과 — BIZ_NO/SE_NM/SE_CD/DAY/TTL/DTL_CN
 *      ※ BIZ_NO({district_code}-{seq})는 PRJC_CD/RPT_MNG_CD와 채번 체계가 전혀 달라
 *        코드로는 조인 불가 (둘 다 앞 5자리 구 코드만 공통).
 *        대신 TTL(공고 제목)·DTL_CN(상세내용)에 실린 구역명 텍스트를
 *        normalizeProjectName()으로 정규화해 upisRebuild의 RGN_NM과
 *        같은 구 코드 내에서 부분일치시켜 매칭한다 (fetchProgressStages 참고).
 *  [경기] openapi.gg.go.kr  GenrlImprvBizpropls / TBGRISSMSCLBSNSM
 *    ※ 경기도 API도 Azure에서 TCP 차단 — 기존 데이터 유지.
 *  [서울] cleanup.seoul.go.kr (정비사업 정보몽땅) — 신속통합기획 후보지
 *    모아타운/신속통합기획/가로주택정비는 서울 열린데이터광장에 공식 API가
 *    없다. 대신 정비사업 정보몽땅의 신속통합기획 추진현황 페이지 2개
 *    (재개발 publicIntgrPlanSttn.do, 재건축 publicIntgrPlanSttn2.do)가
 *    정적 HTML 테이블이라 크롤링 가능함을 확인함(구/구역명/면적/세대수/
 *    추진단계/고시일). 좌표가 없어 구 중심좌표에 지터를 줘서 표시하고,
 *    upisRebuild에 이미 등록된(정식 정비구역 지정된) 동일 구역은
 *    normalizeProjectName() 기준으로 중복 스킵한다 (fetchSinsoktong 참고).
 *    가로주택정비(garoHouse.do)는 사업장 목록이 아니라 법령 안내 페이지라
 *    제외. 모아타운은 이 사이트 메뉴에 없어(별도 시스템으로 추정) 미포함.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs      = require('fs');
const path    = require('path');
const cheerio = require('cheerio');

const DATA_FILE = path.join(__dirname, '..', 'data', 'redevelopment.json');
const TODAY     = new Date().toISOString().split('T')[0];
const SEOUL_KEY  = process.env.SEOUL_API_KEY;
const GG_KEY     = process.env.GG_API_KEY;
const VWORLD_KEY = process.env.VWORLD_KEY;
const PAGE_SIZE = 1000;

// ── 단계 매핑 (idx: -2=모니터링, -1=준비위, 0=구역지정, 1=조합, 2=사업시행, 3=관리처분, 4=착공, 5=완료)
const STAGE_MAP = [
  { key: '완료',       idx: 5 }, { key: '준공',      idx: 5 }, { key: '입주',      idx: 5 },
  { key: '착공',       idx: 4 }, { key: '이주',      idx: 4 }, { key: '철거',      idx: 4 },
  { key: '관리처분',   idx: 3 },
  { key: '사업시행',   idx: 2 },
  { key: '조합설립',   idx: 1 }, { key: '조합인가',  idx: 1 }, { key: '시행자지정', idx: 1 },
  { key: '추진위',     idx: 1 }, { key: '준비위',    idx: 1 },
  { key: '정비구역',   idx: 0 }, { key: '구역지정',  idx: 0 }, { key: '구역지',    idx: 0 },
  { key: '정비계획고시', idx: 0 }, { key: '통심완료', idx: 0 }, { key: '심의', idx: 0 }, { key: '주민공람', idx: 0 },
  { key: '모니터링',   idx: -2 }, { key: '정비예정', idx: -2 }, { key: '관심구역',  idx: -2 },
  { key: '준비단계',   idx: -1 }, { key: '준비위결성',idx: -1 },
];

function getStageIdx(name = '') {
  for (const { key, idx } of STAGE_MAP) {
    if (name.includes(key)) return idx;
  }
  return 0;
}

// ── 구역명 정규화 (BIZ_NO 텍스트 매칭용) ────────────────────────────────────
// "천호A1-1구역", "전농7재정비촉진구역" 등에서 행정 접미어를 제거해
// "천호A11", "전농7" 같은 핵심 식별자만 남긴다.
const NAME_SUFFIX_RE = /(재정비촉진구역|도시환경정비지구|주택재개발정비구역|주택재건축정비구역|재개발사업구역|재건축사업구역|정비촉진구역|정비촉진지구|재개발구역|재건축구역|재개발지구|재건축지구|정비구역|정비지구|촉진구역|촉진지구|재개발|재건축|정비사업|지구|구역|사업)/g;
function normalizeProjectName(s = '') {
  return s.replace(/[^가-힣0-9A-Za-z]/g, '').replace(NAME_SUFFIX_RE, '');
}

function normCoord(v) {
  const n = parseFloat(v) || 0;
  if (n > 900000) return n / 1e7;
  return n;
}

function isSeoulCoord(lat, lng) {
  return lat > 37.4 && lat < 37.7 && lng > 126.7 && lng < 127.3;
}
function isGyeonggiCoord(lat, lng) {
  return lat > 36.9 && lat < 38.3 && lng > 126.3 && lng < 127.8 && !isSeoulCoord(lat, lng);
}
function isMetroCoord(lat, lng) {
  return isSeoulCoord(lat, lng) || isGyeonggiCoord(lat, lng);
}

// ── 구(區)·시(市) 중심 좌표 ──────────────────────────────────────────────────
const DISTRICT_COORD = {
  // 서울 25개 구
  '종로구': [37.5926, 126.9794], '중구':    [37.5641, 126.9979],
  '용산구': [37.5311, 126.9788], '성동구':  [37.5635, 127.0366],
  '광진구': [37.5385, 127.0823], '동대문구':[37.5744, 127.0394],
  '중랑구': [37.6063, 127.0931], '성북구':  [37.5894, 127.0167],
  '강북구': [37.6396, 127.0253], '도봉구':  [37.6688, 127.0471],
  '노원구': [37.6542, 127.0568], '은평구':  [37.6026, 126.9291],
  '서대문구':[37.5792, 126.9368],'마포구':  [37.5638, 126.9086],
  '양천구': [37.5169, 126.8664], '강서구':  [37.5510, 126.8495],
  '구로구': [37.4954, 126.8874], '금천구':  [37.4570, 126.8951],
  '영등포구':[37.5262, 126.8966],'동작구':  [37.5124, 126.9393],
  '관악구': [37.4784, 126.9516], '서초구':  [37.4837, 127.0325],
  '강남구': [37.5172, 127.0473], '송파구':  [37.5145, 127.1059],
  '강동구': [37.5300, 127.1237],
  // 경기도 주요 시
  '수원시': [37.2636, 127.0286], '성남시':  [37.4201, 127.1263],
  '안양시': [37.3943, 126.9568], '부천시':  [37.5034, 126.7660],
  '광명시': [37.4784, 126.8659], '시흥시':  [37.3800, 126.8029],
  '안산시': [37.3219, 126.8310], '의왕시':  [37.3445, 126.9677],
  '군포시': [37.3616, 126.9348], '고양시':  [37.6584, 126.8320],
  '의정부시':[37.7380, 127.0339],'남양주시':[37.6360, 127.2161],
  '하남시': [37.5393, 127.2146], '광주시':  [37.4296, 127.2553],
  '용인시': [37.2411, 127.1776], '평택시':  [36.9921, 127.1129],
  '화성시': [37.1996, 126.8312], '오산시':  [37.1498, 127.0772],
  '구리시': [37.5943, 127.1296], '양주시':  [37.7852, 126.9994],
  '파주시': [37.7597, 126.7798], '김포시':  [37.6152, 126.7156],
  '이천시': [37.2794, 127.4428], '안성시':  [37.0078, 127.2797],
  '포천시': [37.8948, 127.2001], '여주시':  [37.2983, 127.6376],
  '동두천시':[37.9036, 127.0607],'과천시':  [37.4296, 126.9874],
};

// ── fetch 공통 헬퍼 ──────────────────────────────────────────────────────────
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
};

async function fetchWithTimeout(url, timeoutMs = 30000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { ...FETCH_HEADERS, ...extraHeaders }, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    const cause = e.cause;
    const detail = cause ? ` [${cause.code || cause.constructor?.name || ''}] ${cause.message || ''}` : '';
    throw new Error(`${e.message}${detail}`.trim());
  }
}

// ── Seoul Open API 페이지 요청 ────────────────────────────────────────────────
async function fetchSeoulPage(serviceName, start, end) {
  const urls = [
    `https://openapi.seoul.go.kr:443/rest/${SEOUL_KEY}/json/${serviceName}/${start}/${end}/`,
    `http://openapi.seoul.go.kr:8088/${SEOUL_KEY}/json/${serviceName}/${start}/${end}/`,
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const res  = await fetchWithTimeout(url, 30000, { Referer: 'https://data.seoul.go.kr/' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const json = await res.json();
      const root = json[serviceName] || json;
      if (root.RESULT) {
        const code = root.RESULT.CODE || '';
        const msg  = root.RESULT.MESSAGE || code;
        if (!code.includes('INFO-000')) throw new Error(`API 오류: ${msg}`);
      }
      return { rows: root.row || [], total: parseInt(root.list_total_count || 0) };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function fetchSeoulAllPages(serviceName) {
  const first   = await fetchSeoulPage(serviceName, 1, PAGE_SIZE);
  const allRows = [...first.rows];
  const total   = first.total || allRows.length;
  console.log(`[SEOUL API] ${serviceName}: 전체 ${total}건`);
  let start = PAGE_SIZE + 1;
  while (start <= total) {
    const end = Math.min(start + PAGE_SIZE - 1, total);
    const { rows } = await fetchSeoulPage(serviceName, start, end);
    allRows.push(...rows);
    console.log(`  …페이지 ${Math.ceil(start / PAGE_SIZE) + 1} 수신 (누계 ${allRows.length})`);
    start = end + 1;
    await new Promise(r => setTimeout(r, 200));
  }
  return allRows;
}

// ── 추진경과 단계 수집 (CleanupBussinessProgress, HTTP:8088만 접근 가능) ────────
// BIZ_NO = {district_code}-{seq}, SE_NM = 단계명, SE_CD = 단계코드(숫자 클수록 진행)
// TTL(공고 제목)/DTL_CN(상세내용)에 실린 구역명 텍스트를 코퍼스로 모아
// upisRebuild의 RGN_NM과 텍스트 매칭시킨다 (BIZ_NO는 PRJC_CD와 직접 조인 불가).

async function fetchProgressStages(seoulKey) {
  const BASE = `http://openapi.seoul.go.kr:8088/${seoulKey}/json/CleanupBussinessProgress`;
  const PAGE = 1000;
  let allRows = [], total = 0;

  try {
    const res  = await fetchWithTimeout(`${BASE}/1/${PAGE}/`, 30000);
    const json = await res.json();
    const root = json.CleanupBussinessProgress || json;
    if (root.RESULT && !root.RESULT.CODE.includes('INFO-000'))
      throw new Error(`API 오류: ${root.RESULT.MESSAGE}`);
    total = parseInt(root.list_total_count || 0);
    allRows.push(...(root.row || []));
    console.log(`[STAGE API] CleanupBussinessProgress: 전체 ${total}건`);
  } catch (e) {
    console.warn(`[STAGE API] 접근 실패: ${e.message} — stage_idx 미갱신`);
    return null;
  }

  let start = PAGE + 1;
  while (start <= total) {
    const end = Math.min(start + PAGE - 1, total);
    try {
      const res  = await fetchWithTimeout(`${BASE}/${start}/${end}/`, 30000);
      const json = await res.json();
      const root = json.CleanupBussinessProgress || json;
      allRows.push(...(root.row || []));
      console.log(`  …페이지 ${Math.ceil(start / PAGE) + 1} 수신 (누계 ${allRows.length})`);
    } catch (e) {
      console.warn(`[STAGE API] 페이지 ${start}-${end} 실패: ${e.message}`);
      break;
    }
    start = end + 1;
    await new Promise(r => setTimeout(r, 200));
  }

  // BIZ_NO별 최고 SE_CD(가장 진행된 단계) + TTL/DTL_CN 텍스트 코퍼스 수집
  const bizMap = {};
  for (const row of allRows) {
    const bizNo = row.BIZ_NO;
    if (!bizNo) continue;
    if (!bizMap[bizNo]) bizMap[bizNo] = { seCD: -Infinity, seNm: '', day: '', corpus: '' };
    const entry = bizMap[bizNo];
    const seCD = parseInt(row.SE_CD || 0);
    if (seCD > entry.seCD) { entry.seCD = seCD; entry.seNm = row.SE_NM || ''; entry.day = row.DAY || ''; }
    const text = `${row.TTL || ''} ${row.DTL_CN || ''}`.trim();
    if (text) entry.corpus += ' ' + text;
  }
  for (const bizNo of Object.keys(bizMap)) {
    bizMap[bizNo].corpusNorm = normalizeProjectName(bizMap[bizNo].corpus);
  }

  const withCorpus = Object.values(bizMap).filter(v => v.corpusNorm).length;
  console.log(`[STAGE API] 고유 BIZ_NO: ${Object.keys(bizMap).length}건 (구역명 텍스트 보유 ${withCorpus}건)`);
  return bizMap;
}

// ── 신속통합기획 후보지 수집 (정비사업 정보몽땅, 정적 HTML 테이블) ────────────
const SINSOKTONG_SOURCES = [
  { url: 'https://cleanup.seoul.go.kr/cleanup/view/publicIntgrPlanSttn.do',  type: '재개발' },
  { url: 'https://cleanup.seoul.go.kr/cleanup/view/publicIntgrPlanSttn2.do', type: '재건축' },
];

async function fetchSinsoktongRows(url) {
  const res = await fetchWithTimeout(url, 20000);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const rows = [];
  $('table tbody tr').each((_, el) => {
    const cells = $(el).find('td').map((_, td) => $(td).text().trim()).get();
    if (cells.length) rows.push(cells);
  });
  return rows;
}

async function fetchSinsoktong() {
  const parsed = [];
  for (const { url, type } of SINSOKTONG_SOURCES) {
    try {
      const rows = await fetchSinsoktongRows(url);
      console.log(`[신통기획] ${type}: ${rows.length}건`);
      for (const cells of rows) {
        // 재개발(7열): 연번,자치구,구역명,면적,세대수,추진단계,고시일
        // 재건축(8열): 연번,구분,자치구,구역명,면적,세대수,추진단계,고시일
        const isRebuild  = cells.length >= 8;
        const district    = isRebuild ? cells[2] : cells[1];
        const name         = isRebuild ? cells[3] : cells[2];
        const area          = isRebuild ? cells[4] : cells[3];
        const units          = isRebuild ? cells[5] : cells[4];
        const stage            = isRebuild ? cells[6] : cells[5];
        const noticeDate         = isRebuild ? cells[7] : cells[6];
        if (!district || !name || !DISTRICT_COORD[district]) continue;
        parsed.push({ district, name, area, units, stage, noticeDate, type });
      }
    } catch (e) {
      console.warn(`[신통기획] ${type} 접근 실패: ${e.message}`);
    }
  }
  return parsed;
}

function sinsoktongToProject(row, idx) {
  const center = DISTRICT_COORD[row.district];
  return {
    id:             `snt_${idx}`,
    name:           row.name,
    region:         '서울',
    district:       row.district,
    dong:           '',
    type:           row.type,
    stage:          row.stage,
    stage_idx:      getStageIdx(row.stage),
    lat:            center[0] + (Math.random() - 0.5) * 0.02,
    lng:            center[1] + (Math.random() - 0.5) * 0.02,
    area_m2:        parseInt((row.area || '0').replace(/,/g, '')) || 0,
    units:          parseInt((row.units || '0').replace(/,/g, '')) || 0,
    contractor:     '',
    stage_date:     (row.noticeDate || '').replace(/-/g, '').substring(0, 6),
    notes:          '',
    subway:         '',
    hangang:        false,
    completion_est: '',
    ref_note:       '신속통합기획 후보지 (정비사업 정보몽땅)',
  };
}

// ── openapi.gg.go.kr 경기도 API 페이지 요청 ─────────────────────────────────
async function fetchGgPage(serviceName, pIndex, pSize) {
  const qs = `KEY=${GG_KEY}&Type=json&pIndex=${pIndex}&pSize=${pSize}`;
  const urls = [
    `https://openapi.gg.go.kr/${serviceName}?${qs}`,
    `http://openapi.gg.go.kr/${serviceName}?${qs}`,
  ];
  let lastErr;
  for (const url of urls) {
    const proto = url.startsWith('https') ? 'HTTPS' : 'HTTP';
    try {
      const res  = await fetchWithTimeout(url, 30000, { Referer: 'https://openapi.gg.go.kr/' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const json = await res.json();
      const root = json[serviceName] || json;
      if (root.RESULT) {
        const code = root.RESULT.CODE || '';
        const msg  = root.RESULT.MESSAGE || code;
        console.log(`    [GG RESULT] ${code} — ${msg}`);
        if (!code.includes('INFO-000')) throw new Error(`GG API 오류: ${msg}`);
      }
      return { rows: root.row || [], total: parseInt(root.list_total_count || 0) };
    } catch (e) {
      console.warn(`    [GG ${proto}] 실패: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr;
}

async function fetchGgAllPages(serviceName) {
  const first   = await fetchGgPage(serviceName, 1, PAGE_SIZE);
  const allRows = [...first.rows];
  const total   = first.total || allRows.length;
  console.log(`[GG API] ${serviceName}: 전체 ${total}건`);
  let pIndex = 2;
  while ((pIndex - 1) * PAGE_SIZE < total) {
    const { rows } = await fetchGgPage(serviceName, pIndex, PAGE_SIZE);
    if (rows.length === 0) break;
    allRows.push(...rows);
    console.log(`  …페이지 ${pIndex} 수신 (누계 ${allRows.length})`);
    pIndex++;
    await new Promise(r => setTimeout(r, 200));
  }
  return allRows;
}

// ── row → 프로젝트 객체 변환 ──────────────────────────────────────────────────
function rowToProject(r, idx, region = '서울') {
  const name = r.RGN_NM || r.PSTN_NM || r.RPT_NM || r.SBSN_NM || r.JNGB_NM || '알 수 없음';

  const stageName = r.SCLSF || r.MCLSF || r.LCLSF || '';

  const typeHint     = r.RPT_TYPE || r.LCLSF || r.MCLSF || r.JNGB_TYPE || '';
  const isRebuilding = name.includes('재건축') || typeHint.includes('재건축');

  const locationRaw = r.LOGVM || r.PSTN_NM || r.SGG_NM || r.SIGUNGU_NM || '';
  const district    = Object.keys(DISTRICT_COORD).find(k => locationRaw.includes(k)) || '';

  let lat = normCoord(r.CNTRD_Y || r.LAT || r.Y_COORD || r.LAT_CD || 0);
  let lng = normCoord(r.CNTRD_X || r.LON || r.X_COORD || r.LOT_CD || 0);
  if (!isMetroCoord(lat, lng)) {
    const center = DISTRICT_COORD[district];
    if (center) {
      lat = center[0] + (Math.random() - 0.5) * 0.02;
      lng = center[1] + (Math.random() - 0.5) * 0.02;
    }
  }

  return {
    id:             `${region === '서울' ? 'api' : 'gg'}_${idx}`,
    name,
    region,
    district,
    dong:           r.EMD_NM  || r.DONG_NM || '',
    type:           isRebuilding ? '재건축' : '재개발',
    stage:          stageName,
    stage_idx:      getStageIdx(stageName),
    lat,
    lng,
    geo_source:     'jitter',
    area_m2:        parseInt(r.AREA_EXS || r.TOT_AREA || r.ZONE_AR || 0),
    units:          parseInt(r.TOT_HSHLD || r.TOT_HSHLD_CO || r.PLAN_HH || 0),
    contractor:     r.CNSTR_CO_NM || '',
    stage_date:     (r.STEP_DT || r.PRGSRT_DE || '').substring(0, 7),
    notes:          '',
    subway:         '',
    hangang:        false,
    completion_est: '',
    ref_note:       '',
    _prjcCd:        r.RPT_MNG_CD || r.PRJC_CD || '',
    addr:           r.PSTN_NM || '',
  };
}

// ── 기존 수작업 데이터와 병합 ────────────────────────────────────────────────
function mergeWithExisting(apiProjects, existingProjects) {
  const existingMap = new Map();
  for (const p of existingProjects) existingMap.set(p.name.trim(), p);
  return apiProjects.map(ap => {
    const ex = existingMap.get(ap.name.trim());
    if (!ex) return ap;
    const merged = {
      ...ap,
      notes:          ex.notes          || ap.notes,
      subway:         ex.subway         || ap.subway,
      hangang:        ex.hangang        || ap.hangang,
      completion_est: ex.completion_est || ap.completion_est,
      ref_note:       ex.ref_note       || ap.ref_note,
    };
    // 이전 실행에서 VWorld 지오코딩에 성공한 좌표는 유지 — 매번 새로 지터링되지 않도록.
    // vworld_dong(동 단위 근사치)도 유지하되, geocodeProjects()의 재시도 대상에는
    // 계속 포함시켜 지번 단위 정확 좌표로 승격될 기회를 남겨둔다.
    if (ex.geo_source === 'vworld' || ex.geo_source === 'vworld_dong') {
      merged.lat = ex.lat;
      merged.lng = ex.lng;
      merged.geo_source = ex.geo_source;
    }
    return merged;
  });
}

// ── VWorld 지오코더 — PSTN_NM(지번 주소)로 실제 좌표 조회 ───────────────────────
// 지번 텍스트에 "일대/일원/외 N필지/(부가설명)" 등 정형화되지 않은 표현이 섞여
// 있어 지오코더가 못 읽는 경우가 많음 — 정리 후 시도.
// "동 숫자(-숫자)?" 패턴이 있으면 지번 표기로 판단 (괄호 안/밖 중 실제 지번이
// 어느 쪽인지 판별하는 데 사용 — 도로명 주소엔 이 패턴이 없음).
function looksLikeParcel(s) {
  return /[가-힣]+동\s*\d+(-\d+)?/.test(s);
}

function cleanAddress(pstnNm, district) {
  let s = (pstnNm || '').trim();
  if (!s) return '';
  s = s.replace(/및.*$/, ' ');                 // "및 의주로1가 1일대" 등 복수 필지 뒷부분 제거
  const parenMatch = s.match(/\(([^)]*)\)/);
  if (parenMatch) {
    const inner = parenMatch[1];
    const outer = s.replace(/\([^)]*\)/g, ' ');
    // 괄호 안이 실제 지번(예: "문정로 125(가락동 199)")이고 바깥이 도로명이면
    // 바깥(도로명)을 버리고 괄호 안(지번)을 사용 — PARCEL 타입 지오코더는
    // 도로명이 아니라 지번을 기대하므로 반대로 처리하면 실패함.
    s = (looksLikeParcel(inner) && !looksLikeParcel(outer)) ? inner : outer;
  }
  s = s.replace(/,.*$/, '');                  // 쉼표 이후(복수 지번 표기 등) 제거
  s = s.replace(/외\s*\d+\s*필지/g, ' ');       // "외 214필지" 제거
  s = s.replace(/(일대|일원)\s*$/g, ' ');       // 꼬리 표현 제거
  // "신월2동/오류2동" 같은 행정동(동사무소 단위) 표기를 법정동(지번 기준)으로 정규화 —
  // VWorld PARCEL 지오코더는 법정동 이름을 요구해 숫자 접미사가 있으면 실패함.
  s = s.replace(/([가-힣]+)\d+동/g, '$1동');
  s = s.replace(/\s+/g, ' ').trim();
  // 주소 텍스트에 이미 다른 구 이름이 들어있으면(원본 데이터의 district 필드가
  // 틀린 경우가 드물게 있음) 텍스트 쪽을 신뢰하고 district를 덧붙이지 않음 —
  // 그렇지 않으면 "마포구 강동구 고덕동..." 처럼 구가 두 번 겹쳐 실패함.
  if (district && !/[가-힣]+구/.test(s)) s = `${district} ${s}`;
  return `서울특별시 ${s}`.replace(/\s+/g, ' ').trim();
}

// 정확한 지번으로 실패하면(재개발구역 특성상 지번이 이미 통합/변경된 경우가 많음)
// 지번을 떼고 "구 동" 단위로 재시도 — 정확도는 떨어지지만 구 전체 무작위
// 지터보다는 훨씬 실제 위치에 가까움.
function toDongOnly(cleanedAddress) {
  return cleanedAddress.replace(/\s*\d[\d-]*\s*(번지)?\s*$/, '').trim();
}

async function geocodeAddress(address) {
  if (!address) return null;
  const url = `https://api.vworld.kr/req/address?service=address&request=getCoord&version=2.0&crs=epsg:4326&address=${encodeURIComponent(address)}&format=json&type=PARCEL&key=${VWORLD_KEY}`;
  try {
    const res = await fetchWithTimeout(url, 15000);
    const json = await res.json();
    const point = json?.response?.result?.point;
    if (json?.response?.status === 'OK' && point) {
      return { lat: parseFloat(point.y), lng: parseFloat(point.x) };
    }
  } catch (e) {
    // 개별 주소 실패는 조용히 무시하고 지터 좌표 유지 — 아래에서 카운트만 집계
  }
  return null;
}

async function geocodeProjects(projects) {
  if (!VWORLD_KEY) {
    console.log('[GEOCODE] VWORLD_KEY 없음 — 지오코딩 건너뜀 (구 중심좌표 지터 유지)');
    return;
  }
  const targets = projects.filter(p => p.geo_source !== 'vworld' && p.addr);
  console.log(`[GEOCODE] VWorld 지오코딩 대상 ${targets.length}건 (이미 확보된 ${projects.length - targets.length}건 제외)`);
  let success = 0, dongOnly = 0, fail = 0;
  for (const p of targets) {
    const addr = cleanAddress(p.addr, p.district);
    let coord = await geocodeAddress(addr);
    let precise = true;
    if (!coord) {
      // 정확한 지번으로 실패 — 재개발구역 특성상 지번이 이미 통합/변경된 경우가 많아
      // "구 동" 단위로 재시도 (지터보다는 훨씬 정확)
      coord = await geocodeAddress(toDongOnly(addr));
      precise = false;
    }
    if (coord) {
      p.lat = coord.lat;
      p.lng = coord.lng;
      p.geo_source = precise ? 'vworld' : 'vworld_dong';
      if (precise) success++; else dongOnly++;
    } else {
      fail++;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`[GEOCODE] 지번 성공 ${success}건, 동 단위 성공 ${dongOnly}건, 실패(구 중심좌표 지터 유지) ${fail}건`);
}

// ── 서울 데이터 수집 ─────────────────────────────────────────────────────────
async function fetchSeoul(existing) {
  if (!SEOUL_KEY) {
    console.log('[SEOUL] SEOUL_API_KEY 없음 — 기존 서울 데이터 유지.');
    return existing.projects.filter(p => !p.region || p.region === '서울');
  }
  let rawRows = [];
  try {
    console.log('[SEOUL API] 시도: upisRebuild');
    rawRows = await fetchSeoulAllPages('upisRebuild');
    if (rawRows.length > 0) {
      console.log(`[SEOUL API] ✓ upisRebuild 성공 — ${rawRows.length}건`);
      console.log(`[FIELDS] ${Object.keys(rawRows[0]).join(', ')}`);
      const s = rawRows[0];
      console.log(`[SAMPLE] RGN_NM="${s.RGN_NM}" RPT_MNG_CD="${s.RPT_MNG_CD}" PRJC_CD="${s.PRJC_CD}" DCSN_ANCMNT_MNG_CD="${s.DCSN_ANCMNT_MNG_CD}" SCLSF="${s.SCLSF}"`);
      // Log a few more to see RPT_MNG_CD format across records
      for (const r of rawRows.slice(1, 4))
        console.log(`  MORE: RPT_MNG_CD="${r.RPT_MNG_CD}" PRJC_CD="${r.PRJC_CD}" RGN_NM="${r.RGN_NM}"`);
    }
  } catch (e) {
    console.warn(`[SEOUL] 실패: ${e.message} — 기존 데이터 유지`);
    return existing.projects.filter(p => !p.region || p.region === '서울');
  }
  if (rawRows.length === 0) return existing.projects.filter(p => !p.region || p.region === '서울');

  const apiProjects = rawRows
    .map((r, i) => rowToProject(r, i, '서울'))
    .filter(p => isSeoulCoord(p.lat, p.lng) && p.name !== '알 수 없음' && p.district);
  console.log(`[SEOUL] 서울 구역 통과: ${apiProjects.length}건`);

  const distMap = {};
  for (const p of apiProjects) distMap[p.district] = (distMap[p.district] || 0) + 1;
  console.log('[DISTRICT]', JSON.stringify(distMap));

  return mergeWithExisting(apiProjects, existing.projects);
}

// ── 경기도 데이터 수집 ───────────────────────────────────────────────────────
async function fetchGyeonggi(existing) {
  if (!GG_KEY) {
    console.log('[GG] GG_API_KEY 없음 — 경기도 데이터 스킵.');
    return existing.projects.filter(p => p.region === '경기');
  }
  const GG_SERVICES = ['GenrlImprvBizpropls', 'TBGRISSMSCLBSNSM'];
  let allRawRows = [];
  for (const svc of GG_SERVICES) {
    try {
      console.log(`[GG API] 시도: ${svc}`);
      const rows = await fetchGgAllPages(svc);
      if (rows.length > 0) {
        console.log(`[GG API] ✓ ${svc} 성공 — ${rows.length}건`);
        const s = rows[0];
        console.log(`[GG FIELDS] ${Object.keys(s).join(', ')}`);
        console.log(`[GG SAMPLE] ${JSON.stringify(Object.fromEntries(Object.entries(s).slice(0, 12)))}`);
        allRawRows.push(...rows);
      }
    } catch (e) {
      console.warn(`  ✗ ${svc}: ${e.message}`);
    }
  }
  if (allRawRows.length === 0) {
    console.warn('[GG] 모든 서비스 실패 — 기존 경기도 데이터 유지.');
    return existing.projects.filter(p => p.region === '경기');
  }
  const apiProjects = allRawRows
    .map((r, i) => rowToProject(r, i, '경기'))
    .filter(p => isGyeonggiCoord(p.lat, p.lng) && p.name !== '알 수 없음' && p.district);
  console.log(`[GG] 경기 구역 통과: ${apiProjects.length}건`);
  return mergeWithExisting(apiProjects, existing.projects.filter(p => p.region === '경기'));
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  let existing = { updated_at: TODAY, source: 'sample', projects: [] };
  if (fs.existsSync(DATA_FILE)) {
    existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    existing.projects = existing.projects.map(p => ({ region: '서울', ...p }));
  }

  const [seoulProjects, ggProjects] = await Promise.all([
    fetchSeoul(existing),
    fetchGyeonggi(existing),
  ]);

  if (SEOUL_KEY && seoulProjects.some(p => p.id?.startsWith('api_'))) {
    const bizMap = await fetchProgressStages(SEOUL_KEY);
    if (bizMap) {
      // 구 코드(5자리, BIZ_NO 접두)별로 후보 그룹핑
      const byDistrict = {};
      for (const [bizNo, entry] of Object.entries(bizMap)) {
        if (!entry.corpusNorm) continue;
        const distCd = bizNo.split('-')[0];
        (byDistrict[distCd] ||= []).push({ bizNo, ...entry });
      }

      let matched = 0, ambiguous = 0;
      for (const p of seoulProjects) {
        const distCd = (p._prjcCd || '').substring(0, 5);
        const candidates = byDistrict[distCd];
        if (!candidates) continue;
        const core = normalizeProjectName(p.name);
        if (core.length < 2) continue;
        const hits = candidates.filter(c => c.corpusNorm.includes(core));
        if (hits.length === 0) continue;
        if (hits.length > 1) ambiguous++;
        const best = hits.reduce((a, b) => (b.seCD > a.seCD ? b : a));
        p.stage_idx  = getStageIdx(best.seNm);
        p.stage      = best.seNm;
        p.stage_date = best.day ? best.day.substring(0, 6) : p.stage_date;
        matched++;
      }
      console.log(`[STAGE] ${matched}/${seoulProjects.length} 구역 단계 업데이트 (구역명 텍스트 매칭, 중복후보 ${ambiguous}건)`);
    }
  }

  await geocodeProjects(seoulProjects);

  for (const p of [...seoulProjects, ...ggProjects]) { delete p._prjcCd; }

  // 신속통합기획 후보지 — 이미 정비구역 지정되어 upisRebuild에 있는 구역은 중복 스킵
  try {
    const sntRows = await fetchSinsoktong();
    const namesByDistrict = {};
    for (const p of seoulProjects) {
      (namesByDistrict[p.district] ||= []).push(normalizeProjectName(p.name));
    }
    let sntAdded = 0, sntSkipped = 0;
    const sntProjects = [];
    for (const row of sntRows) {
      const core = normalizeProjectName(row.name);
      if (core.length < 2) continue;
      const existingNames = namesByDistrict[row.district] || [];
      const isDup = existingNames.some(n => n.includes(core) || core.includes(n));
      if (isDup) { sntSkipped++; continue; }
      sntProjects.push(sinsoktongToProject(row, sntProjects.length));
      sntAdded++;
    }
    console.log(`[신통기획] 신규 ${sntAdded}건 추가, 기존 구역과 중복 ${sntSkipped}건 스킵`);
    seoulProjects.push(...sntProjects);
  } catch (e) {
    console.warn(`[신통기획] 처리 실패: ${e.message}`);
  }

  const merged     = [...seoulProjects, ...ggProjects];
  const seoulCount = seoulProjects.length;
  const ggCount    = ggProjects.length;

  existing.projects   = merged;
  existing.updated_at = TODAY;
  existing.source     = 'seoul_open_api' + (ggCount > 0 ? '+gg_open_api' : '');
  existing.note       = `수도권 실데이터 — 서울 ${seoulCount}개·경기 ${ggCount}개 구역 (${TODAY} 갱신)`;

  fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2), 'utf-8');
  console.log(`[DONE] 총 ${merged.length}개 구역 저장 완료 (서울 ${seoulCount} + 경기 ${ggCount})`);
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
