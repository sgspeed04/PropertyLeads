/**
 * 서울시 동(洞) 단위 노후도 데이터 연간 갱신 스크립트
 *
 * 필요한 GitHub Secrets:
 *   DATA_GO_KR_KEY - 공공데이터포털 API 키 (data.go.kr 가입 후 무료 발급)
 *
 * 사용 API:
 *   국토교통부 건축물대장 기본개요 조회 (data.go.kr)
 *   - 서비스명: 건축물대장 기본개요 조회 서비스
 *   - 주소: https://www.data.go.kr/data/15044713/openapi.do
 *
 * API 키 없으면 기존 데이터의 updated_at만 갱신.
 * GitHub Actions 연간(또는 수동) 실행 권장.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'nohuodo.json');
const TODAY = new Date().toISOString().split('T')[0];
const CURRENT_YEAR = new Date().getFullYear();
const THRESHOLD_YEAR = CURRENT_YEAR - 30; // 30년 이상 기준

const DATA_GO_KR_KEY = process.env.DATA_GO_KR_KEY;

// 대상 동(洞) 목록 (위도/경도는 각 동의 중심점)
const TARGET_DONGS = [
  { dong:'한남동',    district:'용산구',   sigunguCd:'11170', bjdongCd:'10500', lat:37.5345, lng:127.0016 },
  { dong:'청파동',    district:'용산구',   sigunguCd:'11170', bjdongCd:'10100', lat:37.5442, lng:126.9714 },
  { dong:'이촌동',    district:'용산구',   sigunguCd:'11170', bjdongCd:'10600', lat:37.5195, lng:126.9701 },
  { dong:'흑석동',    district:'동작구',   sigunguCd:'11590', bjdongCd:'10900', lat:37.5098, lng:126.9635 },
  { dong:'노량진동',  district:'동작구',   sigunguCd:'11590', bjdongCd:'10100', lat:37.5136, lng:126.9429 },
  { dong:'봉천동',    district:'관악구',   sigunguCd:'11620', bjdongCd:'10500', lat:37.4812, lng:126.9352 },
  { dong:'신림동',    district:'관악구',   sigunguCd:'11620', bjdongCd:'10800', lat:37.4786, lng:126.9285 },
  { dong:'아현동',    district:'마포구',   sigunguCd:'11440', bjdongCd:'10700', lat:37.5567, lng:126.9558 },
  { dong:'염리동',    district:'마포구',   sigunguCd:'11440', bjdongCd:'10800', lat:37.5497, lng:126.9498 },
  { dong:'미아동',    district:'강북구',   sigunguCd:'11305', bjdongCd:'10100', lat:37.6410, lng:127.0270 },
  { dong:'수유동',    district:'강북구',   sigunguCd:'11305', bjdongCd:'10500', lat:37.6479, lng:127.0247 },
  { dong:'장위동',    district:'성북구',   sigunguCd:'11290', bjdongCd:'11900', lat:37.6075, lng:127.0474 },
  { dong:'길음동',    district:'성북구',   sigunguCd:'11290', bjdongCd:'10700', lat:37.6038, lng:127.0263 },
  { dong:'가리봉동',  district:'구로구',   sigunguCd:'11530', bjdongCd:'10800', lat:37.4805, lng:126.8832 },
  { dong:'신길동',    district:'영등포구', sigunguCd:'11560', bjdongCd:'11600', lat:37.5154, lng:126.9098 },
  { dong:'대림동',    district:'영등포구', sigunguCd:'11560', bjdongCd:'10900', lat:37.4953, lng:126.8959 },
  { dong:'잠실동',    district:'송파구',   sigunguCd:'11710', bjdongCd:'10800', lat:37.5133, lng:127.0990 },
  { dong:'대치동',    district:'강남구',   sigunguCd:'11680', bjdongCd:'10600', lat:37.5044, lng:127.0594 },
  { dong:'압구정동',  district:'강남구',   sigunguCd:'11680', bjdongCd:'10300', lat:37.5270, lng:127.0296 },
  { dong:'개포동',    district:'강남구',   sigunguCd:'11680', bjdongCd:'10700', lat:37.4834, lng:127.0523 },
  { dong:'반포동',    district:'서초구',   sigunguCd:'11650', bjdongCd:'10600', lat:37.5085, lng:126.9990 },
  { dong:'목동',      district:'양천구',   sigunguCd:'11470', bjdongCd:'10700', lat:37.5250, lng:126.8744 },
  { dong:'천호동',    district:'강동구',   sigunguCd:'11740', bjdongCd:'10200', lat:37.5408, lng:127.1242 },
  { dong:'둔촌동',    district:'강동구',   sigunguCd:'11740', bjdongCd:'10300', lat:37.5447, lng:127.1303 },
  { dong:'고덕동',    district:'강동구',   sigunguCd:'11740', bjdongCd:'10500', lat:37.5570, lng:127.1466 },
  { dong:'상계동',    district:'노원구',   sigunguCd:'11350', bjdongCd:'10700', lat:37.6539, lng:127.0609 },
  { dong:'금호동',    district:'성동구',   sigunguCd:'11200', bjdongCd:'10600', lat:37.5543, lng:127.0199 },
  { dong:'자양동',    district:'광진구',   sigunguCd:'11215', bjdongCd:'10300', lat:37.5413, lng:127.0789 },
];

async function fetchDongNohuodo(dong) {
  // 건축물대장 기본개요 API: 동 코드로 전체 건물 조회 후 준공연도 집계
  const base = 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo';
  const params = new URLSearchParams({
    serviceKey: DATA_GO_KR_KEY,
    sigunguCd: dong.sigunguCd,
    bjdongCd:  dong.bjdongCd,
    numOfRows:  1000,
    pageNo:     1,
    _type:      'json',
  });

  const res = await fetch(`${base}?${params}`);
  const json = await res.json();
  const items = json?.response?.body?.items?.item;
  if (!items) return null;

  const list = Array.isArray(items) ? items : [items];
  const total = list.length;
  if (total === 0) return null;

  const old = list.filter(b => {
    const yr = parseInt(b.useAprDay?.substring(0, 4) || 0);
    return yr > 0 && yr <= THRESHOLD_YEAR;
  }).length;

  const ages = list
    .map(b => parseInt(b.useAprDay?.substring(0, 4) || 0))
    .filter(y => y > 1900)
    .map(y => CURRENT_YEAR - y);

  const avg_age_y = ages.length > 0 ? Math.round(ages.reduce((a,b)=>a+b,0)/ages.length) : 0;
  const pct_30y = Math.round((old / total) * 100);

  return { ...dong, pct_30y, avg_age_y, total_buildings: total };
}

async function main() {
  let existing = { updated_at: TODAY, source: 'sample', note: '', dongs: [] };
  if (fs.existsSync(DATA_FILE)) {
    existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  }

  if (!DATA_GO_KR_KEY) {
    console.log('[NOHUODO] DATA_GO_KR_KEY 없음 — 타임스탬프만 갱신. data.go.kr에서 API 키를 발급하세요.');
    existing.updated_at = TODAY;
    fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2), 'utf-8');
    return;
  }

  console.log('[NOHUODO] 건축물대장 API로 노후도 데이터 갱신 중...');
  const results = [];

  for (const dong of TARGET_DONGS) {
    try {
      const data = await fetchDongNohuodo(dong);
      if (data) {
        results.push(data);
        console.log(`  ✓ ${dong.district} ${dong.dong}: ${data.pct_30y}% (${data.total_buildings}동)`);
      } else {
        console.warn(`  ✗ ${dong.district} ${dong.dong}: 데이터 없음 → 기존값 유지`);
        const prev = existing.dongs.find(d => d.dong === dong.dong && d.district === dong.district);
        if (prev) results.push(prev);
        else results.push({ ...dong, pct_30y: 0, avg_age_y: 0 });
      }
    } catch (e) {
      console.error(`  ✗ ${dong.district} ${dong.dong}: 오류 — ${e.message}`);
      const prev = existing.dongs.find(d => d.dong === dong.dong && d.district === dong.district);
      if (prev) results.push(prev); else results.push({ ...dong, pct_30y: 0, avg_age_y: 0 });
    }
    // API rate limit 보호
    await new Promise(r => setTimeout(r, 300));
  }

  existing.dongs = results;
  existing.updated_at = TODAY;
  existing.source = 'data_go_kr';
  existing.note = '국토교통부 건축물대장 기본개요 API 기반 실데이터 (연 1회 갱신)';

  fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2), 'utf-8');
  console.log(`[DONE] data/nohuodo.json 업데이트 완료 (${results.length}개 동, ${TODAY})`);
}

main().catch(e => { console.error('스크립트 오류:', e); process.exit(1); });
